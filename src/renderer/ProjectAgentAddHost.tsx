import { AlertCircle, ArrowLeft, Bot, CheckCircle2, ChevronRight, CopyPlus, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { LocalAgentWorkspace } from "../shared/agent-ui-contracts";
import type { LocalAssignmentItem, LocalAssignmentUiValue } from "../shared/assignment-ui-contracts";
import { configurationForProject, budgetDraftFromCurrent, versionCanBeConfigured, type BudgetDraft } from "./assignment-config";
import { readAgentCatalog, readAgentCatalogDetail } from "./agent-catalog-client";
import { GovernedAgentCreateForm } from "./GovernedAgentCreateForm";
import { LocalRouteLink, useLocalNavigation, type LocalRoute } from "./navigation";
import { projectAgentErrorMessage, readProjectAssignments } from "./ProjectAgentsHost";

type AddRoute = Extract<LocalRoute, { kind: "project-agent-add" | "project-agent-create" }>;
type Catalog = Awaited<ReturnType<typeof readAgentCatalog>>;
type Detail = Extract<LocalAssignmentUiValue, { kind: "catalog.detail" }>;
type GrantPreview = Extract<LocalAssignmentUiValue, { kind: "grant.preview" }>;
type DirtyHandler = (dirty: boolean, discard: () => void) => void;
type Mode = "as-is" | "configure" | "variant";

function definitionValue(value: unknown) {
  return value === undefined ? "Not present" : JSON.stringify(value, null, 2);
}

const readinessMessage: Record<Extract<GrantPreview["readiness"], {state:"not_ready"}>["reason"], string> = {
  ASSIGNMENT_NOT_READY: "The Assignment is not active or its release proof is unavailable.",
  AGENT_VERSION_NOT_READY: "This exact Agent version is unavailable or unconverted.",
  CEILING_NOT_READY: "The organization or Agent Principal grant ceiling is missing or changed.",
  GRANT_MISMATCH: "The selected grant no longer matches the exact Agent version and Principal ceiling.",
  TOOL_CONTRACT_NOT_READY: "The pinned Tool contract or schema is unavailable.",
  SOURCE_NOT_READY: "The Source, Connector, credential, profile, or Project sharing proof is unavailable.",
  POLICY_NOT_READY: "A pinned Policy or organization Policy floor is unavailable.",
  POLICY_DENIED: "A live Policy denies this grant.",
  POLICY_APPROVAL_REQUIRED: "A live Policy requires approval for this grant.",
  WORKSPACE_NOT_READY: "The Project workspace identity or placement has changed.",
};

function BudgetEditor({ initial, initialIds, assignmentId, agentVersionId, api, mode, onDirtyStateChange, onSubmit, busy }: {
  initial: BudgetDraft;
  initialIds: string[];
  assignmentId: string | null;
  agentVersionId: string;
  api: OrchestrionDesktopApi;
  mode: Exclude<Mode, "variant">;
  onDirtyStateChange: DirtyHandler;
  onSubmit: (draft: BudgetDraft, principalVersionIds: string[]) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [selectedIds, setSelectedIds] = useState(initialIds);
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) ||
    JSON.stringify([...selectedIds].sort()) !== JSON.stringify([...initialIds].sort());
  const initialKey = JSON.stringify(initial);
  const initialIdsKey = JSON.stringify(initialIds);
  const selectedKey = JSON.stringify(selectedIds);
  useEffect(() => {
    if (!assignmentId) return;
    let active = true;
    setPreviewBusy(true); setPreviewError(null);
    void api.localAssignments.request({operation:"grant.preview",assignmentId,agentVersionId,
      principalVersionIds:selectedIds}).then(value => {
      if (!active) return;
      if (value.kind !== "grant.preview" || value.assignmentId !== assignmentId ||
          value.agentVersionId !== agentVersionId) throw new Error("SERVICE_UNAVAILABLE");
      setPreview(value); setPreviewKey(selectedKey);
    }).catch(reason => { if (active) { setPreview(null); setPreviewError(projectAgentErrorMessage(reason)); } })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [api, assignmentId, agentVersionId, selectedKey]);
  useEffect(() => {
    onDirtyStateChange(dirty, () => { setDraft(initial); setSelectedIds(initialIds); });
    return () => onDirtyStateChange(false, () => undefined);
  }, [dirty, initialKey, initialIdsKey, onDirtyStateChange]);
  const valid = configurationForProject("project", draft, selectedIds) !== null;
  const currentPreview = previewKey === selectedKey ? preview : null;
  const releaseReady = !selectedIds.length || currentPreview?.readiness.state === "ready";
  const submit = (event: FormEvent) => { event.preventDefault(); if (valid && releaseReady && !previewBusy) void onSubmit(draft, selectedIds); };
  return <form className="project-agent-budget" onSubmit={submit} noValidate>
    <h3>{mode === "as-is" ? "Use this exact Agent version" : "Configure for this Project"}</h3>
    <p>Choose bounded budgets and an explicit subset of this exact Agent version’s direct grants. Empty selection grants no Tools. A release pins configuration for this Project and does not enable Tool execution.</p>
    {assignmentId && <section className="project-agent-grants" aria-label="Direct grant ceiling"><div className="project-agent-list-heading"><span>Direct grant ceiling</span><strong>{selectedIds.length} selected</strong></div>
      {!!selectedIds.length && <button type="button" className="project-agent-clear-grants" disabled={busy} onClick={() => setSelectedIds([])}>Clear selection · deny all Tools</button>}
      {preview?.options.map(option => <label className="project-agent-grant" key={option.principalVersionId}><input type="checkbox" checked={selectedIds.includes(option.principalVersionId)} disabled={busy || (!selectedIds.includes(option.principalVersionId) && selectedIds.length >= 32)} onChange={event => setSelectedIds(current => event.target.checked ? current.length < 32 ? [...current, option.principalVersionId] : current : current.filter(id => id !== option.principalVersionId))} /><span><strong>{option.grant.tool.source} / {option.grant.tool.key}</strong><small>{option.grant.resource_scope.kind}: {option.grant.resource_scope.resource} · {option.grant.constraints.effects.join(", ")} · Policy {option.grant.policy.id}</small><small>Principal grant version {option.principalVersionId}</small></span></label>)}
      {preview && !preview.options.length && <p className="project-agent-help">No exact live Principal grants match this Agent version. The explicit empty selection is available.</p>}
      {previewBusy && <p className="project-agent-help" role="status">Checking current grant readiness…</p>}
      {previewError && <p className="project-agent-help" role="alert">{previewError}</p>}
      {currentPreview?.readiness.state === "not_ready" && <p className="project-agent-help" role="alert"><strong>Not Ready · {currentPreview.readiness.reason}</strong> — {readinessMessage[currentPreview.readiness.reason]}</p>}
      {currentPreview?.readiness.state === "ready" && <p className="project-agent-help" role="status">Current host proof supports a docs-only release for this selection. The host checks every pin again when releasing.</p>}
      {currentPreview?.readiness.state === "empty" && <p className="project-agent-help">Explicit empty selection · no Tool authority.</p>}
    </section>}
    <div className="agent-form-grid">
      <label className="agent-field"><span>Model tokens</span><input aria-label="Project model token budget" inputMode="numeric" value={draft.modelTokens} onChange={(event) => setDraft((current) => ({ ...current, modelTokens: event.target.value }))} /></label>
      <label className="agent-field"><span>Tool calls</span><input aria-label="Project tool call budget" inputMode="numeric" value={draft.toolCalls} onChange={(event) => setDraft((current) => ({ ...current, toolCalls: event.target.value }))} /></label>
      <label className="agent-field"><span>Cost USD</span><input aria-label="Project cost budget USD" inputMode="decimal" value={draft.costUsd} onChange={(event) => setDraft((current) => ({ ...current, costUsd: event.target.value }))} /></label>
    </div>
    {!valid && <p className="project-agent-help" role="alert">Enter positive whole numbers for tokens and Tool calls, and a nonnegative cost.</p>}
    <div className="agent-editor-actions"><span className="agent-editor-status">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>{dirty && <button type="button" className="button secondary-button" onClick={() => { setDraft(initial); setSelectedIds(initialIds); }}>Discard changes</button>}<button type="submit" className="button primary-button" disabled={busy || previewBusy || !valid || !releaseReady}><CheckCircle2 size={14} /> {busy ? "Saving…" : mode === "as-is" ? "Use as-is · release pin" : "Release Project configuration"}</button></div>
  </form>;
}

export function ProjectAgentAddHost({ route, api, workspace, onWorkspaceChange, onDirtyStateChange }: {
  route: AddRoute;
  api: OrchestrionDesktopApi | undefined;
  workspace: LocalAgentWorkspace | null;
  onWorkspaceChange: (workspace: LocalAgentWorkspace) => void;
  onDirtyStateChange: DirtyHandler;
}) {
  const { navigate, replace } = useLocalNavigation();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [assignments, setAssignments] = useState<Awaited<ReturnType<typeof readProjectAssignments>> | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("as-is");
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readEpoch = useRef(0);
  const discardConfiguration = useRef<() => void>(() => undefined);
  const routeAgentId = route.kind === "project-agent-add" ? route.agentId : null;
  const handleEditorDirty = useCallback((dirty: boolean, discard: () => void) => {
    discardConfiguration.current = discard;
    setConfigurationDirty(dirty);
    onDirtyStateChange(dirty, discard);
  }, [onDirtyStateChange]);
  useEffect(() => { setMode("as-is"); setPendingVersionId(null); setPendingMode(null); }, [routeAgentId]);

  const selectVersion = (id: string) => {
    if (id === selectedVersionId) return;
    if (configurationDirty) { setPendingVersionId(id); return; }
    setSelectedVersionId(id);
  };

  const selectMode = (next: Mode) => {
    if (next === mode) return;
    if (configurationDirty && (mode === "variant" || next === "variant")) { setPendingMode(next); return; }
    setMode(next);
  };

  const confirmPendingChange = () => {
    if (!pendingVersionId && !pendingMode) return;
    discardConfiguration.current();
    if (pendingVersionId) setSelectedVersionId(pendingVersionId);
    if (pendingMode) setMode(pendingMode);
    setPendingVersionId(null);
    setPendingMode(null);
  };

  const reload = useCallback(async () => {
    const epoch = ++readEpoch.current;
    if (!api?.localAssignments?.request) { setError(projectAgentErrorMessage(null)); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const [nextCatalog, nextAssignments] = await Promise.all([
        readAgentCatalog(api), readProjectAssignments(api, route.projectId),
      ]);
      const id = routeAgentId;
      const nextDetail = id ? await readAgentCatalogDetail(api, id) : null;
      if (epoch !== readEpoch.current) return;
      if (nextDetail && !nextCatalog.items.some((item) => item.identity.id === id)) throw new Error("AGENT_CATALOG_NOT_FOUND");
      setCatalog(nextCatalog); setAssignments(nextAssignments); setDetail(nextDetail);
      setSelectedVersionId((previous) => nextDetail?.versions.some((version) => version.id === previous) ? previous : nextDetail?.item.latestVersionId ?? null);
    } catch (reason) { if (epoch === readEpoch.current) { setCatalog(null); setAssignments(null); setDetail(null); setError(projectAgentErrorMessage(reason)); } }
    finally { if (epoch === readEpoch.current) setLoading(false); }
  }, [api, route.projectId, routeAgentId]);
  useEffect(() => { void reload(); return () => { readEpoch.current++; }; }, [reload]);

  if (workspace && workspace.projectId !== route.projectId) return <section className="management-host local-agents-host" aria-label="Add Agent"><div className="agent-host-message error" role="alert"><AlertCircle size={20} /><div><strong>Project boundary</strong><p>{projectAgentErrorMessage(new Error("CONTEXT_MISMATCH"))}</p></div></div></section>;

  const candidate = detail?.item ?? null;
  const assignment: LocalAssignmentItem | null = candidate ? assignments?.items.find((item) => item.assignment.agentId === candidate.identity.id) ?? null : null;
  const version = detail?.versions.find((item) => item.id === selectedVersionId) ?? null;
  const pinned = assignment?.currentVersion ? detail?.versions.find((item) => item.id === assignment.currentVersion!.agentVersionId) ?? null : null;
  const changedFields = version && pinned && version.id !== pinned.id ?
    [...new Set([...Object.keys(pinned.definition), ...Object.keys(version.definition)])].filter((key) =>
      JSON.stringify(version.definition[key as keyof typeof version.definition]) !== JSON.stringify(pinned.definition[key as keyof typeof pinned.definition])) : [];
  const available = catalog?.items.filter((item) => item.identity.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];

  const addWithoutRelease = async () => {
    if (!api || !catalog || !candidate || busy || !candidate.eligibleForAdd) return;
    setBusy(true); setError(null);
    try {
      const result = await api.localAssignments.request({operation:"add",expected:catalog.expected,
        requestId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),
        payload:{agentId:candidate.identity.id}});
      if (result.kind!=="command") throw new Error("SERVICE_UNAVAILABLE");
      await reload();
    } catch (reason) { setError(projectAgentErrorMessage(reason)); }
    finally { setBusy(false); }
  };

  const configure = async (draft: BudgetDraft, principalVersionIds: string[]) => {
    if (!api || !catalog || !assignments || !candidate || !version || busy) return;
    const config = configurationForProject(route.projectId, draft, principalVersionIds);
    if (!config || !versionCanBeConfigured(version)) return;
    if (candidate.assignmentStatus === "removed" || candidate.assignmentStatus === "disabled") {
      setError("This Agent is removed or disabled in the Project. Resolve its lifecycle before releasing a version.");
      return;
    }
    setBusy(true); setError(null);
    let added = false;
    try {
      let assignmentId = assignment?.assignment.id ?? null;
      let expected = assignments.expected;
      if (!assignmentId) {
        if (!candidate.eligibleForAdd) throw new Error("ASSIGNMENT_DENIED");
        // The host verifies live catalog eligibility again inside this fenced write.
        const add = await api.localAssignments.request({ operation: "add", expected: catalog.expected,
          requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
          payload: { agentId: candidate.identity.id } });
        if (add.kind !== "command") throw new Error("SERVICE_UNAVAILABLE");
        assignmentId = add.resultRef; expected = add.expected; added = true;
      }
      const operation = assignment?.currentVersion && assignment.currentVersion.agentVersionId !== version.id ? "update" : "configure";
      const release = await api.localAssignments.request({ operation, expected,
        requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        payload: { assignmentId, agentVersionId: version.id, config } });
      if (release.kind !== "command") throw new Error("SERVICE_UNAVAILABLE");
      await reload();
      onDirtyStateChange(false, () => undefined);
      replace({ kind: "project-agents", projectId: route.projectId });
    } catch (reason) {
      await reload();
      setError(added ? `Agent added to this Project, but no Assignment version was released. ${projectAgentErrorMessage(reason)}` : projectAgentErrorMessage(reason));
    } finally { setBusy(false); }
  };

  return <section className="management-host local-agents-host project-agent-add-host" aria-label={route.kind === "project-agent-create" ? "Create Project Agent" : "Add Agent"}>
    <header className="management-header agent-studio-header local-page-heading"><div><span className="eyebrow">Project placement</span><h1>{route.kind === "project-agent-create" ? "Create Project Agent" : "Add Agent"}</h1><p>Choose a governed Agent and review the exact version before releasing a Project Assignment.</p></div><LocalRouteLink className="button secondary-button" to={{ kind: "project-agents", projectId: route.projectId }}><ArrowLeft size={14} /> Project Agents</LocalRouteLink></header>
    <div className="management-body agent-studio-body">
      {error && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{error}</span><button type="button" onClick={() => void reload()}>Reload</button></div>}
      {loading && <div className="agent-loading" role="status">Loading eligible Agents and Assignments…</div>}
      {!loading && catalog && route.kind === "project-agent-create" && api && <GovernedAgentCreateForm key="project-create" api={api} expected={catalog.expected} visibility="project" onDirtyStateChange={onDirtyStateChange} onCreated={() => {
        void api.localAgents.snapshot().then((value) => onWorkspaceChange(value.workspace)).catch(() => undefined);
        replace({ kind: "project-agents", projectId: route.projectId });
      }} />}
      {!loading && catalog && route.kind === "project-agent-add" && <div className="project-agent-add-layout">
        <div className="project-agent-list" aria-label="Choose an Agent"><div className="project-agent-list-heading"><span>Organization and Project Agents</span><strong>{catalog.items.length}</strong></div><label className="organization-agent-search"><Search size={15} /><span className="sr-only">Search available Agents</span><input aria-label="Search available Agents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Agents" /></label>{available.map((item) => <button type="button" key={item.identity.id} className={`project-agent-row ${candidate?.identity.id === item.identity.id ? "active" : ""}`} aria-pressed={candidate?.identity.id === item.identity.id} onClick={() => navigate({ kind: "project-agent-add", projectId: route.projectId, agentId: item.identity.id })}><span className="project-agent-icon"><Bot size={16} /></span><span><strong>{item.identity.name}</strong><small>{item.identity.visibility === "organization" ? "Organization" : "Project only"} · {item.assignmentStatus ?? (item.eligibleForAdd ? "Available" : "Read only")}</small></span><ChevronRight size={15} /></button>)}{!available.length && <div className="management-empty"><Bot size={23} /><h2>No matching Agents</h2><p>Create a new Project-only or organization Agent to start.</p></div>}</div>
        <div className="project-agent-detail">
          <div className="project-agent-create-options"><LocalRouteLink className="button secondary-button" to={{ kind: "project-agent-create", projectId: route.projectId }}><Plus size={14} /> Create Project Agent</LocalRouteLink><LocalRouteLink className="button secondary-button" to={{ kind: "agent-library-create", projectId: route.projectId }}><Plus size={14} /> Create organization Agent and add</LocalRouteLink></div>
          {candidate && version ? <><div className="project-agent-detail-heading"><span className="eyebrow">Choose exact version</span><h2>{candidate.identity.name}</h2><span className="project-agent-badge">{candidate.assignmentStatus ?? "Not added"}</span></div><div className="project-agent-version-choices" role="group" aria-label="Agent versions">{detail!.versions.map((item) => <button type="button" key={item.id} className={item.id === version.id ? "active" : ""} aria-pressed={item.id === version.id} onClick={() => selectVersion(item.id)}>v{item.versionNumber}</button>)}</div>
            {(pendingVersionId || pendingMode) && <div className="project-agent-version-confirm" role="group" aria-label={`Discard edits before changing ${pendingVersionId ? "Agent version" : "Project mode"}`}><strong role="alert">Discard unsaved changes?</strong><p>Changing {pendingVersionId ? "Agent versions" : "Project modes"} will replace the current Project edits.</p><div className="project-agent-actions"><button type="button" className="button secondary-button" onClick={() => { setPendingVersionId(null); setPendingMode(null); }}>Keep editing</button><button type="button" className="button primary-button" onClick={confirmPendingChange}>Discard changes and switch {pendingVersionId ? "version" : "mode"}</button></div></div>}
            <div className="project-agent-facts"><div><span>Selected Agent version</span><strong>v{version.versionNumber} · {version.id}</strong></div><div><span>Current Project pin</span><strong>{assignment?.currentVersion ? pinned ? `v${pinned.versionNumber}` : assignment.currentVersion.agentVersionId : "None"}</strong></div><div><span>Assignment revision</span><strong>{assignment?.currentVersion ? `r${assignment.currentVersion.revision} · ${assignment.currentVersion.id}` : "Not released"}</strong></div><div><span>Definition</span><strong>{version.definition.providerType} / {version.definition.modelId}</strong></div><div><span>Tool grants</span><strong>{version.definition.toolGrants?.grants.length ?? "Unconverted"}</strong></div></div>
            {assignment?.currentVersion && <p className="project-agent-help">The current Assignment pin is immutable. Releasing a new configuration creates the next revision; it does not change historical pins or make Tool execution ready.</p>}
            {assignment?.currentVersion && assignment.currentVersion.agentVersionId !== version.id && <section className="project-agent-update" aria-label="Exact Agent version changes"><strong>Explicit version adoption</strong><p>The current Project version remains unchanged until you release the selected version below. Review each changed definition value before updating the pin.</p>{pinned ? changedFields.length ? <div className="project-agent-update-fields">{changedFields.map((field) => <section key={field} className="project-agent-update-field" aria-label={`${field} change`}><h3>{field}</h3><div className="project-agent-update-values"><div><span>Current pin · v{pinned.versionNumber}</span><pre>{definitionValue(pinned.definition[field as keyof typeof pinned.definition])}</pre></div><div><span>Selected · v{version.versionNumber}</span><pre>{definitionValue(version.definition[field as keyof typeof version.definition])}</pre></div></div></section>)}</div> : <p>The stored definition fields match the current pin.</p> : <p>The pinned Agent version is unavailable in the catalog, so an exact definition comparison cannot be shown.</p>}</section>}
            {candidate.assignmentStatus === "removed" && <div className="project-agent-pin pending"><AlertCircle size={17} /><div><strong>Removed Assignment</strong><p>The retained placement cannot be recreated with a new identity.</p></div></div>}
            {!versionCanBeConfigured(version) && <div className="project-agent-pin pending"><AlertCircle size={17} /><div><strong>Not Ready · AGENT_VERSION_NOT_READY</strong><p>This exact version is unconverted or is not an Agent definition.</p></div></div>}
            <div className="project-agent-mode-picker" role="group" aria-label="Project Agent choice"><button type="button" className={mode === "as-is" ? "active" : ""} aria-pressed={mode === "as-is"} onClick={() => selectMode("as-is")}>Use as-is</button><button type="button" className={mode === "configure" ? "active" : ""} aria-pressed={mode === "configure"} onClick={() => selectMode("configure")}>Configure for Project</button><button type="button" className={mode === "variant" ? "active" : ""} aria-pressed={mode === "variant"} onClick={() => selectMode("variant")}><CopyPlus size={13} /> Create Project variant</button></div>
            {mode === "variant" && api ? <GovernedAgentCreateForm key={`variant:${version.id}`} api={api} expected={catalog.expected} visibility="project" source={version} sourceName={candidate.identity.name} onDirtyStateChange={handleEditorDirty} onCreated={(id) => {
              void api.localAgents.snapshot().then((value) => onWorkspaceChange(value.workspace)).catch(() => undefined);
              replace({ kind: "local-agent", projectId: route.projectId, agentId: id, versionId: null });
            }} /> : mode !== "variant" && versionCanBeConfigured(version) && candidate.assignmentStatus !== "removed" && candidate.assignmentStatus !== "disabled" && !assignment && version.definition.toolGrants!.grants.length ? <div className="project-agent-pin pending"><AlertCircle size={17} /><div><strong>Add before choosing grants</strong><p>The host needs an active Assignment to resolve this Agent Principal’s live ceiling. Adding creates no released version or Tool authority.</p><button type="button" className="button secondary-button" disabled={busy || !candidate.eligibleForAdd} onClick={() => void addWithoutRelease()}>Add Agent to Project</button></div></div> : mode !== "variant" && versionCanBeConfigured(version) && candidate.assignmentStatus !== "removed" && candidate.assignmentStatus !== "disabled" && api ? <BudgetEditor key={`${candidate.identity.id}:${version.id}:${assignment?.currentVersion?.id ?? "none"}`} api={api} assignmentId={assignment?.assignment.id ?? null} agentVersionId={version.id} initialIds={assignment?.currentVersion?.agentVersionId === version.id ? assignment.currentVersion.authorityCeiling.directGrantVersionIds : []} mode={mode} initial={budgetDraftFromCurrent(assignment?.currentVersion)} onDirtyStateChange={handleEditorDirty} onSubmit={configure} busy={busy} /> : null}
          </> : <div className="project-agent-placeholder"><Bot size={25} /><h2>Choose an Agent</h2><p>Review available versions, Project budgets and the current pin before adding or adopting.</p></div>}
        </div>
      </div>}
    </div>
  </section>;
}
