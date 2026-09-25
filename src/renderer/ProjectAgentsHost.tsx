import { AlertCircle, ArrowLeft, Bot, CheckCircle2, ChevronRight, Clock3, LockKeyhole, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestrionDesktopApi } from "../shared/contracts";
import type { LocalAgentWorkspace } from "../shared/agent-ui-contracts";
import type { LocalAssignmentItem, LocalAssignmentUiRequest } from "../shared/assignment-ui-contracts";
import type { LocalVersionPinSchema } from "../shared/local-contracts";
import type { z } from "zod";
import { LocalRouteLink } from "./navigation";
import { readAgentCatalog } from "./agent-catalog-client";
import { CodexSubscriptionConnection } from "./CodexSubscriptionConnection";

type Pin = z.infer<typeof LocalVersionPinSchema>;
type Transition = Extract<LocalAssignmentUiRequest, { operation: "disable" | "enable" | "remove" | "adopt" }>;
const PAGE_SIZE = 100;
const MAX_ITEMS = 10_000;

const errors: Record<string, string> = {
  ASSIGNMENT_DENIED: "This Project cannot make that change with its current authority.",
  ASSIGNMENT_NOT_READY: "This Assignment cannot be released with the current Local authority configuration.",
  ASSIGNMENT_NOT_FOUND: "The Assignment is no longer available in this Project.",
  ASSIGNMENT_NOT_ACTIVE: "This Assignment is not active. Reload its current state.",
  ASSIGNMENT_STATE_CONFLICT: "The Assignment changed. Reload before trying again.",
  ASSIGNMENT_ALREADY_EXISTS: "This Agent is already assigned to this Project.",
  ASSIGNMENT_PLACEMENT_DENIED: "This Agent cannot be placed in the current Project.",
  AGENT_NOT_FOUND: "The Agent is no longer available.",
  AGENT_VERSION_NOT_FOUND: "No eligible immutable Agent version is available.",
  AGENT_CATALOG_NOT_FOUND: "That Agent is no longer visible in this Project.",
  AGENT_CATALOG_NOT_READY: "This Agent is not ready in the authenticated catalog.",
  REVISION_CONFLICT: "The Local Agent ledger changed. Reload before trying again.",
  RUNTIME_OWNER_MISMATCH: "The Local host restarted. Reload before trying again.",
  CONTEXT_MISMATCH: "The host rejected a different Project context. Nothing was changed.",
  NOT_AUTHENTICATED: "This Local document is no longer authorized. Reopen it.",
  OUTCOME_UNKNOWN: "The host could not confirm the outcome. Reload before taking another action.",
};

export function projectAgentErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "SERVICE_UNAVAILABLE";
  return errors[code] ?? "Project Agent storage is unavailable. Reload this page.";
}

export async function readProjectAssignments(api: OrchestrionDesktopApi, projectId: string): Promise<{ expected: Pin; items: LocalAssignmentItem[] }> {
  const items: LocalAssignmentItem[] = [];
  let expected: Pin | null = null;
  for (let offset = 0; offset <= MAX_ITEMS; offset += PAGE_SIZE) {
    const result = await api.localAssignments.request({ operation: "list", limit: PAGE_SIZE, offset });
    if (result.kind !== "page") throw new Error("SERVICE_UNAVAILABLE");
    if (expected && (result.expected.revision !== expected.revision || result.expected.hash !== expected.hash))
      throw new Error("REVISION_CONFLICT");
    expected = result.expected;
    if (result.items.some((item) => item.assignment.projectId !== projectId)) throw new Error("CONTEXT_MISMATCH");
    if (offset === MAX_ITEMS) {
      if (result.items.length) throw new Error("SERVICE_UNAVAILABLE");
      break;
    }
    items.push(...result.items);
    if (result.items.length < PAGE_SIZE) break;
  }
  return { expected: expected!, items };
}

