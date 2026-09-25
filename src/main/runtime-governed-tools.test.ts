import { describe, expect, it, vi } from "vitest";
import type { AgentRecord, CreateAgentInput, CreateProjectInput, CreateSessionInput, ProjectRecord, SessionRecord } from "../shared/contracts";
import type { DynamicToolCallResponse } from "../shared/governed-tool-contracts";
import { JsonRpcConnection } from "./json-rpc";
import { DesktopRuntime, GOVERNED_TOOL_CALL_DEADLINE_MS } from "./runtime";
import type { GovernedCallInput, GovernedDeclaration, GovernedSessionInput, GovernedToolHost } from "./governed-tools";
import type { MetadataStore, StoredMetadata } from "./store";
import { FakeTransport, tick } from "./test-transport";

class MemoryStore implements MetadataStore {
  state: StoredMetadata = { projects: [], agents: [], sessions: [] };
  private id = 0;
  async read() { return structuredClone(this.state); }
  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const record = { ...input, id: `project-${++this.id}`, createdAt: new Date().toISOString() }; this.state.projects.push(record); return structuredClone(record);
  }
  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const record = { ...input, id: `agent-${++this.id}`, createdAt: new Date().toISOString() }; this.state.agents.push(record); return structuredClone(record);
  }
  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = { id: `session-${++this.id}`, agentId: input.agentId, title: input.title ?? "Untitled session", threadId: null, model: null,
      modelProvider: null, reasoningEffort: null, titleSource: "provisional", createdAt: now, updatedAt: now };
    this.state.sessions.push(record); return structuredClone(record);
  }
  async updateSession(session: SessionRecord) { this.state.sessions[this.state.sessions.findIndex((entry) => entry.id === session.id)] = structuredClone(session); }
  async deleteSession(sessionId: string) { this.state.sessions = this.state.sessions.filter((entry) => entry.id !== sessionId); }
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve };
}
const declaration: GovernedDeclaration = { attemptId: "attempt-1", tools: ["file.read"], dynamicTools: [{ type: "function", name: "file_read", description: "read", inputSchema: { type: "object" } }] };
const ok: DynamicToolCallResponse = { success: true, contentItems: [{ type: "inputText", text: "# hello" }] };
class FakeHost implements GovernedToolHost {
  declared: GovernedSessionInput[] = []; executed: GovernedCallInput[] = []; released: string[] = []; shutdowns = 0;
  declaration: GovernedDeclaration | null = declaration;
  next: () => Promise<DynamicToolCallResponse> = async () => ok;
  nextShutdown: () => Promise<void> = async () => undefined;
  async declare(input: GovernedSessionInput) { this.declared.push(input); return this.declaration; }
  async execute(input: GovernedCallInput) { this.executed.push(input); return this.next(); }
  release(sessionId: string) { this.released.push(sessionId); }
  async shutdown() { this.shutdowns++; await this.nextShutdown(); }
}
async function fixture(host: GovernedToolHost | null = new FakeHost()) {
  const store = new MemoryStore(), transport = new FakeTransport(), connection = new JsonRpcConnection(transport);
  const runtime = new DesktopRuntime(store, async () => ({ connection, version: "0.154.0" }), host);
  await runtime.bootstrap();
  const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
  const agent = await runtime.createAgent({ projectId: project.id, name: "Reader", instructions: "Read only." });
  const session = await runtime.createSession({ agentId: agent.id });
  return { runtime, store, transport, project, agent, session };
}
async function startTurn(runtime: DesktopRuntime, transport: FakeTransport, sessionId: string, threadId = "thread-1", turnId = "turn-1", fail = false) {
  const sending = runtime.sendMessage({ sessionId, text: "read the readme" });
  await tick();
  const start = transport.request("thread/start");
  if (fail) { transport.receive({ jsonrpc: "2.0", id: start.id, error: { code: -32600, message: "thread/start.dynamicTools requires experimentalApi capability" } }); await expect(sending).rejects.toThrow("experimentalApi"); return start; }
  transport.receive({ jsonrpc: "2.0", id: start.id, result: { thread: { id: threadId } } });
  await tick();
  transport.respondTo("turn/start", { turn: { id: turnId } });
  await sending;
  return start;
}
const call = (id: number | string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "item/tool/call",
  params: { threadId: "thread-1", turnId: "turn-1", callId: `call-${String(id)}`, tool: "file_read", namespace: null, arguments: { path: "README.md" }, ...params } });
const responseFor = (transport: FakeTransport, id: number | string) => transport.sent.find((entry) => entry.id === id && ("result" in entry || "error" in entry));

