import { describe, expect, it, vi } from "vitest";
import { IPC, type DeleteSessionInput } from "../shared/contracts";
import type { DesktopRuntime } from "./runtime";
import type { ScheduleTerminalCreate, TerminalOwner, WorkspaceTerminalService } from "./workspace-terminal";
import { BackgroundService, type HostDocument } from "./background/service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class QueuedRuntime {
  readonly on = vi.fn();
  readonly off = vi.fn();
  sessionExists = true;
  remoteDeleteError: Error | null = null;
  readonly lifecycle: string[] = [];
  private readonly operations = new Map<string, Promise<void>>();

  runSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.withSessionLock(sessionId, async () => {
      if (!this.sessionExists) throw new Error("Session not found");
      return operation();
    });
  }

  deleteSession(input: DeleteSessionInput, beforeDelete: (sessionId: string) => void | Promise<void>): Promise<void> {
    return this.withSessionLock(input.sessionId, async () => {
      if (!this.sessionExists) throw new Error("Session not found");
      await beforeDelete(input.sessionId);
      this.lifecycle.push("remote-delete");
      if (this.remoteDeleteError) throw this.remoteDeleteError;
      this.sessionExists = false;
      this.lifecycle.push("local-delete");
    });
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.operations.set(sessionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(sessionId) === queued) this.operations.delete(sessionId);
    }
  }
}

