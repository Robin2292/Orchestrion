import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord, ApprovalDecision, CreateAgentInput, CreateProjectInput, CreateSessionInput, ProjectRecord, SessionRecord } from "../shared/contracts";
import { JsonRpcConnection } from "./json-rpc";
import { DesktopRuntime } from "./runtime";
import type { RunningCodex } from "./codex-process";
import type { MetadataStore, StoredMetadata } from "./store";
import { FakeTransport, tick } from "./test-transport";

class MemoryStore implements MetadataStore {
  state: StoredMetadata = { projects: [], agents: [], sessions: [] };
  private id = 0;
  async read() { return structuredClone(this.state); }
  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const record = { ...input, id: `project-${++this.id}`, createdAt: new Date().toISOString() };
    this.state.projects.push(record); return structuredClone(record);
  }
  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const record = { ...input, id: `agent-${++this.id}`, createdAt: new Date().toISOString() };
    this.state.agents.push(record); return structuredClone(record);
  }
  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: `session-${++this.id}`,
      agentId: input.agentId,
      title: input.title ?? "Untitled session",
      threadId: null,
      model: input.model ?? null,
      modelProvider: input.modelProvider ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      titleSource: input.titleSource ?? "provisional",
      createdAt: now,
      updatedAt: now,
    };
    this.state.sessions.push(record); return structuredClone(record);
  }
  async updateSession(session: SessionRecord) {
    this.state.sessions[this.state.sessions.findIndex((entry) => entry.id === session.id)] = structuredClone(session);
  }
  async deleteSession(sessionId: string) {
    this.state.sessions = this.state.sessions.filter((entry) => entry.id !== sessionId);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function fixture() {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const connection = new JsonRpcConnection(transport);
  const runtime = new DesktopRuntime(store, async () => ({ connection, version: "0.154.0" }));
  await runtime.bootstrap();
  const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
  const agent = await runtime.createAgent({ projectId: project.id, name: "Builder", instructions: "Stay scoped." });
  const first = await runtime.createSession({ agentId: agent.id });
  const second = await runtime.createSession({ agentId: agent.id });
  return { runtime, store, transport, first, second };
}

async function startTurn(runtime: DesktopRuntime, transport: FakeTransport, sessionId: string, threadId: string, turnId: string) {
  const sending = runtime.sendMessage({ sessionId, text: `hello ${sessionId}` });
  await tick();
  const start = transport.request("thread/start");
  expect(start.params).toEqual({ cwd: "/workspace/repo", developerInstructions: "Stay scoped." });
  expect(start.params).not.toHaveProperty("approvalPolicy");
  transport.receive({ jsonrpc: "2.0", id: start.id, result: { thread: { id: threadId } } });
  await tick();
  const turn = transport.request("turn/start");
  expect(turn.params).toMatchObject({ threadId, input: [{ type: "text", text: `hello ${sessionId}`, text_elements: [] }] });
  expect(turn.params).toHaveProperty("serviceTier", null);
  transport.receive({ jsonrpc: "2.0", id: turn.id, result: { turn: { id: turnId } } });
  await sending;
}

describe("DesktopRuntime", () => {
  it("keeps native harness provenance outside governed Tool inventory", async () => {
    const { runtime, first, second } = await fixture();
  for (const session of [first, second]) expect(runtime.snapshot().runtimes[session.id].providerCoverage).toEqual({
    source: "codex_native", toolExecution: "outside_governed_tool_execution", admittedTools: [],
    accounting: "not_durable_provider_accounting", evidence: "f0-native-command-exec",
  });
  });
  it("resolves workspace listings through the session, agent, and project records", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-runtime-files-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "index.ts"), "export {};");
      const store = new MemoryStore();
      const transport = new FakeTransport();
      const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transport), version: "0.154.0" }));
      await runtime.bootstrap();
      const project = await runtime.createProject({ name: "Secure project", path: root });
      const agent = await runtime.createAgent({ projectId: project.id, name: "Builder", instructions: "" });
      const session = await runtime.createSession({ agentId: agent.id });

      await expect(runtime.listWorkspaceDirectory({ sessionId: session.id, relativePath: "src" })).resolves.toMatchObject({
        path: "src",
        entries: [{ name: "index.ts", path: join("src", "index.ts"), kind: "file" }],
      });
      const opened = await runtime.readWorkspaceFile({ sessionId: session.id, relativePath: "src/index.ts" });
      expect(opened).toMatchObject({ status: "ready", kind: "text", content: { type: "text", text: "export {};" } });
      if (opened.status !== "ready") throw new Error("fixture did not open");
      await expect(runtime.saveWorkspaceFile({
        sessionId: session.id,
        relativePath: "src/index.ts",
        content: "export const secure = true;",
        expectedRevision: opened.revision,
      })).resolves.toMatchObject({ path: join("src", "index.ts"), revision: expect.stringMatching(/^sha256:/) });
      await expect(runtime.listWorkspaceDirectory({ sessionId: "missing", relativePath: "" })).rejects.toThrow("Session not found");
      await expect(runtime.readWorkspaceFile({ sessionId: "missing", relativePath: "src/index.ts" })).rejects.toThrow("Session not found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a titled session only when its first message starts and sends typed attachments", async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transport), version: "0.154.0" }));
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Builder", instructions: "Stay scoped." });
    const image = { id: "image-1", path: "/tmp/reference.png", name: "reference.png", kind: "image" as const, mimeType: "image/png", size: 12, previewUrl: "data:image/png;base64,AA==" };
    const file = { id: "file-1", path: "/tmp/brief.pdf", name: "brief.pdf", kind: "file" as const, mimeType: null, size: 20, previewUrl: null };

    const starting = runtime.startSession({ agentId: agent.id, text: "Review this release plan in detail", attachments: [image, file] });
    expect(runtime.snapshot().sessions).toHaveLength(0);
    await tick();
    expect(runtime.snapshot().sessions[0]).toMatchObject({ title: "Review this release plan in detail", titleSource: "provisional" });
    transport.request("thread/start");
    transport.respondTo("thread/start", { thread: { id: "thread-draft" } });
    await tick();
    expect(transport.sent.some((entry) => entry.method === "thread/name/set")).toBe(false);
    const turn = transport.request("turn/start");
    expect(turn.params).toMatchObject({
      threadId: "thread-draft",
      input: [
        { type: "text", text: "Review this release plan in detail", text_elements: [] },
        { type: "localImage", path: "/tmp/reference.png" },
        { type: "mention", name: "brief.pdf", path: "/tmp/brief.pdf" },
      ],
    });
    transport.receive({ jsonrpc: "2.0", id: turn.id, result: { turn: { id: "turn-draft" } } });

    await expect(starting).resolves.toMatchObject({ id: runtime.snapshot().sessions[0].id, titleSource: "provisional" });
    expect(runtime.snapshot().runtimes[runtime.snapshot().sessions[0].id].messages[0]).toMatchObject({
      text: "Review this release plan in detail",
      attachments: [{ ...image, previewUrl: null }, file],
    });
  });

  it("rolls back a first-message session when Codex cannot start the turn", async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transport), version: "0.154.0" }));
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Builder", instructions: "" });

    const starting = runtime.startSession({ agentId: agent.id, text: "A failed first turn" });
    await tick();
    transport.respondTo("thread/start", { thread: { id: "orphan-thread" } });
    await tick();
    const turn = transport.request("turn/start");
    transport.receive({ jsonrpc: "2.0", id: turn.id, error: { code: -32000, message: "Could not start" } });
    await tick();
    const deletion = transport.request("thread/delete");
    expect(deletion.params).toEqual({ threadId: "orphan-thread" });
    transport.respondTo("thread/delete", {});

    await expect(starting).rejects.toThrow("Could not start");
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(store.state.sessions).toEqual([]);
  });

  it("rejects more than 32 unique attachments before creating a turn", async () => {
    const { runtime, transport, first } = await fixture();
    const attachments = Array.from({ length: 33 }, (_, index) => ({
      id: `file-${index}`,
      path: `/tmp/file-${index}.txt`,
      name: `file-${index}.txt`,
      kind: "file" as const,
      mimeType: "text/plain",
      size: 10,
      previewUrl: null,
    }));

    await expect(runtime.sendMessage({ sessionId: first.id, text: "Review these", attachments }))
      .rejects.toThrow("up to 32 attachments");
    expect(runtime.snapshot().runtimes[first.id].messages).toEqual([]);
    expect(transport.sent.some((entry) => entry.method === "thread/start" || entry.method === "turn/start")).toBe(false);
  });

  it("loads every visible Codex model page with supported reasoning efforts", async () => {
    const { runtime, transport } = await fixture();
    const loading = runtime.listModels();
    await tick();
    const firstPage = transport.request("model/list");
    expect(firstPage.params).toEqual({ cursor: null, limit: 100, includeHidden: false });
    transport.receive({ jsonrpc: "2.0", id: firstPage.id, result: {
      data: [{
        id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Reliable agentic model",
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Deep" }],
        serviceTiers: [{ id: "priority", name: "Priority", description: "Lower latency" }],
        defaultServiceTier: null,
        defaultReasoningEffort: "low", isDefault: false,
      }],
      nextCursor: "page-2",
    } });
    await tick();
    const secondPage = transport.request("model/list");
    expect(secondPage.params).toEqual({ cursor: "page-2", limit: 100, includeHidden: false });
    transport.receive({ jsonrpc: "2.0", id: secondPage.id, result: {
      data: [{
        id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: "Most capable",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        additionalSpeedTiers: ["fast"],
        defaultServiceTier: "fast",
        defaultReasoningEffort: "medium", isDefault: true,
      }],
      nextCursor: null,
    } });

    await expect(loading).resolves.toEqual([
      {
        id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Reliable agentic model",
        providerId: null, providerDisplayName: null,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Deep" }],
        serviceTiers: [{ id: "priority", name: "Priority", description: "Lower latency" }],
        defaultServiceTier: null,
        defaultReasoningEffort: "low", isDefault: false,
      },
      {
        id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: "Most capable",
        providerId: null, providerDisplayName: null,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        serviceTiers: [{ id: "fast", name: "fast", description: "" }],
        defaultServiceTier: "fast",
        defaultReasoningEffort: "medium", isDefault: true,
      },
    ]);
  });

  it("persists model choices, applies them to new threads and turns, and follows Codex title/settings updates", async () => {
    const { runtime, store, transport, first } = await fixture();
    await expect(runtime.updateSessionSettings({
      sessionId: first.id,
      model: "gpt-6-astra",
      modelProvider: "openai",
      reasoningEffort: "high",
      serviceTier: "priority",
    })).resolves.toMatchObject({
      title: "Untitled session",
      model: "gpt-6-astra",
      modelProvider: "openai",
      reasoningEffort: "high",
      serviceTier: "priority",
    });

    const sending = runtime.sendMessage({ sessionId: first.id, text: "Name this work" });
    await tick();
    const start = transport.request("thread/start");
    expect(start.params).toEqual({
      model: "gpt-6-astra",
      modelProvider: "openai",
      serviceTier: "priority",
      cwd: "/workspace/repo",
      developerInstructions: "Stay scoped.",
    });
    transport.receive({ jsonrpc: "2.0", id: start.id, result: {
      thread: { id: "thread-settings", model: "gpt-6-astra", modelProvider: "openai", reasoningEffort: null },
      model: "gpt-6-astra",
      modelProvider: "openai",
    } });
    await tick();
    const turn = transport.request("turn/start");
    expect(turn.params).toMatchObject({
      threadId: "thread-settings",
      model: "gpt-6-astra",
      effort: "high",
      serviceTier: "priority",
    });
    transport.receive({ jsonrpc: "2.0", id: turn.id, result: { turn: { id: "turn-settings" } } });
    await sending;

    transport.receive({
      jsonrpc: "2.0", method: "thread/name/updated",
      params: { threadId: "thread-settings", threadName: "Name this work" },
    });
    transport.receive({
      jsonrpc: "2.0", method: "thread/settings/updated",
      params: { threadId: "thread-settings", threadSettings: { model: "gpt-5.6-sol", modelProvider: "openai", effort: "medium", serviceTier: null } },
    });
    await tick();
    expect(runtime.snapshot().sessions.find((session) => session.id === first.id)).toMatchObject({
      title: "Name this work",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "medium",
      serviceTier: null,
    });
    expect(store.state.sessions.find((session) => session.id === first.id)).toMatchObject({
      title: "Name this work",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
  });

  it("renames sessions remotely but persists model settings locally for the next turn", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    transport.receive({
      jsonrpc: "2.0", method: "thread/settings/updated",
      params: { threadId: "thread-1", threadSettings: { model: "gpt-6-astra", modelProvider: "openai", effort: "high" } },
    });
    await tick();

    const renaming = runtime.renameSession({ sessionId: first.id, title: "Release readiness" });
    await tick();
    expect(transport.request("thread/name/set").params).toEqual({ threadId: "thread-1", name: "Release readiness" });
    transport.respondTo("thread/name/set", {});
    await expect(renaming).resolves.toMatchObject({ title: "Release readiness" });

    const updating = runtime.updateSessionSettings({
      sessionId: first.id,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: "priority",
    });
    await expect(updating).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "xhigh",
      serviceTier: "priority",
    });
    expect(transport.sent.some((entry) => entry.method === "thread/settings/update")).toBe(false);
  });

  it("deletes a thread-backed session and publishes metadata, maps, and runtime removal", async () => {
    const { runtime, store, transport, first, second } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-delete", "turn-delete");
    const snapshots: Array<ReturnType<DesktopRuntime["snapshot"]>> = [];
    runtime.on("desktopEvent", (event: { type: string; snapshot?: ReturnType<DesktopRuntime["snapshot"]> }) => {
      if (event.type === "snapshot" && event.snapshot) snapshots.push(event.snapshot);
    });

    const closedSessions: string[] = [];
    const deleting = runtime.deleteSession({ sessionId: first.id }, (sessionId) => { closedSessions.push(sessionId); });
    await tick();
    expect(transport.request("thread/delete").params).toEqual({ threadId: "thread-delete" });
    transport.respondTo("thread/delete", {});
    await deleting;

    expect(closedSessions).toEqual([first.id]);
    expect(runtime.snapshot().sessions.map((session) => session.id)).toEqual([second.id]);
    expect(runtime.snapshot().runtimes).not.toHaveProperty(first.id);
    expect(store.state.sessions.map((session) => session.id)).toEqual([second.id]);
    expect(snapshots.at(-1)?.sessions.map((session) => session.id)).toEqual([second.id]);
    transport.receive({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-delete", turnId: "turn-delete", itemId: "stale", delta: "must not return" } });
    expect(runtime.snapshot().runtimes).not.toHaveProperty(first.id);
  });

  it("deletes a local-only session without touching Codex and rejects unknown ids", async () => {
    const { runtime, store, transport, first, second } = await fixture();
    await runtime.deleteSession({ sessionId: first.id });

    expect(runtime.snapshot().sessions.map((session) => session.id)).toEqual([second.id]);
    expect(store.state.sessions.map((session) => session.id)).toEqual([second.id]);
    expect(transport.sent.some((entry) => entry.method === "thread/delete")).toBe(false);
    await expect(runtime.deleteSession({ sessionId: first.id })).rejects.toThrow("Session not found");
    await expect(runtime.deleteSession({ sessionId: "   " })).rejects.toThrow("Session id is required");
  });

  it("preserves local session state when remote thread deletion fails", async () => {
    const { runtime, store, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-preserved", "turn-preserved");

    const closedSessions: string[] = [];
    const deleting = runtime.deleteSession({ sessionId: first.id }, (sessionId) => { closedSessions.push(sessionId); });
    await tick();
    const request = transport.request("thread/delete");
    transport.receive({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Remote deletion failed" } });

    await expect(deleting).rejects.toThrow("Remote deletion failed");
    expect(closedSessions).toEqual([first.id]);
    expect(runtime.snapshot().sessions.find((session) => session.id === first.id)).toMatchObject({ threadId: "thread-preserved" });
    expect(runtime.snapshot().runtimes).toHaveProperty(first.id);
    expect(store.state.sessions.find((session) => session.id === first.id)).toMatchObject({ threadId: "thread-preserved" });
  });

  it("serializes deletion behind session mutations and rejects a queued duplicate safely", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-serialized", "turn-serialized");

    const renaming = runtime.renameSession({ sessionId: first.id, title: "Before delete" });
    await tick();
    const deleting = runtime.deleteSession({ sessionId: first.id });
    const duplicate = runtime.deleteSession({ sessionId: first.id });
    await tick();
    expect(transport.sent.filter((entry) => entry.method === "thread/delete")).toHaveLength(0);
    transport.respondTo("thread/name/set", {});
    await renaming;
    await tick();
    transport.respondTo("thread/delete", {});
    await deleting;

    await expect(duplicate).rejects.toThrow("Session not found");
    expect(runtime.snapshot().sessions.some((session) => session.id === first.id)).toBe(false);
  });

  it("queues deletion behind the shared terminal-create operation seam", async () => {
    const { runtime, first } = await fixture();
    const gate = deferred<void>();
    const creating = runtime.runSessionOperation(first.id, () => gate.promise);
    const deleting = runtime.deleteSession({ sessionId: first.id });
    await tick();
    expect(runtime.snapshot().sessions.some((session) => session.id === first.id)).toBe(true);

    gate.resolve();
    await creating;
    await deleting;
    await expect(runtime.runSessionOperation(first.id, async () => undefined)).rejects.toThrow("Session not found");
  });

  it("carries a local preflight rename into the thread before its first turn", async () => {
    const { runtime, transport, first } = await fixture();
    await expect(runtime.renameSession({ sessionId: first.id, title: "Planned release" })).resolves.toMatchObject({
      title: "Planned release",
      threadId: null,
    });
    expect(transport.sent.some((entry) => entry.method === "thread/name/set")).toBe(false);

    const sending = runtime.sendMessage({ sessionId: first.id, text: "Start" });
    await tick();
    transport.respondTo("thread/start", { thread: { id: "thread-renamed" } });
    await tick();
    expect(transport.request("thread/name/set").params).toEqual({ threadId: "thread-renamed", name: "Planned release" });
    transport.respondTo("thread/name/set", {});
    await tick();
    const turn = transport.request("turn/start");
    transport.receive({ jsonrpc: "2.0", id: turn.id, result: { turn: { id: "turn-renamed" } } });
    await sending;
  });

  it("maps threads to sessions and merges interleaved background deltas without cross-talk", async () => {
    const { runtime, transport, first, second } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    await startTurn(runtime, transport, second.id, "thread-2", "turn-2");

    transport.receive({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-2", turnId: "turn-2", itemId: "item-2", delta: "second" } });
    transport.receive({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "first " } });
    transport.receive({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "answer" } });
    transport.receive({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "first answer", phase: "final_answer" } } });
    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });

    const snapshot = runtime.snapshot();
    expect(snapshot.runtimes[first.id].messages.find((item) => item.id === "item-1")).toMatchObject({ text: "first answer", phase: "final_answer", streaming: false });
    expect(snapshot.runtimes[first.id].messages.some((item) => item.text === "second")).toBe(false);
    expect(snapshot.runtimes[second.id].messages.find((item) => item.id === "item-2")?.text).toBe("second");
    expect(snapshot.runtimes[first.id].status).toBe("idle");
    expect(snapshot.runtimes[second.id].status).toBe("running");
  });

  it("reconciles a completed final answer when turn/completed is lost", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");

    vi.useFakeTimers();
    try {
      transport.receive({ jsonrpc: "2.0", method: "item/completed", params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "agentMessage", id: "answer-1", text: "finished", phase: "final_answer" },
      } });
      expect(runtime.snapshot().runtimes[first.id]).toMatchObject({ status: "running", activeTurnId: "turn-1" });

      await vi.advanceTimersByTimeAsync(250);
      const read = transport.request("thread/read");
      expect(read.params).toEqual({ threadId: "thread-1", includeTurns: true });
      transport.receive({ jsonrpc: "2.0", id: read.id, result: { thread: { id: "thread-1", turns: [
        { id: "turn-1", status: "completed", error: null, items: [] },
      ] } } });
      await Promise.resolve();
      await Promise.resolve();

      expect(runtime.snapshot().runtimes[first.id]).toMatchObject({ status: "idle", activeTurnId: null, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels final-answer reconciliation when turn/completed arrives normally", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");

    vi.useFakeTimers();
    try {
      transport.receive({ jsonrpc: "2.0", method: "item/completed", params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { type: "agentMessage", id: "answer-1", text: "finished", phase: "final_answer" },
      } });
      transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: {
        threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null },
      } });
      await vi.advanceTimersByTimeAsync(3_000);

      expect(runtime.snapshot().runtimes[first.id]).toMatchObject({ status: "idle", activeTurnId: null });
      expect(transport.sent.some((entry) => entry.method === "thread/read")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects public reasoning, tool details, sub-agents, and compaction without private reasoning", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-activity", "turn-activity");

    transport.receive({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-activity", turnId: "turn-activity", item: { type: "reasoning", id: "reasoning-1", summary: [], content: ["private thought"] } } });
    transport.receive({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-activity", turnId: "turn-activity", itemId: "reasoning-1", delta: "Checked the public contract." } });
    transport.receive({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-activity", turnId: "turn-activity", item: { type: "reasoning", id: "reasoning-1", summary: ["Checked the public contract."], content: ["private thought"], status: "completed" } } });
    transport.receive({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-activity", turnId: "turn-activity", item: { type: "mcpToolCall", id: "tool-1", server: "repo", tool: "search", arguments: { query: "activity" }, result: { count: 2 }, status: "completed" } } });
    transport.receive({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-activity", turnId: "turn-activity", item: { type: "collabToolCall", id: "subagent-1", tool: "spawn_agent", newThreadId: "child-1", prompt: "Inspect the renderer" } } });
    transport.receive({ jsonrpc: "2.0", method: "thread/compact/start", params: { threadId: "thread-activity", turnId: "turn-activity" } });

    const messages = runtime.snapshot().runtimes[first.id].messages;
    expect(messages.find((entry) => entry.id === "reasoning-1")).toMatchObject({
      turnId: "turn-activity",
      activity: { kind: "reasoning", result: "Checked the public contract.", status: "completed" },
    });
    expect(JSON.stringify(messages)).not.toContain("private thought");
    expect(messages.find((entry) => entry.id === "tool-1")?.activity).toMatchObject({ kind: "tool", arguments: '{\n  "query": "activity"\n}', result: '{\n  "count": 2\n}' });
    expect(messages.find((entry) => entry.id === "subagent-1")?.activity).toMatchObject({ kind: "subagent", label: "Started a sub-agent" });
    expect(messages.find((entry) => entry.id === "context-compaction:turn-activity")?.activity).toMatchObject({ kind: "compaction", status: "running" });

    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-activity", turn: { id: "turn-activity", status: "completed", error: null } } });
    expect(runtime.snapshot().runtimes[first.id].messages.find((entry) => entry.id === "context-compaction:turn-activity")?.activity?.status).toBe("completed");
  });

  it("projects app-server context telemetry per session from last usage, not cumulative totals", async () => {
    const { runtime, transport, first, second } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    await startTurn(runtime, transport, second.id, "thread-2", "turn-2");

    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "turn-1",
        tokenUsage: {
          total: { totalTokens: 8_900_000, inputTokens: 8_000_000, cachedInputTokens: 7_000_000, cacheWriteInputTokens: 0, outputTokens: 900_000, reasoningOutputTokens: 100_000 },
          last: { totalTokens: 140_000, inputTokens: 138_000, cachedInputTokens: 120_000, cacheWriteInputTokens: 0, outputTokens: 2_000, reasoningOutputTokens: 800 },
          modelContextWindow: 1_000_000,
        },
      },
    });
    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-2", turnId: "turn-2",
        tokenUsage: {
          total: { totalTokens: 55 },
          last: { totalTokens: 55 },
          modelContextWindow: null,
        },
      },
    });

    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage)
      .toEqual({ turnId: "turn-1", usedTokens: 140_000, contextWindowTokens: 1_000_000 });
    expect(runtime.snapshot().runtimes[second.id].contextWindowUsage)
      .toEqual({ turnId: "turn-2", usedTokens: 55, contextWindowTokens: null });

    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "stale-turn",
        tokenUsage: { total: { totalTokens: 9_000_000 }, last: { totalTokens: 999_999 }, modelContextWindow: 1_000_000 },
      },
    });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage?.usedTokens).toBe(140_000);
  });

  it("restores known model windows while waiting for telemetry from an unseen model", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    transport.receive({
      jsonrpc: "2.0", method: "thread/settings/updated",
      params: { threadId: "thread-1", threadSettings: { model: "gpt-6-astra", modelProvider: "openai", effort: "high" } },
    });
    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "turn-1",
        tokenUsage: { total: { totalTokens: 140_000 }, last: { totalTokens: 140_000 }, modelContextWindow: 1_000_000 },
      },
    });
    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });

    await runtime.updateSessionSettings({ sessionId: first.id, model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(transport.sent.some((entry) => entry.method === "thread/settings/update")).toBe(false);
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage).toBeNull();

    await runtime.updateSessionSettings({ sessionId: first.id, model: "gpt-6-astra", reasoningEffort: "high" });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage)
      .toEqual({ turnId: "turn-1", usedTokens: 140_000, contextWindowTokens: 1_000_000 });
    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "turn-1",
        tokenUsage: { total: { totalTokens: 999_000 }, last: { totalTokens: 999_000 }, modelContextWindow: 258_400 },
      },
    });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage)
      .toEqual({ turnId: "turn-1", usedTokens: 140_000, contextWindowTokens: 1_000_000 });

    await runtime.updateSessionSettings({ sessionId: first.id, model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage).toBeNull();

    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "turn-1",
        tokenUsage: { total: { totalTokens: 141_000 }, last: { totalTokens: 141_000 }, modelContextWindow: 1_000_000 },
      },
    });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage).toBeNull();

    const sending = runtime.sendMessage({ sessionId: first.id, text: "continue" });
    await tick();
    const turn = transport.request("turn/start");
    transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
    transport.receive({ jsonrpc: "2.0", id: turn.id, result: { turn: { id: "turn-2" } } });
    await sending;
    transport.receive({
      jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: {
        threadId: "thread-1", turnId: "turn-2",
        tokenUsage: { total: { totalTokens: 282_000 }, last: { totalTokens: 72_000 }, modelContextWindow: 258_400 },
      },
    });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage)
      .toEqual({ turnId: "turn-2", usedTokens: 72_000, contextWindowTokens: 258_400 });

    await runtime.updateSessionSettings({ sessionId: first.id, model: "gpt-6-astra", reasoningEffort: "high" });
    expect(runtime.snapshot().runtimes[first.id].contextWindowUsage)
      .toEqual({ turnId: "turn-2", usedTokens: 72_000, contextWindowTokens: 1_000_000 });
  });

  it("keeps an interrupted turn authoritative until completion and prevents duplicate stops", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    transport.receive({
      jsonrpc: "2.0", id: 1, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "touch x", cwd: "/workspace/repo", reason: "write" },
    });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests).toHaveLength(1);
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0].availableDecisions).toBeUndefined();
    const stopping = runtime.stopTurn({ sessionId: first.id });
    await tick();
    expect(transport.request("turn/interrupt").params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    transport.respondTo("turn/interrupt", {});
    await stopping;
    expect(runtime.snapshot().runtimes[first.id]).toMatchObject({ status: "waiting", activeTurnId: "turn-1" });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests).toHaveLength(1);
    await expect(runtime.stopTurn({ sessionId: first.id })).rejects.toThrow("already been requested");
    await expect(runtime.sendMessage({ sessionId: first.id, text: "too soon" })).rejects.toThrow("already has a running turn");
    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
    expect(runtime.snapshot().runtimes[first.id]).toMatchObject({ status: "idle", activeTurnId: null, pendingRequests: [], error: "Turn interrupted." });
    expect(runtime.snapshot().runtimes[first.id].messages.at(-1)?.text).toBe("Turn interrupted.");
  });

  it("preserves approval decisions in server order and rejects choices not offered", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    const policyDecision: ApprovalDecision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pnpm", "test"] } };
    transport.receive({
      jsonrpc: "2.0", id: 31, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "pnpm test", availableDecisions: ["cancel", policyDecision, "accept"] },
    });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.availableDecisions).toEqual(["cancel", policyDecision, "accept"]);
    await expect(runtime.respondToRequest({ requestId: 31, kind: "approval", decision: "decline" })).rejects.toThrow("not offered");
    expect(runtime.snapshot().runtimes[first.id].pendingRequests).toHaveLength(1);
    await runtime.respondToRequest({ requestId: 31, kind: "approval", decision: policyDecision });
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 31, result: { decision: policyDecision } });

    transport.receive({
      jsonrpc: "2.0", id: 32, method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", availableDecisions: [] },
    });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.availableDecisions).toEqual([]);
    await expect(runtime.respondToRequest({ requestId: 32, kind: "approval", decision: "accept" })).rejects.toThrow("not offered");

    transport.receive({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 32 } });
    transport.receive({
      jsonrpc: "2.0", id: 33, method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "legacy-file" },
    });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.availableDecisions).toBeUndefined();
    await runtime.respondToRequest({ requestId: 33, kind: "approval", decision: "decline" });
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 33, result: { decision: "decline" } });
  });

  it("ignores stale turn events and rejects stale server requests", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });

    const sending = runtime.sendMessage({ sessionId: first.id, text: "new turn" });
    await tick();
    const request = transport.request("turn/start");
    transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } } });
    transport.receive({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-2" } } });
    await sending;

    transport.receive({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "stale-delta", delta: "wrong" } });
    transport.receive({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "stale-item", command: "false", status: "failed", exitCode: 1 } } });
    transport.receive({ jsonrpc: "2.0", id: 55, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "stale-request" } });
    expect(transport.sent.at(-1)).toMatchObject({ id: 55, error: { code: -32602, message: "Server request belongs to a stale turn" } });
    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });

    const snapshot = runtime.snapshot().runtimes[first.id];
    expect(snapshot).toMatchObject({ status: "running", activeTurnId: "turn-2", pendingRequests: [] });
    expect(snapshot.messages.some((entry) => entry.id === "stale-delta" || entry.id === "stale-item")).toBe(false);

    transport.receive({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-2", item: { type: "commandExecution", id: "failed-command", command: "false", status: "failed", exitCode: 7 } } });
    expect(runtime.snapshot().runtimes[first.id].messages.find((entry) => entry.id === "failed-command")).toMatchObject({
      text: "Ran false · failed",
      activity: { kind: "command", status: "failed", summary: "Exited with code 7" },
    });

    transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", error: null } } });
    transport.receive({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-2", itemId: "late-delta", delta: "late" } });
    transport.receive({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-2", item: { type: "fileChange", id: "late-item", status: "completed" } } });
    transport.receive({ jsonrpc: "2.0", id: 56, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-2", itemId: "late-request" } });
    expect(transport.sent.at(-1)).toMatchObject({ id: 56, error: { code: -32602 } });
    expect(runtime.snapshot().runtimes[first.id].messages.some((entry) => entry.id === "late-delta" || entry.id === "late-item")).toBe(false);

    transport.receive({ jsonrpc: "2.0", id: 57, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: null, serverName: "standalone", mode: "form", message: "Standalone", requestedSchema: {} } });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.requestId).toBe(57);
    await runtime.respondToRequest({ requestId: 57, kind: "elicitation", action: "decline", content: null });
  });

  it("routes request responses, honors server resolution, and rejects late answers", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    transport.receive({
      jsonrpc: "2.0", id: 99, method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "tool-1", isBlocking: true, questions: [{ id: "q", header: "Choice", question: "Continue?", isOther: true, isSecret: false, options: [{ label: "Yes", description: "Continue" }] }] },
    });
    transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    expect(runtime.snapshot().runtimes[first.id].status).toBe("waiting");
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.questions?.[0]?.isOther).toBe(true);
    await runtime.respondToRequest({ requestId: 99, kind: "userInput", answers: { q: { answers: ["Something else"] } } });
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 99, result: { answers: { q: { answers: ["Something else"] } } } });
    await expect(runtime.respondToRequest({ requestId: 99, kind: "userInput", answers: {} })).rejects.toThrow("no longer pending");

    transport.receive({ jsonrpc: "2.0", id: "elicitation", method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "demo", mode: "form", message: "Provide value", requestedSchema: {} } });
    transport.receive({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "elicitation" } });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests).toHaveLength(0);
    await expect(runtime.respondToRequest({ requestId: "elicitation", kind: "elicitation", action: "decline", content: null })).rejects.toThrow("no longer pending");
  });

  it("preserves and validates MCP form and URL elicitation modes", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    const requestedSchema = {
      type: "object",
      properties: {
        target: { type: "string", enum: ["staging", "production"] },
        retries: { type: "integer", minimum: 0 },
        notify: { type: "boolean" },
      },
      required: ["target", "retries"],
    };
    transport.receive({ jsonrpc: "2.0", id: "form", method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "deploy", mode: "form", message: "Deploy", requestedSchema } });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.elicitation).toEqual({ mode: "form", serverName: "deploy", message: "Deploy", requestedSchema });
    await expect(runtime.respondToRequest({ requestId: "form", kind: "elicitation", action: "accept", content: { target: "invalid", retries: 2, notify: true } })).rejects.toThrow("does not match");
    await runtime.respondToRequest({ requestId: "form", kind: "elicitation", action: "accept", content: { target: "staging", retries: 2, notify: true } });
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "form", result: { action: "accept", content: { target: "staging", retries: 2, notify: true }, _meta: null } });

    transport.receive({ jsonrpc: "2.0", id: "url", method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "auth", mode: "url", message: "Authorize access", url: "https://example.com/authorize", elicitationId: "auth-1" } });
    expect(runtime.snapshot().runtimes[first.id].pendingRequests[0]?.elicitation).toEqual({ mode: "url", serverName: "auth", message: "Authorize access", url: "https://example.com/authorize", elicitationId: "auth-1" });
    await expect(runtime.respondToRequest({ requestId: "url", kind: "elicitation", action: "accept", content: {} })).rejects.toThrow("does not match");
    await runtime.respondToRequest({ requestId: "url", kind: "elicitation", action: "accept", content: null });
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "url", result: { action: "accept", content: null, _meta: null } });

    const unsupported = { type: "object", properties: { values: { type: "array" } } };
    transport.receive({ jsonrpc: "2.0", id: "unsupported", method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "demo", mode: "openai/form", message: "Values", requestedSchema: unsupported } });
    await expect(runtime.respondToRequest({ requestId: "unsupported", kind: "elicitation", action: "accept", content: { values: [] } })).rejects.toThrow("does not match");
    await runtime.respondToRequest({ requestId: "unsupported", kind: "elicitation", action: "decline", content: null });
    expect(transport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "unsupported", result: { action: "decline", content: null, _meta: null } });
  });

  it("marks active sessions failed and clears pending requests when the server exits", async () => {
    const { runtime, transport, first } = await fixture();
    await startTurn(runtime, transport, first.id, "thread-1", "turn-1");
    transport.receive({ jsonrpc: "2.0", id: 7, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", reason: "edit" } });
    transport.exit(new Error("process exited 9"));
    const snapshot = runtime.snapshot();
    expect(snapshot.appServer).toMatchObject({ status: "error", diagnostic: { code: "server_exited" } });
    expect(snapshot.runtimes[first.id]).toMatchObject({ status: "failed", activeTurnId: null, pendingRequests: [] });
  });

  it("invalidates old requests and active turns before publishing a restarted server", async () => {
    const store = new MemoryStore();
    const firstTransport = new FakeTransport();
    const secondTransport = new FakeTransport();
    const connections = [new JsonRpcConnection(firstTransport), new JsonRpcConnection(secondTransport)];
    let launches = 0;
    const runtime = new DesktopRuntime(store, async () => ({ connection: connections[launches++], version: "0.154.0" }));
    await runtime.bootstrap();
    const project = await runtime.createProject({ name: "Repo", path: "/workspace/repo" });
    const agent = await runtime.createAgent({ projectId: project.id, name: "Builder", instructions: "Stay scoped." });
    const session = await runtime.createSession({ agentId: agent.id });
    await startTurn(runtime, firstTransport, session.id, "thread-restart", "turn-restart");
    firstTransport.receive({ jsonrpc: "2.0", id: 44, method: "item/fileChange/requestApproval", params: { threadId: "thread-restart", turnId: "turn-restart", itemId: "old" } });

    const restartStatuses: string[] = [];
    runtime.on("desktopEvent", (event: { type: string; snapshot?: { appServer: { status: string } } }) => {
      if (event.type === "snapshot" && event.snapshot) restartStatuses.push(event.snapshot.appServer.status);
    });
    await runtime.restartCodex();
    expect(firstTransport.closed).toBe(true);
    expect(restartStatuses).toEqual(["ready"]);
    expect(runtime.snapshot().appServer.status).toBe("ready");
    expect(runtime.snapshot().runtimes[session.id]).toMatchObject({ status: "failed", activeTurnId: null, pendingRequests: [], error: "Codex app-server restarted; the active turn was interrupted." });
    await expect(runtime.respondToRequest({ requestId: 44, kind: "approval", decision: "decline" })).rejects.toThrow("no longer pending");

    secondTransport.receive({ jsonrpc: "2.0", id: 44, method: "item/tool/requestUserInput", params: { threadId: "thread-restart", turnId: null, itemId: "new", isBlocking: true, questions: [] } });
    await runtime.respondToRequest({ requestId: 44, kind: "userInput", answers: {} });
    expect(secondTransport.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 44, result: { answers: {} } });
  });

  it("closes a deferred launch superseded by restart without replacing the new server", async () => {
    const store = new MemoryStore();
    const oldTransport = new FakeTransport();
    const newTransport = new FakeTransport();
    const oldLaunch = deferred<RunningCodex>();
    const newLaunch = deferred<RunningCodex>();
    let launches = 0;
    const runtime = new DesktopRuntime(store, () => launches++ === 0 ? oldLaunch.promise : newLaunch.promise);

    const bootstrapping = runtime.bootstrap();
    await tick();
    const restarting = runtime.restartCodex();
    await tick();
    newLaunch.resolve({ connection: new JsonRpcConnection(newTransport), version: "new" });
    await restarting;
    oldLaunch.resolve({ connection: new JsonRpcConnection(oldTransport), version: "old" });
    await bootstrapping;

    expect(launches).toBe(2);
    expect(oldTransport.closed).toBe(true);
    expect(newTransport.closed).toBe(false);
    expect(runtime.snapshot().appServer).toMatchObject({ status: "ready", codexVersion: "new" });
  });

  it("ignores an exit emitted by the connection replaced during restart", async () => {
    const store = new MemoryStore();
    const oldConnection = new JsonRpcConnection(new FakeTransport());
    const newConnection = new JsonRpcConnection(new FakeTransport());
    const connections = [oldConnection, newConnection];
    let launches = 0;
    const runtime = new DesktopRuntime(store, async () => {
      const index = launches++;
      return { connection: connections[index], version: index === 0 ? "old" : "new" };
    });
    await runtime.bootstrap();
    await runtime.restartCodex();
    oldConnection.emit("exit", new Error("late old exit"));
    expect(runtime.snapshot().appServer).toMatchObject({ status: "ready", codexVersion: "new", diagnostic: null });
  });

  it("restores saved thread history with thread/read", async () => {
    const store = new MemoryStore();
    store.state = {
      projects: [{ id: "p", name: "Repo", path: "/repo", createdAt: "now" }],
      agents: [{ id: "a", projectId: "p", name: "Agent", instructions: "", createdAt: "now" }],
      sessions: [{
        id: "s", agentId: "a", title: "Saved", threadId: "saved-thread",
        model: null, modelProvider: null, reasoningEffort: null, titleSource: "codex",
        createdAt: "now", updatedAt: "now",
      }],
    };
    const transport = new FakeTransport();
    const runtime = new DesktopRuntime(store, async () => ({ connection: new JsonRpcConnection(transport), version: "0.154.0" }));
    const loading = runtime.bootstrap();
    await tick();
    expect(transport.request("thread/read").params).toEqual({ threadId: "saved-thread", includeTurns: true });
    transport.respondTo("thread/read", { thread: {
      name: "Restored task",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
      turns: [{ items: [
        { type: "userMessage", id: "u", content: [{ type: "text", text: "question", text_elements: [] }] },
        { type: "agentMessage", id: "a", text: "answer", phase: "final_answer" },
      ] }],
    } });
    const snapshot = await loading;
    expect(snapshot.runtimes.s.messages.map((entry) => entry.text)).toEqual(["question", "answer"]);
    expect(snapshot.sessions[0]).toMatchObject({
      title: "Restored task",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
    });
  });
});
