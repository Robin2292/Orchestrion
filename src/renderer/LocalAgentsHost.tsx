import {
  AlertCircle,
  Bot,
  Braces,
  CheckCircle2,
  ChevronRight,
  Clock3,
  CopyPlus,
  FileLock2,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { AgentDefinition, LocalAgentVersion } from "../shared/agent-contracts";
import type { LocalAgentDetail, LocalAgentUiValue, LocalAgentWorkspace } from "../shared/agent-ui-contracts";
import { normalizeToolGrants, type ToolGrantSet } from "../shared/tool-grant-contracts";
import { LocalRouteLink, useLocalNavigation, type LocalRoute } from "./navigation";
import { sessionBindingBridgeAvailable, SESSION_TREE_BRIDGE_RESTART_MESSAGE } from "./session-tree-bridge";
import { localAgentBindingBridgeAvailable,localAgentDirectAuthoring,LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE } from "./local-agent-binding-bridge";
import { AgentSoulEditor, AgentSoulVersionDiff } from "./AgentSoulEditor";
import {
  AGENT_PRESET_LABELS,
  AGENT_PRESET_READINESS,
  buildAgentDefinition,
  initialLocalAgentForm,
  type AgentPreset,
  type LocalAgentFormState,
} from "./local-agent-form";

type AgentRoute = Extract<LocalRoute, { kind: "local-agents" | "local-agent-create" | "local-agent" }>;
type DirtyHandler = (dirty: boolean, discard: () => void) => void;

const PRESETS = Object.keys(AGENT_PRESET_LABELS) as AgentPreset[];

export function agentUiErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "SERVICE_UNAVAILABLE";
  const messages: Record<string, string> = {
    INVALID_PAYLOAD: "The Agent definition is invalid. Review the highlighted fields and try again.",
    UNSUPPORTED_VERSION: "This Agent was created by a newer app version and cannot be edited here.",
    CONTEXT_MISMATCH: "This Agent belongs to another Local project. Nothing was opened or changed.",
    RUNTIME_OWNER_MISMATCH: "The Local host restarted. Reload the Agent before saving.",
    REVISION_CONFLICT: "This Agent changed after you opened it. Reload before saving so you do not overwrite a newer version.",
    NOT_AUTHENTICATED: "The Local document is no longer authorized. Reopen this page and try again.",
    SERVICE_UNAVAILABLE: "The Local Agent host is unavailable. Restart or reopen Orchestrion, then reload this page.",
    OUTCOME_UNKNOWN: "The host could not confirm whether that change was saved. Reload before trying again.",
    AGENT_NOT_FOUND: "This Agent is no longer available in the current Local project.",
    AGENT_VERSION_NOT_FOUND: "That immutable Agent version is not available in the current Local project.",
    AGENT_NODE_TYPE_IMMUTABLE: "An Agent preset cannot change after creation. Create a new Agent for a different preset.",
    AGENT_REFERENCED: "This Agent is referenced by a saved session and cannot be deleted. Keep it for history or remove the reference in its owning migration flow.",
    TOOL_REFERENCE_INVALID: "Stored Tool access references a Tool that is no longer permitted. Nothing was saved.",
    SESSION_FOLDER_CONFLICT: "This Personal project is already bound to a different physical folder. Choose its original folder; moving a governed project is not supported yet.",
    SESSION_VERSION_CONFLICT: "This Agent is already bound in Sessions to another immutable version. Version rebinding is not supported yet.",
    SESSION_IDENTITY_CONFLICT: "A native project or Agent already uses this identity. It cannot be adopted into governed Sessions.",
    SESSION_PRESET_UNSUPPORTED: "Only Agent and Coding Agent versions can be bound to Codex Sessions.",
  };
  return messages[code] ?? messages.SERVICE_UNAVAILABLE;
}

