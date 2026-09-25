import { describe, expect, it, vi } from "vitest";
import { TERMINAL_MAX_BUFFERED_OUTPUT_BYTES, TERMINAL_MAX_INPUT_BYTES } from "../shared/contracts";
import {
  WorkspaceTerminalService,
  defaultShell,
  type Disposable,
  type PtyExitEvent,
  type SpawnWorkspacePtyOptions,
  type TerminalOwner,
  type WorkspacePty,
  type WorkspacePtyFactory,
} from "./workspace-terminal";

class FakePty implements WorkspacePty {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = 0;
  dataListeners = new Set<(data: string) => void>();
  exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: string) { this.writes.push(data); }
  resize(columns: number, rows: number) { this.resizes.push([columns, rows]); }
  kill() { this.killed += 1; }
  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  emitData(data: string) { for (const listener of [...this.dataListeners]) listener(data); }
  emitExit(event: PtyExitEvent) { for (const listener of [...this.exitListeners]) listener(event); }
}

class FakeFactory implements WorkspacePtyFactory {
  readonly options: SpawnWorkspacePtyOptions[] = [];
  readonly processes: FakePty[] = [];
  spawn(options: SpawnWorkspacePtyOptions) {
    this.options.push(options);
    const process = new FakePty();
    this.processes.push(process);
    return process;
  }
}

function harness() {
  const factory = new FakeFactory();
  const scheduled: Array<() => void> = [];
  const events: Parameters<TerminalOwner["publish"]>[0][] = [];
  const resolve = vi.fn((sessionId: string) => `/projects/${sessionId}`);
  const service = new WorkspaceTerminalService(resolve, factory, (callback) => scheduled.push(callback), {
    SHELL: "/bin/fish",
    ELECTRON_RUN_AS_NODE: "1",
    SAFE_VALUE: "kept",
  }, "darwin");
  const owner: TerminalOwner = { id: "owner-7", isActive: () => true, publish: (event) => events.push(event) };
  return { service, factory, scheduled, events, resolve, owner };
}