/** Project-scoped placement view. All identity, version and lifecycle facts come from the authenticated host. */
export function ProjectAgentsHost({ projectId, workspace, api }: {
  projectId: string;
  workspace: LocalAgentWorkspace | null;
  api: OrchestrionDesktopApi | undefined;
}) {
  const [ledger, setLedger] = useState<{ expected: Pin; items: LocalAssignmentItem[] } | null>(null);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof readAgentCatalog>> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"remove" | null>(null);
  const readEpoch = useRef(0);

  const reload = useCallback(async () => {
    const epoch = ++readEpoch.current;
    if (!api?.localAssignments?.request) { setError(projectAgentErrorMessage(new Error("SERVICE_UNAVAILABLE"))); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [nextLedger, nextCatalog] = await Promise.all([readProjectAssignments(api, projectId), readAgentCatalog(api)]);
      if (epoch !== readEpoch.current) return;
      setLedger(nextLedger); setCatalog(nextCatalog);
    } catch (reason) { if (epoch === readEpoch.current) { setLedger(null); setCatalog(null); setError(projectAgentErrorMessage(reason)); } }
    finally { if (epoch === readEpoch.current) setLoading(false); }
  }, [api, projectId]);

  useEffect(() => { void reload(); return () => { readEpoch.current++; }; }, [reload]);
  useEffect(() => { setConfirm(null); }, [selectedId]);

  const selected = ledger?.items.find((item) => item.assignment.id === selectedId) ?? null;
  const catalogAgent = selected && catalog?.items.find((item) => item.identity.id === selected.assignment.agentId);
  const updateAvailable = selected?.currentVersion && catalogAgent
    && selected.currentVersion.agentVersionId !== catalogAgent.latestVersionId;
  const localAgent = selected && workspace?.projectId === projectId
    ? workspace.agents.find((item) => item.agent.id === selected.assignment.agentId) ?? null : null;

  const transition = async (operation: Transition["operation"], id: string) => {
    if (!api || !ledger || busy) return;
    setBusy(true); setError(null); setConfirm(null);
    const request = {
      operation,
      expected: ledger.expected,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      payload: operation === "adopt" ? { agentId: id } : { id },
    } as Transition;
    try {
      const result = await api.localAssignments.request(request);
      if (result.kind !== "command") throw new Error("SERVICE_UNAVAILABLE");
      await reload();
    } catch (reason) { setError(projectAgentErrorMessage(reason)); }
    finally { setBusy(false); }
  };

  if (workspace && workspace.projectId !== projectId) return <section className="management-host local-agents-host" aria-label="Project Agents">
    <div className="agent-host-message error" role="alert"><AlertCircle size={20} /><div><strong>Project boundary</strong><p>{errors.CONTEXT_MISMATCH}</p></div></div>
  </section>;

  return <section className="management-host local-agents-host project-agents-host" aria-label="Project Agents">
    <header className="management-header agent-studio-header local-page-heading">
      <div><h1>Project Agents</h1></div>
      <div className="project-agent-header-actions"><LocalRouteLink className="button secondary-button" to={{ kind: "agent-library", projectId }}>Organization Library</LocalRouteLink><LocalRouteLink className="button primary-button" to={{ kind: "project-agent-add", projectId, agentId: null }}>Add Agent</LocalRouteLink><LocalRouteLink className="button secondary-button" to={{ kind: "local-agents", projectId }}><ArrowLeft size={14} /> Definitions</LocalRouteLink></div>
    </header>
    <div className="management-body agent-studio-body">
      <CodexSubscriptionConnection projectId={projectId} />
      <div className="project-agent-statusbar"><span><LockKeyhole size={14} /> Local host decides access and version release</span><button type="button" className="button secondary-button" onClick={() => void reload()} disabled={loading || busy}><RefreshCw size={14} /> Reload</button></div>
      {error && <div className="agent-inline-alert" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
      {loading && <div className="agent-loading" role="status">Loading Project Assignments…</div>}
      {!loading && ledger && <div className="project-agent-layout">
        <div className="project-agent-list" aria-label="Assigned Agents">
          <div className="project-agent-list-heading"><span>Assigned Agents</span><strong>{ledger.items.filter((item) => item.assignment.status !== "removed").length}</strong></div>
          {ledger.items.map((item) => <button type="button" key={item.assignment.id} className={`project-agent-row ${selectedId === item.assignment.id ? "active" : ""}`} aria-pressed={selectedId === item.assignment.id} onClick={() => setSelectedId(item.assignment.id)}>
            <span className="project-agent-icon"><Bot size={17} /></span><span><strong>{item.agent.identityState === "governed" ? item.agent.identity.name : item.agent.name}</strong><small>{item.migrationState === "legacy_unversioned" ? "Legacy · no released Assignment" : item.currentVersion ? `Assignment r${item.currentVersion.revision}` : "No released Assignment"}</small></span><ChevronRight size={15} />
          </button>)}
          {!ledger.items.length && <div className="management-empty"><Bot size={24} /><h2>No assigned Agents yet</h2><p>Choose a governed organization Agent or create a Project-only Agent.</p><LocalRouteLink className="button primary-button" to={{ kind: "project-agent-add", projectId, agentId: null }}>Add Agent</LocalRouteLink></div>}
        </div>
        <article className="project-agent-detail" aria-label="Assignment details">
          {selected ? <>
            <div className="project-agent-detail-heading"><span className="eyebrow">Exact Project Assignment</span><h2>{selected.agent.identityState === "governed" ? selected.agent.identity.name : selected.agent.name}</h2><span className={`project-agent-badge ${selected.assignment.status}`}>{selected.assignment.status}</span></div>
            <div className="project-agent-facts">
              <div><span>Identity</span><strong>{selected.agent.identityState === "governed" ? selected.agent.identity.visibility === "organization" ? "Organization Agent" : "Project Agent" : "Legacy unresolved"}</strong></div>
              <div><span>Agent version</span><strong>{selected.currentVersion ? localAgent?.latestVersion?.id === selected.currentVersion.agentVersionId ? `v${localAgent.latestVersion.versionNumber}` : selected.currentVersion.agentVersionId : "Not pinned"}</strong></div>
              <div><span>Assignment revision</span><strong>{selected.currentVersion ? `r${selected.currentVersion.revision}` : "Not released"}</strong></div>
              <div><span>Migration state</span><strong>{selected.migrationState === "governed" ? "Governed identity" : "Legacy unversioned"}</strong></div>
            </div>
            {selected.currentVersion ? <div className="project-agent-pin"><CheckCircle2 size={17} /><div><strong>Immutable version pin</strong><p>Future Agent versions do not change this Assignment. Configuration hash: <code>{selected.currentVersion.resolvedConfigHash}</code></p></div></div>
              : <div className="project-agent-pin pending"><Clock3 size={17} /><div><strong>No Assignment version released</strong><p>This Project membership does not imply Session or Workflow execution readiness.</p></div></div>}
            {updateAvailable && <div className="project-agent-update" role="status"><strong>New Agent version available</strong><p>The catalog has v{catalogAgent!.latestVersionNumber}; this Assignment remains pinned to its prior version. Adoption needs an explicit version and Project configuration review.</p><LocalRouteLink className="button secondary-button" to={{ kind: "project-agent-add", projectId, agentId: selected.assignment.agentId }}>Review and adopt</LocalRouteLink></div>}
            {selected.agent.identityState === "governed" && selected.agent.identity.derivedFromAgentVersionId && <p className="project-agent-provenance">Project variant derived from Agent version <code>{selected.agent.identity.derivedFromAgentVersionId}</code>. It has its own version history.</p>}
            {selected.agent.identityState === "governed" && !catalogAgent && <div className="project-agent-pin pending"><AlertCircle size={17} /><div><strong>Agent unavailable in current catalog</strong><p>Its historical Assignment remains visible, but no new Project configuration can be released from this view.</p></div></div>}
            <div className="project-agent-actions">
              {selected.agent.identityState === "governed" && catalogAgent && selected.assignment.status === "active" && <LocalRouteLink className="button secondary-button" to={{ kind: "project-agent-add", projectId, agentId: selected.assignment.agentId }}>Configure Project</LocalRouteLink>}
              {selected.migrationState === "legacy_unversioned" && <button type="button" className="button primary-button" disabled={busy || !localAgent?.latestVersion || localAgent.latestVersion.definition.nodeType !== "agent"} onClick={() => void transition("adopt", selected.assignment.agentId)}>Adopt eligible Agent</button>}
              {selected.assignment.status === "active" && <button type="button" className="button secondary-button" disabled={busy} onClick={() => void transition("disable", selected.assignment.id)}>Disable for new work</button>}
              {selected.assignment.status === "disabled" && <button type="button" className="button secondary-button" disabled={busy} onClick={() => void transition("enable", selected.assignment.id)}>Enable</button>}
              {selected.assignment.status !== "removed" && <button type="button" className="button secondary-button danger-outline" disabled={busy} onClick={() => setConfirm("remove")}>Remove from Project</button>}
            </div>
            {selected.migrationState === "legacy_unversioned" && !localAgent?.latestVersion && <p className="project-agent-help">Adoption requires an immutable first-class Agent version in this Project. The host will not infer one from legacy history.</p>}
            {confirm === "remove" && <div className="agent-delete-confirm" role="group" aria-labelledby="remove-assignment-title"><div><strong id="remove-assignment-title">Remove this Assignment?</strong><p>New work is blocked. Historical Sessions and versions remain.</p></div><button type="button" className="button secondary-button" onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="button primary-button danger-button" disabled={busy} onClick={() => void transition("remove", selected.assignment.id)}>Remove</button></div>}
          </> : <div className="project-agent-placeholder"><Bot size={26} /><h2>Select an Agent</h2><p>Inspect its placement, immutable version pin and lifecycle before changing Project access.</p></div>}
        </article>
      </div>}
    </div>
  </section>;
}
