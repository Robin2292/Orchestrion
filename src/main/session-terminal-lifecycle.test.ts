import { describe, expect, it, vi } from "vitest";
import type { StoredMetadata, MetadataStore } from "./store";
import { DesktopRuntime } from "./runtime";
import { JsonRpcConnection } from "./json-rpc";
import { FakeTransport } from "./test-transport";
import {
  WorkspaceTerminalService,
  type Disposable,
  type PtyExitEvent,
  type TerminalOwner,
  type WorkspacePty,
} from "./workspace-terminal";

class FakePty implements WorkspacePty {
  readonly pid = 42;
  readonly kill = vi.fn();
  write() {}
  resize() {}
  onData(_listener: (data: string) => void): Disposable { return { dispose: vi.fn() }; }
  onExit(_listener: (event: PtyExitEvent) => void): Disposable { return { dispose: vi.fn() }; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function harness() {
  const metadata: StoredMetadata = {
    projects: [{ id: "project-1", name: "Repo", path: "/workspace/repo", createdAt: "now" }],
    agents: [{ id: "agent-1", projectId: "project-1", name: "Builder", instructions: "", createdAt: "now" }],
    sessions: [{
      id: "session-1",
      agentId: "agent-1",
      title: "Lifecycle",
      threadId: null,
      model: null,
      modelProvider: null,
      reasoningEffort: null,
      titleSource: "manual",
      createdAt: "now",
      updatedAt: "now",
    }],
  };
  const store = { read: vi.fn(async () => structuredClone(metadata)) } as unknown as MetadataStore;
  const transport = new FakeTransport();
  const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transport), version: "0.154.0" }));
  await runtime.bootstrap();
  const processes: FakePty[] = [];
  const spawn = vi.fn(() => {
    const pty = new FakePty();
    processes.push(pty);
    return pty;
  });
  const terminals = new WorkspaceTerminalService((sessionId) => runtime.projectPathForSession(sessionId), { spawn });
  const owner: TerminalOwner = { id: "document-1", isActive: () => true, publish: vi.fn() };
  const create = () => terminals.create(
    owner,
    { sessionId: "session-1", columns: 80, rows: 24 },
    (operation) => runtime.runSessionOperation("session-1", operation),
  );
  return { runtime, terminals, owner, create, spawn, processes };
}

describe("runtime and terminal lifecycle", () => {
  it("cancels an owner-session create intent waiting in the runtime queue and permits a deliberate fresh reopen", async () => {
    const { runtime, terminals, owner, create, spawn, processes } = await harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const holding = runtime.runSessionOperation("session-1", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const creating = create();
    terminals.closeSessionForOwner(owner.id, "session-1");
    release.resolve();
    await holding;

    await expect(creating).rejects.toThrow("Terminal creation was cancelled");
    expect(spawn).not.toHaveBeenCalled();
    expect(terminals.activeTerminalCount).toBe(0);

    const reopened = await create();
    expect(reopened).toMatchObject({ sessionId: "session-1" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(terminals.activeTerminalCount).toBe(1);
    terminals.closeSessionForOwner(owner.id, "session-1");
    expect(processes[0]?.kill).toHaveBeenCalledOnce();
    expect(terminals.activeTerminalCount).toBe(0);
    runtime.shutdown();
  });
});