describe("EP1-B runtime wiring: thread/start.dynamicTools and item/tool/call", () => {
  it("declares governed tools before thread/start, injects them, and persists the governance marker for that exact thread", async () => {
    const f = await fixture(), host = new FakeHost();
    const runtime = new DesktopRuntime(f.store, async () => ({ connection: new JsonRpcConnection(f.transport), version: "0.154.0" }), host);
    await runtime.bootstrap();
    const start = await startTurn(runtime, f.transport, f.session.id);
    expect(host.declared).toEqual([{ sessionId: f.session.id, agentId: f.agent.id, projectId: f.project.id, projectPath: "/workspace/repo" }]);
    expect(start.params).toEqual({ cwd: "/workspace/repo", developerInstructions: "Read only.", dynamicTools: declaration.dynamicTools });
    expect(f.store.state.sessions[0].governance).toEqual({ attemptId: "attempt-1", threadId: "thread-1", tools: ["file.read"], declaredAt: expect.any(String) });
    expect(runtime.snapshot().sessions[0].governance?.threadId).toBe("thread-1");
  });
  it("keeps the native lane only when the host declares nothing or no host is composed", async () => {
    const host = new FakeHost(); host.declaration = null;
    const f = await fixture(host);
    const start = await startTurn(f.runtime, f.transport, f.session.id);
    expect(start.params).not.toHaveProperty("dynamicTools");
    expect(f.store.state.sessions[0].governance).toBeNull();
    const bare = await fixture(null);
    const bareStart = await startTurn(bare.runtime, bare.transport, bare.session.id);
    expect(bareStart.params).not.toHaveProperty("dynamicTools");
    expect(bare.store.state.sessions[0].governance).toBeNull();
  });
  it("releases the bound attempt when thread/start fails and leaves no marker", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-1", true);
    expect(host.released).toEqual([f.session.id]);
    expect(f.store.state.sessions[0].governance).toBeUndefined();
    expect(f.store.state.sessions[0].threadId).toBeNull();
  });
  it("answers item/tool/call through the host with the session governance and never as a pending request", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    f.transport.receive(call(7));
    await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0]).toMatchObject({ sessionId: f.session.id, governance: { attemptId: "attempt-1", threadId: "thread-1" },
      call: { threadId: "thread-1", turnId: "turn-1", callId: "call-7", tool: "file_read", arguments: { path: "README.md" } } });
    expect(host.executed[0].signal?.aborted).toBe(false);
    expect(responseFor(f.transport, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: ok });
    expect(f.runtime.snapshot().runtimes[f.session.id].pendingRequests).toEqual([]);
    expect(f.runtime.snapshot().runtimes[f.session.id].status).toBe("running");
  });
  it("rejects unmapped threads, refuses stale turns, and refuses when no governed host is composed", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    f.transport.receive(call(1, { threadId: "ghost" }));
    expect(responseFor(f.transport, 1)).toMatchObject({ error: { code: -32602 } });
    f.transport.receive(call(2, { turnId: "turn-9" }));
    expect(responseFor(f.transport, 2)).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } });
    f.transport.receive({ jsonrpc: "2.0", id: 3, method: "item/tool/call", params: { turnId: "turn-1" } });
    expect(responseFor(f.transport, 3)).toMatchObject({ error: { code: -32602 } });
    expect(host.executed).toEqual([]);
    const bare = await fixture(null);
    await startTurn(bare.runtime, bare.transport, bare.session.id);
    bare.transport.receive(call(4));
    expect(responseFor(bare.transport, 4)).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_HOST_UNAVAILABLE/) }] } });
  });
  it("hands a resumed thread's calls to the host with the original marker so the host, not the runtime, decides staleness", async () => {
    const host = new FakeHost(), f = await fixture(host);
    f.store.state.sessions[0] = { ...f.store.state.sessions[0], threadId: "thread-1", governance: { attemptId: "old-attempt", threadId: "thread-1", tools: ["file.read"], declaredAt: "2026-09-15T00:00:00.000Z" } };
    const transport = new FakeTransport();
    const runtime = new DesktopRuntime(f.store, async () => ({ connection: new JsonRpcConnection(transport), version: "0.154.0" }), host);
    const booting = runtime.bootstrap(); await tick();
    transport.respondTo("thread/read", { thread: { id: "thread-1", turns: [] } }); await booting;
    const sending = runtime.sendMessage({ sessionId: f.session.id, text: "again" }); await tick();
    expect(transport.request("thread/resume").params).not.toHaveProperty("dynamicTools");
    transport.respondTo("thread/resume", { thread: { id: "thread-1" } }); await tick();
    transport.respondTo("turn/start", { turn: { id: "turn-2" } }); await sending;
    expect(host.declared).toEqual([]);
    transport.receive(call(5, { turnId: "turn-2" })); await tick(); await tick();
    expect(host.executed[0]).toMatchObject({ governance: { attemptId: "old-attempt", threadId: "thread-1" } });
  });
  it("aborts in-flight calls on turn completion, stop, restart and session deletion, and still delivers the host's final answer", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(10)); await tick();
    const signal = host.executed[0].signal!;
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    expect(signal.aborted).toBe(true);
    pending.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(responseFor(f.transport, 10)).toMatchObject({ result: { success: false } });

    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    const second = deferred<DynamicToolCallResponse>(); host.next = () => second.promise;
    f.transport.receive(call(11, { turnId: "turn-2" })); await tick();
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    expect(host.executed[1].signal?.aborted).toBe(true);
    second.resolve(ok); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "interrupted", error: null } } });

    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-3");
    const third = deferred<DynamicToolCallResponse>(); host.next = () => third.promise;
    f.transport.receive(call(12, { turnId: "turn-3" })); await tick();
    const restarting = f.runtime.restartCodex(); await tick();
    expect(host.executed[2].signal?.aborted).toBe(true);
    third.resolve(ok); await tick(); await restarting.catch(() => undefined);
    expect(responseFor(f.transport, 12)).toBeUndefined();
  });
  it("aborts a session's in-flight call and releases its attempts when the session is deleted", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(30)); await tick();
    const deleting = f.runtime.deleteSession({ sessionId: f.session.id }); await tick();
    f.transport.respondTo("thread/delete", {}); await deleting;
    expect(host.executed[0].signal?.aborted).toBe(true);
    expect(host.released).toEqual([f.session.id]);
    pending.resolve(ok); await tick();
    expect(f.runtime.snapshot().sessions).toEqual([]);
  });
  it("awaits governed process teardown during app shutdown after aborting active calls", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const callResult = deferred<DynamicToolCallResponse>(), teardown = deferred<void>();
    host.next = () => callResult.promise; host.nextShutdown = () => teardown.promise;
    f.transport.receive(call(31)); await tick();
    let finished = false; const shutting = f.runtime.shutdown().then(() => { finished = true; });
    expect(host.executed[0].signal?.aborted).toBe(true); expect(host.shutdowns).toBe(1); expect(finished).toBe(false);
    callResult.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] });
    teardown.resolve(undefined); await shutting;
    expect(finished).toBe(true);
  });
  it("keeps a post-restart call cancellable when an aborted pre-restart call with the same JSON-RPC id settles late (review P2)", async () => {
    const host = new FakeHost(), store = new MemoryStore();
    const transports = [new FakeTransport(), new FakeTransport()];
    let launches = 0;
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transports[launches++]), version: "0.154.0" }), host);
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Reader", instructions: "Read only." });
    const session = await runtime.createSession({ agentId: agent.id });
    const [first, second] = transports;
    await startTurn(runtime, first, session.id, "thread-1", "turn-1");
    const old = deferred<DynamicToolCallResponse>(); host.next = () => old.promise;
    first.receive(call(0)); await tick();
    const oldSignal = host.executed[0].signal!;
    const restarting = runtime.restartCodex(); await tick(); await restarting;
    expect(oldSignal.aborted).toBe(true);
    // New connection, thread resumed, a fresh call that reuses JSON-RPC id 0.
    const sending = runtime.sendMessage({ sessionId: session.id, text: "again" }); await tick();
    second.respondTo("thread/resume", { thread: { id: "thread-1" } }); await tick();
    second.respondTo("turn/start", { turn: { id: "turn-2" } }); await sending;
    const fresh = deferred<DynamicToolCallResponse>(); host.next = () => fresh.promise;
    second.receive(call(0, { turnId: "turn-2", callId: "call-fresh" })); await tick();
    const freshSignal = host.executed[1].signal!;
    expect(freshSignal.aborted).toBe(false);
    // The pre-restart call settles only now; it must not clobber the newer entry.
    old.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(freshSignal.aborted).toBe(false);
    const stopping = runtime.stopTurn({ sessionId: session.id }); await tick();
    second.respondTo("turn/interrupt", {}); await stopping;
    expect(freshSignal.aborted).toBe(true);
    fresh.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(responseFor(second, 0)).toMatchObject({ result: { success: false } });
    expect(responseFor(first, 0)).toBeUndefined();
  });
  it("ignores a same-connection call that reuses a live JSON-RPC id, keeps the original cancellable and answers the id exactly once (review P2, revision 11 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && ("result" in entry || "error" in entry));
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(0)); await tick();
    const original = host.executed[0].signal!;
    // No restart: the same connection replays id 0 while the first call is still pending.
    f.transport.receive(call(0)); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(answers(0)).toEqual([]);
    expect(original.aborted).toBe(false);
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    expect(original.aborted).toBe(true);
    pending.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(answers(0)).toHaveLength(1);
    expect(answers(0)[0]).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_CANCELLED/) }] } });
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    // The same for a call that settles normally: the replay is never answered, the original is answered once.
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    const second = deferred<DynamicToolCallResponse>(); host.next = () => second.promise;
    f.transport.receive(call(1, { turnId: "turn-2", callId: "call-1" })); await tick();
    f.transport.receive(call(1, { turnId: "turn-2", callId: "call-1-replay" })); await tick(); await tick();
    expect(host.executed).toHaveLength(2);
    expect(answers(1)).toEqual([]);
    second.resolve(ok); await tick();
    expect(answers(1)).toEqual([{ jsonrpc: "2.0", id: 1, result: ok }]);
    // Once the id is free again a fresh call under it is admitted as usual.
    host.next = async () => ok;
    f.transport.receive(call(1, { turnId: "turn-2", callId: "call-1-fresh" })); await tick(); await tick();
    expect(host.executed).toHaveLength(3);
    expect(answers(1)).toHaveLength(2);
  });
  it("holds, then refuses, a call carrying the previous turn's id or a guessed id while a resumed thread's turn/start is still pending (review P1; held rather than refused at once since revision 13)", async () => {
    const host = new FakeHost(), store = new MemoryStore();
    const transports = [new FakeTransport(), new FakeTransport()];
    let launches = 0;
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transports[launches++]), version: "0.154.0" }), host);
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Reader", instructions: "Read only." });
    const session = await runtime.createSession({ agentId: agent.id });
    const [first, second] = transports;
    await startTurn(runtime, first, session.id, "thread-1", "turn-1");
    first.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
    const restarting = runtime.restartCodex(); await tick(); await restarting;
    // Resume the governed thread and leave turn/start unanswered: no turn id is known yet.
    const sending = runtime.sendMessage({ sessionId: session.id, text: "again" }); await tick();
    second.respondTo("thread/resume", { thread: { id: "thread-1" } }); await tick();
    expect(second.request("turn/start").params).toMatchObject({ threadId: "thread-1" });
    expect(runtime.snapshot().runtimes[session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    // Neither id can be told from the one the pending result is about to name:
    // both are held — never admitted — until that result settles the turn.
    second.receive(call(0, { turnId: "turn-1", callId: "call-replayed" })); await tick(); await tick();
    expect(responseFor(second, 0)).toBeUndefined();
    second.receive(call(1, { turnId: "turn-guess", callId: "call-guess" })); await tick(); await tick();
    expect(responseFor(second, 1)).toBeUndefined();
    expect(host.executed).toEqual([]);
    // The server names the new turn before answering turn/start: since revision 14 that notification
    // cannot be told from a stale one either, so it and the turn's own call are held with the others.
    second.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
    expect(runtime.snapshot().runtimes[session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    second.receive(call(2, { turnId: "turn-2", callId: "call-new" })); await tick(); await tick();
    expect(responseFor(second, 2)).toBeUndefined();
    expect(host.executed).toEqual([]);
    second.respondTo("turn/start", { turn: { id: "turn-2" } }); await sending; await tick();
    expect(runtime.snapshot().runtimes[session.id]).toMatchObject({ status: "running", activeTurnId: "turn-2" });
    // With turn-2 confirmed, its own call is admitted and the held ids are refused as stale; neither was ever executed.
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0].call).toMatchObject({ turnId: "turn-2", callId: "call-new" });
    expect(responseFor(second, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: ok });
    expect(responseFor(second, 0)).toMatchObject(stale);
    expect(responseFor(second, 1)).toMatchObject(stale);
    expect(host.executed).toHaveLength(1);
  });
  it("admits a fresh turn's calls once the turn/start result names the turn, and refuses the previous id held before that", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "next" }); await tick();
    f.transport.receive(call(3, { turnId: "turn-1" })); await tick(); await tick();
    // Held, not judged: the previous id cannot be told from the one about to be named until the result arrives.
    expect(responseFor(f.transport, 3)).toBeUndefined();
    expect(host.executed).toEqual([]);
    f.transport.respondTo("turn/start", { turn: { id: "turn-2" } }); await sending;
    expect(responseFor(f.transport, 3)).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } });
    expect(host.executed).toEqual([]);
    f.transport.receive(call(4, { turnId: "turn-2" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(responseFor(f.transport, 4)).toEqual({ jsonrpc: "2.0", id: 4, result: ok });
  });
  it("aborts the in-flight call the moment stopTurn is invoked, even when turn/interrupt never answers (review P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(40)); await tick();
    const signal = host.executed[0].signal!;
    expect(signal.aborted).toBe(false);
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(f.transport.request("turn/interrupt").params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    // The interrupt is still unanswered; local cancellation must not wait for it.
    expect(signal.aborted).toBe(true);
    pending.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(responseFor(f.transport, 40)).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_CANCELLED/) }] } });
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    await expect(f.runtime.stopTurn({ sessionId: f.session.id })).rejects.toThrow("already been requested");
  });
  it("keeps the local cancellation when turn/interrupt fails and still allows the stop to be retried (review P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(41)); await tick();
    const signal = host.executed[0].signal!;
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(signal.aborted).toBe(true);
    f.transport.receive({ jsonrpc: "2.0", id: f.transport.request("turn/interrupt").id, error: { code: -32000, message: "interrupt failed" } });
    await expect(stopping).rejects.toThrow("interrupt failed");
    expect(signal.aborted).toBe(true);
    // interruptingTurns bookkeeping was released by the failure: a retry sends a new interrupt.
    const retry = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(f.transport.sent.filter((entry) => entry.method === "turn/interrupt")).toHaveLength(2);
    f.transport.respondTo("turn/interrupt", {}); await retry;
    pending.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(responseFor(f.transport, 41)).toMatchObject({ result: { success: false } });
  });
  it("aborts a session's in-flight call the moment deletion begins, before thread/delete answers (review P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(50)); await tick();
    const signal = host.executed[0].signal!;
    const deleting = f.runtime.deleteSession({ sessionId: f.session.id }); await tick();
    expect(f.transport.request("thread/delete").params).toEqual({ threadId: "thread-1" });
    expect(signal.aborted).toBe(true);
    expect(f.runtime.snapshot().sessions).toHaveLength(1);
    pending.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(responseFor(f.transport, 50)).toMatchObject({ result: { success: false } });
    f.transport.respondTo("thread/delete", {}); await deleting;
    expect(host.released).toEqual([f.session.id]);
    expect(f.runtime.snapshot().sessions).toEqual([]);
  });
  it("refuses a governed call admitted after stopTurn begins until turn/completed retires the turn (review P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(f.transport.request("turn/interrupt").params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    const cancelled = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_CANCELLED/) }] } };
    // turn/interrupt is still unanswered: the turn is nominally active, yet nothing new is admitted for it.
    f.transport.receive(call(60)); await tick(); await tick();
    expect(host.executed).toEqual([]);
    expect(responseFor(f.transport, 60)).toMatchObject(cancelled);
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    // The interrupt answered but turn/completed has not arrived: still closed.
    f.transport.receive(call(61)); await tick(); await tick();
    expect(host.executed).toEqual([]);
    expect(responseFor(f.transport, 61)).toMatchObject(cancelled);
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    f.transport.receive(call(62)); await tick(); await tick();
    expect(responseFor(f.transport, 62)).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } });
    // The next turn admits again.
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    f.transport.receive(call(63, { turnId: "turn-2" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(responseFor(f.transport, 63)).toEqual({ jsonrpc: "2.0", id: 63, result: ok });
  });
  it("refuses a governed call admitted while deleteSession is in flight and reopens only when the deletion fails (review P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const cancelled = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_CANCELLED/) }] } };
    const deleting = f.runtime.deleteSession({ sessionId: f.session.id }); await tick();
    expect(f.transport.request("thread/delete").params).toEqual({ threadId: "thread-1" });
    f.transport.receive(call(70)); await tick(); await tick();
    expect(host.executed).toEqual([]);
    expect(responseFor(f.transport, 70)).toMatchObject(cancelled);
    // thread/delete fails: the session survives and admission reopens.
    f.transport.receive({ jsonrpc: "2.0", id: f.transport.request("thread/delete").id, error: { code: -32000, message: "delete failed" } });
    await expect(deleting).rejects.toThrow("delete failed");
    expect(f.runtime.snapshot().sessions).toHaveLength(1);
    f.transport.receive(call(71)); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(responseFor(f.transport, 71)).toEqual({ jsonrpc: "2.0", id: 71, result: ok });
    // A deletion that completes never admits in between and leaves the thread unmapped afterwards.
    const again = f.runtime.deleteSession({ sessionId: f.session.id }); await tick();
    f.transport.receive(call(72)); await tick(); await tick();
    expect(responseFor(f.transport, 72)).toMatchObject(cancelled);
    f.transport.respondTo("thread/delete", {}); await again;
    expect(host.executed).toHaveLength(1);
    expect(host.released).toEqual([f.session.id]);
    f.transport.receive(call(73));
    expect(responseFor(f.transport, 73)).toMatchObject({ error: { code: -32602 } });
  });
  it("never delivers a cancelled call's late answer under a JSON-RPC id a newer call has taken over (review P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && "result" in entry);
    const stale: DynamicToolCallResponse = { success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] };
    const old = deferred<DynamicToolCallResponse>(); host.next = () => old.promise;
    f.transport.receive(call(5)); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    expect(host.executed[0].signal?.aborted).toBe(true);
    // The same connection reuses id 5 for a fresh call while the cancelled one is still settling.
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    const fresh = deferred<DynamicToolCallResponse>(); host.next = () => fresh.promise;
    f.transport.receive(call(5, { turnId: "turn-2", callId: "call-fresh" })); await tick();
    expect(host.executed).toHaveLength(2);
    expect(host.executed[1].signal?.aborted).toBe(false);
    // The cancelled call settles first: nothing may reach the server under id 5.
    old.resolve(stale); await tick();
    expect(answers(5)).toEqual([]);
    fresh.resolve(ok); await tick();
    expect(answers(5)).toEqual([{ jsonrpc: "2.0", id: 5, result: ok }]);
    // The other order: the fresh call answers first and the cancelled call settles after it.
    const second = deferred<DynamicToolCallResponse>(); host.next = () => second.promise;
    f.transport.receive(call(6, { turnId: "turn-2", callId: "call-6" })); await tick();
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "interrupted", error: null } } });
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-3");
    const third = deferred<DynamicToolCallResponse>(); host.next = () => third.promise;
    f.transport.receive(call(6, { turnId: "turn-3", callId: "call-6-fresh" })); await tick();
    third.resolve(ok); await tick();
    second.resolve(stale); await tick();
    expect(answers(6)).toEqual([{ jsonrpc: "2.0", id: 6, result: ok }]);
    // A cancelled call whose id nobody reused is still answered, so the server's request is not left hanging.
    const lone = deferred<DynamicToolCallResponse>(); host.next = () => lone.promise;
    f.transport.receive(call(7, { turnId: "turn-3", callId: "call-7" })); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-3", status: "completed", error: null } } });
    lone.resolve(stale); await tick();
    expect(answers(7)).toEqual([{ jsonrpc: "2.0", id: 7, result: stale }]);
  });
  it("supersedes a cancelled predecessor even when the call reusing its id is refused rather than admitted (review revision 7 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && ("result" in entry || "error" in entry));
    const stale: DynamicToolCallResponse = { success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] };
    // Call A (id 5) is admitted, then stopTurn cancels it while turn/interrupt is
    // still unanswered, so the turn sits in interruptingTurns.
    const a = deferred<DynamicToolCallResponse>(); host.next = () => a.promise;
    f.transport.receive(call(5)); await tick();
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(host.executed[0].signal?.aborted).toBe(true);
    // Call B reuses id 5 and is refused at the stop-window check, never admitted.
    f.transport.receive(call(5, { callId: "call-5-again" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(answers(5)).toMatchObject([{ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_CANCELLED/) }] } }]);
    // A settles afterwards: id 5 already belongs to B's refusal, so A stays silent.
    a.resolve(stale); await tick();
    expect(answers(5)).toHaveLength(1);
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    // The same holds for every other refusal branch: a stale-turn refusal ...
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    const b = deferred<DynamicToolCallResponse>(); host.next = () => b.promise;
    f.transport.receive(call(6, { turnId: "turn-2" })); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "interrupted", error: null } } });
    expect(host.executed[1].signal?.aborted).toBe(true);
    f.transport.receive(call(6, { turnId: "turn-9", callId: "call-6-stale" })); await tick(); await tick();
    expect(answers(6)).toMatchObject([{ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } }]);
    b.resolve(stale); await tick();
    expect(answers(6)).toHaveLength(1);
    // ... and a protocol rejection for an unmapped thread.
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-3");
    const c = deferred<DynamicToolCallResponse>(); host.next = () => c.promise;
    f.transport.receive(call(7, { turnId: "turn-3" })); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-3", status: "interrupted", error: null } } });
    f.transport.receive(call(7, { threadId: "ghost", callId: "call-7-ghost" })); await tick(); await tick();
    expect(answers(7)).toMatchObject([{ error: { code: -32602 } }]);
    c.resolve(stale); await tick();
    expect(answers(7)).toHaveLength(1);
    expect(host.executed).toHaveLength(3);
  });
  it("abandons a governed call whose host never settles at the deadline so runtime bookkeeping stays bounded (review revision 7 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const live = () => f.runtime["toolCalls"].size, cancelled = () => f.runtime["cancelledToolCalls"].size;
    // A filesystem phase that never returns: the AbortSignal is never observed.
    host.next = () => new Promise<DynamicToolCallResponse>(() => undefined);
    const timedOut = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_TIMED_OUT/) }] } };
    // Only setTimeout/clearTimeout are faked, and only around the deadline-sensitive
    // sections; startTurn's tick() needs the real clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.transport.receive(call(80)); await vi.advanceTimersByTimeAsync(0);
      const signal = host.executed[0].signal!;
      expect(live()).toBe(1);
      await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_CALL_DEADLINE_MS - 1);
      expect(responseFor(f.transport, 80)).toBeUndefined();
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(responseFor(f.transport, 80)).toMatchObject(timedOut);
      expect(live()).toBe(0); expect(cancelled()).toBe(0);
      // A call cancelled by stopTurn whose host still never settles is bounded the same way.
      f.transport.receive(call(81)); await vi.advanceTimersByTimeAsync(0);
      const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await vi.advanceTimersByTimeAsync(0);
      expect(live()).toBe(0); expect(cancelled()).toBe(1);
      f.transport.respondTo("turn/interrupt", {}); await stopping;
      await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_CALL_DEADLINE_MS);
      expect(cancelled()).toBe(0);
      expect(responseFor(f.transport, 81)).toMatchObject(timedOut);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    // The fast path is unchanged: a host that settles answers with its own result,
    // the timer is cleared, and the deadline never produces a second answer.
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    host.next = async () => ok;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.transport.receive(call(82, { turnId: "turn-2" })); await vi.advanceTimersByTimeAsync(0);
      expect(responseFor(f.transport, 82)).toEqual({ jsonrpc: "2.0", id: 82, result: ok });
      expect(live()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_CALL_DEADLINE_MS);
      expect(f.transport.sent.filter((entry) => entry.id === 82 && "result" in entry)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it("retires a turn named by turn/started when the turn/start request itself fails, refusing its calls (review revision 10 P1; the notification and its calls held until the result since revision 14, so none is admitted to abort)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    // The server names the turn before answering turn/start; the notification and a call for it are held.
    f.transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    f.transport.receive(call(60)); await tick(); await tick();
    expect(host.executed).toEqual([]);
    expect(responseFor(f.transport, 60)).toBeUndefined();
    // The turn/start result then names no turn: the request fails, the held notification is discarded
    // against the failed state and the held call is refused rather than left hanging.
    f.transport.respondTo("turn/start", { turn: {} });
    await expect(sending).rejects.toThrow("Protocol field id must be a non-empty string");
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null });
    expect(responseFor(f.transport, 60)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    f.transport.receive(call(61, { callId: "call-61" })); await tick(); await tick();
    expect(responseFor(f.transport, 61)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    // The same holds when the turn/start request is answered with a JSON-RPC error.
    const again = f.runtime.sendMessage({ sessionId: f.session.id, text: "again" }); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    f.transport.receive({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, error: { code: -32000, message: "turn refused" } });
    await expect(again).rejects.toThrow("turn refused");
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null });
    f.transport.receive(call(62, { turnId: "turn-2", callId: "call-62" })); await tick(); await tick();
    expect(responseFor(f.transport, 62)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
  });
  it("releases the bound attempt when a provisional session's turn/start fails and the record is rolled back (review revision 10 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const starting = f.runtime.startSession({ agentId: f.agent.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    expect(host.declared).toHaveLength(1);
    const sessionId = host.declared[0].sessionId;
    expect(f.store.state.sessions.find((entry) => entry.id === sessionId)?.governance).toMatchObject({ attemptId: "attempt-1", threadId: "thread-1" });
    expect(host.released).toEqual([]);
    f.transport.receive({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, error: { code: -32000, message: "turn refused" } }); await tick();
    f.transport.respondTo("thread/delete", {});
    await expect(starting).rejects.toThrow("turn refused");
    expect(f.transport.request("thread/delete").params).toEqual({ threadId: "thread-1" });
    expect(host.released).toEqual([sessionId]);
    expect(f.store.state.sessions.some((entry) => entry.id === sessionId)).toBe(false);
    expect(f.runtime.snapshot().sessions.some((entry) => entry.id === sessionId)).toBe(false);
  });
  it("releases the bound attempt when thread/start answers without a thread id and leaves no marker (review revision 10 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: {} });
    await expect(sending).rejects.toThrow("Protocol field id must be a non-empty string");
    expect(host.released).toEqual([f.session.id]);
    expect(f.store.state.sessions[0].governance).toBeUndefined();
    expect(f.store.state.sessions[0].threadId).toBeNull();
    expect(f.runtime.snapshot().sessions[0]).toMatchObject({ threadId: null });
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null });
  });
  it("retires a turn whose turn/completed shares one delivery chunk with its own turn/start result instead of promoting it (review revision 11 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const burst = (turnId: string, status: string, error: unknown = null) => {
      const result = { jsonrpc: "2.0", id: f.transport.request("turn/start").id, result: { turn: { id: turnId } } };
      const completed = { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status, error } } };
      // One chunk, two lines, no turn/started in between: the connection dispatches
      // the notification synchronously while the result's continuation is still queued.
      f.transport.receiveRaw(`${JSON.stringify(result)}\n${JSON.stringify(completed)}\n`);
    };
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    burst("turn-1", "completed");
    await sending;
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "idle", activeTurnId: null, error: null });
    f.transport.receive(call(90)); await tick(); await tick();
    expect(responseFor(f.transport, 90)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    // An interrupted or failed completion delivered the same way is applied as such.
    const interrupted = f.runtime.sendMessage({ sessionId: f.session.id, text: "again" }); await tick();
    burst("turn-2", "interrupted");
    await interrupted;
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "idle", activeTurnId: null, error: "Turn interrupted." });
    expect(f.runtime.snapshot().runtimes[f.session.id].messages.some((entry) => entry.id === "turn-turn-2-interrupted")).toBe(true);
    const failed = f.runtime.sendMessage({ sessionId: f.session.id, text: "once more" }); await tick();
    burst("turn-3", "failed", { message: "model refused" });
    await failed;
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null, error: "model refused" });
    f.transport.receive(call(91, { turnId: "turn-3", callId: "call-91" })); await tick(); await tick();
    expect(responseFor(f.transport, 91)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    expect(f.runtime["startingTurns"].size).toBe(0);
    // A turn/started arriving late for a retired turn does not resurrect it.
    f.transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-3", status: "inProgress" } } });
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null });
    // The ordinary path is unchanged: the next turn is promoted and its calls admitted.
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-4");
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "running", activeTurnId: "turn-4" });
    f.transport.receive(call(92, { turnId: "turn-4", callId: "call-92" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(responseFor(f.transport, 92)).toEqual({ jsonrpc: "2.0", id: 92, result: ok });
  });
  it("does not let a turn/started delivered after a buffered turn/completed resurrect the finished turn, in one chunk ahead of the turn/start continuation (review revision 12 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const line = (payload: object) => `${JSON.stringify(payload)}\n`;
    // One chunk, four lines: result (continuation queued as a microtask),
    // turn/completed (buffered: activeTurnId is still null), turn/started
    // (would promote the finished turn), item/tool/call (would then be admitted).
    // All four are dispatched synchronously before the continuation runs.
    const burst = (turnId: string, status: string, callId: number, error: unknown = null) => f.transport.receiveRaw(
      line({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, result: { turn: { id: turnId } } })
      + line({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status, error } } })
      + line({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } } })
      + line(call(callId, { turnId, callId: `call-${String(callId)}` })));
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    burst("turn-1", "completed", 95);
    // Before the continuation has run: the completion is buffered, the turn/started and the call are
    // held (since revision 14 the notification is held too) — nothing promoted, nothing answered.
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    expect(responseFor(f.transport, 95)).toBeUndefined();
    expect(host.executed).toEqual([]);
    await sending; await tick(); await tick();
    // After it: the turn was retired, never promoted, nothing is stuck "running", the held
    // turn/started was discarded against the retired state, the call refused, the host never ran.
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "idle", activeTurnId: null, error: null });
    expect(responseFor(f.transport, 95)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    expect(f.runtime["startingTurns"].size).toBe(0);
    f.transport.receive(call(96, { callId: "call-96" })); await tick(); await tick();
    expect(responseFor(f.transport, 96)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    // A failed completion delivered the same way is applied as failed, once.
    const failed = f.runtime.sendMessage({ sessionId: f.session.id, text: "again" }); await tick();
    burst("turn-2", "failed", 97, { message: "model refused" });
    await failed; await tick();
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null, error: "model refused" });
    expect(responseFor(f.transport, 97)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    expect(f.runtime.snapshot().runtimes[f.session.id].messages.filter((entry) => entry.id.startsWith("turn-turn-2"))).toEqual([]);
    // A late duplicate turn/started for the retired turn is still refused.
    f.transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "failed", activeTurnId: null });
    // The ordinary path: turn/started ahead of the result is held, and the live turn it names is
    // promoted once the result confirms the same id.
    const live = f.runtime.sendMessage({ sessionId: f.session.id, text: "once more" }); await tick();
    f.transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-3", status: "inProgress" } } });
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "starting", activeTurnId: null });
    f.transport.respondTo("turn/start", { turn: { id: "turn-3" } }); await live;
    expect(f.runtime.snapshot().runtimes[f.session.id]).toMatchObject({ status: "running", activeTurnId: "turn-3" });
    f.transport.receive(call(98, { turnId: "turn-3", callId: "call-98" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(responseFor(f.transport, 98)).toEqual({ jsonrpc: "2.0", id: 98, result: ok });
  });
  it("admits a held item/tool/call that shares one delivery chunk with the turn/start result naming its turn and no turn/started, and applies the held item notifications (review revision 13 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const line = (payload: object) => `${JSON.stringify(payload)}\n`;
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && ("result" in entry || "error" in entry));
    const runtime = () => f.runtime.snapshot().runtimes[f.session.id];
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    expect(runtime()).toMatchObject({ status: "starting", activeTurnId: null });
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    // One chunk, five lines, no turn/started: the result queues the continuation
    // as a microtask; everything after it is dispatched synchronously while
    // activeTurnId is still null.
    f.transport.receiveRaw(
      line({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, result: { turn: { id: "turn-1" } } })
      + line({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "ls" } } })
      + line({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Reading" } })
      + line(call(100, { callId: "call-100" }))
      + line({ jsonrpc: "2.0", id: 101, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "input-101", isBlocking: true, questions: [{ id: "q", question: "Continue?" }] } }));
    // Before the continuation: held, neither refused nor admitted — no id is accepted on speculation.
    expect(answers(100)).toEqual([]); expect(answers(101)).toEqual([]);
    expect(host.executed).toEqual([]);
    expect(runtime()).toMatchObject({ status: "starting", activeTurnId: null, pendingRequests: [] });
    expect(runtime().messages.map((entry) => entry.role)).toEqual(["user"]);
    expect(f.runtime["startingTurns"].get(f.session.id)?.deferred).toHaveLength(4);
    // A replay of a held id while it is held is ignored: the held request owns it.
    f.transport.receive(call(100, { callId: "call-100-replay" }));
    expect(f.runtime["startingTurns"].get(f.session.id)?.deferred).toHaveLength(4);
    await sending; await tick();
    // After it: the turn is confirmed and every held envelope was judged as if it had just arrived, in order.
    expect(f.runtime["startingTurns"].size).toBe(0);
    expect(runtime()).toMatchObject({ status: "waiting", activeTurnId: "turn-1" });
    expect(runtime().pendingRequests.map((entry) => entry.requestId)).toEqual([101]);
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0].call).toMatchObject({ threadId: "thread-1", turnId: "turn-1", callId: "call-100" });
    expect(host.executed[0].signal?.aborted).toBe(false);
    expect(runtime().messages.find((entry) => entry.id === "cmd-1")).toMatchObject({
      role: "system", text: "Ran ls", streaming: true, turnId: "turn-1",
      activity: { kind: "command", label: "Ran ls", status: "running", arguments: "ls" },
    });
    expect(runtime().messages.find((entry) => entry.id === "msg-1")).toMatchObject({ role: "assistant", text: "Reading", streaming: true });
    expect(answers(100)).toEqual([]);
    pending.resolve(ok); await tick();
    expect(answers(100)).toEqual([{ jsonrpc: "2.0", id: 100, result: ok }]);
    await f.runtime.respondToRequest({ requestId: 101, kind: "userInput", answers: { q: { answers: ["yes"] } } });
    expect(answers(101)).toEqual([{ jsonrpc: "2.0", id: 101, result: { answers: { q: { answers: ["yes"] } } } }]);
    expect(runtime()).toMatchObject({ status: "running", activeTurnId: "turn-1" });
    // The turn is an ordinary live turn afterwards: the next call is admitted and stopTurn still aborts it.
    const second = deferred<DynamicToolCallResponse>(); host.next = () => second.promise;
    f.transport.receive(call(102, { callId: "call-102" })); await tick();
    expect(host.executed).toHaveLength(2);
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(host.executed[1].signal?.aborted).toBe(true);
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    second.resolve({ success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] }); await tick();
    expect(answers(102)).toHaveLength(1);
  });
  it("quarantines a fatal turn error ahead of a tool call in the turn/start result chunk, while preserving retrying errors (review revision 16 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const line = (payload: object) => `${JSON.stringify(payload)}\n`;
    const state = () => f.runtime.snapshot().runtimes[f.session.id];
    const error = (turnId: string, willRetry: boolean, message: string) => line({
      jsonrpc: "2.0", method: "error", params: { threadId: "thread-1", turnId, willRetry, error: { message } },
    });
    const result = (turnId: string) => line({
      jsonrpc: "2.0", id: f.transport.request("turn/start").id, result: { turn: { id: turnId } },
    });
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();

    // One chunk, no turn/completed: the result queues its continuation, then the fatal error and
    // governed call are synchronously dispatched while the turn is still unnamed locally. Arrival
    // order is security-significant: the replay must fail the turn before judging the call.
    f.transport.receiveRaw(result("turn-1")
      + error("turn-1", false, "fatal turn failure")
      + line(call(103, { turnId: "turn-1", callId: "call-103" })));
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null, error: null });
    expect(f.runtime["startingTurns"].get(f.session.id)?.deferred.map((entry) => entry.envelope.method))
      .toEqual(["error", "item/tool/call"]);
    expect(responseFor(f.transport, 103)).toBeUndefined();
    expect(host.executed).toEqual([]);

    await sending; await tick();
    expect(state()).toMatchObject({ status: "failed", activeTurnId: null, error: "fatal turn failure" });
    expect(responseFor(f.transport, 103)).toMatchObject({
      result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] },
    });
    expect(host.executed).toEqual([]);
    expect(f.runtime["startingTurns"].size).toBe(0);

    // A completion may arrive later, but the already-failed turn and refused call stay retired.
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "fatal turn failure" } },
    } });
    expect(state()).toMatchObject({ status: "failed", activeTurnId: null, error: "fatal turn failure" });
    expect(host.executed).toEqual([]);

    // Retrying errors keep the confirmed turn live, so the following call remains admissible.
    const retrying = f.runtime.sendMessage({ sessionId: f.session.id, text: "try again" }); await tick();
    f.transport.receiveRaw(result("turn-2")
      + error("turn-2", true, "retrying upstream")
      + line(call(104, { turnId: "turn-2", callId: "call-104" })));
    await retrying; await tick(); await tick();
    expect(state()).toMatchObject({ status: "running", activeTurnId: "turn-2", error: "retrying upstream" });
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0].call).toMatchObject({ turnId: "turn-2", callId: "call-104" });
    expect(responseFor(f.transport, 104)).toEqual({ jsonrpc: "2.0", id: 104, result: ok });
  });
  it("refuses a held item/tool/call as stale when the turn/start result names another turn, fails, or the turn completed in the same chunk (review revision 13 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const line = (payload: object) => `${JSON.stringify(payload)}\n`;
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && ("result" in entry || "error" in entry));
    const runtime = () => f.runtime.snapshot().runtimes[f.session.id];
    const result = (turn: object) => line({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, result: { turn } });
    const completed = (turnId: string) => line({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
    // (1) The result names turn-1 while the held call names another turn: refused once the turn is known, never before.
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    f.transport.receiveRaw(result({ id: "turn-1" }) + line(call(110, { turnId: "turn-guess", callId: "call-110" })));
    expect(answers(110)).toEqual([]);
    await sending; await tick();
    expect(runtime()).toMatchObject({ status: "running", activeTurnId: "turn-1" });
    expect(answers(110)).toMatchObject([stale]);
    expect(host.executed).toEqual([]);
    f.transport.receive(call(111, { callId: "call-111" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(answers(111)).toEqual([{ jsonrpc: "2.0", id: 111, result: ok }]);
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
    // (2) The result names no turn: the request fails and the held call is refused, not left hanging.
    const unnamed = f.runtime.sendMessage({ sessionId: f.session.id, text: "again" }); await tick();
    f.transport.receiveRaw(result({}) + line(call(112, { turnId: "turn-2", callId: "call-112" })));
    expect(answers(112)).toEqual([]);
    await expect(unnamed).rejects.toThrow("Protocol field id must be a non-empty string");
    expect(runtime()).toMatchObject({ status: "failed", activeTurnId: null });
    expect(answers(112)).toMatchObject([stale]);
    // (3) The request is answered with a JSON-RPC error: same outcome, and a held
    // renderer-facing request is rejected as stale exactly as it would have been.
    const refused = f.runtime.sendMessage({ sessionId: f.session.id, text: "once more" }); await tick();
    f.transport.receiveRaw(line({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, error: { code: -32000, message: "turn refused" } })
      + line(call(113, { turnId: "turn-3", callId: "call-113" }))
      + line({ jsonrpc: "2.0", id: 114, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-3", itemId: "input-114", isBlocking: true, questions: [] } }));
    expect(answers(113)).toEqual([]); expect(answers(114)).toEqual([]);
    await expect(refused).rejects.toThrow("turn refused");
    expect(answers(113)).toMatchObject([stale]);
    expect(answers(114)).toMatchObject([{ error: { code: -32602, message: "Server request belongs to a stale turn" } }]);
    expect(runtime()).toMatchObject({ status: "failed", activeTurnId: null, pendingRequests: [] });
    // (4) The turn completed in the same chunk (revisions 11/12): retired, never promoted, and the
    // held call is refused whether it precedes or follows the completion.
    const finished = f.runtime.sendMessage({ sessionId: f.session.id, text: "and again" }); await tick();
    f.transport.receiveRaw(result({ id: "turn-4" }) + line(call(115, { turnId: "turn-4", callId: "call-115" })) + completed("turn-4"));
    expect(answers(115)).toEqual([]);
    await finished; await tick();
    expect(runtime()).toMatchObject({ status: "idle", activeTurnId: null, error: null });
    expect(answers(115)).toMatchObject([stale]);
    const finishedAgain = f.runtime.sendMessage({ sessionId: f.session.id, text: "last" }); await tick();
    f.transport.receiveRaw(result({ id: "turn-5" }) + completed("turn-5") + line(call(116, { turnId: "turn-5", callId: "call-116" })));
    await finishedAgain; await tick();
    expect(runtime()).toMatchObject({ status: "idle", activeTurnId: null });
    expect(answers(116)).toMatchObject([stale]);
    expect(host.executed).toHaveLength(1);
    expect(f.runtime["startingTurns"].size).toBe(0);
  });
  it("never replays envelopes held on a connection that a restart has since replaced (review revision 13 P1)", async () => {
    const host = new FakeHost(), store = new MemoryStore();
    const transports = [new FakeTransport(), new FakeTransport()];
    let launches = 0;
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transports[launches++]), version: "0.154.0" }), host);
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Reader", instructions: "Read only." });
    const session = await runtime.createSession({ agentId: agent.id });
    const [first, second] = transports;
    const settled = (transport: FakeTransport, id?: number) => transport.sent.filter((entry) => (id === undefined || entry.id === id) && ("result" in entry || "error" in entry));
    const sending = runtime.sendMessage({ sessionId: session.id, text: "read the readme" }); await tick();
    first.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    // The call arrives while turn/start is unanswered and is held on the first connection.
    first.receive(call(120, { callId: "call-120" }));
    expect(runtime["startingTurns"].get(session.id)?.deferred).toHaveLength(1);
    const failing = expect(sending).rejects.toThrow("restarted");
    const restarting = runtime.restartCodex(); await tick();
    await failing; await restarting;
    expect(runtime["startingTurns"].size).toBe(0);
    expect(host.executed).toEqual([]);
    // Nothing was answered on the old connection and nothing was replayed onto the new one.
    expect(settled(first, 120)).toEqual([]);
    expect(settled(second)).toEqual([]);
    // The new connection starts clean: a fresh turn on it is promoted and its call admitted under the same id.
    const again = runtime.sendMessage({ sessionId: session.id, text: "again" }); await tick();
    second.respondTo("thread/resume", { thread: { id: "thread-1" } }); await tick();
    second.respondTo("turn/start", { turn: { id: "turn-2" } }); await again;
    second.receive(call(120, { turnId: "turn-2", callId: "call-120-fresh" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(settled(second, 120)).toEqual([{ jsonrpc: "2.0", id: 120, result: ok }]);
    expect(settled(first, 120)).toEqual([]);
  });
  it("ignores a server request of another method that reuses a live item/tool/call id, and the reverse, so each id is answered once by its owner (review revision 13 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && ("result" in entry || "error" in entry));
    const runtime = () => f.runtime.snapshot().runtimes[f.session.id];
    const userInput = (id: number, itemId: string, turnId = "turn-1") => ({ jsonrpc: "2.0", id, method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId, itemId, isBlocking: true, questions: [{ id: "q", question: "Continue?" }] } });
    // (a) A governed call owns id 5 and is still executing; a renderer-facing
    // request of another method arrives under the same id.
    const pending = deferred<DynamicToolCallResponse>(); host.next = () => pending.promise;
    f.transport.receive(call(5)); await tick();
    expect(host.executed).toHaveLength(1);
    f.transport.receive(userInput(5, "input-5")); await tick();
    expect(answers(5)).toEqual([]);
    expect(runtime()).toMatchObject({ status: "running", pendingRequests: [] });
    await expect(f.runtime.respondToRequest({ requestId: 5, kind: "userInput", answers: {} })).rejects.toThrow("no longer pending");
    pending.resolve(ok); await tick();
    expect(answers(5)).toEqual([{ jsonrpc: "2.0", id: 5, result: ok }]);
    // (b) The reverse: a renderer-facing request owns id 6; a governed call reuses it.
    f.transport.receive(userInput(6, "input-6")); await tick();
    expect(runtime()).toMatchObject({ status: "waiting" });
    expect(runtime().pendingRequests.map((entry) => entry.requestId)).toEqual([6]);
    host.next = async () => ok;
    f.transport.receive(call(6, { callId: "call-6" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(answers(6)).toEqual([]);
    expect(runtime().pendingRequests.map((entry) => entry.requestId)).toEqual([6]);
    await f.runtime.respondToRequest({ requestId: 6, kind: "userInput", answers: { q: { answers: ["yes"] } } });
    expect(answers(6)).toEqual([{ jsonrpc: "2.0", id: 6, result: { answers: { q: { answers: ["yes"] } } } }]);
    expect(runtime()).toMatchObject({ status: "running", pendingRequests: [] });
    // An unsupported method or an unmapped thread under a live id is ignored the
    // same way rather than rejected: the rejection would be a second answer.
    f.transport.receive(userInput(7, "input-7")); await tick();
    f.transport.receive({ jsonrpc: "2.0", id: 7, method: "item/unknown/request", params: { threadId: "thread-1" } });
    f.transport.receive(call(7, { threadId: "ghost", callId: "call-7-ghost" })); await tick();
    expect(answers(7)).toEqual([]);
    await f.runtime.respondToRequest({ requestId: 7, kind: "userInput", answers: {} });
    expect(answers(7)).toHaveLength(1);
    // Once an id is free again either kind of request is admitted under it.
    f.transport.receive(call(6, { callId: "call-6-fresh" })); await tick(); await tick();
    expect(host.executed).toHaveLength(2);
    expect(answers(6)).toHaveLength(2);
    f.transport.receive(userInput(5, "input-5-fresh")); await tick();
    expect(runtime().pendingRequests.map((entry) => entry.requestId)).toEqual([5]);
  });
  it("supersedes a cancelled item/tool/call when a request of another method reuses its id, and admits that request normally (review revision 13 P2)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    const answers = (id: number) => f.transport.sent.filter((entry) => entry.id === id && ("result" in entry || "error" in entry));
    const runtime = () => f.runtime.snapshot().runtimes[f.session.id];
    const stale: DynamicToolCallResponse = { success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_CANCELLED: cancelled" }] };
    const old = deferred<DynamicToolCallResponse>(); host.next = () => old.promise;
    f.transport.receive(call(8)); await tick();
    const stopping = f.runtime.stopTurn({ sessionId: f.session.id }); await tick();
    expect(host.executed[0].signal?.aborted).toBe(true);
    expect(f.runtime["cancelledToolCalls"].size).toBe(1);
    f.transport.respondTo("turn/interrupt", {}); await stopping;
    f.transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    await startTurn(f.runtime, f.transport, f.session.id, "thread-1", "turn-2");
    // The cancelled call is still settling when a renderer-facing request reuses id 8.
    f.transport.receive({ jsonrpc: "2.0", id: 8, method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-2", itemId: "input-8", isBlocking: true, questions: [{ id: "q", question: "Continue?" }] } }); await tick();
    expect(runtime()).toMatchObject({ status: "waiting" });
    expect(runtime().pendingRequests.map((entry) => entry.requestId)).toEqual([8]);
    expect(f.runtime["cancelledToolCalls"].size).toBe(0);
    // The predecessor settles: id 8 belongs to the pending request now, so it stays silent.
    old.resolve(stale); await tick();
    expect(answers(8)).toEqual([]);
    await f.runtime.respondToRequest({ requestId: 8, kind: "userInput", answers: { q: { answers: ["yes"] } } });
    expect(answers(8)).toEqual([{ jsonrpc: "2.0", id: 8, result: { answers: { q: { answers: ["yes"] } } } }]);
    expect(runtime()).toMatchObject({ status: "running", pendingRequests: [] });
  });
  it("holds a turn/started naming an already-completed turn while the next turn/start is in flight, promotes the turn the result names, and refuses the stale turn's call (review revision 14 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const runtime = () => f.runtime.snapshot().runtimes[f.session.id];
    const started = (turnId: string) => ({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } } });
    const completed = (turnId: string) => ({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
    // turn-1 runs and completes normally; its record in startingTurns is long gone.
    await startTurn(f.runtime, f.transport, f.session.id);
    f.transport.receive(completed("turn-1"));
    expect(runtime()).toMatchObject({ status: "idle", activeTurnId: null });
    // turn-2's turn/start is in flight: a null activeTurnId and "starting" are what that request left behind.
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "next" }); await tick();
    expect(f.transport.request("turn/start").params).toMatchObject({ threadId: "thread-1" });
    expect(runtime()).toMatchObject({ status: "starting", activeTurnId: null });
    // A late duplicate turn/started for the finished turn-1 arrives now, in its own chunk. It satisfies
    // the promotion guards by timing alone and must not be acted on: held, not promoted.
    f.transport.receive(started("turn-1"));
    expect(runtime()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(f.runtime["startingTurns"].get(f.session.id)?.deferred).toHaveLength(1);
    // A fresh call id under the stale turn: neither admitted nor refused yet, held behind the notification.
    f.transport.receive(call(130, { turnId: "turn-1", callId: "call-130" })); await tick(); await tick();
    expect(responseFor(f.transport, 130)).toBeUndefined();
    expect(host.executed).toEqual([]);
    expect(f.runtime["startingTurns"].get(f.session.id)?.deferred).toHaveLength(2);
    // The result names turn-2: the real turn is promoted (not silently dropped), the replayed turn/started
    // for turn-1 is discarded by the active-turn guard, the held call is refused stale and never reaches the host.
    f.transport.respondTo("turn/start", { turn: { id: "turn-2" } }); await sending; await tick();
    expect(runtime()).toMatchObject({ status: "running", activeTurnId: "turn-2", error: null });
    expect(f.runtime["startingTurns"].size).toBe(0);
    expect(responseFor(f.transport, 130)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    // turn-2's own calls are admitted normally; a further late turn/started for turn-1 is discarded outright.
    f.transport.receive(call(131, { turnId: "turn-2", callId: "call-131" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0].call).toMatchObject({ turnId: "turn-2", callId: "call-131" });
    expect(responseFor(f.transport, 131)).toEqual({ jsonrpc: "2.0", id: 131, result: ok });
    f.transport.receive(started("turn-1"));
    expect(runtime()).toMatchObject({ status: "running", activeTurnId: "turn-2" });
    f.transport.receive(completed("turn-2"));
    // The same stale notification while a turn/start that then fails is in flight: the catch path resets
    // the session before replaying, so the turn/started is discarded and the held call refused — the
    // finished turn-2 is not resurrected under the failed request.
    const failing = f.runtime.sendMessage({ sessionId: f.session.id, text: "again" }); await tick();
    f.transport.receive(started("turn-2"));
    f.transport.receive(call(132, { turnId: "turn-2", callId: "call-132" })); await tick(); await tick();
    expect(runtime()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(responseFor(f.transport, 132)).toBeUndefined();
    f.transport.receive({ jsonrpc: "2.0", id: f.transport.request("turn/start").id, error: { code: -32000, message: "turn refused" } });
    await expect(failing).rejects.toThrow("turn refused");
    expect(runtime()).toMatchObject({ status: "failed", activeTurnId: null });
    expect(responseFor(f.transport, 132)).toMatchObject(stale);
    expect(host.executed).toHaveLength(1);
    expect(f.runtime["startingTurns"].size).toBe(0);
  });
  it("holds a stale turn/started and its call that share one chunk with a resumed thread's thread/resume response, ahead of turn/start, and promotes the turn the result names (review revision 15 P1)", async () => {
    const host = new FakeHost(), store = new MemoryStore();
    const transports = [new FakeTransport(), new FakeTransport(), new FakeTransport()];
    let launches = 0;
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transports[launches++]), version: "0.154.0" }), host);
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Reader", instructions: "Read only." });
    const session = await runtime.createSession({ agentId: agent.id });
    const [first, second, third] = transports;
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const line = (payload: object) => `${JSON.stringify(payload)}\n`;
    const state = () => runtime.snapshot().runtimes[session.id];
    const held = () => runtime["startingTurns"].get(session.id)?.deferred;
    const started = (turnId: string) => ({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } } });
    const completed = (turnId: string) => ({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
    // turn-1 runs and completes on the first connection. A restart leaves the thread mapped to the
    // session (threadToSession survives) but not joined, so the next message goes through thread/resume.
    await startTurn(runtime, first, session.id, "thread-1", "turn-1");
    first.receive(completed("turn-1"));
    expect(state()).toMatchObject({ status: "idle", activeTurnId: null });
    const restarting = runtime.restartCodex(); await tick(); await restarting;
    // "starting" is set on sendMessage's first line; thread/resume is pending and turn/start not yet sent.
    const sending = runtime.sendMessage({ sessionId: session.id, text: "again" }); await tick();
    expect(second.request("thread/resume").params).toMatchObject({ threadId: "thread-1" });
    expect(() => second.request("turn/start")).toThrow("No turn/start request was sent");
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    // One chunk, three lines: the thread/resume response (its continuation queued as a microtask),
    // a late duplicate turn/started for the finished turn-1, and a fresh-callId call for turn-1.
    // Both envelopes are dispatched synchronously in the window before turn/start exists at all.
    second.receiveRaw(line({ jsonrpc: "2.0", id: second.request("thread/resume").id, result: { thread: { id: "thread-1" } } })
      + line(started("turn-1")) + line(call(140, { turnId: "turn-1", callId: "call-140" })));
    // Before the continuation: held — not promoted, not admitted, not refused.
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(held()).toHaveLength(2);
    expect(responseFor(second, 140)).toBeUndefined();
    expect(host.executed).toEqual([]);
    await tick(); await tick();
    // The continuation has sent turn/start for the real next turn; the same record still holds both.
    expect(second.request("turn/start").params).toMatchObject({ threadId: "thread-1" });
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(held()).toHaveLength(2);
    expect(responseFor(second, 140)).toBeUndefined();
    expect(host.executed).toEqual([]);
    // The result names turn-2: promoted (not desynchronised behind a wrongly promoted turn-1), the replayed
    // turn/started discarded by the active-turn guard, the held call refused stale, the host never ran.
    second.respondTo("turn/start", { turn: { id: "turn-2" } }); await sending; await tick();
    expect(state()).toMatchObject({ status: "running", activeTurnId: "turn-2", error: null });
    expect(runtime["startingTurns"].size).toBe(0);
    expect(responseFor(second, 140)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    second.receive(call(141, { turnId: "turn-2", callId: "call-141" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0].call).toMatchObject({ threadId: "thread-1", turnId: "turn-2", callId: "call-141" });
    expect(responseFor(second, 141)).toEqual({ jsonrpc: "2.0", id: 141, result: ok });
    second.receive(completed("turn-2"));
    // The same pair sharing a chunk with a thread/resume that fails: the catch path resets the session and
    // replays, so the notification is discarded and the call refused; nothing stays held, nothing resurrected.
    const again = runtime.restartCodex(); await tick(); await again;
    const failing = runtime.sendMessage({ sessionId: session.id, text: "once more" }); await tick();
    third.receiveRaw(line({ jsonrpc: "2.0", id: third.request("thread/resume").id, error: { code: -32000, message: "thread unavailable" } })
      + line(started("turn-2")) + line(call(142, { turnId: "turn-2", callId: "call-142" })));
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(held()).toHaveLength(2);
    expect(responseFor(third, 142)).toBeUndefined();
    await expect(failing).rejects.toThrow("thread unavailable");
    expect(state()).toMatchObject({ status: "failed", activeTurnId: null, error: "thread unavailable" });
    expect(runtime["startingTurns"].size).toBe(0);
    expect(responseFor(third, 142)).toMatchObject(stale);
    expect(host.executed).toHaveLength(1);
  });
  it("holds a turn/started and its call that share one chunk with a new manually titled thread's thread/name/set response, ahead of turn/start (review revision 15 P1)", async () => {
    const host = new FakeHost(), f = await fixture(host);
    const stale = { result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_STALE_TURN/) }] } };
    const line = (payload: object) => `${JSON.stringify(payload)}\n`;
    const state = () => f.runtime.snapshot().runtimes[f.session.id];
    const held = () => f.runtime["startingTurns"].get(f.session.id)?.deferred;
    // On the thread/start path the thread is mapped to the session only once it is persisted; the one
    // await left between that and turn/start is thread/name/set, sent for a manually titled session.
    await f.runtime.renameSession({ sessionId: f.session.id, title: "Readme" });
    expect(f.store.state.sessions[0].titleSource).toBe("manual");
    const sending = f.runtime.sendMessage({ sessionId: f.session.id, text: "read the readme" }); await tick();
    f.transport.respondTo("thread/start", { thread: { id: "thread-1" } }); await tick();
    expect(f.transport.request("thread/name/set").params).toEqual({ threadId: "thread-1", name: "Readme" });
    expect(() => f.transport.request("turn/start")).toThrow("No turn/start request was sent");
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    // One chunk: the thread/name/set response, a turn/started naming a turn this thread never started,
    // and a call for it — dispatched before the continuation sends turn/start.
    f.transport.receiveRaw(line({ jsonrpc: "2.0", id: f.transport.request("thread/name/set").id, result: {} })
      + line({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-ghost", status: "inProgress" } } })
      + line(call(150, { turnId: "turn-ghost", callId: "call-150" })));
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(held()).toHaveLength(2);
    expect(responseFor(f.transport, 150)).toBeUndefined();
    expect(host.executed).toEqual([]);
    await tick(); await tick();
    expect(f.transport.request("turn/start").params).toMatchObject({ threadId: "thread-1" });
    expect(state()).toMatchObject({ status: "starting", activeTurnId: null });
    expect(held()).toHaveLength(2);
    f.transport.respondTo("turn/start", { turn: { id: "turn-1" } }); await sending; await tick();
    expect(state()).toMatchObject({ status: "running", activeTurnId: "turn-1", error: null });
    expect(f.runtime["startingTurns"].size).toBe(0);
    expect(responseFor(f.transport, 150)).toMatchObject(stale);
    expect(host.executed).toEqual([]);
    f.transport.receive(call(151, { callId: "call-151" })); await tick(); await tick();
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0].call).toMatchObject({ turnId: "turn-1", callId: "call-151" });
    expect(responseFor(f.transport, 151)).toEqual({ jsonrpc: "2.0", id: 151, result: ok });
  });
  it("surfaces a throwing host as a redacted unavailable refusal", async () => {
    const host = new FakeHost(), f = await fixture(host);
    await startTurn(f.runtime, f.transport, f.session.id);
    host.next = () => Promise.reject(new Error("/Users/secret/path"));
    f.transport.receive(call(20)); await tick(); await tick();
    const response = responseFor(f.transport, 20);
    expect(response).toMatchObject({ result: { success: false, contentItems: [{ text: expect.stringMatching(/^TOOL_CALL_HOST_UNAVAILABLE/) }] } });
    expect(JSON.stringify(response)).not.toContain("/Users/secret");
  });
  it("normalizes a malformed persisted governance marker to null on load", async () => {
    const { JsonMetadataStore } = await import("./store");
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "orclocal-ep1b-store-"));
    try {
      const now = "2026-09-15T00:00:00.000Z";
      await writeFile(join(dir, "orchestrion-desktop.json"), JSON.stringify({ projects: [], agents: [], sessions: [
        { id: "s1", agentId: "a", title: "t", threadId: "th", createdAt: now, updatedAt: now, governance: { attemptId: "x", threadId: "th", tools: ["bash"], declaredAt: now } },
        { id: "s2", agentId: "a", title: "t", threadId: "th2", createdAt: now, updatedAt: now, governance: { attemptId: "y", threadId: "th2", tools: ["file.read"], declaredAt: now } },
      ] }));
      const loaded = await new JsonMetadataStore(join(dir, "orchestrion-desktop.json")).read();
      expect(loaded.sessions[0].governance).toBeNull();
      expect(loaded.sessions[1].governance).toEqual({ attemptId: "y", threadId: "th2", tools: ["file.read"], declaredAt: now });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
vi.setConfig({ testTimeout: 10_000 });
