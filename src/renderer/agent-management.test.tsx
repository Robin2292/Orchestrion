/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import { CatalogAgentItemSchema, CatalogAgentVersionSchema, LocalAssignmentItemSchema } from "../shared/assignment-ui-contracts";
import { AGENT_SESSION_CONTRACT_VERSION } from "../shared/agent-session-contracts";
import { serializeToolGrants } from "../shared/tool-grant-contracts";
import { LocalNavigationProvider, LocalRouteLink, useLocalNavigation } from "./navigation";
import { ProjectAgentAddHost } from "./ProjectAgentAddHost";
import { ProjectAgentsHost } from "./ProjectAgentsHost";
import { OrganizationAgentLibraryHost } from "./OrganizationAgentLibraryHost";
import { GovernedAgentCreateForm } from "./GovernedAgentCreateForm";
import { buildAgentDefinition, initialLocalAgentForm } from "./local-agent-form";
import { EMPTY_DIRECT_GRANTS_HASH, configurationForProject, versionCanBeConfigured } from "./assignment-config";
import { readAgentCatalog } from "./agent-catalog-client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const hash = `sha256:${"a".repeat(64)}`;
const pin = { revision: 1, hash };
const nextPin = { revision: 2, hash: `sha256:${"b".repeat(64)}` };
const time = "2026-09-24T00:00:00Z";
const definition = { ...buildAgentDefinition({ ...initialLocalAgentForm("agent"), name: "Shared" }).definition!,
  toolGrants: { schema_version: "tool_grants@1" as const, grants: [] } };
const version1 = CatalogAgentVersionSchema.parse({ id: "agent-v1", versionNumber: 1, definition, createdAt: time });
const version2 = CatalogAgentVersionSchema.parse({ id: "agent-v2", versionNumber: 2,
  definition: { ...definition, systemPrompt: "A reviewed new instruction",
    inputSchema: { type: "object", properties: { task: { type: "string" } } }, interactionMode: "approval_gated" }, createdAt: time });
const shared = CatalogAgentItemSchema.parse({ identity: { schemaVersion: AGENT_SESSION_CONTRACT_VERSION,
  id: "shared-agent", orgId: "org", name: "Shared", visibility: "organization", homeProjectId: "other-project",
  derivedFromAgentVersionId: null, agentPrincipal: { type: "agent", id: "shared-agent" } },
  latestVersionId: "agent-v2", latestVersionNumber: 2, assignmentStatus: null, eligibleForAdd: true });
const projectOnly = CatalogAgentItemSchema.parse({ ...shared, identity: { ...shared.identity,
  id: "project-agent", name: "Project private", visibility: "project", homeProjectId: "project",
  agentPrincipal: { type: "agent", id: "project-agent" } } });
const assignment = LocalAssignmentItemSchema.parse({ assignment: { schemaVersion: AGENT_SESSION_CONTRACT_VERSION,
  id: "assignment-1", orgId: "org", projectId: "project", agentId: "shared-agent",
  currentAssignmentVersionId: null, status: "active" }, agent: { identityState: "governed", identity: shared.identity },
  migrationState: "governed", currentVersion: null });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); window.history.replaceState({}, "", "#/projects/project/project-agents/add/shared-agent"); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const click = async (text: string) => {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((row) => row.textContent?.includes(text));
  expect(button, text).toBeTruthy(); await act(async () => button!.click());
};
const baseReply = (operation: string, items = [shared], assignments = [] as typeof assignment[]) => {
  if (operation === "catalog.list") return { kind: "catalog.page" as const, expected: pin, items, total: items.length };
  if (operation === "catalog.detail") return { kind: "catalog.detail" as const, expected: pin, item: shared,
    versions: [version2, version1], totalVersions: 2 };
  if (operation === "list") return { kind: "page" as const, expected: pin, items: assignments };
  throw new Error(`Unexpected ${operation}`);
};
async function mountAdd(request: OrchestrionDesktopApi["localAssignments"]["request"], onDirty = vi.fn()) {
  const api = { localAssignments: { request }, localAgents: { snapshot: vi.fn().mockResolvedValue({ workspace: { projectId: "project" } }) } } as unknown as OrchestrionDesktopApi;
  await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}><ProjectAgentAddHost
    route={{ kind: "project-agent-add", projectId: "project", agentId: "shared-agent" }} workspace={null} api={api}
    onWorkspaceChange={() => {}} onDirtyStateChange={onDirty} /></LocalNavigationProvider>));
  return api;
}

