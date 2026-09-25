/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_BRIDGE_VERSION, type OrchestrionDesktopApi } from "../shared/contracts";
import { LocalAgentSchema, LocalAgentVersionSchema } from "../shared/agent-contracts";
import { LocalAgentWorkspaceSchema } from "../shared/agent-ui-contracts";
import { LocalNavigationProvider } from "./navigation";
import { buildAgentDefinition, initialLocalAgentForm } from "./local-agent-form";
import { LocalAgentsHost } from "./LocalAgentsHost";
import { SESSION_TREE_BRIDGE_RESTART_MESSAGE } from "./session-tree-bridge";
import { LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE } from "./local-agent-binding-bridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = { org_id: "org", project_id: "project", principal: { type: "user", id: "owner" } };
const time = "2026-09-16T00:00:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const catalogId = digest("1");
const grant = {
  tool:{ source:"files",key:"file.read" },contract:{ id:"contract-1",hash:digest("a") },connection:null,
  execution_target:{ kind:"local_workspace" as const,id:context.project_id,placement:"local_trusted" as const,workspace_hash:digest("b") },
  resource_scope:{ kind:"workspace_path",resource:"/workspace/original" },
  constraints:{ effects:["read" as const],argument_schema_hash:digest("c"),max_output_bytes:4096,max_runtime_seconds:30 },
  policy:{ id:"policy-1",hash:digest("d") },approval:null,
};
const drift = { content:false,schema:false,executor:false,contract:false,requiresReview:false,requiresPublish:false };
const selection = { connection:null,executionTarget:{ kind:"local_workspace" as const,id:context.project_id,placement:"local_trusted" as const,workspaceHash:digest("b") } };
const direct = { toolSourceCatalog:{ schemaVersion:"tool_source_catalog@1" as const,authority:"none" as const,orgId:context.org_id,sources:[{
  namespace:"files",kind:"builtin" as const,label:"Project files",authority:"none" as const,connections:[{
    selection,label:"Local workspace",state:"accepted" as const,reasonCode:"READY",credentialReadiness:"not_required" as const,
    review:{ latestSnapshotId:null,acceptedSnapshotId:null,acceptedContentDigest:null,latestContentDigest:null,publishedRevision:null,activeRevision:null,rollbackRevision:null },drift,
    tools:[{ catalogId,identity:{ source:"files",key:"file.read" },selection,metadata:{ name:"Read file",description:"Read a reviewed workspace file",namespace:"files",inputSchema:{},outputSchema:null,
      claimedEffects:["read" as const],claimedRisk:"low" as const,annotations:{},trust:"reviewed" as const,metadataDigest:digest("e") },state:"accepted" as const,reasonCode:"READY",authority:"none" as const,
      contract:{ versionId:"contract-1",contractHash:digest("a"),schemaHash:digest("c"),executorHash:digest("f"),declaredEffects:["read" as const],physicalReadonlyProven:false },drift,grantReadiness:"ready" as const }],
  }],
}]},toolGrantTemplates:[{ catalogId,grant }] };
const definition = { ...buildAgentDefinition({ ...initialLocalAgentForm("agent"), name: "Reader" }).definition!,toolGrants:null };
const version = LocalAgentVersionSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context, id: "version-1", agentId: "agent-1", versionNumber: 1, definition,
  createdAt: time });
const newer = { ...version, id: "version-2", versionNumber: 2 };
const agent = LocalAgentSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context, id: "agent-1", nodeType: "agent", name: "Reader", description: null,
  userGuide: null, latestVersionId: newer.id, legacyDraft: null, createdAt: time, updatedAt: time, deletedAt: null });
const workspace = LocalAgentWorkspaceSchema.parse({ schemaVersion: "orchestrion.local.agent.ui.v3", projectId: context.project_id,
  expected: { revision: 1, hash: `sha256:${"0".repeat(64)}` },...direct,agents: [{ agent, latestVersion: newer }] });
