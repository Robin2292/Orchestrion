import { beforeAll, describe, expect, it, vi } from "vitest";
import { DESKTOP_BRIDGE_VERSION, IPC, UPDATER_IPC, type OrchestrionDesktopApi, type TerminalEvent } from "../shared/contracts";
import { REALTIME_CHANNEL, REALTIME_NOTICE } from "../shared/realtime-contracts";
import { LOCAL_AGENT_UI_CHANNEL } from "../shared/agent-ui-contracts";
import { LOCAL_AGENT_SOUL_CHANNEL } from "../shared/agent-soul-ui-contracts";
import { LOCAL_ASSIGNMENT_UI_CHANNEL } from "../shared/assignment-ui-contracts";
import { LOCAL_DIRECT_SESSION_CHANNEL } from "../shared/direct-session-ui-contracts";
import { LOCAL_POLICY_UI_CHANNEL } from "../shared/policy/p2-ui-contracts";
import { GOVERNED_SESSION_NOT_READY_MESSAGE } from "../shared/session-tree-contracts";

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    api: null as OrchestrionDesktopApi | null,
    invoke: vi.fn(async (channel: string): Promise<unknown> => channel === "orchestrion:document-identity" ? "fixture-document" : undefined),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener); }),
    off: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    }),
    listeners,
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: OrchestrionDesktopApi) => { electron.api = api; } },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off },
  webUtils: { getPathForFile: () => "" },
}));

beforeAll(async () => {
  await import("./index");
});

