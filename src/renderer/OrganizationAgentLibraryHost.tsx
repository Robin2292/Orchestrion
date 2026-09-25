import { AlertCircle, ArrowLeft, Bot, ChevronRight, History, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { LocalAgentWorkspace } from "../shared/agent-ui-contracts";
import type { LocalAssignmentUiValue } from "../shared/assignment-ui-contracts";
import { readAgentCatalog, readAgentCatalogDetail } from "./agent-catalog-client";
import { GovernedAgentCreateForm } from "./GovernedAgentCreateForm";
import { AgentSoulEditor, AgentSoulVersionDiff } from "./AgentSoulEditor";
import { LocalRouteLink, useLocalNavigation, type LocalRoute } from "./navigation";

type LibraryRoute = Extract<LocalRoute, { kind: "agent-library" | "agent-library-detail" | "agent-library-create" }>;
type Detail = Extract<LocalAssignmentUiValue, { kind: "catalog.detail" }>;
type DirtyHandler = (dirty: boolean, discard: () => void) => void;

export function catalogErrorMessage(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : "SERVICE_UNAVAILABLE";
  const messages: Record<string, string> = {
    AGENT_CATALOG_NOT_FOUND: "That Agent is not visible in the organization Library.",
    AGENT_CATALOG_NOT_READY: "This Agent has no current, governed version available in the Library.",
    REVISION_CONFLICT: "The Agent Library changed while loading. Reload it before making a choice.",
    NOT_AUTHENTICATED: "Your Local membership changed. Reopen this page.",
    CONTEXT_MISMATCH: "This page belongs to another Project.",
    OUTCOME_UNKNOWN: "The host could not confirm the last change. Reload before trying again.",
  };
  return messages[code] ?? "The organization Agent Library is unavailable. Reload this page.";
}

export function OrganizationAgentLibraryHost({ route, api, workspace, onWorkspaceChange, onDirtyStateChange }: {
  route: LibraryRoute;
  api: OrchestrionDesktopApi | undefined;
  workspace: LocalAgentWorkspace | null;
  onWorkspaceChange: (workspace: LocalAgentWorkspace) => void;
  onDirtyStateChange: DirtyHandler;
}) {
  const { replace } = useLocalNavigation();
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof readAgentCatalog>> | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "available" | "assigned">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const readEpoch = useRef(0);
  const detailId = route.kind === "agent-library-detail" ? route.agentId : null;

  const reload = useCallback(async () => {
    const epoch = ++readEpoch.current;
    if (!api?.localAssignments?.request) { setError(catalogErrorMessage(null)); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const next = await readAgentCatalog(api);
      const selected = detailId ? await readAgentCatalogDetail(api, detailId) : null;
      if (epoch !== readEpoch.current) return;
      if (selected && selected.item.identity.visibility !== "organization") throw new Error("AGENT_CATALOG_NOT_FOUND");
      setCatalog(next); setDetail(selected);
      setSelectedVersionId(selected?.item.latestVersionId ?? null);
    } catch (reason) { if (epoch === readEpoch.current) { setCatalog(null); setDetail(null); setError(catalogErrorMessage(reason)); } }
    finally { if (epoch === readEpoch.current) setLoading(false); }
  }, [api, detailId]);
  useEffect(() => { void reload(); return () => { readEpoch.current++; }; }, [reload]);

  if (workspace && workspace.projectId !== route.projectId) return <section className="management-host local-agents-host" aria-label="Organization Agent Library"><div className="agent-host-message error" role="alert"><AlertCircle size={20} /><div><strong>Project boundary</strong><p>{catalogErrorMessage(new Error("CONTEXT_MISMATCH"))}</p></div></div></section>;

  const organizationAgents = catalog?.items.filter((item) => item.identity.visibility === "organization") ?? [];
  const visible = organizationAgents.filter((item) => item.identity.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (statusFilter === "all" || (statusFilter === "available" ? item.eligibleForAdd : item.assignmentStatus !== null)));
  const selected = detail?.versions.find((version) => version.id === selectedVersionId) ?? detail?.versions[0] ?? null;
  const previous = detail?.versions.find((version) => version.versionNumber === (selected?.versionNumber ?? 0) - 1) ?? null;
  const changedFields = selected && previous ? Object.keys(selected.definition).filter((key) =>
    JSON.stringify(selected.definition[key as keyof typeof selected.definition]) !== JSON.stringify(previous.definition[key as keyof typeof previous.definition])) : [];

  return <section className="management-host local-agents-host organization-agent-library" aria-label="Organization Agent Library">
    <header className="management-header agent-studio-header local-page-heading"><div><h1>{route.kind === "agent-library-create" ? "New organization Agent" : route.kind === "agent-library-detail" ? "Agent detail" : "Organization Agent Library"}</h1></div><div className="project-agent-header-actions"><LocalRouteLink className="button secondary-button" to={{ kind: "project-agents", projectId: route.projectId }}>Project Agents</LocalRouteLink><LocalRouteLink className="button secondary-button" to={{ kind: "local-agents", projectId: route.projectId }}>Local definitions</LocalRouteLink><LocalRouteLink className="button primary-button" to={{ kind: "agent-library-create", projectId: route.projectId }}><Plus size={14} /> New organization Agent</LocalRouteLink></div></header>
    <div className="management-body agent-studio-body">
      {error && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{error}</span><button type="button" onClick={() => void reload()}>Reload</button></div>}
      {loading && <div className="agent-loading" role="status">Loading organization Agents…</div>}
      {!loading && catalog && route.kind === "agent-library-create" && api && <GovernedAgentCreateForm
        key="organization-create" api={api} expected={catalog.expected} visibility="organization"
        onDirtyStateChange={onDirtyStateChange} onCreated={(id) => {
          void api.localAgents.snapshot().then((value) => onWorkspaceChange(value.workspace)).catch(() => undefined);
          replace({ kind: "agent-library-detail", projectId: route.projectId, agentId: id });
        }} />}
      {!loading && catalog && route.kind === "agent-library" && <>
        <div className="project-agent-statusbar"><label className="organization-agent-search"><Search size={15} /><span className="sr-only">Search organization Agents</span><input aria-label="Search organization Agents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search organization Agents" /></label><label className="agent-field organization-agent-filter"><span>Current Project</span><select aria-label="Filter organization Agents by Project status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All</option><option value="available">Available to add</option><option value="assigned">Already placed</option></select></label><button type="button" className="button secondary-button" onClick={() => void reload()}><RefreshCw size={14} /> Reload</button></div>
        <div className="agent-library-ledger" aria-label="Organization Agents">
          <div className="agent-ledger-heading"><span>Identity</span><span>Visibility</span><span>Latest version</span><span>This Project</span></div>
          {visible.map((item) => <LocalRouteLink key={item.identity.id} className="agent-ledger-row" to={{ kind: "agent-library-detail", projectId: route.projectId, agentId: item.identity.id }}><span className="agent-ledger-identity"><i><Bot size={15} /></i><span><strong>{item.identity.name}</strong><small>{item.identity.id}</small></span></span><span><b>Organization</b><small>Reusable identity</small></span><span><b>v{item.latestVersionNumber}</b><small>Immutable</small></span><span><b>{item.assignmentStatus ?? "Not added"}</b><small>{item.eligibleForAdd ? "Available to add" : item.assignmentStatus ? "Existing placement" : "Read only"}</small><ChevronRight size={15} /></span></LocalRouteLink>)}
          {!visible.length && <div className="management-empty"><Bot size={24} /><h2>{organizationAgents.length ? "No matching Agents" : "No organization Agents yet"}</h2><p>{organizationAgents.length ? "Try another name." : "Create a reusable first-class Agent to make it available to other Projects."}</p></div>}
        </div>
      </>}
      {!loading && detail && route.kind === "agent-library-detail" && <>
        <LocalRouteLink className="management-back" to={{ kind: "agent-library", projectId: route.projectId }}><ArrowLeft size={14} /> Library</LocalRouteLink>
        <div className="project-agent-detail-heading"><span className="eyebrow">Organization Agent</span><h2>{detail.item.identity.name}</h2><span className="project-agent-badge">{detail.item.assignmentStatus ? `This Project: ${detail.item.assignmentStatus}` : "Not in this Project"}</span></div>
        <div className="project-agent-header-actions"><LocalRouteLink className="button primary-button" to={{ kind: "project-agent-add", projectId: route.projectId, agentId: detail.item.identity.id }}>Add or configure in Project</LocalRouteLink></div>
        <div className="agent-detail-layout organization-agent-detail-layout"><aside className="agent-version-rail" aria-label="Agent version history"><span className="eyebrow"><History size={12} /> Immutable versions</span>{detail.versions.map((version) => <button type="button" key={version.id} className={version.id === selected?.id ? "active" : ""} aria-pressed={version.id === selected?.id} onClick={() => setSelectedVersionId(version.id)}>v{version.versionNumber}<small>{new Date(version.createdAt).toLocaleString()}</small></button>)}</aside>
          {selected && <article className="agent-version-sheet" aria-label={`Agent version ${selected.versionNumber}`}><span className="eyebrow">Exact Agent version</span><h2>v{selected.versionNumber}</h2><dl className="agent-definition-facts"><div><dt>Role</dt><dd>{selected.definition.role || "Not set"}</dd></div><div><dt>Provider</dt><dd>{selected.definition.providerType}</dd></div><div><dt>Model</dt><dd>{selected.definition.modelId}</dd></div><div><dt>Tool grants</dt><dd>{selected.definition.toolGrants?.grants.length ?? "Unconverted"}</dd></div></dl><section className="agent-binding-summary" aria-label="Version Tool and Policy bindings"><span className="eyebrow">Exact Tool and Policy bindings</span>{selected.definition.toolGrants?.grants.length ? <ul>{selected.definition.toolGrants.grants.map((grant) => <li key={JSON.stringify(grant)}><strong>{grant.tool.source} / {grant.tool.key}</strong><span>{grant.policy ? `Policy ${grant.policy.id}` : "No Policy reference"}</span></li>)}</ul> : <p>{selected.definition.toolGrants ? "Explicit deny all Tools." : "Legacy Tool configuration is unconverted."}</p>}</section><div className="project-agent-pin pending"><AlertCircle size={17} /><div><strong>Release and Eval status</strong><p>The current Local catalog stores immutable version facts but does not expose Eval or release metadata. Project readiness is decided by its Assignment version and live authority.</p></div></div><section className="project-agent-version-diff" aria-label="Agent version changes"><h3>Changes from previous version</h3><p>{previous ? changedFields.length ? changedFields.join(", ") : "No definition field changes" : "First version"}</p></section><AgentSoulVersionDiff current={selected} previous={previous} /><details className="agent-definition-json"><summary>Complete stored definition</summary><pre>{JSON.stringify(selected.definition, null, 2)}</pre></details></article>}
        </div>
        {api && workspace && detail.item.identity.homeProjectId === route.projectId && detail.versions[0]
          && <AgentSoulEditor api={api} agentId={detail.item.identity.id} latest={detail.versions[0]}
            expected={workspace.expected} onPublished={reload} onDirtyStateChange={onDirtyStateChange} />}
      </>}
    </div>
  </section>;
}
