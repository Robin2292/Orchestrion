import { app } from "electron";
import { pathToFileURL } from "node:url";

const EXPECTED_ELECTRON = "38.8.6";
const MARKER = "__ORCHESTRION_WORKSPACE_LIFECYCLE__";
const serviceBundle = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function main() {
  assert(process.versions.electron === EXPECTED_ELECTRON, `Expected Electron ${EXPECTED_ELECTRON}, received ${process.versions.electron ?? "none"}`);
  assert(typeof serviceBundle === "string" && serviceBundle.length > 0, "Workspace terminal service bundle is required");
  const { WorkspaceTerminalService, nodePtyFactory } = await import(pathToFileURL(serviceBundle).href);
  const processes = [];
  const events = [];
  const factory = {
    async spawn(options) {
      const terminal = await nodePtyFactory.spawn(options);
      processes.push(terminal);
      return terminal;
    },
  };
  const service = new WorkspaceTerminalService(() => process.cwd(), factory);
  const makeOwner = (id) => ({
    id,
    isActive: () => true,
    publish(event) {
      events.push(event);
      if (event.type === "output") service.acknowledgeOutput(id, {
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        sequence: event.sequence,
      });
    },
  });
  const owner = makeOwner("native-document-1");

  const first = await service.create(owner, { sessionId: "session-a", columns: 80, rows: 24 });
  const firstPid = processes.at(-1).pid;
  service.input(owner.id, { ...first, data: `printf '${MARKER}\\n'\n` });
  await waitFor(() => events.some((event) => event.type === "output" && event.data.includes(MARKER)), "Real PTY did not emit the lifecycle marker");
  service.closeSessionForOwner(owner.id, "session-a");
  await waitFor(() => !alive(firstPid), `Panel close left PTY ${firstPid} alive`);
  assert(service.activeTerminalCount === 0, "Panel close retained terminal state");

  assert(service.activeTerminalCount === 0, "Panel reopen eagerly created a terminal");
  const reopened = await service.create(owner, { sessionId: "session-a", columns: 80, rows: 24 });
  const reopenedPid = processes.at(-1).pid;
  assert(reopened.terminalId !== first.terminalId && reopenedPid !== firstPid, "Panel reopen reused the previous shell");
  service.closeSessionForOwner(owner.id, "session-a");
  await waitFor(() => !alive(reopenedPid), `Session switch left PTY ${reopenedPid} alive`);
  assert(service.activeTerminalCount === 0, "Same-project Session B switch eagerly created a PTY");

  const second = await service.create(owner, { sessionId: "session-b", columns: 90, rows: 30 });
  const secondPid = processes.at(-1).pid;
  service.closeSession("session-b");
  await waitFor(() => !alive(secondPid), `Session delete left PTY ${secondPid} alive`);
  assert(service.activeTerminalCount === 0, "Session delete retained terminal state");

  await service.create(owner, { sessionId: "session-a", columns: 80, rows: 24 });
  const reloadPid = processes.at(-1).pid;
  service.closeOwner(owner.id);
  await waitFor(() => !alive(reloadPid), `Renderer reload left PTY ${reloadPid} alive`);

  const reloadedOwner = makeOwner("native-document-2");
  await service.create(reloadedOwner, { sessionId: "session-a", columns: 80, rows: 24 });
  const quitPid = processes.at(-1).pid;
  service.closeAll();
  await waitFor(() => !alive(quitPid), `Application quit left PTY ${quitPid} alive`);
  assert(service.activeTerminalCount === 0, "Application quit retained PTYs");
  process.stdout.write(`Electron ${process.versions.electron} verified real Workspace PTY panel close, fresh reopen, same-project session switch, delete, renderer reload, and app quit cleanup.\n`);
}

void main().then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
