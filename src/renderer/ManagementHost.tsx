import { LocalRecoveryFixture } from "./LocalRecoveryFixture";
import { CodexSubscriptionConnection } from "./CodexSubscriptionConnection";
import {
  Activity,
  ArrowLeft,
  Bot,
  Cable,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCheck2,
  FolderKanban,
  Inbox,
  LockKeyhole,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AgentRecord, DesktopSnapshot, ProjectRecord, SessionRecord } from "../shared/contracts";
import {
  LocalRouteLink,
  type AgentSettingsSection,
  type LocalRoute,
  type ProjectSettingsSection,
} from "./navigation";

export const PROJECT_SECTION_LABELS: Record<ProjectSettingsSection, string> = {
  overview: "Overview",
  automation: "Automation",
  capabilities: "Capabilities",
  safety: "Safety controls",
  audit: "Audit trail",
};

export const AGENT_SECTION_LABELS: Record<AgentSettingsSection, string> = {
  profile: "Profile",
  capabilities: "Capabilities",
  activity: "Activity",
  advanced: "Advanced",
};

function firstSessionRoute(snapshot: DesktopSnapshot, projectId?: string): LocalRoute {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId) ?? snapshot.projects[0];
  const agent = project && snapshot.agents.find((candidate) => candidate.projectId === project.id);
  const session = agent && snapshot.sessions.find((candidate) => candidate.agentId === agent.id);
  return project && agent && session
    ? { kind: "session", projectId: project.id, agentId: agent.id, sessionId: session.id }
    : { kind: "workspace" };
}

export function ProjectManagementHost({
  project,
  section,
  snapshot,
}: {
  project: ProjectRecord;
  section: ProjectSettingsSection;
  snapshot: DesktopSnapshot;
}) {
  const agents = snapshot.agents.filter((agent) => agent.projectId === project.id);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const sessions = snapshot.sessions.filter((session) => agentIds.has(session.agentId));
  return <section className="management-host" aria-label={`${project.name} project settings`}>
    <ManagementHeader
      eyebrow="Project"
      title={project.name}
      detail="Keep people-facing work close; configure automation and access only when you need them."
      backRoute={firstSessionRoute(snapshot, project.id)}
    />
    <nav className="management-tabs" aria-label="Project settings">
      {(Object.keys(PROJECT_SECTION_LABELS) as ProjectSettingsSection[]).map((item) => <LocalRouteLink
        key={item}
        to={{ kind: "project-settings", projectId: project.id, section: item }}
        className={item === section ? "active" : ""}
        aria-current={item === section ? "page" : undefined}
      >{PROJECT_SECTION_LABELS[item]}</LocalRouteLink>)}
    </nav>
    <div className="management-body">
      {section === "overview" && <ProjectOverview agents={agents} sessions={sessions} project={project} />}
      {section === "automation" && <AutomationPanel project={project} />}
      {section === "capabilities" && <><CapabilitiesPanel subject="project" /><CodexSubscriptionConnection projectId={project.id} /></>}
      {section === "safety" && <SafetyPanel />}
      {section === "audit" && <AuditPanel />}
    </div>
  </section>;
}

export function AgentManagementHost({
  project,
  agent,
  section,
  sessions,
}: {
  project: ProjectRecord;
  agent: AgentRecord;
  section: AgentSettingsSection;
  sessions: SessionRecord[];
}) {
  const backRoute = sessions[0]
    ? { kind: "session", projectId: project.id, agentId: agent.id, sessionId: sessions[0].id } as const
    : { kind: "project-settings", projectId: project.id, section: "overview" } as const;
  return <section className="management-host" aria-label={`${agent.name} agent settings`}>
    <ManagementHeader
      eyebrow={`${project.name} / Agent`}
      title={agent.name}
      detail="Identity, working context and access stay scoped to this project."
      backRoute={backRoute}
    />
    <nav className="management-tabs" aria-label="Agent settings">
      {(Object.keys(AGENT_SECTION_LABELS) as AgentSettingsSection[]).map((item) => <LocalRouteLink
        key={item}
        to={{ kind: "agent-settings", projectId: project.id, agentId: agent.id, section: item }}
        className={item === section ? "active" : ""}
        aria-current={item === section ? "page" : undefined}
      >{AGENT_SECTION_LABELS[item]}</LocalRouteLink>)}
    </nav>
    <div className="management-body">
      {section === "profile" && <AgentProfile agent={agent} sessions={sessions} />}
      {section === "capabilities" && <CapabilitiesPanel subject="agent" />}
      {section === "activity" && <AgentActivity sessions={sessions} />}
      {section === "advanced" && <AgentAdvanced />}
    </div>
  </section>;
}