describe("preload bridge", () => {
  it("exposes only validated updater state and never forwards malformed event payloads", async () => {
    const api = electron.api!;
    await api.bootstrap();
    const state = { phase: "available", currentVersion: "0.1.0", availableVersion: "0.2.0", progressPercent: null,
      changelog: [{ version: "0.2.0", notes: ["Fix"] }], error: null };
    electron.invoke.mockResolvedValueOnce(state);
    expect(await api.updaterBridge.getState()).toEqual(state);
    expect(electron.invoke.mock.calls.at(-1)).toEqual([UPDATER_IPC.getState, undefined, "fixture-document"]);
    electron.invoke.mockResolvedValueOnce({ ...state, secret: "CANARY" });
    await expect(api.updaterBridge.check()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const listener = vi.fn();
    const dispose = api.updaterBridge.onState(listener);
    electron.listeners.get(UPDATER_IPC.state)?.({}, { ...state, secret: "CANARY" });
    electron.listeners.get(UPDATER_IPC.state)?.({}, state);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(state);
    dispose();
    expect(electron.listeners.has(UPDATER_IPC.state)).toBe(false);
  });
  it("validates catalog read requests and typed replies across preload IPC",async()=>{
    const api=electron.api!; await api.bootstrap();
    const request={operation:"catalog.list" as const,limit:100,offset:0};
    const value={kind:"catalog.page" as const,expected:{revision:0,hash:`sha256:${"0".repeat(64)}`},items:[],total:0};
    electron.invoke.mockResolvedValueOnce({ok:true,value});
    expect(await api.localAssignments.request(request)).toEqual(value);
    expect(electron.invoke.mock.calls.at(-1)).toEqual([LOCAL_ASSIGNMENT_UI_CHANNEL,request,"fixture-document"]);
    const calls=electron.invoke.mock.calls.length;
    await expect(api.localAssignments.request({...request,orgId:"forged"} as typeof request)).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ok:false,error:{code:"AGENT_CATALOG_NOT_FOUND",retryable:false}});
    await expect(api.localAssignments.request({operation:"catalog.detail",agentId:"missing",limit:100,offset:0}))
      .rejects.toMatchObject({code:"AGENT_CATALOG_NOT_FOUND",retryable:false});
    electron.invoke.mockResolvedValueOnce({ok:true,value:{...value,secret:"CANARY"}});
    await expect(api.localAssignments.request(request)).rejects.toThrow("SERVICE_UNAVAILABLE");
  });
  it("validates Direct Session IPC and hides malformed host replies",async()=>{
    const api=electron.api!,request={operation:"get" as const,sessionId:"session-1"};
    const value={kind:"detail" as const,expected:{revision:0,hash:`sha256:${"0".repeat(64)}`},session:null};
    await api.bootstrap();
    electron.invoke.mockResolvedValueOnce({ok:true,value});
    expect(await api.localDirectSessions.request(request)).toEqual(value);
    expect(electron.invoke.mock.calls.at(-1)).toEqual([LOCAL_DIRECT_SESSION_CHANNEL,request,"fixture-document"]);
    const calls=electron.invoke.mock.calls.length;
    await expect(api.localDirectSessions.request({...request,sessionId:""})).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ok:true,value:{...value,secret:"CANARY"}});
    await expect(api.localDirectSessions.request(request)).rejects.toThrow("SERVICE_UNAVAILABLE");
  });
  it.each(["startSession", "sendMessage"] as const)("projects only closed readiness failures for %s", async (method) => {
    const api = electron.api!; await api.bootstrap();
    const call = () => method === "startSession" ? api.startSession({ agentId: "agent-81", text: "read" }) : api.sendMessage({ sessionId: "session-81", text: "read" });
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "GOVERNED_SESSION_NOT_READY", retryable: false } });
    await expect(call()).rejects.toMatchObject({ message: GOVERNED_SESSION_NOT_READY_MESSAGE, code: "GOVERNED_SESSION_NOT_READY", retryable: false });
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "OUTCOME_UNKNOWN", retryable: false } });
    await expect(call()).rejects.toMatchObject({ message: "OUTCOME_UNKNOWN", code: "OUTCOME_UNKNOWN", retryable: false });
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "GOVERNED_SESSION_NOT_READY", retryable: false, secret: "CANARY" } });
    await expect(call()).rejects.toMatchObject({ message: "SERVICE_UNAVAILABLE", code: "SERVICE_UNAVAILABLE", retryable: false });
    electron.invoke.mockRejectedValueOnce(Object.assign(new Error("CANARY"), { code: "GOVERNED_SESSION_NOT_READY" }));
    await expect(call()).rejects.toMatchObject({ message: "SERVICE_UNAVAILABLE", code: "SERVICE_UNAVAILABLE", retryable: false });
  });
  it("binds published Session Agents with a strict request/reply and redacted failures", async () => {
    const api = electron.api!; await api.bootstrap();
    const input = { path: "/chosen/folder", agentId: "agent-81", versionId: "version-81" };
    const value = { id: input.agentId, projectId: "host-project", name: "Reader", instructions: "Read", createdAt: "2026-09-16T00:00:00.000Z",
      executionMode: "governed", localAgentVersionId: input.versionId };
    electron.invoke.mockResolvedValueOnce({ ok: true, value });
    expect(await api.bindSessionAgent(input)).toEqual(value);
    expect(electron.invoke.mock.calls.at(-1)).toEqual([IPC.bindSessionAgent, input, "fixture-document"]);
    const calls = electron.invoke.mock.calls.length;
    await expect(api.bindSessionAgent({ ...input, projectId: "forged" } as typeof input)).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "SESSION_FOLDER_CONFLICT", retryable: false } });
    await expect(api.bindSessionAgent(input)).rejects.toMatchObject({ code: "SESSION_FOLDER_CONFLICT", retryable: false });
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { ...value, secret: "CANARY" } });
    await expect(api.bindSessionAgent(input)).rejects.toMatchObject({ message: "SERVICE_UNAVAILABLE", code: "SERVICE_UNAVAILABLE", retryable: false });
    electron.invoke.mockRejectedValueOnce(new Error("CANARY"));
    await expect(api.bindSessionAgent(input)).rejects.toMatchObject({ message: "SERVICE_UNAVAILABLE", code: "SERVICE_UNAVAILABLE", retryable: false });
  });
  it("exposes strict Policy authoring commands without renderer-selected authority",async()=>{
    const api=electron.api!,workspace={ schemaVersion:"orchestrion.local.policy.ui.v1",projectId:"personal-project",
      expected:{ revision:0,hash:`sha256:${"0".repeat(64)}` },supportedLayers:["organization"],items:[] };
    await api.bootstrap();
    electron.invoke.mockResolvedValueOnce({ ok:true,value:{ workspace,selectedReleaseId:null,simulation:null } });
    expect(await api.localPolicies.snapshot()).toEqual({ workspace,selectedReleaseId:null,simulation:null });
    expect(electron.invoke.mock.calls.at(-1)).toEqual([LOCAL_POLICY_UI_CHANNEL,{ operation:"snapshot" },"fixture-document"]);
    const calls=electron.invoke.mock.calls.length;
    await expect(api.localPolicies.simulate({ operation:"simulate",expected:workspace.expected,payload:{ id:"release-1",releaseHash:"forged",stateRevision:0,
      resource:{ resourceType:"workspace_path",value:"/workspace/public/a.txt",mode:"read" } } })).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ ok:false,error:{ code:"POLICY_APPROVAL_RUNTIME_UNSUPPORTED",retryable:false } });
    await expect(api.localPolicies.snapshot()).rejects.toMatchObject({ code:"POLICY_APPROVAL_RUNTIME_UNSUPPORTED",retryable:false });
  });
  it("exposes strict Local Agent operations without renderer-selected authority", async () => {
    const api = electron.api!;
    await api.bootstrap();
    const workspace = { schemaVersion: "orchestrion.local.agent.ui.v3", projectId: "personal-project",
      expected: { revision: 0, hash: `sha256:${"0".repeat(64)}` }, agents: [] };
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { workspace, detail: null, selectedVersionId: null } });
    expect(await api.localAgents.snapshot()).toEqual({ workspace, detail: null, selectedVersionId: null });
    expect(electron.invoke.mock.calls.at(-1)).toEqual([LOCAL_AGENT_UI_CHANNEL, { operation: "snapshot" }, "fixture-document"]);

    const calls = electron.invoke.mock.calls.length;
    await expect(api.localAgents.detail("")).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { workspace, detail: null, selectedVersionId: null, secret: "canary" } });
    await expect(api.localAgents.snapshot()).rejects.toThrow("SERVICE_UNAVAILABLE");
  });
  it("validates SOUL draft IPC and masks malformed host content", async () => {
    const api = electron.api!; await api.bootstrap();
    const request = { operation:"read" as const,agentId:"00000000-0000-4000-8000-000000000001" };
    const value = { kind:"draft",draft:{content:"# Agent\n",hash:`sha256:${"a".repeat(64)}`,
      source:"managed_file",publishedVersionId:"version-1"} };
    electron.invoke.mockResolvedValueOnce({ok:true,value});
    expect(await api.localAgentSoul!.request(request)).toEqual(value);
    expect(electron.invoke.mock.calls.at(-1)).toEqual([LOCAL_AGENT_SOUL_CHANNEL,request,"fixture-document"]);
    const calls=electron.invoke.mock.calls.length;
    await expect(api.localAgentSoul!.request({...request,agentId:""})).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ok:true,value:{...value,secret:"CANARY"}});
    await expect(api.localAgentSoul!.request(request)).rejects.toThrow("SERVICE_UNAVAILABLE");
    electron.invoke.mockResolvedValueOnce({ok:false,error:{code:"SOUL_CONFLICT",retryable:false}});
    await expect(api.localAgentSoul!.request(request)).rejects.toMatchObject({code:"SOUL_CONFLICT",retryable:false});
  });
  it.each(["REVISION_CONFLICT", "RUNTIME_OWNER_MISMATCH", "NOT_AUTHENTICATED", "OUTCOME_UNKNOWN"] as const)(
    "preserves the schema-validated %s Local Agent failure",
    async (code) => {
      electron.invoke.mockResolvedValueOnce({ ok: false, error: { code, retryable: false } });
      try {
        await electron.api!.localAgents.snapshot();
        throw new Error("Expected Local Agent failure");
      } catch (error) {
        const value = error as Error & { code?: unknown; retryable?: unknown };
        expect({ name: value.name, message: value.message, code: value.code, retryable: value.retryable,
          keys: Object.keys(value).sort() }).toEqual({ name: "Error", message: code, code, retryable: false,
          keys: ["code", "retryable"] });
      }
    },
  );
  it("preserves typed Agent domain failures but masks malformed and rejected transport values", async () => {
    const api = electron.api!, canary = "A1_UNTRUSTED_FAILURE_CANARY";
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "AGENT_REFERENCED", retryable: false } });
    await expect(api.localAgents.snapshot()).rejects.toMatchObject({ message: "AGENT_REFERENCED", code: "AGENT_REFERENCED", retryable: false });

    const publicErrors: Array<Record<string, unknown>> = [];
    for (const result of [
      { kind: "reply", value: { ok: false, error: { code: "REVISION_CONFLICT", retryable: false, secret: canary } } },
      { kind: "reply", value: { ok: true, value: { secret: canary } } },
      { kind: "reject", value: Object.assign(new Error(`REVISION_CONFLICT ${canary}`), { code: "REVISION_CONFLICT" }) },
    ]) {
      if (result.kind === "reply") electron.invoke.mockResolvedValueOnce(result.value);
      else electron.invoke.mockRejectedValueOnce(result.value);
      try { await api.localAgents.snapshot(); }
      catch (error) {
        const value = error as Error & { code?: unknown; retryable?: unknown };
        publicErrors.push({ name: value.name, message: value.message, code: value.code,
          retryable: value.retryable, keys: Object.keys(value).sort() });
      }
    }
    expect(publicErrors).toHaveLength(3);
    expect(new Set(publicErrors.map((value) => JSON.stringify(value)))).toHaveLength(1);
    expect(publicErrors[0]).toEqual({ name: "Error", message: "SERVICE_UNAVAILABLE", code: "SERVICE_UNAVAILABLE",
      retryable: false, keys: ["code", "retryable"] });
    expect(JSON.stringify(publicErrors)).not.toContain(canary);
  });
  it("rejects secret-bearing credential inputs before IPC and validates every readiness response", async () => {
    const api = electron.api!, canary = "SYNTHETIC_F5_PRELOAD_SECRET";
    const id = "00000000-0000-4000-8000-000000000001";
    const command = { schema_version: "orchestrion.local.v1", request_id: id, idempotency_key: id,
      context: { org_id: "org", project_id: "project", principal: { type: "user", id: "user" } },
      runtime_owner: { engine: "local", instance_id: id, epoch: 0 },
      expected: { revision: 0, hash: `sha256:${"0".repeat(64)}` }, run: null,
      command: "credential.readiness", payload: { credential_ref: id, connector_id: id, revision: 0 } };
    const calls = electron.invoke.mock.calls.length;
    await expect(api.credentialReadiness(JSON.stringify({ ...command, secret: canary }))).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    // Initialize the existing document handshake before replacing this response.
    await api.bootstrap();
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { ok: true, value: { ...command.payload, mask: canary, state: "ready" } } });
    await expect(api.credentialReadiness(JSON.stringify(command))).rejects.toThrow("CREDENTIAL_UNAVAILABLE");
    const safe = { ok: true, value: { ...command.payload, mask: "••••••••", state: "unavailable" } };
    electron.invoke.mockResolvedValueOnce({ ok: true, value: safe });
    expect(await api.credentialReadiness(JSON.stringify(command))).toEqual(safe);
    const publicErrors: Array<Record<string, unknown>> = [];
    for (const credential_ref of [id, "00000000-0000-4000-8000-000000000009"]) {
      electron.invoke.mockResolvedValueOnce({ ok: false,
        error: { code: "NOT_AUTHENTICATED", retryable: false } });
      try {
        await api.credentialReadiness(JSON.stringify({ ...command,
          context: { ...command.context, project_id: "forged-project" },
          payload: { ...command.payload, credential_ref } }));
      } catch (error) {
        const value = error as Error & { code?: unknown; retryable?: unknown };
        publicErrors.push({ name: value.name, message: value.message, code: value.code,
          retryable: value.retryable, keys: Object.keys(value).sort() });
      }
    }
    expect(publicErrors).toHaveLength(2);
    expect(publicErrors[0]).toEqual(publicErrors[1]);
    expect(publicErrors[0]).toMatchObject({ message: "NOT_AUTHENTICATED",
      code: "NOT_AUTHENTICATED", retryable: false });
    expect(JSON.stringify(electron.invoke.mock.calls)).not.toContain(canary);
  });
  it("keeps experimental account requests and replies strictly non-secret", async () => {
    const api = electron.api!, canary = "SYNTHETIC_ACCOUNT_SECRET";
    const before = electron.invoke.mock.calls.length;
    await expect(api.codexAccount({ operation: "start", projectId: "project", explicitOptIn: true, token: canary } as never))
      .rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(before);
    await api.bootstrap();
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { availability: "available",
      state: "connected", accountDisplay: "verified-account", executionReady: false, accessToken: canary } });
    await expect(api.codexAccount({ operation: "read", projectId: "project" })).rejects.toThrow("SERVICE_UNAVAILABLE");
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { availability: "available",
      state: "connected", accountDisplay: "verified-account", executionReady: false } });
    await expect(api.codexAccount({ operation: "read", projectId: "project" })).rejects.toThrow("SERVICE_UNAVAILABLE");
    const safe = { availability: "unavailable" as const, state: "unavailable" as const,
      accountDisplay: null, executionReady: false as const };
    electron.invoke.mockResolvedValueOnce({ ok: true, value: safe });
    expect(await api.codexAccount({ operation: "read", projectId: "project" })).toEqual(safe);
    expect(JSON.stringify(electron.invoke.mock.calls)).not.toContain(canary);
  });
  it("advertises and forwards the complete workspace file contract", async () => {
    const api = electron.api!;
    const read = { sessionId: "session-1", relativePath: "README.md" };
    const save = { ...read, content: "# Updated", expectedRevision: "sha256:before" };
    const open = { ...read, destination: "cursor" as const };

    expect(api.bridgeInfo).toEqual({
      version: DESKTOP_BRIDGE_VERSION,
      capabilities: { workspaceFiles: { read: true, save: true, open: true }, sessionTree: { bindSessionAgent: true }, localAgents:{ directToolGrants:true } },
    });
    await api.readWorkspaceFile(read);
    await api.saveWorkspaceFile(save);
    await api.openWorkspaceFile(open);

    expect(electron.invoke.mock.calls.slice(-3)).toEqual([
      [IPC.readWorkspaceFile, read, "fixture-document"],
      [IPC.saveWorkspaceFile, save, "fixture-document"],
      [IPC.openWorkspaceFile, open, "fixture-document"],
    ]);
  });

  it("forwards only the typed terminal values over IPC", async () => {
    const api = electron.api!;
    await api.createTerminal({ sessionId: "session-1", columns: 80, rows: 24 });
    await api.sendTerminalInput({ sessionId: "session-1", terminalId: "terminal-1", data: "pwd\r" });
    await api.acknowledgeTerminalOutput({ sessionId: "session-1", terminalId: "terminal-1", sequence: 1 });
    await api.resizeTerminal({ sessionId: "session-1", terminalId: "terminal-1", columns: 100, rows: 30 });
    await api.closeTerminal({ sessionId: "session-1", terminalId: "terminal-1" });
    await api.closeSessionTerminals({ sessionId: "session-1" });
    await api.deleteSession({ sessionId: "session-1" });

    expect(electron.invoke.mock.calls.slice(-7)).toEqual([
      [IPC.createTerminal, { sessionId: "session-1", columns: 80, rows: 24 }, "fixture-document"],
      [IPC.terminalInput, { sessionId: "session-1", terminalId: "terminal-1", data: "pwd\r" }, "fixture-document"],
      [IPC.acknowledgeTerminalOutput, { sessionId: "session-1", terminalId: "terminal-1", sequence: 1 }, "fixture-document"],
      [IPC.resizeTerminal, { sessionId: "session-1", terminalId: "terminal-1", columns: 100, rows: 30 }, "fixture-document"],
      [IPC.closeTerminal, { sessionId: "session-1", terminalId: "terminal-1" }, "fixture-document"],
      [IPC.closeSessionTerminals, { sessionId: "session-1" }, "fixture-document"],
      [IPC.deleteSession, { sessionId: "session-1" }, "fixture-document"],
    ]);
  });

  it("delivers terminal events and removes the exact listener on unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = electron.api!.onTerminalEvent(listener);
    const payload: TerminalEvent = { type: "output", sessionId: "session-1", terminalId: "terminal-1", sequence: 1, data: "hello" };
    electron.listeners.get(IPC.terminalEvent)?.({}, payload);
    expect(listener).toHaveBeenCalledWith(payload);

    unsubscribe();
    expect(electron.listeners.has(IPC.terminalEvent)).toBe(false);
    expect(electron.off).toHaveBeenCalledWith(IPC.terminalEvent, expect.any(Function));
  });
  it("bounds realtime wires, validates replies/notices and uses the captured document identity", async () => {
    const api = electron.api!.localRealtime!, listener = vi.fn();
    const off = api.onNotice(listener), generation = "00000000-0000-4000-8000-000000000001";
    electron.listeners.get(REALTIME_NOTICE)?.({}, { version: "future", generation });
    electron.listeners.get(REALTIME_NOTICE)?.({}, { version: "synthetic.notice.v1", generation, secret: "rejected" });
    expect(listener).not.toHaveBeenCalled();
    electron.listeners.get(REALTIME_NOTICE)?.({}, { version: "synthetic.notice.v1", generation });
    expect(listener).toHaveBeenCalledOnce(); off(); expect(electron.listeners.has(REALTIME_NOTICE)).toBe(false);
    const calls = electron.invoke.mock.calls.length;
    await expect(api.request("x".repeat(32769))).rejects.toThrow("INVALID_PAYLOAD");
    expect(electron.invoke.mock.calls.length).toBe(calls);
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { subject_id: "fixture" } });
    expect(await api.request("fixture-wire")).toEqual({ subject_id: "fixture" });
    expect(electron.invoke.mock.calls.at(-1)).toEqual([REALTIME_CHANNEL, "fixture-wire", "fixture-document"]);
    electron.invoke.mockResolvedValueOnce({ ok: true, value: { secret: "rejected" } });
    await expect(api.request("fixture-wire")).rejects.toThrow();
  });
});