export function LocalAgentsHost({
  route,
  workspace,
  loadError,
  api,
  onWorkspaceChange,
  onDirtyStateChange,
}: {
  route: AgentRoute;
  workspace: LocalAgentWorkspace | null;
  loadError: string | null;
  api: OrchestrionDesktopApi | undefined;
  onWorkspaceChange: (workspace: LocalAgentWorkspace) => void;
  onDirtyStateChange: DirtyHandler;
}) {
  const { replace } = useLocalNavigation();
  const [detail, setDetail] = useState<LocalAgentDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(loadError);
  const agentId = route.kind === "local-agent" ? route.agentId : null;

  useEffect(() => setError(loadError), [loadError]);
  useEffect(() => {
    if (!api || !agentId || typeof api.localAgents?.detail !== "function") { setDetail(null); return; }
    let active = true;
    setLoadingDetail(true);
    setError(null);
    void api.localAgents.detail(agentId).then((value) => {
      if (!active) return;
      onWorkspaceChange(value.workspace);
      setDetail(value.detail);
    }).catch((reason) => { if (active) setError(agentUiErrorMessage(reason)); })
      .finally(() => { if (active) setLoadingDetail(false); });
    return () => { active = false; };
  }, [agentId, api, onWorkspaceChange]);

  const reload = async () => {
    if (!api || typeof api.localAgents?.snapshot !== "function" || typeof api.localAgents?.detail !== "function") { setError(agentUiErrorMessage(new Error("SERVICE_UNAVAILABLE"))); return; }
    setError(null);
    try {
      const value = agentId ? await api.localAgents.detail(agentId) : await api.localAgents.snapshot();
      onWorkspaceChange(value.workspace);
      setDetail(value.detail);
    } catch (reason) { setError(agentUiErrorMessage(reason)); }
  };

  if (!workspace) return <AgentShell title="Agents" detail="Versioned Agent definitions stay on this device and inside one Local project.">
    <HostMessage error={error} onRetry={reload} />
  </AgentShell>;
  if (workspace.projectId !== route.projectId) return <AgentShell title="Project boundary" detail="Local Agent routes are checked against the host-owned project scope.">
    <div className="agent-inline-alert" role="alert"><AlertCircle size={17} /><span>{agentUiErrorMessage(new Error("CONTEXT_MISMATCH"))}</span></div>
  </AgentShell>;
  if (route.kind === "local-agents") return <AgentLibrary workspace={workspace} error={error} onRetry={reload} />;
  if (route.kind === "local-agent-create" && (!localAgentBindingBridgeAvailable(api) || !localAgentDirectAuthoring(workspace)))
    return <AgentBindingBridgeBlocked />;
  if (route.kind === "local-agent-create") return <AgentEditor
    key="new-agent"
    workspace={workspace}
    api={api}
    onWorkspaceChange={onWorkspaceChange}
    onDirtyStateChange={onDirtyStateChange}
    onSaved={(value) => {
      const id = value.detail?.agent.id;
      if (id) replace({ kind: "local-agent", projectId: value.workspace.projectId, agentId: id, versionId: value.selectedVersionId });
    }}
  />;
  if (loadingDetail || !detail) return <AgentShell title="Agent record" detail="Loading the immutable version ledger from the Local host.">
    {error ? <HostMessage error={error} onRetry={reload} /> : <div className="agent-loading" role="status"><LoaderCircle className="spin" size={18} /> Loading Agent versions…</div>}
  </AgentShell>;
  return <AgentDetailView
    key={`${detail.agent.id}:${route.versionId ?? "latest"}`}
    route={route}
    detail={detail}
    workspace={workspace}
    api={api}
    error={error}
    onReload={reload}
    onWorkspaceChange={onWorkspaceChange}
    onDetailChange={setDetail}
    onDirtyStateChange={onDirtyStateChange}
  />;
}

function AgentBindingBridgeBlocked() {
  return <AgentShell title="Restart required" detail="The Tool Source catalog and exact grant evidence must come from the current Local host and isolated preload.">
    <div className="agent-host-message error" role="alert"><AlertCircle size={22} /><div><strong>Agent editor unavailable</strong><p>{LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE}</p></div></div>
  </AgentShell>;
}

function AgentShell({ title, action, children }: { title: string; detail: string; action?: ReactNode; children: ReactNode }) {
  return <section className="management-host local-agents-host" aria-label={title}>
    <header className="management-header agent-studio-header local-page-heading"><h1>{title}</h1>{action}</header>
    <div className="management-body agent-studio-body">{children}</div>
  </section>;
}