describe("Agent Library and Project assignment contract", () => {
  it("uses the canonical empty grant digest and validates bounded budget inputs", () => {
    expect(EMPTY_DIRECT_GRANTS_HASH).toBe(`sha256:${createHash("sha256").update(serializeToolGrants({ schema_version: "tool_grants@1", grants: [] })).digest("hex")}`);
    expect(versionCanBeConfigured(version2)).toBe(true);
    expect(configurationForProject("project", { modelTokens: "1000", toolCalls: "1", costUsd: "0" })).toMatchObject({
      authorityCeiling: { organizationCeilingHash: EMPTY_DIRECT_GRANTS_HASH },
      memoryScopeCeiling: { projectId: "project" }, placementConstraints: { fallback: "forbidden" },
    });
    expect(configurationForProject("project", { modelTokens: "0", toolCalls: "1", costUsd: "0" })).toBeNull();
    expect(configurationForProject("project", { modelTokens: "1000", toolCalls: "1.5", costUsd: "0" })).toBeNull();
    expect(configurationForProject("project", { modelTokens: "1000", toolCalls: "1", costUsd: "0" },
      ["grant-1", "grant-1"])).toBeNull();
  });

  it("keeps an Agent version with omitted Tool grants Not Ready in the add flow", async () => {
    const { toolGrants: _omitted, ...legacyDefinition } = version2.definition;
    void _omitted;
    const unconverted = CatalogAgentVersionSchema.parse({ ...version2, definition: legacyDefinition });
    expect(versionCanBeConfigured(unconverted)).toBe(false);
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "catalog.detail") return { kind: "catalog.detail" as const,
        expected: pin, item: shared, versions: [unconverted], totalVersions: 1 };
      return baseReply(input.operation);
    });
    await mountAdd(request);
    expect(container.textContent).toContain("Not Ready · AGENT_VERSION_NOT_READY");
    expect(container.querySelector(".project-agent-budget")).toBeNull();
    expect(request.mock.calls.some(([input]) => input.operation === "add" || input.operation === "configure")).toBe(false);
  });

  it("guards selected grants, shows typed Not Ready, and submits only a host-checked narrowing", async () => {
    const grant = { tool: { source: "reviewed-source", key: "docs.read" },
      contract: { id: "contract-1", hash }, connection: { kind: "local_connector", id: "connector-1", authority_hash: hash },
      execution_target: null, resource_scope: { kind: "workspace_path", resource: "/workspace/docs" },
      constraints: { effects: ["read"], argument_schema_hash: hash, max_output_bytes: 1024, max_runtime_seconds: 10 },
      policy: { id: "policy-1", hash }, approval: null };
    const granted = CatalogAgentVersionSchema.parse({ ...version2,
      definition: { ...version2.definition, toolGrants: { schema_version: "tool_grants@1", grants: [grant] } } });
    let ready = false;
    const placed = { ...shared, assignmentStatus: "active" as const, eligibleForAdd: false };
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "catalog.detail") return { kind: "catalog.detail" as const, expected: pin,
        item: placed, versions: [granted], totalVersions: 1 };
      if (input.operation === "grant.preview") return { kind: "grant.preview" as const,
        assignmentId: input.assignmentId, agentVersionId: input.agentVersionId,
        options: [{ principalVersionId: "grant-1", grant: granted.definition.toolGrants!.grants[0] }],
        readiness: input.principalVersionIds.length ? ready
          ? { state: "ready" as const, executionReady: false as const }
          : { state: "not_ready" as const, reason: "SOURCE_NOT_READY" as const, executionReady: false as const }
          : { state: "empty" as const, executionReady: false as const } };
      if (input.operation === "configure") return { kind: "command" as const, expected: nextPin,
        resultRef: "assignment-v1", replayed: false };
      return baseReply(input.operation, [placed], [assignment]);
    });
    const onDirty = vi.fn();
    await mountAdd(request, onDirty);
    const checkbox = container.querySelector<HTMLInputElement>('.project-agent-grant input[type="checkbox"]')!;
    expect(checkbox).toBeTruthy();
    await act(async () => checkbox.click());
    expect(container.textContent).toContain("Not Ready · SOURCE_NOT_READY");
    expect(container.textContent).toContain("Unsaved changes");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await click("Create Project variant");
    expect(container.textContent).toContain("Discard unsaved changes?");
    await click("Keep editing");
    ready = true;
    await act(async () => checkbox.click());
    await act(async () => checkbox.click());
    expect(container.textContent).toContain("docs-only release");
    await click("Use as-is · release pin");
    expect(request.mock.calls.find(([input]) => input.operation === "configure")?.[0]).toMatchObject({
      payload: { assignmentId: "assignment-1", agentVersionId: "agent-v2",
        config: { authorityCeiling: { directGrantVersionIds: ["grant-1"] } } },
    });
    expect(request.mock.calls.some(([input]) => input.operation === "add")).toBe(false);
  });

  it("loads bounded catalog pages and rejects a revision change before showing an incomplete list", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ ...shared,
      identity: { ...shared.identity, id: `agent-${index}`, agentPrincipal: { type: "agent" as const, id: `agent-${index}` } } }));
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation !== "catalog.list") throw new Error("Unexpected request");
      return { kind: "catalog.page" as const, expected: pin,
        items: rows.slice(input.offset, input.offset + input.limit), total: rows.length };
    });
    const api = { localAssignments: { request } } as unknown as OrchestrionDesktopApi;
    expect((await readAgentCatalog(api)).items).toHaveLength(101);
    expect(request.mock.calls.map(([input]) => input.operation === "catalog.list" ? input.offset : -1)).toEqual([0, 100]);
    request.mockImplementation(async (input) => ({ kind: "catalog.page", expected: input.operation === "catalog.list" && input.offset === 0 ? pin : nextPin,
      items: input.operation === "catalog.list" ? rows.slice(input.offset, input.offset + input.limit) : [], total: rows.length }));
    await expect(readAgentCatalog(api)).rejects.toThrow("REVISION_CONFLICT");
  });

  it("adds a cross-Project organization Agent, then releases only an exact selected version", async () => {
    let added = false;
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "add") { added = true; return { kind: "command" as const, expected: nextPin, resultRef: "assignment-1", replayed: false }; }
      if (input.operation === "configure") return { kind: "command" as const, expected: { revision: 3, hash }, resultRef: "assignment-version-1", replayed: false };
      return baseReply(input.operation, [shared], added ? [assignment] : []);
    });
    await mountAdd(request);
    expect(container.textContent).toContain("Shared");
    expect(request.mock.calls.some(([input]) => input.operation === "add")).toBe(false);
    await click("Use as-is · release pin");
    const add = request.mock.calls.find(([input]) => input.operation === "add")![0];
    const configure = request.mock.calls.find(([input]) => input.operation === "configure")![0];
    expect(add).toMatchObject({ expected: pin, payload: { agentId: "shared-agent" } });
    expect(configure).toMatchObject({ expected: nextPin, payload: { assignmentId: "assignment-1", agentVersionId: "agent-v2",
      config: { parameterValues: {}, connectionBindings: [], credentialReferences: [], policyReferences: [],
        authorityCeiling: { agentVersionGrantHash: EMPTY_DIRECT_GRANTS_HASH }, budgetCeilings: { modelTokens: 1000, toolCalls: 1, costUsd: 0 } } } });
    expect(add).not.toHaveProperty("orgId");
    expect(window.location.hash).toBe("#/projects/project/project-agents");
  });

  it("reports a partial add when host authority refuses the release", async () => {
    let added = false;
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "add") { added = true; return { kind: "command" as const, expected: nextPin, resultRef: "assignment-1", replayed: false }; }
      if (input.operation === "configure") throw new Error("ASSIGNMENT_NOT_READY");
      return baseReply(input.operation, [shared], added ? [assignment] : []);
    });
    await mountAdd(request);
    await click("Use as-is · release pin");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Agent added to this Project, but no Assignment version was released");
    expect(window.location.hash).toContain("/add/shared-agent");
    expect(request.mock.calls.filter(([input]) => input.operation === "add")).toHaveLength(1);
  });

  it("shows a version diff and requires explicit update for an existing pinned Assignment", async () => {
    const current = { ...assignment, assignment: { ...assignment.assignment, currentAssignmentVersionId: "assignment-v1" },
      currentVersion: { schemaVersion: AGENT_SESSION_CONTRACT_VERSION, id: "assignment-v1", orgId: "org", assignmentId: "assignment-1",
        revision: 1, agentVersionId: "agent-v1", parameterValues: {}, connectionBindings: [], credentialReferences: [],
        workspaceScope: { mode: "none" as const, pathPrefixes: [] }, policyReferences: [], dataScope: { domains: [], resourceReferences: [] },
        authorityCeiling: { organizationCeilingHash: hash, principalGrantHash: hash, agentVersionGrantHash: hash, directGrantVersionIds: [] },
        memoryScopeCeiling: { projectId: "project", allowedWorkflowIds: [], allowedDataDomains: [], projectPromotionAllowed: false, organizationPromotionAllowed: false as const },
        placementConstraints: { allowed: ["local_trusted" as const], fallback: "forbidden" as const }, budgetCeilings: { modelTokens: 2000, toolCalls: 2, costUsd: 0 },
        resolvedConfigHash: hash, authorityCeilingHash: hash, memoryScopeHash: hash, createdAt: time, createdByPrincipalId: "owner" } };
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "update") return { kind: "command" as const, expected: nextPin, resultRef: "assignment-v2", replayed: false };
      return baseReply(input.operation, [{ ...shared, assignmentStatus: "active", eligibleForAdd: false }], [current as typeof assignment]);
    });
    await mountAdd(request);
    expect(container.textContent).toContain("Explicit version adoption");
    expect(container.textContent).toContain("systemPrompt");
    const promptChange = container.querySelector('[aria-label="systemPrompt change"]')!;
    expect([...promptChange.querySelectorAll("pre")].map((node) => node.textContent)).toEqual([
      JSON.stringify(version1.definition.systemPrompt, null, 2), JSON.stringify(version2.definition.systemPrompt, null, 2),
    ]);
    const schemaChange = container.querySelector('[aria-label="inputSchema change"]')!;
    expect([...schemaChange.querySelectorAll("pre")].map((node) => node.textContent)).toEqual([
      JSON.stringify(version1.definition.inputSchema, null, 2), JSON.stringify(version2.definition.inputSchema, null, 2),
    ]);
    const behaviorChange = container.querySelector('[aria-label="interactionMode change"]')!;
    expect([...behaviorChange.querySelectorAll("pre")].map((node) => node.textContent)).toEqual([
      JSON.stringify(version1.definition.interactionMode, null, 2), JSON.stringify(version2.definition.interactionMode, null, 2),
    ]);
    expect(request.mock.calls.some(([input]) => input.operation === "update")).toBe(false);
    await click("Use as-is · release pin");
    expect(request.mock.calls.find(([input]) => input.operation === "update")?.[0]).toMatchObject({ payload: {
      assignmentId: "assignment-1", agentVersionId: "agent-v2", config: { budgetCeilings: { modelTokens: 2000, toolCalls: 2, costUsd: 0 } },
    } });
    expect(request.mock.calls.some(([input]) => input.operation === "add")).toBe(false);
  });

  it("keeps a dirty budget until the user explicitly discards it before switching versions", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => baseReply(input.operation));
    await mountAdd(request);
    const budget = container.querySelector<HTMLInputElement>('input[aria-label="Project model token budget"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(budget, "1700");
      budget.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(budget.value).toBe("1700");
    expect(container.textContent).toContain("Unsaved changes");
    await click("v1");
    expect(container.querySelector('[aria-label="Discard edits before changing Agent version"]')?.textContent).toContain("Discard unsaved changes?");
    expect(container.textContent).toContain("Selected Agent versionv2");
    expect(budget.value).toBe("1700");
    await click("Keep editing");
    expect(container.querySelector('[aria-label="Discard edits before changing Agent version"]')).toBeNull();
    expect(budget.value).toBe("1700");
    await click("Create Project variant");
    expect(container.querySelector('[aria-label="Discard edits before changing Project mode"]')?.textContent).toContain("Discard unsaved changes?");
    expect(budget.value).toBe("1700");
    await click("Keep editing");
    await click("v1");
    await click("Discard changes and switch version");
    expect(container.textContent).toContain("Selected Agent versionv1");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Project model token budget"]')?.value).toBe("1000");
    expect(request.mock.calls.some(([input]) => input.operation === "update" || input.operation === "configure")).toBe(false);
  });

  it("creates a Project variant from the exact source snapshot with separate provenance", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) => {
      if (input.operation === "create") return { kind: "command" as const, expected: nextPin, resultRef: "variant-1", replayed: false };
      return baseReply(input.operation);
    });
    await mountAdd(request);
    await click("Create Project variant");
    expect(container.textContent).toContain("Copies exact source v2");
    expect(request.mock.calls.some(([input]) => input.operation === "create")).toBe(false);
    const save = container.querySelector<HTMLButtonElement>(".governed-agent-form button[type=submit]")!;
    await act(async () => save.click());
    expect(request.mock.calls.find(([input]) => input.operation === "create")?.[0]).toMatchObject({ payload: {
      visibility: "project", sourceVersionId: "agent-v2", definition: version2.definition,
    } });
  });

  it("creates an organization Agent with an explicit empty Tool ceiling and no fabricated source", async () => {
    const request = vi.fn().mockResolvedValue({ kind: "command", expected: nextPin, resultRef: "org-agent-1", replayed: false });
    const api = { localAssignments: { request } } as unknown as OrchestrionDesktopApi;
    const created = vi.fn();
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}>
      <GovernedAgentCreateForm api={api} expected={pin} visibility="organization" onCreated={created} onDirtyStateChange={() => {}} />
    </LocalNavigationProvider>));
    const name = container.querySelector<HTMLInputElement>('.governed-agent-form input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "New shared Agent");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.governed-agent-form button[type=submit]')!.click());
    expect(request.mock.calls[0][0]).toMatchObject({ operation: "create", expected: pin, payload: {
      name: "New shared Agent", visibility: "organization", sourceVersionId: null,
      definition: { nodeType: "agent", toolGrants: { schema_version: "tool_grants@1", grants: [] } },
    } });
    expect(created).toHaveBeenCalledWith("org-agent-1");
  });

  it("filters Project-only identities out of Organization Library without changing the host page", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) =>
      baseReply(input.operation, [shared, projectOnly]));
    const api = { localAssignments: { request } } as unknown as OrchestrionDesktopApi;
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}><OrganizationAgentLibraryHost
      route={{ kind: "agent-library", projectId: "project" }} api={api} workspace={null}
      onWorkspaceChange={() => {}} onDirtyStateChange={() => {}} /></LocalNavigationProvider>));
    expect(container.querySelector('[aria-label="Organization Agents"]')?.textContent).toContain("Shared");
    expect(container.querySelector('[aria-label="Organization Agents"]')?.textContent).not.toContain("Project private");
    const header = container.querySelector("header.local-page-heading")!;
    expect(header.querySelector("h1")?.textContent).toBe("Organization Agent Library");
    expect(header.querySelector(".eyebrow, p")).toBeNull();
    expect([...header.querySelectorAll("a")].map((link) => link.textContent?.trim())).toEqual([
      "Project Agents", "Local definitions", "New organization Agent",
    ]);
  });

  it("keeps Library detail labels while showing only the page title and actions in its header", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) =>
      baseReply(input.operation));
    const api = { localAssignments: { request } } as unknown as OrchestrionDesktopApi;
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}><OrganizationAgentLibraryHost
      route={{ kind: "agent-library-detail", projectId: "project", agentId: "shared-agent" }} api={api} workspace={null}
      onWorkspaceChange={() => {}} onDirtyStateChange={() => {}} /></LocalNavigationProvider>));
    const header = container.querySelector("header.local-page-heading")!;
    expect(header.querySelector("h1")?.textContent).toBe("Agent detail");
    expect(header.querySelector(".eyebrow, p")).toBeNull();
    expect(container.querySelector(".project-agent-detail-heading .eyebrow")?.textContent).toBe("Organization Agent");
    expect(container.querySelector(".agent-version-rail .eyebrow")?.textContent).toContain("Immutable versions");
  });

  it("keeps Project Agent actions and detail labels without page-header extras", async () => {
    const request = vi.fn(async (input: Parameters<OrchestrionDesktopApi["localAssignments"]["request"]>[0]) =>
      baseReply(input.operation, [shared], [assignment]));
    const api = { localAssignments: { request } } as unknown as OrchestrionDesktopApi;
    await act(async () => root.render(<LocalNavigationProvider isDirty={false} onDiscard={() => {}}><ProjectAgentsHost
      projectId="project" workspace={null} api={api} /></LocalNavigationProvider>));
    const header = container.querySelector("header.local-page-heading")!;
    expect(header.querySelector("h1")?.textContent).toBe("Project Agents");
    expect(header.querySelector(".eyebrow, p")).toBeNull();
    expect([...header.querySelectorAll("a")].map((link) => link.textContent?.trim())).toEqual([
      "Organization Library", "Add Agent", "Definitions",
    ]);
    await click("Shared");
    expect(container.querySelector(".project-agent-detail-heading .eyebrow")?.textContent).toBe("Exact Project Assignment");
  });

  it("holds route navigation until a changed Agent form is explicitly discarded", async () => {
    const request = vi.fn();
    const api = { localAssignments: { request } } as unknown as OrchestrionDesktopApi;
    function GuardProbe() {
      const { pendingRoute, confirmPending } = useLocalNavigation();
      return <><LocalRouteLink to={{ kind: "project-agents", projectId: "project" }}>Leave form</LocalRouteLink>
        {pendingRoute && <button type="button" onClick={confirmPending}>Discard and leave</button>}</>;
    }
    function Harness() {
      const [dirty, setDirty] = useState(false);
      const [discard, setDiscard] = useState<() => void>(() => () => undefined);
      const handleDirty = useCallback((value: boolean, reset: () => void) => {
        setDirty(value); setDiscard(() => reset);
      }, []);
      return <LocalNavigationProvider isDirty={dirty} onDiscard={() => { discard(); setDirty(false); }}>
        <GovernedAgentCreateForm api={api} expected={pin} visibility="organization" onCreated={() => {}}
          onDirtyStateChange={handleDirty} />
        <GuardProbe />
      </LocalNavigationProvider>;
    }
    await act(async () => root.render(<Harness />));
    const name = container.querySelector<HTMLInputElement>('.governed-agent-form input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Draft");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Unsaved changes");
    const before = window.location.hash;
    await act(async () => container.querySelector<HTMLAnchorElement>("a[href$='/project-agents']")!.click());
    expect(window.location.hash).toBe(before);
    expect(container.textContent).toContain("Discard and leave");
    await click("Discard and leave");
    expect(window.location.hash).toBe("#/projects/project/project-agents");
    expect(request).not.toHaveBeenCalled();
  });
});