export function InboxHost({
  snapshot,
  project,
}: {
  snapshot: DesktopSnapshot;
  project: ProjectRecord | null;
}) {
  const agents = project
    ? snapshot.agents.filter((agent) => agent.projectId === project.id)
    : snapshot.agents;
  const agentIds = new Set(agents.map((agent) => agent.id));
  const sessions = snapshot.sessions.filter((session) => agentIds.has(session.agentId));
  const pending = sessions.flatMap((session) => (snapshot.runtimes[session.id]?.pendingRequests ?? []).map((request) => ({ session, request })));
  return <section className="management-host inbox-host" aria-label="Pending items">
    <header className="local-page-heading"><h1>Inbox</h1></header>
    <div className="management-body">
      {!project && <LocalRecoveryFixture />}
      <div className="management-summary-row">
        <MetricCard label="Pending items" value={String(pending.length)} icon={<Inbox size={18} />} />
        <MetricCard label="Active agents" value={String(agents.length)} icon={<Bot size={18} />} />
        <MetricCard label="Sessions" value={String(sessions.length)} icon={<Activity size={18} />} />
      </div>
      {pending.length === 0 ? <div className="management-empty"><CheckCircle2 size={25} /><h2>Nothing needs your input</h2><p>When an Agent pauses for a decision, it will appear here with its project and session context.</p></div> : <div className="pending-list">{pending.map(({ session, request }) => {
        const agent = snapshot.agents.find((candidate) => candidate.id === session.agentId)!;
        const owningProject = snapshot.projects.find((candidate) => candidate.id === agent.projectId)!;
        return <LocalRouteLink key={`${session.id}:${String(request.requestId)}`} className="pending-row" to={{ kind: "session", projectId: owningProject.id, agentId: agent.id, sessionId: session.id }}>
          <span className="pending-icon"><CircleAlert size={16} /></span>
          <span><strong>{request.title}</strong><small>{owningProject.name} · {agent.name} · {session.title}</small></span>
          <span className="pending-open">Open session</span>
        </LocalRouteLink>;
      })}</div>}
    </div>
  </section>;
}

export function RouteRecovery({ route, snapshot }: { route: Extract<LocalRoute, { kind: "recovery" }>; snapshot: DesktopSnapshot }) {
  return <section className="route-recovery" role="alert">
    <div className="route-recovery-mark"><CircleAlert size={24} /></div>
    <span className="eyebrow">Navigation recovery</span>
    <h1>{route.reason === "invalid-context" ? "That link belongs somewhere else" : "We could not find that page"}</h1>
    <p>{route.reason === "invalid-context"
      ? "The project, Agent and session in this link do not match. Nothing was opened in another project."
      : "The address is not part of this Local workspace. Return to a known project without changing any data."}</p>
    <code>{route.requestedPath}</code>
    <LocalRouteLink className="button primary-button" to={firstSessionRoute(snapshot)}><ArrowLeft size={15} /> Return to workspace</LocalRouteLink>
  </section>;
}

function ManagementHeader({ eyebrow, title, detail, backRoute }: { eyebrow: string; title: string; detail: string; backRoute: LocalRoute }) {
  return <header className="management-header">
    <LocalRouteLink to={backRoute} className="management-back" aria-label="Back to session"><ArrowLeft size={16} /></LocalRouteLink>
    <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div>
    <span className="local-scope-badge"><LockKeyhole size={13} /> Local scope</span>
  </header>;
}