function queuedLifecycleHarness(remoteDeleteError: Error | null = null) {
  const runtime = new QueuedRuntime();
  runtime.remoteDeleteError = remoteDeleteError;
  let activeTerminals = 0;
  let pendingCreates = 0;
  const terminals = {
    create: vi.fn(async (_owner: TerminalOwner, input: { sessionId: string }, scheduleCreate: ScheduleTerminalCreate) => {
      pendingCreates += 1;
      try {
        return await scheduleCreate(async () => {
          runtime.lifecycle.push("terminal-create");
          activeTerminals += 1;
          return { terminalId: "terminal-queued", sessionId: input.sessionId };
        });
      } finally {
        pendingCreates -= 1;
      }
    }),
    input: vi.fn(),
    acknowledgeOutput: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    closeSessionForOwner: vi.fn(),
    closeSession: vi.fn(() => {
      runtime.lifecycle.push(activeTerminals > 0 ? "terminal-close-active" : "terminal-close-empty");
      activeTerminals = 0;
    }),
    closeOwner: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as WorkspaceTerminalService;
  return {
    runtime,
    terminals,
    counts: () => ({ activeTerminals, pendingCreates }),
  };
}


const document: HostDocument = { id: "test-document", isActive: () => true, publish: () => {}, openSystem: async () => {} };
async function hostService(runtime: object, terminals: WorkspaceTerminalService) {
  const service = new BackgroundService(Object.assign(runtime, { bootstrap: async () => ({}), snapshot: () => ({}) }) as DesktopRuntime, terminals);
  await service.invoke(IPC.bootstrap, undefined, document);
  return (channel: string, input: unknown) => service.invoke(channel, input, document);
}

describe("IPC compatibility delegated to the background service", () => {
  it("delegates existing file inputs unchanged", async () => {
    const runtime = { readWorkspaceFile: vi.fn(), saveWorkspaceFile: vi.fn(), openWorkspaceFile: vi.fn() };
    const invoke = await hostService(runtime, {} as WorkspaceTerminalService);
    const read = { sessionId: "s", relativePath: "README.md" };
    const save = { ...read, content: "new", expectedRevision: "sha256:before" };
    const open = { ...read, destination: "cursor" };
    await invoke(IPC.readWorkspaceFile, read); await invoke(IPC.saveWorkspaceFile, save); await invoke(IPC.openWorkspaceFile, open);
    expect(runtime.readWorkspaceFile).toHaveBeenCalledWith(read); expect(runtime.saveWorkspaceFile).toHaveBeenCalledWith(save, expect.any(Function)); expect(runtime.openWorkspaceFile).toHaveBeenCalledWith(open, expect.any(Function), expect.any(Function));
  });
  it("rejects invalid or revoked requests with no business effects", async () => {
    const runtime = { bootstrap: vi.fn(), createProject: vi.fn() } as unknown as DesktopRuntime;
    const service = new BackgroundService(runtime, {} as WorkspaceTerminalService);
    expect(await service.invoke(IPC.createProject, {}, document)).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });
    expect(await service.invoke(IPC.createProject, { name: "x", path: "/tmp" }, { ...document, isActive: () => false })).toMatchObject({ error: { code: "NOT_AUTHENTICATED" } });
    expect(runtime.bootstrap).not.toHaveBeenCalled(); expect(runtime.createProject).not.toHaveBeenCalled();
  });
  it.each(["send", "rename"])("retains terminal/session lock ordering behind %s", async (holderName) => {
    const { runtime, terminals, counts } = queuedLifecycleHarness();
    const invoke = await hostService(runtime, terminals);
    const gate = deferred<void>();
    const holder = runtime.runSessionOperation("session-1", async () => { runtime.lifecycle.push(`${holderName}-start`); await gate.promise; runtime.lifecycle.push(`${holderName}-end`); });
    await Promise.resolve();
    const creating = invoke(IPC.createTerminal, { sessionId: "session-1", columns: 80, rows: 24 });
    const deleting = invoke(IPC.deleteSession, { sessionId: "session-1" });
    await Promise.resolve();
    expect(runtime.lifecycle).toEqual([`${holderName}-start`, "terminal-close-empty"]);
    gate.resolve(); await holder; await creating; await deleting;
    expect(runtime.lifecycle).toEqual([`${holderName}-start`, "terminal-close-empty", `${holderName}-end`, "terminal-create", "terminal-close-active", "remote-delete", "local-delete"]);
    expect(counts()).toEqual({ activeTerminals: 0, pendingCreates: 0 });
    await expect(invoke(IPC.createTerminal, { sessionId: "session-1", columns: 80, rows: 24 })).rejects.toThrow("Session not found");
    expect(runtime.lifecycle.filter((event) => event === "terminal-create")).toHaveLength(1);
  });
  it("retains local session after remote deletion fails but closes preceding terminal", async () => {
    const { runtime, terminals, counts } = queuedLifecycleHarness(new Error("Remote deletion failed"));
    const invoke = await hostService(runtime, terminals); const gate = deferred<void>();
    const holder = runtime.runSessionOperation("session-1", () => gate.promise); await Promise.resolve();
    const creating = invoke(IPC.createTerminal, { sessionId: "session-1", columns: 80, rows: 24 });
    const deleting = invoke(IPC.deleteSession, { sessionId: "session-1" });
    gate.resolve(); await holder; await creating; await expect(deleting).rejects.toThrow("Remote deletion failed");
    expect(runtime.sessionExists).toBe(true); expect(runtime.lifecycle).toEqual(["terminal-close-empty", "terminal-create", "terminal-close-active", "remote-delete"]);
    expect(counts()).toEqual({ activeTerminals: 0, pendingCreates: 0 });
  });
  it("rejects terminal create queued after deletion before spawning", async () => {
    const { runtime, terminals, counts } = queuedLifecycleHarness(); const invoke = await hostService(runtime, terminals);
    const deleting = invoke(IPC.deleteSession, { sessionId: "session-1" });
    const creating = invoke(IPC.createTerminal, { sessionId: "session-1", columns: 80, rows: 24 });
    await deleting; await expect(creating).rejects.toThrow("Session not found");
    expect(runtime.lifecycle).toEqual(["terminal-close-empty", "terminal-close-empty", "remote-delete", "local-delete"]);
    expect(counts()).toEqual({ activeTerminals: 0, pendingCreates: 0 });
  });
});
