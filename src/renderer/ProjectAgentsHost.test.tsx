/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import { LocalAssignmentItemSchema } from "../shared/assignment-ui-contracts";
import { LocalAgentWorkspaceSchema } from "../shared/agent-ui-contracts";
import { LocalAgentSchema, LocalAgentVersionSchema } from "../shared/agent-contracts";
import { AGENT_SESSION_CONTRACT_VERSION } from "../shared/agent-session-contracts";
import { buildAgentDefinition, initialLocalAgentForm } from "./local-agent-form";
import { LocalNavigationProvider, localRouteHash, parseLocalRoute } from "./navigation";
import { ProjectAgentsHost } from "./ProjectAgentsHost";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const hash = `sha256:${"a".repeat(64)}`;
const expected = { revision: 3, hash };
const context = { org_id: "org", project_id: "project", principal: { type: "user", id: "owner" } };
const time = "2026-09-24T00:00:00Z";
const definition = { ...buildAgentDefinition({ ...initialLocalAgentForm("agent"), name: "Researcher" }).definition!,
  toolGrants: { schema_version: "tool_grants@1" as const, grants: [] } };
const localVersion = LocalAgentVersionSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context,
  id: "agent-v2", agentId: "agent-1", versionNumber: 2, definition, createdAt: time });
const localAgent = LocalAgentSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context,
  id: "agent-1", nodeType: "agent", name: "Researcher", description: null, userGuide: null,
  latestVersionId: "agent-v2", legacyDraft: null, createdAt: time, updatedAt: time, deletedAt: null });
const workspace = LocalAgentWorkspaceSchema.parse({ schemaVersion: "orchestrion.local.agent.ui.v3", projectId: "project", expected, agents: [{ agent: localAgent, latestVersion: localVersion }] });
const item = LocalAssignmentItemSchema.parse({
  assignment: { schemaVersion: AGENT_SESSION_CONTRACT_VERSION, id: "assignment-1", orgId: "org", projectId: "project",
    agentId: "agent-1", currentAssignmentVersionId: null, status: "active" },
  agent: { identityState: "governed", identity: { schemaVersion: AGENT_SESSION_CONTRACT_VERSION, id: "agent-1", orgId: "org",
    name: "Researcher", visibility: "organization", homeProjectId: "project", derivedFromAgentVersionId: null,
    agentPrincipal: { type: "agent", id: "agent-1" } } },
  migrationState: "governed", currentVersion: null,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function mount(request: OrchestrionDesktopApi["localAssignments"]["request"], rows = workspace) {
  const api = { localAssignments: { request } } as OrchestrionDesktopApi;
  await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}>
    <ProjectAgentsHost projectId="project" workspace={rows} api={api} />
  </LocalNavigationProvider>));
}
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.includes(text));
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}