function ProjectOverview({ project, agents, sessions }: { project: ProjectRecord; agents: AgentRecord[]; sessions: SessionRecord[] }) {
  return <>
    <div className="management-summary-row">
      <MetricCard label="Agents" value={String(agents.length)} icon={<Bot size={18} />} />
      <MetricCard label="Sessions" value={String(sessions.length)} icon={<Activity size={18} />} />
      <MetricCard label="Location" value="Local" icon={<FolderKanban size={18} />} />
    </div>
    <div className="management-card wide"><div className="management-card-icon"><FolderKanban size={19} /></div><div><span className="eyebrow">Project context</span><h2>{project.name}</h2><p>Agents, sessions, automation and access remain isolated to this project. The local path stays hidden from this view.</p></div></div>
  </>;
}

function AutomationPanel({ project }: { project: ProjectRecord }) {
  return <div className="management-grid">
    <div className="management-card featured"><div className="management-card-icon"><Workflow size={19} /></div><div><span className="eyebrow">Project automation</span><h2>Reusable work, owned by {project.name}</h2><p>Automations remain Project-owned and independently runnable. Agent access can only be assigned by a later capability slice.</p><span className="management-status">Host ready · editor not migrated</span></div></div>
    <div className="management-card"><div className="management-card-icon"><Clock3 size={19} /></div><div><span className="eyebrow">Runs</span><h2>History and results</h2><p>Deep links for run status and results will attach here without moving ownership to an Agent.</p></div></div>
  </div>;
}

function CapabilitiesPanel({ subject }: { subject: "project" | "agent" }) {
  return <div className="management-grid">
    <div className="management-card featured"><div className="management-card-icon"><Sparkles size={19} /></div><div><span className="eyebrow">Capabilities</span><h2>{subject === "project" ? "Available to this project" : "Assigned to this Agent"}</h2><p>This host displays reviewed access only. Visibility here never grants execution authority.</p><span className="management-status">No capability editor connected</span></div></div>
    <div className="management-card"><div className="management-card-icon"><Cable size={19} /></div><div><span className="eyebrow">Connectors</span><h2>External systems</h2><p>Connections and credentials stay project-scoped and are configured by their owning Local slice.</p></div></div>
  </div>;
}

function SafetyPanel() {
  return <div className="management-grid">
    <div className="management-card featured"><div className="management-card-icon"><LockKeyhole size={19} /></div><div><span className="eyebrow">Safety controls</span><h2>Effective access stays outside the UI</h2><p>This page will preview and narrow server-owned rules. Saving a screen can never mint authority.</p><span className="management-status">Read-only host</span></div></div>
    <div className="management-card"><div className="management-card-icon"><SlidersHorizontal size={19} /></div><div><span className="eyebrow">Review</span><h2>Changes before activation</h2><p>Simulation, approval and rollback arrive with the dedicated safety-controls slice.</p></div></div>
  </div>;
}

function AuditPanel() {
  return <div className="management-grid">
    <div className="management-card featured"><div className="management-card-icon"><FileCheck2 size={19} /></div><div><span className="eyebrow">Audit trail</span><h2>Evidence without extra authority</h2><p>Administrative diagnostics can be attached here as bounded, redacted records. This host does not expose internal wire payloads.</p><span className="management-status">Read-only host</span></div></div>
  </div>;
}

function AgentProfile({ agent, sessions }: { agent: AgentRecord; sessions: SessionRecord[] }) {
  return <div className="management-grid">
    <div className="management-card featured"><div className="management-card-icon"><Bot size={19} /></div><div><span className="eyebrow">Agent</span><h2>{agent.name}</h2><p>{agent.instructions || "No role instructions have been added yet."}</p><span className="management-status">{sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span></div></div>
  </div>;
}

function AgentActivity({ sessions }: { sessions: SessionRecord[] }) {
  return <div className="management-card wide"><div className="management-card-icon"><Activity size={19} /></div><div><span className="eyebrow">Activity</span><h2>Sessions and results</h2><p>{sessions.length ? `${sessions.length} saved ${sessions.length === 1 ? "session is" : "sessions are"} available in the project tree.` : "Start a session from the project tree to see activity here."}</p></div></div>;
}

function AgentAdvanced() {
  return <div className="management-card wide"><div className="management-card-icon"><Settings2 size={19} /></div><div><span className="eyebrow">Advanced</span><h2>Administrative diagnostics</h2><p>Version and execution details can be mounted here by their owning slices. They remain read-only until an authorized service accepts a change.</p></div></div>;
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="metric-card"><span>{icon}</span><small>{label}</small><strong>{value}</strong></div>;
}