describe("WorkspaceTerminalService", () => {
  it("resolves cwd from the session, starts the default shell, and supports input, resize, output, and exit", async () => {
    const { service, factory, scheduled, events, resolve, owner } = harness();
    const handle = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    const process = factory.processes[0]!;

    expect(resolve).toHaveBeenCalledWith("session-1");
    expect(factory.options[0]).toMatchObject({
      shell: "/bin/fish",
      args: [],
      cwd: "/projects/session-1",
      columns: 80,
      rows: 24,
      env: { SHELL: "/bin/fish", SAFE_VALUE: "kept", TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    expect(factory.options[0]!.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");

    service.input(owner.id, { ...handle, data: "printf ready\\r" });
    service.resize(owner.id, { ...handle, columns: 100, rows: 32 });
    process.emitData("ready\r\n");
    expect(events).toEqual([]);
    scheduled.shift()?.();
    expect(process.writes).toEqual(["printf ready\\r"]);
    expect(process.resizes).toEqual([[100, 32]]);
    expect(events[0]).toEqual({ type: "output", ...handle, sequence: 1, data: "ready\r\n" });

    service.acknowledgeOutput(owner.id, { ...handle, sequence: 1 });
    process.emitExit({ exitCode: 0, signal: 0 });
    expect(events.at(-1)).toEqual({ type: "exit", ...handle, exitCode: 0, signal: 0, reason: "exit" });
    expect(service.activeTerminalCount).toBe(0);
    process.emitData("must not leak");
    expect(events).toHaveLength(2);
  });

  it("enforces renderer and session ownership", async () => {
    const { service, owner } = harness();
    const handle = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });

    expect(() => service.input("owner-8", { ...handle, data: "x" })).toThrow("ownership mismatch");
    expect(() => service.resize(owner.id, { ...handle, sessionId: "session-2", columns: 80, rows: 24 })).toThrow("ownership mismatch");
    expect(() => service.close("owner-8", handle)).toThrow("ownership mismatch");
    await expect(service.create({ id: "owner-8", isActive: () => true, publish: vi.fn() }, { sessionId: "session-1", columns: 80, rows: 24 }))
      .rejects.toThrow("belongs to another renderer");
  });

  it("validates dimensions and input bounds before reaching the PTY", async () => {
    const { service, factory, owner } = harness();
    await expect(service.create(owner, { sessionId: "session-1", columns: 1, rows: 24 })).rejects.toThrow("between 2 and 500");
    await expect(service.create(owner, { sessionId: "session-1", columns: 80.5, rows: 24 })).rejects.toThrow("integer");
    expect(factory.processes).toHaveLength(0);

    const handle = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    expect(() => service.resize(owner.id, { ...handle, columns: 501, rows: 24 })).toThrow("between 2 and 500");
    expect(() => service.resize(owner.id, { ...handle, columns: 80, rows: 301 })).toThrow("between 1 and 300");
    expect(() => service.input(owner.id, { ...handle, data: "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1) })).toThrow("exceeds");
    expect(factory.processes[0]!.writes).toEqual([]);
  });

  it("bounds buffered output without splitting UTF-8 and flushes output before natural exit", async () => {
    const { service, factory, scheduled, events, owner } = harness();
    const handle = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    const process = factory.processes[0]!;
    process.emitData(`prefix${"🙂".repeat(80_000)}`);
    process.emitExit({ exitCode: 9 });

    expect(events.map((event) => event.type)).toEqual(["output"]);
    const output = events[0]!;
    expect(output.type).toBe("output");
    if (output.type === "output") {
      expect(Buffer.byteLength(output.data, "utf8")).toBeLessThanOrEqual(TERMINAL_MAX_BUFFERED_OUTPUT_BYTES);
      expect(output.data).toContain("Earlier terminal output was truncated");
      expect(output.data).not.toContain("�");
    }
    scheduled.shift()?.();
    service.acknowledgeOutput(owner.id, { ...handle, sequence: 1 });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ ...handle, exitCode: 9, signal: null });
  });

  it("drains every acknowledged output chunk in order before publishing natural exit", async () => {
    const { service, factory, scheduled, events, owner } = harness();
    const handle = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    const process = factory.processes[0]!;
    process.emitData("first");
    scheduled.shift()?.();
    process.emitData("second");
    process.emitExit({ exitCode: 7, signal: 2 });
    expect(events).toEqual([{ type: "output", ...handle, sequence: 1, data: "first" }]);
    expect(scheduled).toHaveLength(0);

    expect(() => service.acknowledgeOutput("owner-8", { ...handle, sequence: 1 })).toThrow("ownership mismatch");
    expect(() => service.acknowledgeOutput(owner.id, { ...handle, sessionId: "session-2", sequence: 1 })).toThrow("ownership mismatch");
    expect(() => service.acknowledgeOutput(owner.id, { ...handle, sequence: 2 })).toThrow("out of sequence");
    expect(events).toHaveLength(1);

    service.acknowledgeOutput(owner.id, { ...handle, sequence: 1 });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(events[1]).toEqual({ type: "output", ...handle, sequence: 2, data: "second" });
    expect(() => service.acknowledgeOutput(owner.id, { ...handle, sequence: 1 })).toThrow("out of sequence");
    expect(events).toHaveLength(2);

    service.acknowledgeOutput(owner.id, { ...handle, sequence: 2 });
    expect(events[2]).toEqual({ type: "exit", ...handle, exitCode: 7, signal: 2, reason: "exit" });
    expect(service.activeTerminalCount).toBe(0);
    service.acknowledgeOutput(owner.id, { ...handle, sequence: 2 });
    expect(events).toHaveLength(3);
  });

  it("closes idempotently, drops pending output, and always reopens as a fresh process", async () => {
    const { service, factory, scheduled, events, owner } = harness();
    const first = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    factory.processes[0]!.emitData("pending secret");
    service.close(owner.id, first);
    service.close(owner.id, first);
    scheduled.shift()?.();
    expect(factory.processes[0]!.killed).toBe(1);
    expect(events).toEqual([{ type: "exit", ...first, exitCode: null, signal: null, reason: "closed" }]);

    const second = await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(factory.processes).toHaveLength(2);
  });

  it("provides session, renderer-unsubscribe, and app-wide cleanup primitives", async () => {
    const { service, factory, events, owner } = harness();
    await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    await service.create(owner, { sessionId: "session-2", columns: 80, rows: 24 });
    service.closeSession("session-1");
    expect(factory.processes.map((process) => process.killed)).toEqual([1, 0]);
    expect(service.activeTerminalCount).toBe(1);

    service.closeOwner(owner.id);
    expect(factory.processes.map((process) => process.killed)).toEqual([1, 1]);
    expect(service.activeTerminalCount).toBe(0);
    expect(events).toHaveLength(1);

    await service.create(owner, { sessionId: "session-3", columns: 80, rows: 24 });
    service.closeAll();
    expect(factory.processes[2]!.killed).toBe(1);
    expect(service.activeTerminalCount).toBe(0);
  });

  it("closes only the requested owner and session", async () => {
    const { service, factory, owner } = harness();
    const otherOwner: TerminalOwner = { id: "owner-8", isActive: () => true, publish: vi.fn() };
    await service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    await service.create(owner, { sessionId: "session-2", columns: 80, rows: 24 });

    service.closeSessionForOwner(otherOwner.id, "session-1");
    expect(factory.processes.map((process) => process.killed)).toEqual([0, 0]);
    service.closeSessionForOwner(owner.id, "session-1");
    expect(factory.processes.map((process) => process.killed)).toEqual([1, 0]);
    expect(service.activeTerminalCount).toBe(1);
  });

  it("kills a PTY that finishes spawning after its renderer has gone away", async () => {
    let active = true;
    let resolvePty!: (pty: FakePty) => void;
    let markStarted!: () => void;
    const process = new FakePty();
    const spawned = new Promise<WorkspacePty>((resolve) => { resolvePty = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const factory: WorkspacePtyFactory = {
      spawn: () => {
        markStarted();
        return spawned;
      },
    };
    const service = new WorkspaceTerminalService(() => "/projects/session-1", factory);
    const creating = service.create({ id: "owner-7", isActive: () => active, publish: vi.fn() }, {
      sessionId: "session-1",
      columns: 80,
      rows: 24,
    });
    await started;
    active = false;
    resolvePty(process);

    await expect(creating).rejects.toThrow("creation was cancelled");
    expect(process.killed).toBe(1);
    expect(service.activeTerminalCount).toBe(0);
  });

  it.each(["session", "owner", "all"] as const)("cancels a pending spawn during %s cleanup", async (scope) => {
    let resolvePty!: (pty: WorkspacePty) => void;
    let markStarted!: () => void;
    const process = new FakePty();
    const spawned = new Promise<WorkspacePty>((resolve) => { resolvePty = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const factory: WorkspacePtyFactory = {
      spawn: () => {
        markStarted();
        return spawned;
      },
    };
    const service = new WorkspaceTerminalService(() => "/projects/session-1", factory);
    const owner: TerminalOwner = { id: "owner-7", isActive: () => true, publish: vi.fn() };
    const creating = service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    await started;
    if (scope === "session") service.closeSession("session-1");
    else if (scope === "owner") service.closeOwner(owner.id);
    else service.closeAll();

    await expect(creating).rejects.toThrow("creation was cancelled");
    expect(process.killed).toBe(0);
    resolvePty(process);
    await Promise.resolve();
    expect(process.killed).toBe(1);
    expect(service.activeTerminalCount).toBe(0);
  });

  it("cancels a deferred create only for the exact owner and session", async () => {
    let resolvePty!: (pty: WorkspacePty) => void;
    let markStarted!: () => void;
    const process = new FakePty();
    const spawned = new Promise<WorkspacePty>((resolve) => { resolvePty = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const service = new WorkspaceTerminalService(() => "/projects/session-1", { spawn: () => { markStarted(); return spawned; } });
    const owner: TerminalOwner = { id: "owner-7", isActive: () => true, publish: vi.fn() };
    const creating = service.create(owner, { sessionId: "session-1", columns: 80, rows: 24 });
    await started;

    service.closeSessionForOwner("owner-8", "session-1");
    service.closeSessionForOwner(owner.id, "session-2");
    resolvePty(process);
    await expect(creating).resolves.toMatchObject({ sessionId: "session-1" });
    expect(process.killed).toBe(0);

    service.closeSessionForOwner(owner.id, "session-1");
    expect(process.killed).toBe(1);
  });

  it("uses safe platform fallbacks when the configured shell is not absolute", () => {
    expect(defaultShell("darwin", { SHELL: "zsh" })).toEqual({ shell: "/bin/zsh", args: [] });
    expect(defaultShell("linux", {})).toEqual({ shell: "/bin/sh", args: [] });
    expect(defaultShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({ shell: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });
});