describe("Project Agent placement", () => {
  it("keeps the Project route distinct from the existing Agent definition and Session routes", () => {
    const route = { kind: "project-agents" as const, projectId: "project" };
    expect(parseLocalRoute(localRouteHash(route))).toEqual(route);
    expect(parseLocalRoute(localRouteHash({ kind: "project-agent-add", projectId: "project", agentId: "agent-1" }))).toEqual({ kind: "project-agent-add", projectId: "project", agentId: "agent-1" });
    expect(parseLocalRoute(localRouteHash({ kind: "agent-library-detail", projectId: "project", agentId: "agent-1" }))).toEqual({ kind: "agent-library-detail", projectId: "project", agentId: "agent-1" });
    expect(parseLocalRoute("#/projects/project/agents").kind).toBe("local-agents");
    expect(parseLocalRoute("#/projects/project/agents/agent-1/sessions/session-1").kind).toBe("session");
  });

  it("reads only the host project ledger and requires an explicit lifecycle command", async () => {
    let disabled = false;
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "catalog.list") return { kind: "catalog.page" as const, expected, items: [], total: 0 };
      if (input.operation === "list") return { kind: "page" as const, expected, items: [{ ...item, assignment: { ...item.assignment, status: disabled ? "disabled" as const : "active" as const } }] };
      expect(input).toMatchObject({ operation: "disable", expected, payload: { id: "assignment-1" } });
      disabled = true;
      return { kind: "command" as const, expected, resultRef: "assignment-1", replayed: false };
    });
    await mount(request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Assigned Agents"]')).toBeTruthy();
    await click("Researcher");
    expect(container.textContent).toContain("No Assignment version released");
    expect(container.textContent).toContain("does not imply Session or Workflow execution readiness");
    await click("Disable for new work");
    expect(request).toHaveBeenCalledTimes(5);
    expect(container.textContent).toContain("Enable");
  });

  it("shows immutable pin drift without silently adopting a newer Agent version", async () => {
    const currentVersion = {
      schemaVersion: AGENT_SESSION_CONTRACT_VERSION, id: "assignment-v1", orgId: "org", assignmentId: "assignment-1",
      revision: 1, agentVersionId: "agent-v1", parameterValues: {}, connectionBindings: [], credentialReferences: [],
      workspaceScope: { mode: "none", pathPrefixes: [] }, policyReferences: [], dataScope: { domains: [], resourceReferences: [] },
      authorityCeiling: { organizationCeilingHash: hash, principalGrantHash: hash, agentVersionGrantHash: hash, directGrantVersionIds: [] },
      memoryScopeCeiling: { projectId: "project", allowedWorkflowIds: [], allowedDataDomains: [], projectPromotionAllowed: false, organizationPromotionAllowed: false },
      placementConstraints: { allowed: ["local_trusted"], fallback: "forbidden" }, budgetCeilings: { modelTokens: 1000, toolCalls: 1, costUsd: 0 },
      resolvedConfigHash: hash, authorityCeilingHash: hash, memoryScopeHash: hash, createdAt: time, createdByPrincipalId: "owner",
    };
    const pinned = LocalAssignmentItemSchema.parse({ ...item, assignment: { ...item.assignment, currentAssignmentVersionId: "assignment-v1" }, currentVersion });
    if (item.agent.identityState !== "governed") throw new Error("Expected governed fixture");
    const catalogIdentity = item.agent.identity;
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => input.operation === "catalog.list"
      ? { kind: "catalog.page" as const, expected, items: [{ identity: catalogIdentity,
          latestVersionId: "agent-v2", latestVersionNumber: 2, assignmentStatus: "active" as const, eligibleForAdd: false }], total: 1 }
      : { kind: "page" as const, expected, items: [pinned] });
    await mount(request);
    await click("Researcher");
    expect(container.textContent).toContain("New Agent version available");
    expect(container.textContent).toContain("remains pinned to its prior version");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("requires deliberate removal confirmation and preserves the host result as the only truth", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "catalog.list") return { kind: "catalog.page" as const, expected, items: [], total: 0 };
      if (input.operation === "list") return { kind: "page" as const, expected, items: [item] };
      return { kind: "command" as const, expected, resultRef: "assignment-1", replayed: false };
    });
    await mount(request);
    await click("Researcher");
    await click("Remove from Project");
    expect(container.querySelector('[role="group"][aria-labelledby="remove-assignment-title"]')).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
    await click("Cancel");
    expect(request).toHaveBeenCalledTimes(2);
    await click("Remove from Project");
    const confirm = container.querySelector<HTMLButtonElement>('[aria-labelledby="remove-assignment-title"] .danger-button')!;
    await act(async () => confirm.click());
    expect(request.mock.calls.find(([input]) => input.operation === "remove")?.[0]).toMatchObject({ operation: "remove", payload: { id: "assignment-1" } });
  });

  it("rejects an out-of-project page before exposing rows or actions", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => input.operation === "catalog.list"
      ? { kind: "catalog.page" as const, expected, items: [], total: 0 }
      : { kind: "page" as const, expected, items: [{ ...item, assignment: { ...item.assignment, projectId: "another-project" } }] });
    await mount(request);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("different Project context");
    expect(container.querySelector('[aria-label="Assigned Agents"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