let container: HTMLDivElement, root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); window.history.replaceState({}, "", "#/projects/project/agents/agent-1/versions/version-1"); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const bridgeInfo = { version: DESKTOP_BRIDGE_VERSION, capabilities: { sessionTree: { bindSessionAgent: true },localAgents:{ directToolGrants:true }, workspaceFiles: { read: true, save: true, open: true } } };
async function mount(choose = vi.fn().mockResolvedValue("/chosen/folder"), bind = vi.fn().mockResolvedValue({ id: agent.id }), overrides: Record<string, unknown> = {}) {
  const api = { bridgeInfo, chooseProjectDirectory: choose, bindSessionAgent: bind, localAgents: { detail: vi.fn().mockResolvedValue({ workspace, detail: { agent, versions: [newer, version] }, selectedVersionId: version.id }),create:vi.fn(),createVersion:vi.fn() }, ...overrides } as unknown as OrchestrionDesktopApi;
  await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}>
    <LocalAgentsHost route={{ kind: "local-agent", projectId: context.project_id, agentId: agent.id, versionId: version.id }} workspace={workspace}
      loadError={null} api={api} onWorkspaceChange={() => {}} onDirtyStateChange={() => {}} />
  </LocalNavigationProvider>));
  return { choose, bind };
}
async function useInSessions() {
  const button = [...container.querySelectorAll("button")].find(row => row.textContent?.includes("Use in Sessions"));
  expect(button).toBeTruthy(); await act(async () => button!.click());
}
describe("Local Agent definitions page header", () => {
  it("keeps one heading and all three navigation actions in the header", async () => {
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}>
      <LocalAgentsHost route={{ kind: "local-agents", projectId: context.project_id }} workspace={workspace}
        loadError={null} api={undefined} onWorkspaceChange={() => {}} onDirtyStateChange={() => {}} />
    </LocalNavigationProvider>));

    const header = container.querySelector(".local-agents-host .local-page-heading");
    expect(header?.querySelectorAll("h1")).toHaveLength(1);
    expect(header?.querySelector("h1")?.textContent).toBe("Agents");
    expect(header?.querySelector("p, .eyebrow")).toBeNull();
    expect([...header!.querySelectorAll<HTMLAnchorElement>("a")].map((link) => [link.textContent?.trim(), link.getAttribute("href")])).toEqual([
      ["Organization Library", "#/projects/project/agent-library"],
      ["Project Agents", "#/projects/project/project-agents"],
      ["New Agent", "#/projects/project/agents/new"],
    ]);
  });
});
function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
  input.dispatchEvent(new Event("input",{ bubbles:true }));
}
describe("ORCLOCAL-81 published Local Agent to Sessions UI", () => {
  it("selects a physical folder and sends only the explicitly viewed immutable version references", async () => {
    const { choose, bind } = await mount(); await useInSessions();
    expect(choose).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenCalledExactlyOnceWith({ path: "/chosen/folder", agentId: agent.id, versionId: version.id });
    expect(container.textContent).toContain("Codex native tools remain separate");
    expect(container.textContent).not.toContain(SESSION_TREE_BRIDGE_RESTART_MESSAGE);
    expect(window.location.hash).toBe("#/");
  });
  it.each([
    ["missing method", { bindSessionAgent: undefined }],
    ["missing bridge metadata", { bridgeInfo: undefined }],
    ["old preload version", { bridgeInfo: { ...bridgeInfo, version: 1 } }],
    ["missing capability", { bridgeInfo: { version: DESKTOP_BRIDGE_VERSION, capabilities: { workspaceFiles: bridgeInfo.capabilities.workspaceFiles } } }],
    ["disabled capability", { bridgeInfo: { ...bridgeInfo, capabilities: { sessionTree: { bindSessionAgent: false } } } }],
    ["partial capability", { bridgeInfo: { ...bridgeInfo, capabilities: { sessionTree: {} } } }],
    ["partial methods (missing picker)", { chooseProjectDirectory: undefined }],
    ["malformed metadata", { bridgeInfo: [] }],
  ])("blocks the %s bridge before opening the folder picker", async (_label, overrides) => {
    const { choose, bind } = await mount(undefined, undefined, overrides as Record<string, unknown>);
    const button = [...container.querySelectorAll("button")].find(row => row.textContent?.includes("Use in Sessions"))!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe("session-tree-bridge-status");
    expect(container.querySelector("#session-tree-bridge-status")?.textContent).toBe(SESSION_TREE_BRIDGE_RESTART_MESSAGE);
    await useInSessions();
    expect(choose).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
    expect(window.location.hash).toContain("version-1");
  });
  it("keeps a cancelled folder selection free of mutations", async () => {
    const { bind } = await mount(vi.fn().mockResolvedValue(null)); await useInSessions(); expect(bind).not.toHaveBeenCalled();
  });
  it("shows a binding conflict and keeps the selected version open for recovery", async () => {
    await mount(undefined, vi.fn().mockRejectedValue(new Error("SESSION_FOLDER_CONFLICT"))); await useInSessions();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("already bound to a different physical folder");
    expect(window.location.hash).toContain("version-1");
  });
});

