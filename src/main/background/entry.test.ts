import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../../shared/contracts";
import { GOVERNED_SESSION_NOT_READY_MESSAGE } from "../../shared/session-tree-contracts";
import { LocalFailureSchema } from "../../shared/local-contracts";
import { FakeTransport } from "../test-transport";
import { JsonRpcConnection } from "../json-rpc";

const adapters = vi.hoisted(() => ({
  api: null as OrchestrionDesktopApi | null,
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  launch: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: OrchestrionDesktopApi) => { adapters.api = api; } },
  ipcRenderer: { invoke: adapters.invoke, on: vi.fn(), off: vi.fn() },
  webUtils: { getPathForFile: () => "" },
}));
vi.mock("../codex-process", async (original) => ({ ...await original<object>(), launchCodex: adapters.launch }));

class ApplicationPort extends EventEmitter {
  readonly sent: Array<{ type: string; id?: string; value?: unknown }> = [];
  postMessage(message: { type: string; id?: string; value?: unknown }) { this.sent.push(message); }
  async invoke(channel: unknown, input: unknown, documentId: unknown) {
    const id = randomUUID();
    this.emit("message", { data: { type: "invoke", id, channel, input, documentId } });
    await vi.waitFor(() => expect(this.sent.some(message => message.type === "result" && message.id === id)).toBe(true));
    return this.sent.find(message => message.type === "result" && message.id === id)!.value;
  }
}