function HostMessage({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return <div className={`agent-host-message ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
    {error ? <AlertCircle size={22} /> : <LoaderCircle className="spin" size={22} />}
    <div><strong>{error ? "Local host needs attention" : "Connecting to Local Agent storage"}</strong><p>{error ?? "Reading the current project scope and immutable version ledger."}</p></div>
    {error && <button className="button secondary-button" onClick={onRetry}><RefreshCw size={14} /> Reload</button>}
  </div>;
}

function AgentLibrary({ workspace, error, onRetry }: { workspace: LocalAgentWorkspace; error: string | null; onRetry: () => void }) {
  return <AgentShell
    title="Agents"
    detail="Create durable definitions, inspect every immutable version, and keep execution authority outside the editor."
    action={<div className="project-agent-header-actions"><LocalRouteLink className="button secondary-button" to={{ kind: "agent-library", projectId: workspace.projectId }}>Organization Library</LocalRouteLink><LocalRouteLink className="button secondary-button" to={{ kind: "project-agents", projectId: workspace.projectId }}>Project Agents</LocalRouteLink><LocalRouteLink className="button primary-button agent-create-link" to={{ kind: "local-agent-create", projectId: workspace.projectId }}><Plus size={14} /> New Agent</LocalRouteLink></div>}
  >
    {error && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{error}</span><button onClick={onRetry}>Reload</button></div>}
    <div className="agent-library-ledger" aria-label="Local Agent definitions">
      <div className="agent-ledger-heading"><span>Identity</span><span>Preset</span><span>Version</span><span>Execution</span></div>
      {workspace.agents.map(({ agent, latestVersion }) => <LocalRouteLink key={agent.id} className="agent-ledger-row" to={{ kind: "local-agent", projectId: workspace.projectId, agentId: agent.id, versionId: null }}>
        <span className="agent-ledger-identity"><i><Bot size={15} /></i><span><strong>{agent.name}</strong><small>{agent.description || "No description"}</small></span></span>
        <span><b>{AGENT_PRESET_LABELS[agent.nodeType]}</b><small>{agent.nodeType}</small></span>
        <span><b>{latestVersion ? `v${latestVersion.versionNumber}` : "Draft"}</b><small>{latestVersion ? "immutable" : "no version"}</small></span>
        <span><em className="agent-readiness-dot" /> <small>{AGENT_PRESET_READINESS[agent.nodeType].label}</small><ChevronRight size={15} /></span>
      </LocalRouteLink>)}
      {!workspace.agents.length && <div className="management-empty"><Bot size={25} /><h2>Define your first Local Agent</h2><p>Choose one of five current presets. Saving creates immutable v1; it does not grant execution authority.</p><LocalRouteLink className="button primary-button" to={{ kind: "local-agent-create", projectId: workspace.projectId }}><Plus size={14} /> New Agent</LocalRouteLink></div>}
    </div>
  </AgentShell>;
}

function AgentDetailView({ route, detail, workspace, api, error, onReload, onWorkspaceChange, onDetailChange, onDirtyStateChange }: {
  route: Extract<AgentRoute, { kind: "local-agent" }>;
  detail: LocalAgentDetail;
  workspace: LocalAgentWorkspace;
  api: OrchestrionDesktopApi | undefined;
  error: string | null;
  onReload: () => void;
  onWorkspaceChange: (workspace: LocalAgentWorkspace) => void;
  onDetailChange: (detail: LocalAgentDetail) => void;
  onDirtyStateChange: DirtyHandler;
}) {
  const { replace } = useLocalNavigation();
  const selected = route.versionId
    ? detail.versions.find((version) => version.id === route.versionId) ?? null
    : detail.versions[0] ?? null;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bindingAvailable = sessionBindingBridgeAvailable(api);
  const editorAvailable=localAgentBindingBridgeAvailable(api) && localAgentDirectAuthoring(workspace) !== null;

  if (route.versionId && !selected) return <AgentShell title="Version unavailable" detail="Immutable version routes are checked against this Agent's Local project ledger.">
    <div className="agent-host-message error" role="alert"><AlertCircle size={22} /><div><strong>Agent version not found</strong><p>{agentUiErrorMessage(new Error("AGENT_VERSION_NOT_FOUND"))}</p></div><button className="button secondary-button" onClick={onReload}><RefreshCw size={14} /> Reload</button></div>
  </AgentShell>;

  if (editing && selected && editorAvailable) return <AgentEditor
    workspace={workspace}
    api={api}
    source={selected}
    metadata={{ name: detail.agent.name, description: detail.agent.description, userGuide: detail.agent.userGuide }}
    onWorkspaceChange={onWorkspaceChange}
    onDirtyStateChange={onDirtyStateChange}
    onSaved={(value) => {
      setEditing(false);
      if (value.detail) onDetailChange(value.detail);
      onWorkspaceChange(value.workspace);
      replace({ kind: "local-agent", projectId: value.workspace.projectId, agentId: detail.agent.id, versionId: value.selectedVersionId });
    }}
  />;

  const remove = async () => {
    if (!api) { setDeleteError(agentUiErrorMessage(new Error("SERVICE_UNAVAILABLE"))); return; }
    setBusy(true); setDeleteError(null);
    try {
      const value = await api.localAgents.delete({ operation: "delete", expected: workspace.expected, requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), payload: { id: detail.agent.id } });
      onWorkspaceChange(value.workspace);
      replace({ kind: "local-agents", projectId: value.workspace.projectId });
    } catch (reason) { setDeleteError(agentUiErrorMessage(reason)); }
    finally { setBusy(false); }
  };

  const useInSessions = async () => {
    if (!api || !selected || !sessionBindingBridgeAvailable(api)) return;
    setBusy(true); setDeleteError(null);
    try {
      const path = await api.chooseProjectDirectory();
      if (!path) return;
      await api.bindSessionAgent({ path, agentId: detail.agent.id, versionId: selected.id });
      replace({ kind: "workspace" });
    } catch (reason) { setDeleteError(agentUiErrorMessage(reason)); }
    finally { setBusy(false); }
  };

  return <AgentShell
    title={detail.agent.name}
    detail={`${AGENT_PRESET_LABELS[detail.agent.nodeType]} · ${detail.versions.length} immutable ${detail.versions.length === 1 ? "version" : "versions"}.`}
    action={<button className="button secondary-button danger-outline" onClick={() => setDeleting(true)}><Trash2 size={14} /> Delete</button>}
  >
    {(error || deleteError) && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{deleteError ?? error}</span><button onClick={onReload}>Reload</button></div>}
    {deleting && <div className="agent-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-agent-title">
      <div><span className="eyebrow">Retain historical integrity</span><strong id="delete-agent-title">Delete {detail.agent.name}?</strong><p>Deletion hides the identity but keeps immutable versions. Referenced Agents are refused.</p></div>
      <button className="button secondary-button" onClick={() => setDeleting(false)}>Cancel</button>
      <button className="button primary-button danger-button" disabled={busy} onClick={remove}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Delete Agent</button>
    </div>}
    <div className="agent-detail-layout">
      <aside className="agent-version-rail" aria-label="Version history">
        <span className="eyebrow"><History size={12} /> Immutable history</span>
        {detail.versions.map((version) => <LocalRouteLink key={version.id} className={selected?.id === version.id ? "active" : ""} aria-current={selected?.id === version.id ? "page" : undefined} to={{ kind: "local-agent", projectId: workspace.projectId, agentId: detail.agent.id, versionId: version.id }}>
          <span><strong>v{version.versionNumber}</strong><small>{new Date(version.createdAt).toLocaleString()}</small></span><ChevronRight size={14} />
        </LocalRouteLink>)}
      </aside>
      {selected ? <article className="agent-version-sheet" aria-label={`${detail.agent.name} version ${selected.versionNumber}`}>
        <div className="agent-version-title"><div><span className="eyebrow">Immutable Agent version</span><h2>v{selected.versionNumber} · {AGENT_PRESET_LABELS[selected.definition.nodeType]}</h2></div><button className="button primary-button" disabled={!editorAvailable} aria-describedby={!editorAvailable ? "agent-binding-bridge-status" : undefined} onClick={() => { if (editorAvailable) setEditing(true); }}><CopyPlus size={14} /> Edit as new version</button></div>
        {!editorAvailable && <div className="agent-inline-alert" id="agent-binding-bridge-status" role="status"><AlertCircle size={16} /><span>{LOCAL_AGENT_BINDING_BRIDGE_RESTART_MESSAGE}</span></div>}
        <ReadinessCard nodeType={selected.definition.nodeType} />
        {(selected.definition.nodeType === "agent" || selected.definition.nodeType === "coding_agent") && <div className="agent-readiness-card">
          <FileLock2 size={17} /><div><strong>Use this version in governed Sessions</strong><p>Select the physical folder for this Personal project. The selected Agent version and direct Tool grants stay pinned. Current Policy and credential state may tighten access but cannot add it. Codex native tools remain separate.</p>
          {!bindingAvailable && <p id="session-tree-bridge-status" role="status">{SESSION_TREE_BRIDGE_RESTART_MESSAGE}</p>}
          <button className="button secondary-button" disabled={busy || !bindingAvailable} aria-describedby={!bindingAvailable ? "session-tree-bridge-status" : undefined} onClick={useInSessions}>Choose folder · Use in Sessions</button></div>
        </div>}
        <dl className="agent-definition-facts"><div><dt>Role</dt><dd>{selected.definition.role || "Not set"}</dd></div><div><dt>Output type</dt><dd>{selected.definition.outputType}</dd></div><div><dt>Provider</dt><dd>{selected.definition.providerType || "Not connected"}</dd></div><div><dt>Model</dt><dd>{selected.definition.modelId || "Not connected"}</dd></div></dl>
        <section className="agent-binding-summary" aria-label="Exact direct Tool grants"><span className="eyebrow">Exact direct Tool grants</span>{selected.definition.toolGrants?.grants.length
          ? <ul>{selected.definition.toolGrants.grants.map((grant) => <li key={JSON.stringify(grant)}><strong>{grant.tool.source} / {grant.tool.key}</strong><span>{grant.resource_scope.kind}: {grant.resource_scope.resource}</span></li>)}</ul>
          : <p>{selected.definition.toolGrants ? "Explicit deny all." : "Legacy configuration is unconverted and cannot grant Tool access."}</p>}</section>
        <SchemaPair definition={selected.definition} />
        {selected.definition.nodeType === "agent" && <AgentSoulVersionDiff current={selected}
          previous={detail.versions.find((version) => version.versionNumber === selected.versionNumber - 1) ?? null} />}
        <details className="agent-definition-json"><summary><Braces size={14} /> Complete stored definition</summary><pre>{JSON.stringify(selected.definition, null, 2)}</pre></details>
      </article> : <div className="agent-host-message"><Clock3 size={22} /><div><strong>No immutable version</strong><p>This imported draft has no fabricated historical version. Create its first explicit immutable version in the migration flow.</p></div></div>}
    </div>
    {api && detail.agent.nodeType === "agent" && detail.versions[0] &&
      <AgentSoulEditor api={api} agentId={detail.agent.id} latest={detail.versions[0]}
        expected={workspace.expected} onPublished={onReload} onDirtyStateChange={onDirtyStateChange} />}
  </AgentShell>;
}

function SchemaPair({ definition }: { definition: AgentDefinition }) {
  return <div className="agent-schema-grid">
    <section><span className="eyebrow">Input schema</span><pre>{JSON.stringify(definition.inputSchema ?? {}, null, 2)}</pre></section>
    <section><span className="eyebrow">Output schema</span><pre>{JSON.stringify(definition.outputSchema ?? {}, null, 2)}</pre></section>
  </div>;
}

function ReadinessCard({ nodeType }: { nodeType: AgentPreset }) {
  const readiness = AGENT_PRESET_READINESS[nodeType];
  return <div className={`agent-readiness-card ${readiness.tone}`}><CheckCircle2 size={17} /><div><strong>{readiness.label}</strong><p>{readiness.detail}</p></div></div>;
}

function AgentEditor({ workspace, api, source, metadata, onWorkspaceChange, onDirtyStateChange, onSaved }: {
  workspace: LocalAgentWorkspace;
  api: OrchestrionDesktopApi | undefined;
  source?: LocalAgentVersion;
  metadata?: { name: string; description: string | null; userGuide: string | null };
  onWorkspaceChange: (workspace: LocalAgentWorkspace) => void;
  onDirtyStateChange: DirtyHandler;
  onSaved: (value: LocalAgentUiValue) => void;
}) {
  const { navigate } = useLocalNavigation();
  const [initial] = useState(() => {
    const form = initialLocalAgentForm(source?.definition.nodeType ?? "agent", source?.definition, metadata);
    const grants = source
      ? source.definition.toolGrants ?? null
      : { schema_version:"tool_grants@1" as const,grants:[] };
    return { form,grants };
  });
  const [form, setForm] = useState(initial.form);
  const [grants,setGrants] = useState<ToolGrantSet | null>(initial.grants);
  const [toolQuery,setToolQuery] = useState("");
  const [selectedCatalogId,setSelectedCatalogId] = useState<string | null>(null);
  const [resourceKind,setResourceKind] = useState("workspace_path");
  const [resource,setResource] = useState("");
  const [resourceFilter,setResourceFilter] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify({ form,grants }) !== JSON.stringify(initial);
  const listRoute: LocalRoute = { kind: "local-agents", projectId: workspace.projectId };
  const direct = localAgentDirectAuthoring(workspace)!;
  const catalogRows = direct.catalog.sources.flatMap((sourceItem) => sourceItem.connections.flatMap((connection) =>
    connection.tools.map((tool) => ({ source:sourceItem,connection,tool }))));
  const visibleRows = catalogRows.filter(({ source:sourceItem,connection,tool }) => {
    const q=toolQuery.trim().toLocaleLowerCase();
    return !q || [sourceItem.label,sourceItem.namespace,connection.label,tool.metadata.name,tool.metadata.description,
      tool.metadata.claimedEffects.join(" "),tool.metadata.claimedRisk].some((value) => value.toLocaleLowerCase().includes(q));
  });
  const sourceGroups=[...new Map(visibleRows.map((row) => [`${row.source.namespace}:${row.source.kind}`,row.source])).entries()];
  const visibleGrants=(grants?.grants ?? []).filter((grant) => grant.resource_scope.resource.toLocaleLowerCase()
    .includes(resourceFilter.trim().toLocaleLowerCase()));

  useEffect(() => {
    const discard = () => { setForm(structuredClone(initial.form));setGrants(structuredClone(initial.grants)); };
    onDirtyStateChange(dirty, discard);
    return () => onDirtyStateChange(false, () => undefined);
  }, [dirty, initial, onDirtyStateChange]);

  const update = <K extends keyof LocalAgentFormState>(key: K, value: LocalAgentFormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = buildAgentDefinition(form, source?.definition);
    setErrors(built.errors);
    if (!built.definition || !api) {
      if (!api) setSaveError(agentUiErrorMessage(new Error("SERVICE_UNAVAILABLE")));
      return;
    }
    setBusy(true); setSaveError(null);
    try {
      let value: LocalAgentUiValue;
      const supportsGrants = built.definition.nodeType === "agent" || built.definition.nodeType === "coding_agent";
      const definition = { ...built.definition, toolGrants:supportsGrants
        ? grants === null ? null : normalizeToolGrants(grants)
        : { schema_version:"tool_grants@1" as const,grants:[] } };
      if (!source) {
        value = await api.localAgents.create({ operation: "create", expected: workspace.expected, requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), payload: {
          name: form.name.trim(), description: form.description.trim() || null, userGuide: form.userGuide.trim() || null, definition,
        } });
      } else {
        const metadataChanged = form.name.trim() !== metadata?.name || (form.description.trim() || null) !== metadata?.description || (form.userGuide.trim() || null) !== metadata?.userGuide;
        value = await api.localAgents.createVersion({ operation: "version.create", expected: workspace.expected, requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), payload: {
          agentId: source.agentId,
          definition,
          ...(metadataChanged ? { metadata: { name: form.name.trim(), description: form.description.trim() || null,
            userGuide: form.userGuide.trim() || null } } : {}),
        } });
      }
      onWorkspaceChange(value.workspace);
      onDirtyStateChange(false, () => undefined);
      onSaved(value);
    } catch (reason) { setSaveError(agentUiErrorMessage(reason)); }
    finally { setBusy(false); }
  };

  return <AgentShell
    title={source ? `New version from v${source.versionNumber}` : "New Local Agent"}
    detail={source ? "Saving appends an immutable version. The version you opened remains unchanged and viewable." : "Choose a preset and save one complete, project-scoped v1 definition."}
    action={<span className="agent-editor-status">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>}
  >
    {saveError && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{saveError}</span></div>}
    {errors.form && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{errors.form}</span></div>}
    <form className="agent-editor" onSubmit={submit} noValidate>
      <section className="agent-editor-section preset-section"><div><span className="eyebrow">01 / Preset</span><h2>What kind of definition is this?</h2><p>Preset type is immutable after creation. A stored definition is not an execution grant.</p></div><div className="preset-picker" role="radiogroup" aria-label="Agent preset">
        {PRESETS.map((preset) => <button key={preset} type="button" role="radio" aria-checked={form.nodeType === preset} disabled={Boolean(source)} className={form.nodeType === preset ? "active" : ""} onClick={() => { setForm(initialLocalAgentForm(preset, undefined, { name: form.name, description: form.description || null, userGuide: form.userGuide || null }));if (preset !== "agent" && preset !== "coding_agent") setGrants({ schema_version:"tool_grants@1",grants:[] }); }}><span>{AGENT_PRESET_LABELS[preset]}</span><small>{preset}</small></button>)}
      </div><ReadinessCard nodeType={form.nodeType} /></section>
      <section className="agent-editor-section"><div><span className="eyebrow">02 / Identity</span><h2>Human-facing identity</h2></div><div className="agent-form-grid">
        <Field label="Name" error={errors.name}><input aria-label="Agent name" value={form.name} onChange={(event) => update("name", event.target.value)} /></Field>
        <Field label="Role"><input aria-label="Agent role" value={form.role} onChange={(event) => update("role", event.target.value)} placeholder="e.g. Summarizes research into a decision brief" /></Field>
        <Field label="Description" wide><textarea aria-label="Agent description" rows={3} value={form.description} onChange={(event) => update("description", event.target.value)} /></Field>
        <Field label="User guide" wide><textarea aria-label="Agent user guide" rows={3} value={form.userGuide} onChange={(event) => update("userGuide", event.target.value)} /></Field>
      </div></section>
      <PresetFields form={form} errors={errors} update={update} />
      <section className="agent-editor-section"><div><span className="eyebrow">04 / Contracts</span><h2>Input and output</h2><p>JSON objects are validated before any host mutation.</p></div><div className="agent-form-grid">
        <Field label="Input schema" error={errors.inputSchema} wide><textarea className="code-input" aria-label="Input schema" rows={7} value={form.inputSchema} onChange={(event) => update("inputSchema", event.target.value)} placeholder={'{\n  "type": "object"\n}'} /></Field>
        <Field label="Output schema" error={errors.outputSchema} wide><textarea className="code-input" aria-label="Output schema" rows={7} value={form.outputSchema} onChange={(event) => update("outputSchema", event.target.value)} placeholder={'{\n  "type": "object"\n}'} /></Field>
        <Field label="Output type"><input aria-label="Output type" value={form.outputType} onChange={(event) => update("outputType", event.target.value)} /></Field>
      </div></section>
      {(form.nodeType === "agent" || form.nodeType === "coding_agent") && <section className="agent-editor-section"><div><span className="eyebrow">05 / Tools</span><h2>Choose exact Tool access</h2><p>Each draft row keeps Tool, connection or trusted target, immutable contract, Policy and one resource scope together. Saving publishes a new immutable Agent version.</p></div><div className="agent-binding-picker" role="group" aria-label="Direct Tool grants">
        <label className="agent-field wide"><span className="sr-only">Search Tool Source catalog</span><span><Search size={13} /> Search by name, description, Source, effect or risk</span><input aria-label="Search Tool Source catalog" value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} /></label>
        {sourceGroups.map(([groupKey,sourceItem]) => <div key={groupKey} role="group" aria-label={`${sourceItem.label} Source`}>
          <span className="eyebrow">{sourceItem.label} · {sourceItem.namespace}</span>
          {visibleRows.filter((row) => row.source === sourceItem).map(({ connection,tool }) => {
          const ready=tool.grantReadiness === "ready" && direct.templates.some((template) => template.catalogId === tool.catalogId);
          return <button type="button" role="checkbox" aria-checked={selectedCatalogId === tool.catalogId} disabled={!ready} className={`agent-binding-choice ${ready ? "available" : "unavailable"}`} key={tool.catalogId} onClick={() => setSelectedCatalogId(tool.catalogId)}><span><strong>{tool.metadata.name}</strong><small>{sourceItem.label} · {connection.label} · {tool.metadata.claimedEffects.join(", ") || "unknown effect"} · {tool.metadata.claimedRisk} risk · {ready ? "ready" : tool.grantReadiness}</small></span></button>;
        })}</div>)}
        {!visibleRows.length && <p className="agent-binding-empty">No Source entries match this filter.</p>}
        <div className="agent-form-grid"><Field label="Resource kind"><input aria-label="Direct grant resource kind" value={resourceKind} onChange={(event) => setResourceKind(event.target.value)} /></Field><Field label="Resource" wide><input aria-label="Direct grant resource" value={resource} onChange={(event) => setResource(event.target.value)} /></Field></div>
        <button type="button" className="button secondary-button" disabled={!selectedCatalogId || !resource.trim()} onClick={() => {
          const template=direct.templates.find((item) => item.catalogId === selectedCatalogId);if(!template)return;
          const next={ ...structuredClone(template.grant),resource_scope:{ kind:resourceKind.trim(),resource:resource.trim() } };
          setGrants(normalizeToolGrants({ schema_version:"tool_grants@1",grants:[...(grants?.grants ?? []),next] }));setSelectedCatalogId(null);setResource("");
        }}>Add exact Tool grant</button>
        <label className="agent-field wide"><span>Configured resource filter</span><input aria-label="Filter configured Tool resources" value={resourceFilter} onChange={(event) => setResourceFilter(event.target.value)} /></label>
        <div aria-label="Draft direct grants">{grants === null
          ? <div className="agent-binding-empty"><p>Legacy configuration is unconverted and cannot grant Tool access.</p><button type="button" className="button secondary-button" onClick={() => setGrants({ schema_version:"tool_grants@1",grants:[] })}>Set explicit deny all</button></div>
          : grants.grants.length
            ? <>{visibleGrants.length ? <ul>{visibleGrants.map((grant) => { const index=grants.grants.indexOf(grant);return <li key={JSON.stringify(grant)}><strong>{grant.tool.source} / {grant.tool.key}</strong><span>{grant.resource_scope.kind}: {grant.resource_scope.resource}</span><button type="button" aria-label={`Remove ${grant.tool.key} grant`} onClick={() => setGrants(normalizeToolGrants({ schema_version:"tool_grants@1",grants:grants.grants.filter((_,i) => i !== index) }))}>Remove</button></li>;})}</ul> : <p className="agent-binding-empty">No configured resources match this filter.</p>}</>
            : <p className="agent-binding-empty">Explicit deny all. Empty grants never mean all Tools.</p>}</div>
      </div></section>}
      <div className="agent-editor-actions"><button type="button" className="button secondary-button" onClick={() => navigate(listRoute)}>Cancel</button><button type="submit" className="button primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{source ? "Save new version" : "Create v1"}</button></div>
    </form>
  </AgentShell>;
}

function PresetFields({ form, errors, update }: { form: LocalAgentFormState; errors: Record<string, string>; update: <K extends keyof LocalAgentFormState>(key: K, value: LocalAgentFormState[K]) => void }) {
  if (form.nodeType === "terminal") return <EditorBlock number="03" title="Terminal template" detail="These fields are stored for compatibility; the human Terminal surface remains separate."><Field label="Initial prompt" wide><textarea aria-label="Initial prompt" rows={5} value={form.terminalPrompt} onChange={(event) => update("terminalPrompt", event.target.value)} /></Field><Field label="Execution mode"><select aria-label="Terminal execution mode" value={form.terminalMode} onChange={(event) => update("terminalMode", event.target.value as LocalAgentFormState["terminalMode"])}><option value="">Use stored default</option><option value="interactive">Interactive</option><option value="headless">Headless (not runnable here)</option></select></Field></EditorBlock>;
  if (form.nodeType === "code") return <EditorBlock number="03" title="Code template" detail="The script and preset timeout are versioned, but A1 cannot execute them."><Field label="Script" error={errors.codeScript} wide><textarea className="code-input" aria-label="Code script" rows={10} value={form.codeScript} onChange={(event) => update("codeScript", event.target.value)} /></Field><Field label="Preset timeout seconds" error={errors.codeTimeoutSeconds}><input aria-label="Code timeout seconds" inputMode="numeric" value={form.codeTimeoutSeconds} onChange={(event) => update("codeTimeoutSeconds", event.target.value)} /></Field></EditorBlock>;
  if (form.nodeType === "coding_agent") return <EditorBlock number="03" title="Coding Agent template" detail="Provider fields are retained without starting a provider session or granting tools."><Field label="Provider" error={errors.codingProvider}><input aria-label="Coding provider" value={form.codingProvider} onChange={(event) => update("codingProvider", event.target.value)} /></Field><Field label="Model"><input aria-label="Coding model" value={form.codingModel} onChange={(event) => update("codingModel", event.target.value)} /></Field><Field label="Prompt" wide><textarea aria-label="Coding prompt" rows={6} value={form.codingPrompt} onChange={(event) => update("codingPrompt", event.target.value)} /></Field><Field label="Max turns" error={errors.codingMaxTurns}><input aria-label="Coding max turns" inputMode="numeric" value={form.codingMaxTurns} onChange={(event) => update("codingMaxTurns", event.target.value)} /></Field><Field label="Preset timeout seconds" error={errors.codingTimeoutSeconds}><input aria-label="Coding timeout seconds" inputMode="numeric" value={form.codingTimeoutSeconds} onChange={(event) => update("codingTimeoutSeconds", event.target.value)} /></Field><Field label="Permission mode"><select aria-label="Coding permission mode" value={form.codingPermissionMode} onChange={(event) => update("codingPermissionMode", event.target.value as LocalAgentFormState["codingPermissionMode"])}><option value="">Use stored default</option><option value="default">Default</option><option value="accept_edits">Accept edits</option><option value="full_auto">Full auto (stored only)</option></select></Field><Field label="Allowed tool names" wide><textarea aria-label="Allowed tool names" rows={4} value={form.codingAllowedTools} onChange={(event) => update("codingAllowedTools", event.target.value)} placeholder="One name per line; this does not grant authority" /></Field></EditorBlock>;
  if (form.nodeType === "sub_workflow") return <EditorBlock number="03" title="Workflow-backed Agent" detail="Exact Workflow and version IDs are pinned in every newly saved Agent version. Workflow execution is outside A1."><Field label="Workflow ID" error={errors.workflowId}><input aria-label="Workflow ID" value={form.workflowId} onChange={(event) => update("workflowId", event.target.value)} /></Field><Field label="Workflow version ID" error={errors.workflowVersionId}><input aria-label="Workflow version ID" value={form.workflowVersionId} onChange={(event) => update("workflowVersionId", event.target.value)} /></Field></EditorBlock>;
  return <EditorBlock number="03" title="LLM Agent definition" detail="Current model and prompt fields mirror the established Agent form. Local execution remains unbound."><Field label="Provider" error={errors.providerType}><input aria-label="Provider" value={form.providerType} onChange={(event) => update("providerType", event.target.value)} /></Field><Field label="Model" error={errors.modelId}><input aria-label="Model" value={form.modelId} onChange={(event) => update("modelId", event.target.value)} /></Field><Field label="System prompt" wide><textarea aria-label="System prompt" rows={7} value={form.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} /></Field><Field label="User prompt template" wide><textarea aria-label="User prompt template" rows={4} value={form.userPromptTemplate} onChange={(event) => update("userPromptTemplate", event.target.value)} /></Field><Field label="Model parameters" error={errors.modelParams} wide><textarea className="code-input" aria-label="Model parameters" rows={4} value={form.modelParams} onChange={(event) => update("modelParams", event.target.value)} /></Field><Field label="Max tokens" error={errors.maxTokens}><input aria-label="Max tokens" inputMode="numeric" value={form.maxTokens} onChange={(event) => update("maxTokens", event.target.value)} /></Field><Field label="Retries" error={errors.maxRetries}><input aria-label="Max retries" inputMode="numeric" value={form.maxRetries} onChange={(event) => update("maxRetries", event.target.value)} /></Field><Field label="Tool turns" error={errors.maxToolTurns}><input aria-label="Max tool turns" inputMode="numeric" value={form.maxToolTurns} onChange={(event) => update("maxToolTurns", event.target.value)} /></Field><Field label="Timeout seconds" error={errors.timeoutSeconds}><input aria-label="Timeout seconds" inputMode="numeric" value={form.timeoutSeconds} onChange={(event) => update("timeoutSeconds", event.target.value)} /></Field></EditorBlock>;
}

function EditorBlock({ number, title, detail, children }: { number: string; title: string; detail: string; children: ReactNode }) {
  return <section className="agent-editor-section"><div><span className="eyebrow">{number} / Configuration</span><h2>{title}</h2><p>{detail}</p></div><div className="agent-form-grid">{children}</div></section>;
}

function Field({ label, error, wide, children }: { label: string; error?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`agent-field ${wide ? "wide" : ""}`}><span>{label}</span>{children}{error && <small role="alert">{error}</small>}</label>;
}