describe("ORCLOCAL-106 direct Tool authoring",() => {
  it("normalizes a legacy auto-upgrading Workflow Agent only in the new definition",() => {
    const initial={ ...initialLocalAgentForm("sub_workflow"),name:"Pinned Workflow",workflowId:"workflow-1",workflowVersionId:"workflow-version-1",workflowAutoUpgrade:true };
    const pinned=buildAgentDefinition(initial).definition!;
    const legacy={ ...pinned,config:{ ...pinned.config,auto_upgrade:true } };
    const edited={ ...initialLocalAgentForm("sub_workflow",legacy),name:"Pinned Workflow" };
    const next=buildAgentDefinition(edited,legacy).definition!;
    expect(legacy.config.auto_upgrade).toBe(true);
    expect(next.config).toMatchObject({ auto_upgrade:false,workflow_id:"workflow-1",workflow_version_id:"workflow-version-1" });
  });

  it("blocks an old preload from entering the immutable-version editor with full-restart guidance",async () => {
    await mount(undefined,undefined,{ bridgeInfo:{ ...bridgeInfo,version:3 } });
    const edit=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Edit as new version"))!;
    expect(edit.disabled).toBe(true);expect(edit.getAttribute("aria-describedby")).toBe("agent-binding-bridge-status");
    expect(container.querySelector("#agent-binding-bridge-status")?.textContent).toBe(LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE);
    await act(async () => edit.click());expect(container.querySelector('[aria-label="Agent name"]')).toBeNull();
  });

  it("fails closed when direct authoring catalog data is unavailable",async () => {
    const legacy={ ...workspace } as unknown as typeof workspace;
    Reflect.deleteProperty(legacy as unknown as Record<string,unknown>,"toolSourceCatalog");
    Reflect.deleteProperty(legacy as unknown as Record<string,unknown>,"toolGrantTemplates");
    const api={ bridgeInfo,localAgents:{ detail:vi.fn().mockResolvedValue({ workspace:legacy,detail:{ agent,versions:[newer,version] },selectedVersionId:version.id }),create:vi.fn(),createVersion:vi.fn() },chooseProjectDirectory:vi.fn(),bindSessionAgent:vi.fn() } as unknown as OrchestrionDesktopApi;
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}><LocalAgentsHost route={{ kind:"local-agent",projectId:context.project_id,agentId:agent.id,versionId:version.id }} workspace={legacy} loadError={null} api={api} onWorkspaceChange={() => {}} onDirtyStateChange={() => {}} /></LocalNavigationProvider>));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain(LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE);
    expect(container.textContent).toContain("Legacy configuration is unconverted");
    const edit=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Edit as new version"))!;
    expect(edit.disabled).toBe(true);expect(container.querySelector('[aria-label="Agent name"]')).toBeNull();
  });

  it("blocks a create route when the direct-grant bridge capability is absent",async () => {
    const api={ bridgeInfo:{ version:3,capabilities:{} },localAgents:{ create:vi.fn(),createVersion:vi.fn() } } as unknown as OrchestrionDesktopApi;
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}><LocalAgentsHost route={{ kind:"local-agent-create",projectId:context.project_id }} workspace={workspace} loadError={null} api={api} onWorkspaceChange={() => {}} onDirtyStateChange={() => {}} /></LocalNavigationProvider>));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Fully quit and restart");
    expect(container.querySelector('[aria-label="Agent name"]')).toBeNull();expect(api.localAgents.create).not.toHaveBeenCalled();
  });

  it("preserves a legacy null Tool grant state when an unchanged version is saved",async () => {
    expect(version.definition.toolGrants).toBeNull();
    const createVersion=vi.fn().mockResolvedValue({ workspace });
    await mount(undefined,undefined,{ localAgents:{ detail:vi.fn().mockResolvedValue({ workspace,detail:{ agent,versions:[newer,version] },selectedVersionId:version.id }),create:vi.fn(),createVersion } });
    const edit=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Edit as new version"))!;
    await act(async () => edit.click());
    expect(container.textContent).toContain("No unsaved changes");
    expect(container.querySelector('[aria-label="Draft direct grants"]')?.textContent).toContain("Legacy configuration is unconverted");
    const save=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save new version"))!;
    await act(async () => save.click());
    expect(createVersion).toHaveBeenCalledOnce();
    expect(createVersion.mock.calls[0][0].payload.definition.toolGrants).toBeNull();
    expect(createVersion.mock.calls[0][0].payload).not.toHaveProperty("sourceVersionId");
    expect(createVersion.mock.calls[0][0].payload).not.toHaveProperty("toolsetBindings");
  });

  it("converts legacy null Tool grants to explicit deny-all only after the user chooses it",async () => {
    const createVersion=vi.fn().mockResolvedValue({ workspace });
    await mount(undefined,undefined,{ localAgents:{ detail:vi.fn().mockResolvedValue({ workspace,detail:{ agent,versions:[newer,version] },selectedVersionId:version.id }),create:vi.fn(),createVersion } });
    const edit=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Edit as new version"))!;
    await act(async () => edit.click());
    const denyAll=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Set explicit deny all"))!;
    await act(async () => denyAll.click());
    expect(container.textContent).toContain("Unsaved changes");
    expect(container.querySelector('[aria-label="Draft direct grants"]')?.textContent).toContain("Explicit deny all");
    const save=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save new version"))!;
    await act(async () => save.click());
    expect(createVersion.mock.calls[0][0].payload.definition.toolGrants).toEqual({ schema_version:"tool_grants@1",grants:[] });
    expect(createVersion.mock.calls[0][0].payload).not.toHaveProperty("sourceVersionId");
    expect(createVersion.mock.calls[0][0].payload).not.toHaveProperty("toolsetBindings");
  });

  it("keeps same-name Source selection exact, tracks unsaved changes and publishes the direct grant",async () => {
    const createVersion=vi.fn().mockResolvedValue({ workspace });
    const dirty=vi.fn();
    await mount(undefined,undefined,{ localAgents:{ detail:vi.fn().mockResolvedValue({ workspace,detail:{ agent,versions:[newer,version] },selectedVersionId:version.id }),create:vi.fn(),createVersion } });
    const edit=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Edit as new version"))!;
    await act(async () => edit.click());
    const search=container.querySelector<HTMLInputElement>('[aria-label="Search Tool Source catalog"]')!;
    await act(async () => inputValue(search,"reviewed workspace"));
    const choice=[...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find((button) => button.textContent?.includes("Read file"))!;
    expect(choice).toBeTruthy();expect(choice.disabled).toBe(false);
    await act(async () => choice.click());
    const resource=container.querySelector<HTMLInputElement>('[aria-label="Direct grant resource"]')!;
    await act(async () => inputValue(resource,"/workspace/team/report.md"));
    const add=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add exact Tool grant"))!;
    await act(async () => add.click());
    expect(container.textContent).toContain("Unsaved changes");
    expect(container.querySelector('[aria-label="Draft direct grants"]')?.textContent).toContain("/workspace/team/report.md");
    const save=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save new version"))!;
    await act(async () => save.click());
    expect(createVersion).toHaveBeenCalledOnce();
    expect(createVersion.mock.calls[0][0].payload.definition.toolGrants.grants[0]).toMatchObject({
      tool:{ source:"files",key:"file.read" },execution_target:{ id:"project" },resource_scope:{ kind:"workspace_path",resource:"/workspace/team/report.md" },
    });
    expect(createVersion.mock.calls[0][0].payload).not.toHaveProperty("toolsetBindings");
    expect(createVersion.mock.calls[0][0].payload).not.toHaveProperty("sourceVersionId");
    void dirty;
  });
});