let directory: string | undefined, port: ApplicationPort | undefined;
const argv = [...process.argv], parentPort = Object.getOwnPropertyDescriptor(process, "parentPort");
const signalListeners = process.listeners("SIGTERM");
afterEach(async () => {
  if (port?.sent.some(message => message.type === "ready")) {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    port.emit("message", { data: { type: "shutdown" } });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  }
  for (const listener of process.listeners("SIGTERM")) if (!signalListeners.includes(listener)) process.removeListener("SIGTERM", listener);
  process.argv = argv;
  if (parentPort) Object.defineProperty(process, "parentPort", parentPort);
  else Reflect.deleteProperty(process, "parentPort");
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ORCLOCAL-81/82 production entry transport", () => {
  it("preserves a real governed declaration refusal through entry-port and preload for start/send, with no native thread or provisional orphan", async () => {
    directory = mkdtempSync(join(tmpdir(), "orclocal-81-entry-"));
    const workspace = join(directory, "workspace"); mkdirSync(workspace);
    port = new ApplicationPort();
    process.argv = [argv[0], argv[1], directory];
    Object.defineProperty(process, "parentPort", { configurable: true, value: port });
    const transport = new FakeTransport();
    adapters.launch.mockResolvedValue({ connection: new JsonRpcConnection(transport), version: "fixture" });
    adapters.invoke.mockImplementation(async (channel, input, identity) => channel === "orchestrion:document-identity"
      ? "production-entry-document" : port!.invoke(channel, input, identity));
    // Import the production composition and its real port listener. Only Electron
    // IPC and the native Codex process are replaced; SQLite, services, bindings,
    // runtime, readiness and the result/rejection projection are not mocked.
    await import("./entry");
    await import("../../preload/index");
    const api = adapters.api!;
    const initial = await api.localAgents.snapshot();
    expect(await api.codexAccount({ operation: "read", projectId: initial.workspace.projectId })).toEqual({
      availability: process.platform === "darwin" ? "available" : "unavailable",
      state: process.platform === "darwin" ? "disconnected" : "unavailable",
      accountDisplay: null, executionReady: false });
    expect(api.bridgeInfo).toMatchObject({ version:5,capabilities:{ localAgents:{ directToolGrants:true } } });
    expect(initial.workspace).toMatchObject({ schemaVersion:"orchestrion.local.agent.ui.v3" });
    const fixture = JSON.parse(readFileSync(new URL("../../fixtures/f1-agent-v1.json", import.meta.url), "utf8")).agentDetail.latestVersion;
    const { id: _id, agentId: _agent, versionNumber: _version, createdAt: _created, skills: _skills, ...legacyDefinition } = fixture;
    void _id; void _agent; void _version; void _created; void _skills;
    const definition = { ...legacyDefinition, toolGrants: { schema_version: "tool_grants@1", grants: [] } };
    const created = await api.localAgents.create({ operation: "create", requestId: randomUUID(), idempotencyKey: randomUUID(),
      expected: initial.workspace.expected, payload: { name: "Reader", description: null, userGuide: null, definition } });
    const assignments=await api.localAssignments.request({operation:"list",limit:100,offset:0});
    expect(assignments).toMatchObject({kind:"page",items:[{
      assignment:{agentId:created.detail!.agent.id,status:"active"},
      agent:{identityState:"legacy_unresolved"},migrationState:"legacy_unversioned",currentVersion:null,
    }]});
    // Production composition exposes the bounded preview but has no C1/C3A
    // reviewed Source host wired yet. A forged nonempty choice stays Not Ready.
    if (assignments.kind!=="page") throw new Error("Expected Assignment page");
    const governed=await api.localAssignments.request({operation:"create",expected:assignments.expected,
      requestId:randomUUID(),idempotencyKey:randomUUID(),payload:{name:"Governed reader",
        description:null,userGuide:null,definition,visibility:"project",sourceVersionId:null}});
    if (governed.kind!=="command") throw new Error("Expected governed Agent creation");
    const catalog=await api.localAssignments.request({operation:"catalog.detail",agentId:governed.resultRef,
      limit:100,offset:0});
    if (catalog.kind!=="catalog.detail") throw new Error("Expected governed Agent catalog detail");
    const governedAssignments=await api.localAssignments.request({operation:"list",limit:100,offset:0});
    if (governedAssignments.kind!=="page") throw new Error("Expected governed Assignment page");
    const assignmentId=governedAssignments.items.find(item=>item.assignment.agentId===governed.resultRef)!.assignment.id;
    expect(await api.localAssignments.request({operation:"grant.preview",assignmentId,
      agentVersionId:catalog.versions[0].id,principalVersionIds:[randomUUID()]}))
      .toMatchObject({kind:"grant.preview",options:[],readiness:{state:"not_ready",
        reason:"ASSIGNMENT_NOT_READY",executionReady:false}});
    const bound = await api.bindSessionAgent({ path: workspace, agentId: created.detail!.agent.id, versionId: created.detail!.versions[0].id });
    const expected = { message: GOVERNED_SESSION_NOT_READY_MESSAGE, code: "GOVERNED_SESSION_NOT_READY", retryable: false };
    await expect(api.startSession({ agentId: bound.id, text: "Read README" })).rejects.toMatchObject(expected);
    expect((await api.bootstrap()).sessions).toEqual([]); // provisional Session rollback remains intact
    const session = await api.createSession({ agentId: bound.id });
    await expect(api.sendMessage({ sessionId: session.id, text: "Read README" })).rejects.toMatchObject(expected);
    const snapshot = await api.bootstrap();
    expect(snapshot.sessions).toEqual([session]);
    expect(snapshot.runtimes[session.id]).toMatchObject({ status: "failed", error: GOVERNED_SESSION_NOT_READY_MESSAGE });
    const failures = port.sent.filter(message => message.type === "result").flatMap(message => {
      const failure = LocalFailureSchema.safeParse(message.value); return failure.success ? [failure.data] : [];
    });
    expect(failures).toEqual(Array(2).fill({ ok: false, error: { code: "GOVERNED_SESSION_NOT_READY", retryable: false } }));
    expect(adapters.launch).toHaveBeenCalledOnce();
    expect(transport.sent.filter(message => message.method === "thread/start" || message.method === "turn/start")).toEqual([]);

    // Arbitrary exceptions must not obtain the corrective typed classification,
    // even when their message/code imitates it. No exception text crosses IPC.
    const { DesktopRuntime } = await import("../runtime");
    vi.spyOn(DesktopRuntime.prototype, "sendMessage").mockRejectedValueOnce(Object.assign(new Error("PRIVATE_CANARY"), { code: "GOVERNED_SESSION_NOT_READY" }));
    await expect(api.sendMessage({ sessionId: session.id, text: "Read README" })).rejects.toMatchObject({ message: "OUTCOME_UNKNOWN", code: "OUTCOME_UNKNOWN", retryable: false });
    expect(JSON.stringify(port.sent)).not.toContain("PRIVATE_CANARY");
  });
});
