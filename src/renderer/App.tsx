import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Ellipsis,
  Command,
  Copy,
  FileCode2,
  FileText,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  Inbox as InboxIcon,
  Music2,
  Paperclip,
  PanelLeft,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  X,
  Zap,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentRecord,
  ApprovalDecision,
  ComposerAttachment,
  ConversationMessage,
  DesktopEvent,
  DesktopSnapshot,
  DesktopWindowState,
  PendingRequest,
  ProjectRecord,
  RequestResponse,
  RuntimeDiagnostic,
  ModelOption,
  SessionRecord,
  SessionRuntime,
  UserInputQuestion,
  ContextWindowUsage,
} from "../shared/contracts";
import {
  approvalDecisionKey,
  buildElicitationContent,
  buildUserInputAnswers,
  effectiveApprovalDecisions,
  initialElicitationFormValues,
  parseElicitationFormSchema,
  userInputAnswersComplete,
} from "../shared/request-contracts";
import type { ElicitationFormField, ElicitationFormValues, UserInputSelection } from "../shared/request-contracts";
import { appendAttachmentsToDraft, MAX_COMPOSER_ATTACHMENTS, previewMap, retainPreviewPayloadsForDraft } from "./attachment-state";
import { effectiveSidebarWidth, initialSidebarLayout, MAX_SIDEBAR_WIDTH, MIN_MAIN_PANEL_WIDTH, MIN_SIDEBAR_WIDTH, sidebarLayoutForKey, sidebarLayoutForRequestedWidth, toggleSidebarLayout } from "./sidebar-state";
import { reduceDesktopSnapshot } from "./state";
import { anchoredTreeMenuPosition, pointerTreeMenuPosition } from "./tree-menu";
import { WorkspacePanel, WorkspacePanelControls } from "./WorkspacePanel";
import { initialWorkspacePanelState, updateWorkspacePanel, workspacePanelGeometry, workspacePanelStateForSession } from "./workspace-panel-state";
import { installResizeGestureCleanup, resizeRailMounted, workspacePanelResizeEnabled } from "./resize-rail-state";
import { ContextWindowIndicator } from "./ContextWindowIndicator";
import { CompactModelPicker } from "./CompactModelPicker";
import { UpdateEntry } from "./UpdateEntry";
import { useDesktopApi } from "./api-context";
import { AGENT_SECTION_LABELS, AgentManagementHost, InboxHost, PROJECT_SECTION_LABELS, ProjectManagementHost, RouteRecovery } from "./ManagementHost";
import { LocalNavigationProvider, localRouteHash, useLocalNavigation, validateRouteContext } from "./navigation";
import { LocalAgentsHost, agentUiErrorMessage } from "./LocalAgentsHost";
import { ProjectAgentsHost } from "./ProjectAgentsHost";
import { ProjectAgentAddHost } from "./ProjectAgentAddHost";
import { OrganizationAgentLibraryHost } from "./OrganizationAgentLibraryHost";
import type { LocalAgentWorkspace } from "../shared/agent-ui-contracts";
import { LocalPoliciesHost,policyUiErrorMessage } from "./LocalPoliciesHost";
import type { LocalPolicyUiWorkspace } from "../shared/policy/p2-ui-contracts";
import type { LocalDirectSessionItem } from "../shared/direct-session-ui-contracts";
import { DirectSessionHost, readDirectSessions } from "./DirectSessionHost";
import { ProviderConnectionDialog, ProviderSettingsHost } from "./ProviderConnections";

interface ComposerDraft { text: string; attachments: ComposerAttachment[]; attachmentLimitExceeded?: boolean }
interface NewSessionDraft extends ComposerDraft {
  agentId: string;
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
}
type ComposerDrafts = Record<string, ComposerDraft>;
type ExpandedState = Record<string, boolean>;
type NativeTreeTarget = { kind: "project"; record: ProjectRecord } | { kind: "agent"; record: AgentRecord };
type TreeEntity = NativeTreeTarget | { kind: "session"; record: SessionRecord };
function treeEntityName(target: TreeEntity): string { return target.kind === "session" ? target.record.title : target.record.name; }
function treeEntityKey(target: TreeEntity): string { return `${target.kind}:${target.record.id}`; }

const GLOBAL_RAIL_WIDTH = 58;

const EMPTY_SNAPSHOT: DesktopSnapshot = {
  appServer: { status: "starting", codexVersion: null, diagnostic: null },
  projects: [],
  agents: [],
  sessions: [],
  runtimes: {},
};

function runtimeFor(snapshot: DesktopSnapshot, sessionId: string | null): SessionRuntime {
  return (
    (sessionId && snapshot.runtimes[sessionId]) || {
      status: "idle",
      activeTurnId: null,
      messages: [],
      pendingRequests: [],
      error: null,
    }
  );
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function isTurnBusy(status: SessionRuntime["status"]) {
  return status === "starting" || status === "running" || status === "waiting";
}

function isResizeKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((existing, currentIndex) => (currentIndex === index ? item : existing));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function App() {
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const discardWorkspaceChanges = useRef<() => void>(() => undefined);
  const handleDirtyStateChange = useCallback((dirty: boolean, discard: () => void) => {
    discardWorkspaceChanges.current = discard;
    setWorkspaceDirty(dirty);
  }, []);
  const discardDirtyState = useCallback(() => {
    discardWorkspaceChanges.current();
    setWorkspaceDirty(false);
  }, []);
  return <LocalNavigationProvider isDirty={workspaceDirty} onDiscard={discardDirtyState}>
    <DesktopApp onWorkspaceDirtyStateChange={handleDirtyStateChange} workspaceDirty={workspaceDirty} onDiscardWorkspaceChanges={discardDirtyState} />
  </LocalNavigationProvider>;
}

function DesktopApp({ onWorkspaceDirtyStateChange, workspaceDirty, onDiscardWorkspaceChanges }: {
  onWorkspaceDirtyStateChange: (dirty: boolean, discard: () => void) => void;
  workspaceDirty: boolean;
  onDiscardWorkspaceChanges: () => void;
}) {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>(EMPTY_SNAPSHOT);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [newSessionDraft, setNewSessionDraft] = useState<NewSessionDraft | null>(null);
  const [startingDraft, setStartingDraft] = useState(false);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [drafts, setDrafts] = useState<ComposerDrafts>({});
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [sessionDragging, setSessionDragging] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [modal, setModal] = useState<"project" | "agent" | null>(null);
  const [newAgentProjectId, setNewAgentProjectId] = useState<string | null>(null);
  const [nativeTreeDialog, setNativeTreeDialog] = useState<{ target: NativeTreeTarget; action: "rename" | "remove" } | null>(null);
  const [renameSession, setRenameSession] = useState<SessionRecord | null>(null);
  const [deletingSession, setDeletingSession] = useState<SessionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [localAgentWorkspace, setLocalAgentWorkspace] = useState<LocalAgentWorkspace | null>(null);
  const [localAgentError, setLocalAgentError] = useState<string | null>(null);
  const [localPolicyWorkspace,setLocalPolicyWorkspace] = useState<LocalPolicyUiWorkspace|null>(null);
  const [localPolicyError,setLocalPolicyError] = useState<string|null>(null);
  const [directSessions,setDirectSessions] = useState<LocalDirectSessionItem[]>([]);
  const [windowState, setWindowState] = useState<DesktopWindowState>({ isFullScreen: false });
  const [sidebarLayout, setSidebarLayout] = useState(initialSidebarLayout);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [workspacePanelState, dispatchWorkspacePanel] = useReducer(updateWorkspacePanel, undefined, initialWorkspacePanelState);
  const [workspacePanelResizing, setWorkspacePanelResizing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  const [profileOpen, setProfileOpen] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [agentDetailsOpen, setAgentDetailsOpen] = useState(false);
  const [treeMenu, setTreeMenu] = useState<
    | { kind: "project"; project: ProjectRecord; x: number; y: number }
    | { kind: "agent"; agent: AgentRecord; x: number; y: number }
    | { kind: "session"; session: SessionRecord; x: number; y: number }
    | null
  >(null);
  const messageViewportRef = useRef<HTMLElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const agentDetailsRef = useRef<HTMLDivElement>(null);
  const treeMenuRef = useRef<HTMLDivElement>(null);
  const treeMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const previousSessionId = useRef<string | null>(null);
  const lastSelectedSessionId = useRef<string | null>(null);
  const draftEpochRef = useRef(0);
  const sessionDragDepthRef = useRef(0);
  const appShellRef = useRef<HTMLDivElement>(null);
  const sidebarPointerRef = useRef<number | null>(null);
  const workspacePanelPointerRef = useRef<number | null>(null);
  const followLiveOutputRef = useRef(true);

  const api = useDesktopApi();
  const acceptLocalAgentWorkspace = useCallback((workspace: LocalAgentWorkspace) => {
    setLocalAgentWorkspace(workspace);
    setLocalAgentError(null);
  }, []);
  const acceptLocalPolicyWorkspace = useCallback((workspace:LocalPolicyUiWorkspace) => {
    setLocalPolicyWorkspace(workspace);setLocalPolicyError(null);
  },[]);
  const reloadDirectSessions=useCallback(async()=>{
    if (!api?.localDirectSessions?.request || !localAgentWorkspace) {setDirectSessions([]);return;}
    const page=await readDirectSessions(api);
    if (page.items.some(item=>item.projectId!==localAgentWorkspace.projectId)) throw new Error("CONTEXT_MISMATCH");
    setDirectSessions(page.items);
  },[api,localAgentWorkspace]);
  useEffect(()=>{void reloadDirectSessions().catch(()=>setDirectSessions([]));},[reloadDirectSessions]);
  const { route, pendingRoute, navigate, replace, confirmPending, cancelPending } = useLocalNavigation();
  useEffect(()=>{if (route.kind==="direct-session") void reloadDirectSessions().catch(()=>setDirectSessions([]));},[route,reloadDirectSessions]);
  const routeRef = useRef(route);
  routeRef.current = route;
  const pendingRouteRef = useRef(pendingRoute);
  pendingRouteRef.current = pendingRoute;
  const closeTreeMenuAfterCommit = useCallback(() => setTreeMenu(null), []);

  useLayoutEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    if (!sidebarResizing && !workspacePanelResizing) return;
    const finishResize = () => {
      sidebarPointerRef.current = null;
      workspacePanelPointerRef.current = null;
      setSidebarResizing(false);
      setWorkspacePanelResizing(false);
    };
    return installResizeGestureCleanup(window, finishResize);
  }, [sidebarResizing, workspacePanelResizing]);

  const applyEvent = useCallback((event: DesktopEvent) => setSnapshot((current) => reduceDesktopSnapshot(current, event)), []);

  useEffect(() => {
    if (!api) {
      setBootError("The desktop bridge is unavailable. Start Orchestrion in Electron to connect to Codex.");
      return;
    }
    api
      .bootstrap()
      .then((next) => {
        setSnapshot(next);
        const requestedRoute = routeRef.current;
        if (requestedRoute.kind === "workspace") {
          const firstSession = next.sessions[0];
          const firstAgent = firstSession && next.agents.find((agent) => agent.id === firstSession.agentId);
          const firstProject = firstAgent && next.projects.find((project) => project.id === firstAgent.projectId);
          if (firstSession && firstAgent && firstProject) {
            replace({ kind: "session", projectId: firstProject.id, agentId: firstAgent.id, sessionId: firstSession.id });
          }
        }
        setBootError(null);
        void api.listModels().then(setModels).catch(() => setModels([]));
        if (api.localAgents && typeof api.localAgents.snapshot === "function") {
          void api.localAgents.snapshot().then((value) => acceptLocalAgentWorkspace(value.workspace))
            .catch((error) => setLocalAgentError(agentUiErrorMessage(error)));
        } else {
          setLocalAgentError(agentUiErrorMessage(new Error("SERVICE_UNAVAILABLE")));
        }
        if (api.localPolicies && typeof api.localPolicies.snapshot === "function") {
          void api.localPolicies.snapshot().then((value) => acceptLocalPolicyWorkspace(value.workspace))
            .catch((error) => setLocalPolicyError(policyUiErrorMessage(error)));
        } else {
          setLocalPolicyError(policyUiErrorMessage(new Error("SERVICE_UNAVAILABLE")));
        }
      })
      .catch((error: unknown) => setBootError(error instanceof Error ? error.message : "Could not connect to the local Codex runtime."));
    const unsub = api.onEvent(applyEvent);
    const unsubscribeWindowState = api.onWindowState(setWindowState);
    void api.getWindowState().then(setWindowState).catch(() => setWindowState({ isFullScreen: false }));
    return () => {
      unsub();
      unsubscribeWindowState();
    };
  }, [acceptLocalAgentWorkspace, acceptLocalPolicyWorkspace, api, applyEvent, replace]);

  useEffect(() => {
    if (snapshot.appServer.status === "starting") return;
    const nextRoute = validateRouteContext(route, snapshot, localAgentWorkspace,localPolicyWorkspace);
    if (localRouteHash(nextRoute) !== localRouteHash(route)) {
      replace(nextRoute);
      setSelectedSessionId(null);
      setNewSessionDraft(null);
      return;
    }
    if (nextRoute.kind === "session") {
      setNewSessionDraft(null);
      setSelectedSessionId(nextRoute.sessionId);
      setExpanded((current) => ({ ...current, [nextRoute.projectId]: true, [nextRoute.agentId]: true }));
      return;
    }
    if (!newSessionDraft) setSelectedSessionId(null);
  }, [localAgentWorkspace, localPolicyWorkspace, newSessionDraft, replace, route, snapshot]);

  useLayoutEffect(() => {
    dispatchWorkspacePanel({ type: "session-changed", sessionId: selectedSessionId });
  }, [selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId) lastSelectedSessionId.current = selectedSessionId;
  }, [selectedSessionId]);

  const selectedSession = snapshot.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedAgent = selectedSession ? snapshot.agents.find((agent) => agent.id === selectedSession.agentId) ?? null : null;
  const selectedProject = selectedAgent ? snapshot.projects.find((project) => project.id === selectedAgent.projectId) ?? null : null;
  const draftAgent = newSessionDraft ? snapshot.agents.find((agent) => agent.id === newSessionDraft.agentId) ?? null : null;
  const draftProject = draftAgent ? snapshot.projects.find((project) => project.id === draftAgent.projectId) ?? null : null;
  const activeRoute = snapshot.appServer.status === "starting" ? route : validateRouteContext(route, snapshot, localAgentWorkspace,localPolicyWorkspace);
  const routeProjectId = activeRoute.kind === "inbox" ? activeRoute.projectId : "projectId" in activeRoute ? activeRoute.projectId : null;
  const routeProject = routeProjectId ? snapshot.projects.find((project) => project.id === routeProjectId) ?? null : null;
  const routeAgent = activeRoute.kind === "session" || activeRoute.kind === "agent-settings"
    ? snapshot.agents.find((agent) => agent.id === activeRoute.agentId && agent.projectId === activeRoute.projectId) ?? null
    : null;
  const activeAgent = selectedAgent ?? draftAgent ?? routeAgent;
  const activeProject = selectedProject ?? draftProject ?? routeProject;
  const modalProject = newAgentProjectId ? snapshot.projects.find((project) => project.id === newAgentProjectId) ?? null : activeProject;
  const runtime = runtimeFor(snapshot, selectedSessionId);
  const turnBusy = isTurnBusy(runtime.status);
  const canStop = runtime.status === "running" || runtime.status === "waiting";
  const starting = runtime.status === "starting" || startingDraft;
  const sessionViewActive = activeRoute.kind === "session" || (activeRoute.kind === "workspace" && Boolean(newSessionDraft));
  const localAgentViewActive = activeRoute.kind === "local-agents" || activeRoute.kind === "local-agent-create" || activeRoute.kind === "local-agent" || activeRoute.kind === "project-agents" || activeRoute.kind === "project-agent-add" || activeRoute.kind === "project-agent-create" || activeRoute.kind === "agent-library" || activeRoute.kind === "agent-library-detail" || activeRoute.kind === "agent-library-create";
  const localPolicyViewActive = activeRoute.kind === "local-policies" || activeRoute.kind === "local-policy";
  const workspaceContextViewActive = activeRoute.kind === "workspace" || activeRoute.kind === "session" || activeRoute.kind === "direct-session" || activeRoute.kind === "project-settings" || activeRoute.kind === "agent-settings";
  const streamlinedManagementViewActive = activeRoute.kind === "inbox" || activeRoute.kind === "provider-settings" || localAgentViewActive || localPolicyViewActive;

  useEffect(() => {
    if (!messageViewportRef.current || selectedSessionId === previousSessionId.current) return;
    messageViewportRef.current.scrollTop = 0;
    followLiveOutputRef.current = shouldFollowLiveOutput(messageViewportRef.current);
    previousSessionId.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!messageViewportRef.current || !selectedSessionId) return;
    if (followLiveOutputRef.current && (runtime.status === "running" || runtime.messages.some((message) => message.streaming))) {
      messageViewportRef.current.scrollTop = messageViewportRef.current.scrollHeight;
    }
  }, [selectedSessionId, runtime.status, runtime.messages, runtime.pendingRequests]);

  const trackLiveOutputPreference = useCallback(() => {
    if (messageViewportRef.current) followLiveOutputRef.current = shouldFollowLiveOutput(messageViewportRef.current);
  }, []);

  useEffect(() => {
    setAttachmentPreviews({});
    setDrafts((current) => retainPreviewPayloadsForDraft(current, selectedSessionId));
    sessionDragDepthRef.current = 0;
    setSessionDragging(false);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!sessionViewActive || turnBusy || starting || !api || snapshot.appServer.status === "error") {
      sessionDragDepthRef.current = 0;
      setSessionDragging(false);
    }
  }, [api, sessionViewActive, snapshot.appServer.status, starting, turnBusy]);

  useEffect(() => {
    if (!api || !selectedSessionId) return;
    let active = true;
    void api.loadAttachmentPreviews({ sessionId: selectedSessionId }).then((previews) => {
      if (active) setAttachmentPreviews(previews);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, selectedSessionId, runtime.messages.length]);

  useEffect(() => {
    const closeFloatingLayers = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideNavigationGuard = target instanceof Element && target.closest("[data-unsaved-navigation-guard]") !== null;
      if (!profileRef.current?.contains(target)) setProfileOpen(false);
      if (!agentDetailsRef.current?.contains(target)) setAgentDetailsOpen(false);
      if (!pendingRouteRef.current && !insideNavigationGuard && !treeMenuRef.current?.contains(target)) setTreeMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setProfileOpen(false);
      setAgentDetailsOpen(false);
    };
    document.addEventListener("mousedown", closeFloatingLayers);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeFloatingLayers);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!treeMenu) return;
    treeMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const anchor = treeMenuAnchorRef.current;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = [...(treeMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [])];
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTreeMenu(null);
      queueMicrotask(() => anchor?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [treeMenu]);

  const setDraft = (value: string) => {
    if (newSessionDraft) {
      setNewSessionDraft((current) => current ? { ...current, text: value } : current);
      return;
    }
    if (!selectedSessionId) return;
    setDrafts((current) => ({ ...current, [selectedSessionId]: { text: value, attachments: current[selectedSessionId]?.attachments ?? [] } }));
  };

  const send = async () => {
    if (!api || turnBusy || startingDraft) return;
    const draft = newSessionDraft ?? (selectedSessionId ? drafts[selectedSessionId] : undefined) ?? { text: "", attachments: [] };
    const text = draft.text.trim();
    if (!text && draft.attachments.length === 0) return;
    setAttachmentPreviews(previewMap(draft.attachments));
    setActionError(null);
    if (newSessionDraft) {
      const draftEpoch = draftEpochRef.current;
      setStartingDraft(true);
      try {
        const session = await api.startSession({
          agentId: newSessionDraft.agentId,
          text,
          attachments: draft.attachments,
          model: newSessionDraft.model,
          modelProvider: newSessionDraft.modelProvider,
          reasoningEffort: newSessionDraft.reasoningEffort,
          serviceTier: newSessionDraft.serviceTier,
        });
        setSnapshot((current) => ({ ...current, sessions: upsertById(current.sessions, session) }));
        if (draftEpochRef.current === draftEpoch) {
          setNewSessionDraft(null);
          const agent = snapshot.agents.find((candidate) => candidate.id === session.agentId);
          if (agent) navigate({ kind: "session", projectId: agent.projectId, agentId: agent.id, sessionId: session.id });
        }
      } catch (error: unknown) {
        if (draftEpochRef.current === draftEpoch) setActionError(errorMessage(error, "Session could not be started."));
      } finally {
        if (draftEpochRef.current === draftEpoch) setStartingDraft(false);
      }
      return;
    }
    if (!selectedSessionId) return;
    setDrafts((current) => ({ ...current, [selectedSessionId]: { text: "", attachments: [] } }));
    try {
      await api.sendMessage({ sessionId: selectedSessionId, text, attachments: draft.attachments });
    } catch (error: unknown) {
      const message = errorMessage(error, "Message could not be sent.");
      setActionError(message);
      setDrafts((current) => ({ ...current, [selectedSessionId]: draft }));
      setSnapshot((current) => {
        const currentRuntime = runtimeFor(current, selectedSessionId);
        return { ...current, runtimes: { ...current.runtimes, [selectedSessionId]: { ...currentRuntime, status: "failed", error: message } } };
      });
    }
  };

  const stop = async () => {
    if (!api || !selectedSessionId || !turnBusy) return;
    setActionError(null);
    try {
      await api.stopTurn({ sessionId: selectedSessionId });
    } catch (error: unknown) {
      setActionError(errorMessage(error, "The turn could not be stopped."));
    }
  };

  const respond = async (response: RequestResponse) => {
    if (!api) return;
    setActionError(null);
    try {
      await api.respondToRequest(response);
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Your response could not be sent."));
    }
  };

  const retry = async () => {
    if (!api) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.restartCodex();
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Codex could not be restarted."));
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (name: string, path: string) => {
    if (!api) return;
    setBusy(true);
    setActionError(null);
    try {
      const project = await api.createProject({ name, path });
      setSnapshot((current) => ({ ...current, projects: upsertById(current.projects, project) }));
      setExpanded((current) => ({ ...current, [project.id]: true }));
      setModal(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Project could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const createAgent = async (name: string, instructions: string) => {
    if (!api || !modalProject) return;
    setBusy(true);
    setActionError(null);
    try {
      const agent = await api.createAgent({ projectId: modalProject.id, name, instructions });
      setSnapshot((current) => ({ ...current, agents: upsertById(current.agents, agent) }));
      setExpanded((current) => ({ ...current, [agent.id]: true, [modalProject.id]: true }));
      setModal(null);
      setNewAgentProjectId(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Agent could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const createSession = (agent: AgentRecord) => {
    navigate({ kind: "workspace" }, {
      afterCommit: () => {
        draftEpochRef.current += 1;
        setStartingDraft(false);
        setActionError(null);
        const defaultModel = models.find((model) => model.isDefault) ?? models[0];
        setNewSessionDraft({
          agentId: agent.id,
          text: "",
          attachments: [],
          model: defaultModel?.model ?? null,
          modelProvider: defaultModel?.providerId ?? null,
          reasoningEffort: defaultModel?.defaultReasoningEffort ?? null,
          serviceTier: defaultModel?.defaultServiceTier ?? null,
        });
        setSelectedSessionId(null);
        setExpanded((current) => ({ ...current, [agent.id]: true }));
      },
      finalizeCommit: closeTreeMenuAfterCommit,
    });
  };

  const toggle = (id: string) => setExpanded((current) => ({ ...current, [id]: !(current[id] ?? true) }));

  const openTreeMenu = (event: ReactMouseEvent<HTMLButtonElement>, target: TreeEntity, anchored: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    setAgentDetailsOpen(false);
    treeMenuAnchorRef.current = event.currentTarget;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const height = target.kind === "session" ? 80 : target.record.executionMode === "governed" ? 110 : 180;
    const position = anchored
      ? anchoredTreeMenuPosition(event.currentTarget.getBoundingClientRect(), viewport, height)
      : pointerTreeMenuPosition(event.clientX, event.clientY, viewport, height);
    if (target.kind === "project") setTreeMenu({ kind: "project", project: target.record, ...position });
    else if (target.kind === "agent") setTreeMenu({ kind: "agent", agent: target.record, ...position });
    else setTreeMenu({ kind: "session", session: target.record, ...position });
  };

  const openNativeTreeDialog = (target: NativeTreeTarget, action: "rename" | "remove") => {
    setActionError(null);
    setNativeTreeDialog({ target, action });
    setTreeMenu(null);
  };

  const saveNativeTreeAction = async (name: string) => {
    if (!api || !nativeTreeDialog) return;
    const { target, action } = nativeTreeDialog;
    setBusy(true);
    setActionError(null);
    try {
      if ([api.renameProject, api.renameAgent, api.deleteProject, api.deleteAgent].some(method => typeof method !== "function"))
        throw new Error("Sidebar actions are out of date. Fully quit and restart the desktop app.");
      if (action === "rename") {
        if (target.kind === "project") {
          const record = await api.renameProject({ projectId: target.record.id, name });
          setSnapshot(current => ({ ...current, projects: current.projects.map(row => row.id === record.id ? record : row) }));
        } else {
          const record = await api.renameAgent({ agentId: target.record.id, name });
          setSnapshot(current => ({ ...current, agents: current.agents.map(row => row.id === record.id ? record : row) }));
        }
      } else {
        if (target.kind === "project") await api.deleteProject({ projectId: target.record.id });
        else await api.deleteAgent({ agentId: target.record.id });
        setSnapshot(current => target.kind === "project"
          ? { ...current, projects: current.projects.filter(row => row.id !== target.record.id) }
          : { ...current, agents: current.agents.filter(row => row.id !== target.record.id) });
        if ((target.kind === "project" && "projectId" in activeRoute && activeRoute.projectId === target.record.id)
          || (target.kind === "agent" && "agentId" in activeRoute && activeRoute.agentId === target.record.id)) {
          replace({ kind: "workspace" });
          setNewSessionDraft(null);
        }
      }
      setNativeTreeDialog(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, `The ${target.kind} could not be ${action === "rename" ? "renamed" : "removed"}.`));
      setNativeTreeDialog(null);
    } finally { setBusy(false); }
  };

  const beginCreateAgent = (project: ProjectRecord) => {
    setTreeMenu(null);
    if (project.executionMode === "governed") {
      navigate({ kind: "local-agents", projectId: project.id });
      return;
    }
    setNewAgentProjectId(project.id);
    setModal("agent");
  };

  const beginCreateSession = (agent: AgentRecord) => {
    createSession(agent);
  };

  const selectSession = (sessionId: string) => {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const agent = session && snapshot.agents.find((candidate) => candidate.id === session.agentId);
    if (!session || !agent) return;
    draftEpochRef.current += 1;
    navigate({ kind: "session", projectId: agent.projectId, agentId: agent.id, sessionId });
  };

  const saveSessionName = async (title: string) => {
    if (!api || !renameSession) return;
    setBusy(true);
    setActionError(null);
    try {
      const session = await api.renameSession({ sessionId: renameSession.id, title });
      setSnapshot((current) => ({ ...current, sessions: upsertById(current.sessions, session) }));
      setRenameSession(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Session could not be renamed."));
    } finally {
      setBusy(false);
    }
  };

  const deleteConfirmedSession = async () => {
    if (!api || !deletingSession) return;
    const session = deletingSession;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteSession({ sessionId: session.id });
      const remaining = snapshot.sessions.filter((candidate) => candidate.id !== session.id);
      const nextSessionId = selectedSessionId === session.id
        ? remaining.find((candidate) => candidate.agentId === session.agentId)?.id ?? remaining[0]?.id ?? null
        : selectedSessionId;
      setSnapshot((current) => {
        const runtimes = { ...current.runtimes };
        delete runtimes[session.id];
        return {
          ...current,
          sessions: current.sessions.filter((candidate) => candidate.id !== session.id),
          runtimes,
        };
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      if (selectedSessionId === session.id) {
        setAttachmentPreviews({});
        dispatchWorkspacePanel({ type: "session-changed", sessionId: nextSessionId });
        const nextSession = remaining.find((candidate) => candidate.id === nextSessionId);
        const nextAgent = nextSession && snapshot.agents.find((candidate) => candidate.id === nextSession.agentId);
        if (nextSession && nextAgent) replace({ kind: "session", projectId: nextAgent.projectId, agentId: nextAgent.id, sessionId: nextSession.id });
        else replace({ kind: "workspace" });
      }
      setRenameSession((current) => current?.id === session.id ? null : current);
      setDeletingSession(null);
    } catch (error: unknown) {
      setDeletingSession(null);
      setActionError(errorMessage(error, "Session could not be deleted."));
    } finally {
      setBusy(false);
    }
  };

  const updateSessionModel = async (model: ModelOption, reasoningEffort: string | null, serviceTier: string | null) => {
    if (newSessionDraft) {
      setNewSessionDraft((current) => current ? {
        ...current,
        model: model.model,
        modelProvider: model.providerId,
        reasoningEffort,
        serviceTier,
      } : current);
      return;
    }
    if (!api || !selectedSession) return;
    setActionError(null);
    try {
      const session = await api.updateSessionSettings({
        sessionId: selectedSession.id,
        model: model.model,
        modelProvider: model.providerId,
        reasoningEffort,
        serviceTier,
      });
      setSnapshot((current) => ({ ...current, sessions: upsertById(current.sessions, session) }));
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Model settings could not be updated."));
      throw error;
    }
  };

  const appendAttachments = (attachments: ComposerAttachment[]) => {
    if (attachments.length === 0) return;
    if (newSessionDraft) {
      setNewSessionDraft((current) => current ? appendAttachmentsToDraft(current, attachments) : current);
      return;
    }
    if (!selectedSessionId) return;
    setDrafts((current) => ({
      ...current,
      [selectedSessionId]: appendAttachmentsToDraft({
        text: current[selectedSessionId]?.text ?? "",
        attachments: current[selectedSessionId]?.attachments ?? [],
      }, attachments),
    }));
  };

  const addFiles = async () => {
    if (!api) return;
    const draftEpoch = draftEpochRef.current;
    setActionError(null);
    try {
      const attachments = await api.chooseAttachments();
      if (draftEpochRef.current === draftEpoch) appendAttachments(attachments);
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Files could not be selected."));
    }
  };

  const addFolder = async () => {
    if (!api) return;
    const draftEpoch = draftEpochRef.current;
    const chosen = await api.chooseAttachmentFolder();
    if (chosen && draftEpochRef.current === draftEpoch) appendAttachments([chosen]);
  };

  const addDroppedFiles = async (files: FileList) => {
    if (!api || files.length === 0) return;
    const draftEpoch = draftEpochRef.current;
    setActionError(null);
    try {
      const attachments = await api.resolveDroppedAttachments(Array.from(files));
      if (draftEpochRef.current === draftEpoch) appendAttachments(attachments);
    } catch (error: unknown) {
      setActionError(errorMessage(error, "Dropped files could not be added."));
    }
  };

  const sessionDropDisabled = !api || snapshot.appServer.status === "error" || turnBusy || starting;
  const isFileDrag = (event: ReactDragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
  const handleSessionDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!sessionViewActive || !isFileDrag(event)) return;
    event.preventDefault();
    if (!sessionDropDisabled) {
      sessionDragDepthRef.current += 1;
      setSessionDragging(true);
    }
  };
  const handleSessionDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!sessionViewActive || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = sessionDropDisabled ? "none" : "copy";
  };
  const handleSessionDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    sessionDragDepthRef.current = Math.max(0, sessionDragDepthRef.current - 1);
    if (sessionDragDepthRef.current === 0) setSessionDragging(false);
  };
  const handleSessionDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!sessionViewActive || !isFileDrag(event)) return;
    event.preventDefault();
    sessionDragDepthRef.current = 0;
    setSessionDragging(false);
    if (!sessionDropDisabled) void addDroppedFiles(event.dataTransfer.files);
  };

  const removeAttachment = (attachmentId: string) => {
    if (newSessionDraft) {
      setNewSessionDraft((current) => current ? { ...current, attachmentLimitExceeded: false, attachments: current.attachments.filter((attachment) => attachment.id !== attachmentId) } : current);
      return;
    }
    if (!selectedSessionId) return;
    setDrafts((current) => ({
      ...current,
      [selectedSessionId]: {
        text: current[selectedSessionId]?.text ?? "",
        attachmentLimitExceeded: false,
        attachments: (current[selectedSessionId]?.attachments ?? []).filter((attachment) => attachment.id !== attachmentId),
      },
    }));
  };

  const sessionCount = snapshot.sessions.length+directSessions.length;
  const composerDraft = newSessionDraft ?? (selectedSessionId ? drafts[selectedSessionId] : undefined) ?? { text: "", attachments: [] };
  const composerSettings = selectedSession ?? newSessionDraft;
  const activeSessionTitle = selectedSession?.title ?? (newSessionDraft ? "New session" : null);
  const sidebarCollapsed = sidebarLayout.collapsed;
  const contextSidebarFits = viewportWidth >= GLOBAL_RAIL_WIDTH + MIN_SIDEBAR_WIDTH + MIN_MAIN_PANEL_WIDTH;
  const contextSidebarCollapsed = sidebarCollapsed || !workspaceContextViewActive || !contextSidebarFits;
  const availableSidebarWidth = effectiveSidebarWidth(MAX_SIDEBAR_WIDTH, viewportWidth - GLOBAL_RAIL_WIDTH);
  const visibleSidebarWidth = effectiveSidebarWidth(sidebarLayout.width, viewportWidth - GLOBAL_RAIL_WIDTH);
  const renderedSidebarWidth = contextSidebarCollapsed ? 0 : visibleSidebarWidth;
  const leftNavigationWidth = GLOBAL_RAIL_WIDTH + renderedSidebarWidth;
  const activeWorkspacePanelState = workspacePanelStateForSession(workspacePanelState, selectedSessionId);
  const panelGeometry = workspacePanelGeometry(activeWorkspacePanelState, viewportWidth, leftNavigationWidth, false);
  const appShellStyle = {
    "--global-rail-width": `${GLOBAL_RAIL_WIDTH}px`,
    "--sidebar-width": `${renderedSidebarWidth}px`,
    "--left-navigation-width": `${leftNavigationWidth}px`,
    "--workspace-panel-width": `${sessionViewActive && (activeWorkspacePanelState.open || workspacePanelResizing) ? panelGeometry.renderedWidth : 0}px`,
  } as CSSProperties;
  const routeContextLabel = activeRoute.kind === "inbox"
    ? activeProject ? `${activeProject.name} – Inbox` : "Inbox"
    : activeRoute.kind === "provider-settings" ? "Providers"
    : activeRoute.kind === "direct-session" ? "Direct Session"
    : activeRoute.kind === "project-settings"
      ? `${activeProject?.name ?? "Project"} – ${PROJECT_SECTION_LABELS[activeRoute.section]}`
      : activeRoute.kind === "agent-settings"
        ? `${activeAgent?.name ?? "Agent"} – ${AGENT_SECTION_LABELS[activeRoute.section]}`
        : localAgentViewActive
          ? activeRoute.kind === "project-agents" ? "Project Agents" : activeRoute.kind === "project-agent-add" ? "Add Agent" : activeRoute.kind === "project-agent-create" ? "Create Project Agent" : activeRoute.kind === "agent-library" || activeRoute.kind === "agent-library-detail" ? "Organization Agent Library" : activeRoute.kind === "agent-library-create" ? "New organization Agent" : activeRoute.kind === "local-agents" ? "Local Agents" : activeRoute.kind === "local-agent-create" ? "New Local Agent" : "Local Agent version"
        : localPolicyViewActive
          ? activeRoute.kind === "local-policies" ? "Policies" : "Policy release"
        : activeRoute.kind === "recovery" ? "Navigation recovery" : null;
  const inboxProject = activeRoute.kind === "inbox" && activeRoute.projectId
    ? snapshot.projects.find((project) => project.id === activeRoute.projectId) ?? null
    : null;
  const pendingRequestCount = Object.values(snapshot.runtimes).reduce((total, item) => total + item.pendingRequests.length, 0);

  const openChats = () => {
    const preferredSession = snapshot.sessions.find((session) => session.id === lastSelectedSessionId.current) ?? snapshot.sessions[0];
    const preferredAgent = preferredSession && snapshot.agents.find((agent) => agent.id === preferredSession.agentId);
    if (preferredSession && preferredAgent) {
      navigate({ kind: "session", projectId: preferredAgent.projectId, agentId: preferredAgent.id, sessionId: preferredSession.id });
      return;
    }
    navigate({ kind: "workspace" });
  };

  const toggleSidebar = () => {
    setProfileOpen(false);
    setAgentDetailsOpen(false);
    setSidebarLayout(toggleSidebarLayout);
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setProfileOpen(false);
    setAgentDetailsOpen(false);
    setSidebarResizing(true);
  };

  const resizeSidebar = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarPointerRef.current !== event.pointerId) return;
    const shellBounds = appShellRef.current?.getBoundingClientRect();
    const requestedWidth = event.clientX - (shellBounds?.left ?? 0) - GLOBAL_RAIL_WIDTH;
    const availableWidth = effectiveSidebarWidth(MAX_SIDEBAR_WIDTH, (shellBounds?.width ?? viewportWidth) - GLOBAL_RAIL_WIDTH);
    setSidebarLayout((current) => sidebarLayoutForRequestedWidth(
      requestedWidth < MIN_SIDEBAR_WIDTH ? requestedWidth : Math.min(requestedWidth, availableWidth),
      current.width,
    ));
  };

  const stopSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarPointerRef.current !== event.pointerId) return;
    sidebarPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setSidebarResizing(false);
  };

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = sidebarLayoutForKey({ ...sidebarLayout, width: visibleSidebarWidth }, event.key, availableSidebarWidth);
    if (!next) return;
    event.preventDefault();
    setSidebarLayout(next);
  };

  const startWorkspacePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !activeWorkspacePanelState.open || activeWorkspacePanelState.maximized) return;
    event.preventDefault();
    workspacePanelPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setWorkspacePanelResizing(true);
  };

  const resizeWorkspacePanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (workspacePanelPointerRef.current !== event.pointerId || !workspacePanelResizeEnabled(activeWorkspacePanelState.open, activeWorkspacePanelState.maximized)) return;
    const shellBounds = appShellRef.current?.getBoundingClientRect();
    const right = shellBounds?.right ?? window.innerWidth;
    dispatchWorkspacePanel({ type: "resize", width: right - event.clientX, workspaceWidth: panelGeometry.workspaceWidth });
  };

  const stopWorkspacePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (workspacePanelPointerRef.current !== event.pointerId) return;
    workspacePanelPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setWorkspacePanelResizing(false);
  };

  const resizeWorkspacePanelWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isResizeKey(event.key)) return;
    event.preventDefault();
    dispatchWorkspacePanel({ type: "resize-key", key: event.key, workspaceWidth: panelGeometry.workspaceWidth });
  };

  return (
    <div ref={appShellRef} className={`app-shell ${windowState.isFullScreen ? "native-fullscreen" : ""} ${sidebarResizing ? "sidebar-is-resizing" : ""} ${workspacePanelResizing ? "workspace-panel-is-resizing" : ""} ${streamlinedManagementViewActive ? "streamlined-management-shell" : ""}`} style={appShellStyle}>
      <header className={`topbar topbar-drag-region ${contextSidebarCollapsed ? "sidebar-hidden" : ""}`} aria-label="Window drag region">
        <span className="topbar-sidebar-tone" aria-hidden="true" />
        {workspaceContextViewActive && contextSidebarFits && <button className="sidebar-visibility-button" onClick={toggleSidebar} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"} title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}><PanelLeft size={15} /></button>}
        {!streamlinedManagementViewActive && <div className="topbar-context" title={routeContextLabel ?? (activeAgent && activeSessionTitle ? `${activeAgent.name} – ${activeSessionTitle}` : undefined)}>
          {routeContextLabel ? <strong className="topbar-context-agent">{routeContextLabel}</strong> : activeAgent && activeSessionTitle && <><strong className="topbar-context-agent">{activeAgent.name}</strong><span className="topbar-context-separator" aria-hidden="true">–</span><span className="topbar-context-session">{activeSessionTitle}</span></>}
        </div>}
        {sessionViewActive && activeAgent && <span className="local-scope-badge" title={selectedSession?.governance ? `Declared governed tools: ${selectedSession.governance.tools.join(", ")}. Codex native tools remain separate.` : activeAgent.executionMode === "governed" ? "Pinned Local Agent version. Tools are checked before a new thread starts." : "Native Codex Session; no governed tool authority."}>
          {activeAgent.executionMode === "governed" ? selectedSession?.governance ? "Governed tools declared" : "Governed · readiness required" : "Native Codex"}
        </span>}
        {sessionViewActive && <WorkspacePanelControls state={activeWorkspacePanelState} sessionId={selectedSessionId} dispatch={dispatchWorkspacePanel} />}
        {localAgentWorkspace && <button type="button" className="button direct-topbar-create" onClick={()=>navigate({kind:"direct-session",projectId:localAgentWorkspace.projectId,sessionId:null})}><Plus size={14}/> New Session</button>}
      </header>

      {workspaceContextViewActive && contextSidebarFits && resizeRailMounted(!sidebarCollapsed, sidebarResizing) && <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="Resize workspace sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={availableSidebarWidth}
        aria-valuenow={visibleSidebarWidth}
        aria-valuetext={`${visibleSidebarWidth} pixels`}
        tabIndex={0}
        onKeyDown={resizeSidebarWithKeyboard}
        onPointerDown={startSidebarResize}
        onPointerMove={resizeSidebar}
        onPointerUp={stopSidebarResize}
        onPointerCancel={stopSidebarResize}
        onLostPointerCapture={() => { sidebarPointerRef.current = null; setSidebarResizing(false); }}
      />}

      {sessionViewActive && resizeRailMounted(workspacePanelResizeEnabled(activeWorkspacePanelState.open, activeWorkspacePanelState.maximized), workspacePanelResizing) && <div
        className="workspace-panel-resize-handle"
        role="separator"
        aria-label="Resize workspace panel"
        aria-orientation="vertical"
        aria-valuemin={Math.round(panelGeometry.minimumDockedWidth)}
        aria-valuemax={Math.round(panelGeometry.maximumDockedWidth)}
        aria-valuenow={Math.round(panelGeometry.renderedWidth)}
        aria-valuetext={`${Math.round(panelGeometry.renderedWidth)} pixels`}
        tabIndex={0}
        onKeyDown={resizeWorkspacePanelWithKeyboard}
        onPointerDown={startWorkspacePanelResize}
        onPointerMove={resizeWorkspacePanel}
        onPointerUp={stopWorkspacePanelResize}
        onPointerCancel={stopWorkspacePanelResize}
        onLostPointerCapture={() => { workspacePanelPointerRef.current = null; setWorkspacePanelResizing(false); }}
      />}

      <div className={`workspace ${sessionViewActive && activeWorkspacePanelState.maximized ? "workspace-panel-is-maximized" : ""}`}>
        <nav className="global-navigation" aria-label="Product navigation">
          <div className="global-navigation-brand" aria-label="Orchestrion" title="Orchestrion"><Command size={19} strokeWidth={1.8} /></div>
          <div className="global-navigation-primary">
            <button type="button" className={`global-navigation-item ${workspaceContextViewActive ? "active" : ""}`} aria-label="Chats" aria-current={workspaceContextViewActive ? "page" : undefined} onClick={openChats} data-label="Chats"><MessageSquare size={18} /><span className="global-navigation-tooltip">Chats</span></button>
            <button type="button" className={`global-navigation-item ${activeRoute.kind === "inbox" ? "active" : ""}`} aria-label={`Inbox${pendingRequestCount ? `, ${pendingRequestCount} pending` : ""}`} aria-current={activeRoute.kind === "inbox" ? "page" : undefined} onClick={() => navigate({ kind: "inbox", projectId: activeProject?.id ?? snapshot.projects[0]?.id ?? null })} data-label="Inbox"><InboxIcon size={18} />{pendingRequestCount > 0 && <span className="global-navigation-count">{pendingRequestCount > 99 ? "99+" : pendingRequestCount}</span>}<span className="global-navigation-tooltip">Inbox</span></button>
            <span className="global-navigation-divider" aria-hidden="true" />
            <button type="button" className={`global-navigation-item ${localAgentViewActive ? "active" : ""}`} aria-label="Agents" aria-current={localAgentViewActive ? "page" : undefined} disabled={!localAgentWorkspace} onClick={() => localAgentWorkspace && navigate({ kind: "agent-library", projectId: localAgentWorkspace.projectId })} data-label="Agents"><Bot size={18} /><span className="global-navigation-tooltip">Agents</span></button>
            <button type="button" className={`global-navigation-item ${localPolicyViewActive ? "active" : ""}`} aria-label="Policies" aria-current={localPolicyViewActive ? "page" : undefined} disabled={!localPolicyWorkspace} onClick={() => localPolicyWorkspace && navigate({ kind: "local-policies", projectId: localPolicyWorkspace.projectId })} data-label="Policies"><ShieldCheck size={18} />{Boolean(localPolicyWorkspace?.items.length) && <span className="global-navigation-count">{localPolicyWorkspace!.items.length}</span>}<span className="global-navigation-tooltip">Policies</span></button>
          </div>
          <div className="global-navigation-bottom">
            <button type="button" className={`global-navigation-item ${activeRoute.kind === "provider-settings" ? "active" : ""}`} aria-label="Settings · Providers" aria-current={activeRoute.kind === "provider-settings" ? "page" : undefined} onClick={() => navigate({ kind: "provider-settings" })} data-label="Settings"><Settings2 size={18} /><span className="global-navigation-tooltip">Settings</span></button>
            <UpdateEntry bridge={api?.updaterBridge} workspaceDirty={workspaceDirty} onDiscardWorkspaceChanges={onDiscardWorkspaceChanges} />
            <div className="global-navigation-footer" ref={profileRef}>
              {profileOpen && <div className="profile-popover global-profile-popover" role="status" aria-label="Local profile"><div className="profile-popover-heading"><div className="avatar">L</div><div><strong>Local profile</strong><span>No account connected</span></div></div><div className="local-note"><ShieldCheck size={14} /><span>Local runtime<br /><small>{snapshot.appServer.status === "ready" ? `Codex ${snapshot.appServer.codexVersion ?? "connected"}` : snapshot.appServer.status}</small></span></div></div>}
              <button type="button" className="global-profile-button" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen} aria-haspopup="dialog" aria-label="Open local profile" title="Local profile"><span className="global-profile-avatar">L</span><span className={`global-runtime-dot ${snapshot.appServer.status === "ready" ? "ready" : snapshot.appServer.status}`} aria-hidden="true" /></button>
            </div>
          </div>
        </nav>
        <aside id="workspace-sidebar" className={`sidebar ${contextSidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-heading">
            {!contextSidebarCollapsed && <><span className="eyebrow">Chats</span><span className="session-total">{sessionCount} {sessionCount === 1 ? "session" : "sessions"}</span></>}
          </div>
          {!contextSidebarCollapsed && <>
            <div className="tree-actions">
              <button className="tree-action primary" onClick={() => setModal("project")} aria-label="New project" title="New project"><FolderPlus size={14} /><span>New project</span></button>
              <div className="sidebar-popover-anchor" ref={agentDetailsRef}>
                <button className="tree-action" onClick={() => setAgentDetailsOpen((value) => !value)} disabled={!activeAgent} aria-expanded={agentDetailsOpen} aria-haspopup="true" aria-label={activeAgent ? `Customize ${activeAgent.name}` : "Customize agent (select a session first)"} title={activeAgent ? `Customize ${activeAgent.name}` : "Select a session first"}><Bot size={14} /><span>Customize agent</span></button>
                {agentDetailsOpen && activeAgent && <div className="sidebar-popover agent-details-popover" role="status" aria-label={`${activeAgent.name} details`}><span className="eyebrow">Current agent</span><strong>{activeAgent.name}</strong><p>{activeAgent.instructions}</p><small>Editing will be added when the local Agent update contract is available.</small></div>}
              </div>
            </div>
            <div className="tree" aria-label="Projects, agents and sessions">
              {snapshot.projects.length === 0 ? <EmptyTree onNew={() => setModal("project")} /> : snapshot.projects.map((project) => <ProjectTree key={project.id} project={project} agents={snapshot.agents.filter((agent) => agent.projectId === project.id)} sessions={snapshot.sessions} directSessions={directSessions.filter(item=>item.projectId===project.id)} selectedDirectId={activeRoute.kind==="direct-session"?activeRoute.sessionId:null} onSelectDirect={id=>navigate({kind:"direct-session",projectId:project.id,sessionId:id})} runtimes={snapshot.runtimes} expanded={expanded} selectedSessionId={selectedSessionId} onToggle={toggle} onSelect={selectSession} openMenuKey={treeMenu ? `${treeMenu.kind}:${treeMenu.kind === "project" ? treeMenu.project.id : treeMenu.kind === "agent" ? treeMenu.agent.id : treeMenu.session.id}` : null} onOpenMenu={openTreeMenu} />)}
            </div>
          </>}
        </aside>

        <main
          className={`main-panel ${sessionViewActive ? "session-view" : "management-view"} ${sessionDragging ? "session-dragging" : ""}`}
          aria-hidden={sessionViewActive && activeWorkspacePanelState.maximized || undefined}
          inert={sessionViewActive && activeWorkspacePanelState.maximized || undefined}
          onDragEnter={handleSessionDragEnter}
          onDragOver={handleSessionDragOver}
          onDragLeave={handleSessionDragLeave}
          onDrop={handleSessionDrop}
        >
          {sessionDragging && <div className="session-drop-overlay"><Paperclip size={22} /><strong>Drop files into this session</strong><span>Images, audio, documents, and folders will be added to your next message.</span></div>}
          {bootError && <DiagnosticBanner diagnostic={{ code: "handshake_failed", message: bootError }} onRetry={retry} busy={busy} />}
          {!bootError && snapshot.appServer.diagnostic && <DiagnosticBanner diagnostic={snapshot.appServer.diagnostic} onRetry={retry} busy={busy} />}
          {actionError && <div className="action-error" role="alert"><AlertCircle size={15} /><span>{actionError}</span><button className="icon-button subtle" onClick={() => setActionError(null)} aria-label="Dismiss error"><X size={14} /></button></div>}
          {activeRoute.kind==="direct-session" ? <DirectSessionHost key={`${activeRoute.projectId}:${activeRoute.sessionId??"new"}`} api={api} projectId={activeRoute.projectId} projectName={snapshot.projects.find(item=>item.id===activeRoute.projectId)?.name??"Project"} sessionId={activeRoute.sessionId} onSelect={id=>navigate({kind:"direct-session",projectId:activeRoute.projectId,sessionId:id})} onChanged={reloadDirectSessions} onConnectProviders={() => setProviderDialogOpen(true)} /> : sessionViewActive && composerSettings && activeAgent && activeProject ? <>
            <section className="message-viewport" ref={messageViewportRef} onScroll={trackLiveOutputPreference}>
              {runtime.messages.length === 0 && runtime.pendingRequests.length === 0 && !runtime.error && runtime.status !== "running" && runtime.status !== "starting" ? <WelcomeState agent={activeAgent} project={activeProject} onPrompt={setDraft} /> : <div className="message-list" aria-live="polite"><ConversationTimeline messages={runtime.messages} previewUrls={attachmentPreviews} />{(runtime.status === "running" || runtime.status === "starting") && !runtime.messages.some((message) => message.streaming) && <ThinkingRow />}{runtime.error && <div className="inline-error"><AlertCircle size={15} />{runtime.error}</div>}{runtime.pendingRequests.map((request) => <RequestCard key={String(request.requestId)} request={request} onRespond={respond} />)}</div>}
            </section>
            <div className="composer-wrap"><Composer value={composerDraft.text} attachments={composerDraft.attachments} attachmentLimitExceeded={composerDraft.attachmentLimitExceeded === true} session={composerSettings} contextWindowUsage={runtime.contextWindowUsage} models={models} onModelChange={updateSessionModel} onConnectProviders={() => setProviderDialogOpen(true)} onChange={setDraft} onSend={send} onStop={stop} onAddFiles={addFiles} onAddFolder={addFolder} onRemoveAttachment={removeAttachment} running={canStop} starting={starting} disabled={!api || snapshot.appServer.status === "error"} /></div>
          </> : activeRoute.kind === "provider-settings" ? <ProviderSettingsHost projectId={localAgentWorkspace?.projectId ?? null} />
            : activeRoute.kind === "inbox" ? <InboxHost snapshot={snapshot} project={inboxProject} />
            : activeRoute.kind === "project-agents" ? <ProjectAgentsHost projectId={activeRoute.projectId} workspace={localAgentWorkspace} api={api} />
            : activeRoute.kind === "project-agent-add" || activeRoute.kind === "project-agent-create" ? <ProjectAgentAddHost route={activeRoute} workspace={localAgentWorkspace} api={api} onWorkspaceChange={acceptLocalAgentWorkspace} onDirtyStateChange={onWorkspaceDirtyStateChange} />
            : activeRoute.kind === "agent-library" || activeRoute.kind === "agent-library-detail" || activeRoute.kind === "agent-library-create" ? <OrganizationAgentLibraryHost route={activeRoute} workspace={localAgentWorkspace} api={api} onWorkspaceChange={acceptLocalAgentWorkspace} onDirtyStateChange={onWorkspaceDirtyStateChange} />
            : activeRoute.kind === "local-agents" || activeRoute.kind === "local-agent-create" || activeRoute.kind === "local-agent" ? <LocalAgentsHost route={activeRoute} workspace={localAgentWorkspace} loadError={localAgentError} api={api} onWorkspaceChange={acceptLocalAgentWorkspace} onDirtyStateChange={onWorkspaceDirtyStateChange} />
            : activeRoute.kind === "local-policies" || activeRoute.kind === "local-policy" ? <LocalPoliciesHost route={activeRoute} workspace={localPolicyWorkspace} loadError={localPolicyError} api={api} onWorkspaceChange={acceptLocalPolicyWorkspace} onDirtyStateChange={onWorkspaceDirtyStateChange}/>
            : activeRoute.kind === "project-settings" && activeProject ? <ProjectManagementHost project={activeProject} section={activeRoute.section} snapshot={snapshot} localProjectId={localAgentWorkspace?.projectId} />
            : activeRoute.kind === "agent-settings" && activeProject && activeAgent ? <AgentManagementHost project={activeProject} agent={activeAgent} section={activeRoute.section} sessions={snapshot.sessions.filter((session) => session.agentId === activeAgent.id)} />
            : activeRoute.kind === "recovery" ? <RouteRecovery route={activeRoute} snapshot={snapshot} />
            : <NoSessionState projects={snapshot.projects} onNewProject={() => setModal("project")} />}
        </main>
        {providerDialogOpen && <ProviderConnectionDialog projectId={localAgentWorkspace?.projectId ?? null} onClose={() => setProviderDialogOpen(false)} onManageSubscription={() => { setProviderDialogOpen(false); navigate({kind:"provider-settings"}); }} returnFocus={() => document.querySelector<HTMLElement>(".provider-subscription-target, .direct-model-route button, .composer-model-button, [aria-label='Settings · Providers']")} />}
        {sessionViewActive && <WorkspacePanel
          state={activeWorkspacePanelState}
          geometry={panelGeometry}
          context={{ sessionId: selectedSessionId, project: activeProject ? { id: activeProject.id, name: activeProject.name, path: activeProject.path } : null }}
          api={api}
          dispatch={dispatchWorkspacePanel}
          onDirtyStateChange={onWorkspaceDirtyStateChange}
        />}
      </div>
      {treeMenu && <div ref={treeMenuRef} className="context-menu tree-context-menu" role="menu" aria-label={`${treeMenu.kind === "project" ? treeMenu.project.name : treeMenu.kind === "agent" ? treeMenu.agent.name : treeMenu.session.title} actions`} style={{ left: treeMenu.x, top: treeMenu.y }}>{treeMenu.kind === "project" ? <>{treeMenu.project.executionMode !== "governed" && <button role="menuitem" onClick={() => openNativeTreeDialog({ kind: "project", record: treeMenu.project }, "rename")}><Pencil size={14} /> Rename project</button>}<button role="menuitem" autoFocus onClick={() => beginCreateAgent(treeMenu.project)}><Bot size={14} /> Create agent</button><button role="menuitem" onClick={() => navigate({ kind: "project-settings", projectId: treeMenu.project.id, section: "overview" }, { finalizeCommit: closeTreeMenuAfterCommit })}><FolderOpen size={14} /> Project overview</button><button role="menuitem" onClick={() => navigate({ kind: "project-settings", projectId: treeMenu.project.id, section: "capabilities" }, { finalizeCommit: closeTreeMenuAfterCommit })}><ShieldCheck size={14} /> Advanced settings</button>{treeMenu.project.executionMode !== "governed" && <><div role="separator" className="menu-separator" /><button role="menuitem" className="danger-menu-item" onClick={() => openNativeTreeDialog({ kind: "project", record: treeMenu.project }, "remove")}><Trash2 size={14} /> Remove project</button></>}</> : treeMenu.kind === "agent" ? <>{treeMenu.agent.executionMode !== "governed" && <button role="menuitem" onClick={() => openNativeTreeDialog({ kind: "agent", record: treeMenu.agent }, "rename")}><Pencil size={14} /> Rename agent</button>}<button role="menuitem" autoFocus onClick={() => beginCreateSession(treeMenu.agent)}><MessageSquare size={14} /> New session</button><button role="menuitem" onClick={() => navigate({ kind: "agent-settings", projectId: treeMenu.agent.projectId, agentId: treeMenu.agent.id, section: "profile" }, { finalizeCommit: closeTreeMenuAfterCommit })}><Bot size={14} /> Agent profile</button><button role="menuitem" onClick={() => navigate({ kind: "agent-settings", projectId: treeMenu.agent.projectId, agentId: treeMenu.agent.id, section: "capabilities" }, { finalizeCommit: closeTreeMenuAfterCommit })}><ShieldCheck size={14} /> Capabilities</button>{treeMenu.agent.executionMode !== "governed" && <><div role="separator" className="menu-separator" /><button role="menuitem" className="danger-menu-item" onClick={() => openNativeTreeDialog({ kind: "agent", record: treeMenu.agent }, "remove")}><Trash2 size={14} /> Remove agent</button></>}</> : <><button role="menuitem" autoFocus onClick={() => { setRenameSession(treeMenu.session); setTreeMenu(null); }}><Pencil size={14} /> Rename session</button><button role="menuitem" className="danger-menu-item" onClick={() => { setActionError(null); setDeletingSession(treeMenu.session); setTreeMenu(null); }}><Trash2 size={14} /> Delete session</button></>}</div>}
      {modal && <Modal type={modal} selectedProject={modalProject} onClose={() => { setModal(null); setNewAgentProjectId(null); }} onCreateProject={createProject} onCreateAgent={createAgent} busy={busy} chooseDirectory={async () => api?.chooseProjectDirectory() ?? null} />}
      {nativeTreeDialog && <NativeTreeDialog key={`${nativeTreeDialog.action}:${nativeTreeDialog.target.record.id}`} {...nativeTreeDialog} busy={busy} onClose={() => setNativeTreeDialog(null)} onSubmit={saveNativeTreeAction} />}
      {renameSession && <RenameSessionDialog session={renameSession} onClose={() => setRenameSession(null)} onRename={saveSessionName} busy={busy} />}
      {deletingSession && <DeleteSessionDialog session={deletingSession} onClose={() => setDeletingSession(null)} onDelete={deleteConfirmedSession} busy={busy} />}
      {pendingRoute && <UnsavedNavigationDialog onStay={cancelPending} onDiscard={confirmPending} />}
    </div>
  );
}

function EmptyTree({ onNew }: { onNew: () => void }) {
  return <div className="empty-tree"><div className="empty-tree-icon"><FolderOpen size={17} /></div><p>No projects yet</p><button onClick={onNew}>Add a project</button></div>;
}

function ProjectTree({ project, agents, sessions, directSessions, selectedDirectId, onSelectDirect, runtimes, expanded, selectedSessionId, openMenuKey, onToggle, onSelect, onOpenMenu }: { project: ProjectRecord; agents: AgentRecord[]; sessions: SessionRecord[]; directSessions:LocalDirectSessionItem[];selectedDirectId:string|null;onSelectDirect:(id:string)=>void;runtimes: DesktopSnapshot["runtimes"]; expanded: ExpandedState; selectedSessionId: string | null; openMenuKey: string | null; onToggle: (id: string) => void; onSelect: (id: string) => void; onOpenMenu: (event: ReactMouseEvent<HTMLButtonElement>, target: TreeEntity, anchored: boolean) => void }) {
  const projectOpen = expanded[project.id] ?? true;
  const target = { kind: "project", record: project } satisfies TreeEntity;
  return <div className="tree-project"><TreeRowShell target={target} menuOpen={openMenuKey === treeEntityKey(target)} onOpenMenu={onOpenMenu}><button className="tree-row tree-row-main project-row" aria-expanded={projectOpen} aria-label={`${project.name} project`} title={`${project.name} · Right-click for actions`} onClick={() => onToggle(project.id)} onContextMenu={(event) => onOpenMenu(event, target, false)}><span className="tree-chevron">{projectOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span><span className="tree-icon project-icon"><FolderOpen size={15} /></span><span className="tree-label">{project.name}</span></button></TreeRowShell>{projectOpen && <div className="tree-children">{directSessions.length>0 && <div className="direct-tree-group" aria-label={`${project.name} Direct Sessions`}><span className="direct-tree-heading">Direct Sessions</span>{directSessions.map(item=><button type="button" key={item.id} className={`tree-row tree-row-main session-row ${selectedDirectId===item.id?"selected":""}`} aria-label={`${item.title}, Direct Session, ${item.lifecycle}`} aria-current={selectedDirectId===item.id?"page":undefined} onClick={()=>onSelectDirect(item.id)}><span className="tree-label">{item.title}</span><span className="direct-tree-state">{item.lifecycle}</span></button>)}</div>}{agents.length>0 && <span className="direct-tree-heading">Legacy Sessions</span>}{agents.map((agent) => <AgentTree key={agent.id} agent={agent} sessions={sessions.filter((session) => session.agentId === agent.id)} runtimes={runtimes} expanded={expanded} selectedSessionId={selectedSessionId} openMenuKey={openMenuKey} onToggle={onToggle} onSelect={onSelect} onOpenMenu={onOpenMenu} />)}</div>}</div>;
}

function AgentTree({ agent, sessions, runtimes, expanded, selectedSessionId, openMenuKey, onToggle, onSelect, onOpenMenu }: { agent: AgentRecord; sessions: SessionRecord[]; runtimes: DesktopSnapshot["runtimes"]; expanded: ExpandedState; selectedSessionId: string | null; openMenuKey: string | null; onToggle: (id: string) => void; onSelect: (id: string) => void; onOpenMenu: (event: ReactMouseEvent<HTMLButtonElement>, target: TreeEntity, anchored: boolean) => void }) {
  const open = expanded[agent.id] ?? true;
  const target = { kind: "agent", record: agent } satisfies TreeEntity;
  return <div className="tree-agent"><TreeRowShell target={target} menuOpen={openMenuKey === treeEntityKey(target)} onOpenMenu={onOpenMenu}><button className="tree-row tree-row-main agent-row" aria-expanded={open} aria-label={`${agent.name}, ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`} title={`${agent.name} · Right-click for actions`} onClick={() => onToggle(agent.id)} onContextMenu={(event) => onOpenMenu(event, target, false)}><span className="tree-chevron">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span><span className="tree-icon agent-icon"><Bot size={14} /></span><span className="tree-label">{agent.name}</span><span className="tree-row-meta row-count">{sessions.length}</span></button></TreeRowShell>{open && <div className="tree-sessions">{sessions.map((session) => {
    const sessionTarget = { kind: "session", record: session } satisfies TreeEntity;
    return <TreeRowShell key={session.id} target={sessionTarget} menuOpen={openMenuKey === treeEntityKey(sessionTarget)} onOpenMenu={onOpenMenu}><button className={`tree-row tree-row-main session-row ${selectedSessionId === session.id ? "selected" : ""}`} aria-label={session.title} title={`${session.title} · Right-click for actions`} onClick={() => onSelect(session.id)} onContextMenu={(event) => onOpenMenu(event, sessionTarget, false)}><span className="tree-label">{session.title}</span><span className="tree-row-meta"><SessionDot status={runtimes[session.id]?.status ?? "idle"} /></span></button></TreeRowShell>;
  })}</div>}</div>;
}

function TreeRowShell({ target, menuOpen, onOpenMenu, children }: { target: TreeEntity; menuOpen: boolean; onOpenMenu: (event: ReactMouseEvent<HTMLButtonElement>, target: TreeEntity, anchored: boolean) => void; children: ReactNode }) {
  return <div className={`tree-row-shell ${target.kind}-row-shell ${menuOpen ? "menu-open" : ""}`}>{children}<button className="tree-more-button" type="button" aria-label={`${treeEntityName(target)} actions`} aria-haspopup="menu" aria-expanded={menuOpen} title="More actions" onClick={(event) => onOpenMenu(event, target, true)} onContextMenu={(event) => onOpenMenu(event, target, false)}><Ellipsis size={15} /></button></div>;
}

function SessionDot({ status }: { status: string }) { return <span className={`session-dot ${status}`} />; }

function NoSessionState({ projects, onNewProject }: { projects: ProjectRecord[]; onNewProject: () => void }) {
  return <div className="no-session"><div className="no-session-orbit"><span /><span /><span /><Zap size={24} /></div><h2>{projects.length ? "Choose a session to begin" : "A calm place to think with Codex"}</h2><p>{projects.length ? "Select a session from the workspace tree, or start a fresh one from an agent." : "Add a local project, give your agent a role, and keep the work moving in one focused thread."}</p>{!projects.length && <button className="button primary-button" onClick={onNewProject}><FolderPlus size={15} /> Add your first project</button>}</div>;
}

function WelcomeState({ agent, project, onPrompt }: { agent: AgentRecord; project: ProjectRecord; onPrompt: (value: string) => void }) {
  return <div className="welcome-state"><div className="welcome-kicker"><span className="kicker-line" />New session</div><h2>What are we working on?</h2><p><strong>{agent.name}</strong> is ready in {project.name}.</p><div className="prompt-suggestions"><span>Try asking</span><button onClick={() => onPrompt("Give me a quick read of this project")}>“Give me a quick read of this project”</button><button onClick={() => onPrompt("What should I work on first?")}>“What should I work on first?”</button></div></div>;
}

export function ThinkingRow() {
  return <div className="thinking-row" role="status" aria-label="Agent is thinking">
    <div className="thinking-mark" aria-hidden="true"><i /><i /><i /><span /></div>
    <span className="thinking-label">Thinking</span>
    <span className="thinking-signal" aria-hidden="true"><i /><i /><i /></span>
  </div>;
}

export function shouldFollowLiveOutput(viewport: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, threshold = 72): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold;
}

type ConversationSegment =
  | { kind: "message"; message: ConversationMessage }
  | { kind: "turn"; key: string; messages: ConversationMessage[] };

export function ConversationTimeline({ messages, previewUrls }: { messages: ConversationMessage[]; previewUrls: Record<string, string> }) {
  const segments = conversationSegments(messages);
  return <>{segments.map((segment) => segment.kind === "message"
    ? <MessageBubble key={segment.message.id} message={segment.message} previewUrls={previewUrls} />
    : <ConversationTurn key={segment.key} messages={segment.messages} previewUrls={previewUrls} />)}</>;
}

function conversationSegments(messages: ConversationMessage[]): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  let turn: ConversationMessage[] = [];
  let turnKey = "";
  let legacyIndex = 0;
  const flush = () => {
    if (!turn.length) return;
    segments.push({ kind: "turn", key: turnKey || `legacy-turn-${legacyIndex++}`, messages: turn });
    turn = [];
    turnKey = "";
  };
  for (const entry of messages) {
    if (entry.role === "user") {
      flush();
      segments.push({ kind: "message", message: entry });
      continue;
    }
    const key = entry.turnId || turnKey || `legacy-turn-${legacyIndex}`;
    if (turn.length && key !== turnKey) flush();
    turnKey = key;
    turn.push(entry);
  }
  flush();
  return segments;
}

function ConversationTurn({ messages, previewUrls }: { messages: ConversationMessage[]; previewUrls: Record<string, string> }) {
  let finalIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].phase === "final_answer") { finalIndex = index; break; }
  }
  const finalMessage = finalIndex >= 0 ? messages[finalIndex] : null;
  const process = finalIndex >= 0 ? messages.filter((_, index) => index !== finalIndex) : messages;
  const [expanded, setExpanded] = useState(finalMessage === null);
  const wasComplete = useRef(finalMessage !== null);

  useEffect(() => {
    if (finalMessage && !wasComplete.current) setExpanded(false);
    wasComplete.current = finalMessage !== null;
  }, [finalMessage]);

  return <section className={`conversation-turn ${finalMessage ? "complete" : "active"}`}>
    {process.length > 0 && finalMessage && <button type="button" className="work-capsule" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="work-capsule-mark" aria-hidden="true"><i /><i /></span>
      <span className="work-capsule-copy"><strong>Worked for {elapsedLabel(messages)}</strong><small>{processLabel(process)}</small></span>
      <ChevronRight className="work-capsule-chevron" size={15} />
    </button>}
    {process.length > 0 && (!finalMessage || expanded) && <div className="turn-process" aria-label="Agent work details">
      {process.map((message) => message.activity
        ? <ActivityCard key={message.id} message={message} />
        : <MessageBubble key={message.id} message={message} previewUrls={previewUrls} compact />)}
    </div>}
    {finalMessage && <MessageBubble message={finalMessage} previewUrls={previewUrls} />}
  </section>;
}

export function ActivityCard({ message }: { message: ConversationMessage }) {
  const activity = message.activity!;
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(activity.arguments || activity.result || activity.error || activity.metadata?.length);
  const statusLabel = activity.status === "running" ? "In progress" : activity.status === "completed" ? "Done" : activity.status === "declined" ? "Declined" : "Failed";
  return <article className={`activity-card activity-${activity.kind}`} data-activity-kind={activity.kind}>
    <button type="button" className="activity-toggle" disabled={!hasDetails} aria-expanded={hasDetails ? expanded : undefined} onClick={() => hasDetails && setExpanded((value) => !value)}>
      <ActivityIcon kind={activity.kind} running={activity.status === "running"} />
      <span className="activity-copy"><strong>{activity.label}</strong>{activity.summary && <small>{activity.summary}</small>}</span>
      {activity.durationMs !== undefined && <span className="activity-duration">{durationLabel(activity.durationMs)}</span>}
      <span className={`activity-status ${activity.status}`}>{activity.status === "running" ? <LoaderCircle className="spin" size={12} /> : activity.status === "completed" ? <Check size={12} /> : <X size={12} />}{statusLabel}</span>
      {hasDetails && <ChevronRight className="activity-chevron" size={14} />}
    </button>
    {expanded && hasDetails && <div className="activity-detail-viewport">
      {activity.metadata?.map((entry) => <div className="activity-meta" key={`${entry.label}:${entry.value}`}><span>{entry.label}</span><code>{entry.value}</code></div>)}
      {activity.arguments && <ActivityDetail label={activity.kind === "command" ? "Command" : activity.kind === "subagent" ? "Task" : "Arguments"} value={activity.arguments} />}
      {activity.result && <ActivityDetail label={activity.kind === "reasoning" ? "Public summary" : activity.kind === "command" ? "Output" : "Result"} value={activity.result} copyable />}
      {activity.error && <ActivityDetail label="Error" value={activity.error} error />}
    </div>}
  </article>;
}

function ActivityIcon({ kind, running }: { kind: NonNullable<ConversationMessage["activity"]>["kind"]; running: boolean }) {
  if (kind === "compaction") return <span className={`activity-icon memory-fold ${running ? "running" : ""}`} aria-hidden="true"><i /><i /><b /></span>;
  const icon = kind === "command" ? <Terminal size={14} />
    : kind === "tool" ? <Wrench size={14} />
    : kind === "file_change" ? <FileCode2 size={14} />
    : kind === "subagent" ? <Bot size={14} />
    : kind === "web_search" ? <Search size={14} />
    : kind === "image_view" ? <FileText size={14} />
    : <Sparkles size={14} />;
  return <span className={`activity-icon ${running ? "running" : ""}`} aria-hidden="true">{icon}</span>;
}

function ActivityDetail({ label, value, error = false, copyable = false }: { label: string; value: string; error?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);
  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return <section className={`activity-detail ${error ? "error" : ""}`}>
    <div className="activity-detail-head"><h4>{label}</h4>{copyable && <button type="button" className="activity-result-copy" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`} title={copied ? "Copied" : `Copy ${label.toLowerCase()}`}>{copied ? <Check size={11} /> : <Copy size={11} />}<span>{copied ? "Copied" : "Copy"}</span></button>}</div>
    <pre>{value}</pre>
  </section>;
}

function elapsedLabel(messages: ConversationMessage[]): string {
  const times = messages.map((message) => new Date(message.createdAt).valueOf()).filter(Number.isFinite);
  if (times.length < 2) return "under 1s";
  return durationLabel(Math.max(0, Math.max(...times) - Math.min(...times)));
}

function durationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function processLabel(messages: ConversationMessage[]): string {
  const activities = messages.filter((message) => message.activity);
  const subagents = activities.filter((message) => message.activity?.kind === "subagent").length;
  const commentary = messages.length - activities.length;
  const parts = [activities.length ? `${activities.length} ${activities.length === 1 ? "action" : "actions"}` : "", commentary ? `${commentary} ${commentary === 1 ? "update" : "updates"}` : "", subagents ? `${subagents} delegated` : ""].filter(Boolean);
  return parts.join(" · ");
}

export function MessageBubble({ message, previewUrls, compact = false }: { message: ConversationMessage; previewUrls: Record<string, string>; compact?: boolean }) {
  const user = message.role === "user";
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachments = message.attachments?.map((attachment) => ({ ...attachment, previewUrl: attachment.previewUrl ?? previewUrls[attachment.path] ?? null }));
  const avatar = <div className={`message-avatar ${user ? "user-avatar" : "assistant-avatar"}`} aria-hidden="true">{user ? <UserRound size={15} /> : <Sparkles size={14} />}</div>;
  useEffect(() => () => { if (copyResetRef.current) clearTimeout(copyResetRef.current); }, []);
  const copyFinalResponse = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  const renderMarkdown = !user && message.phase === "final_answer";
  const showCopy = message.role === "assistant" && message.phase === "final_answer" && !message.streaming && Boolean(message.text);
  const content = <div className="message-content"><div className="message-topline"><span className="message-author">{user ? "You" : "Codex"}</span><span className="message-time">{timeLabel(message.createdAt)}</span></div>{attachments && <AttachmentCards attachments={attachments} />}{message.text && <div className={`message-text ${renderMarkdown ? "message-markdown" : ""}`}>{renderMarkdown ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown> : message.text}{message.streaming && <span className="stream-caret" />}</div>}{showCopy && <div className="message-final-actions"><button type="button" className="message-copy-button" onClick={() => void copyFinalResponse()} aria-label={copied ? "Copied final response" : "Copy final response"} title={copied ? "Copied" : "Copy response"}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}<span>{copied ? "Copied" : "Copy"}</span></button></div>}</div>;
  return <article className={`message ${user ? "message-user" : "message-assistant"}${compact ? " message-compact" : ""}`} data-message-role={user ? "user" : "assistant"}>{user ? <>{content}{avatar}</> : <>{avatar}{content}</>}</article>;
}

function Composer({ value, attachments, attachmentLimitExceeded, session, contextWindowUsage, models, onModelChange, onConnectProviders, onChange, onSend, onStop, onAddFiles, onAddFolder, onRemoveAttachment, running, starting, disabled }: { value: string; attachments: ComposerAttachment[]; attachmentLimitExceeded: boolean; session: Pick<SessionRecord, "model" | "modelProvider" | "reasoningEffort" | "serviceTier">; contextWindowUsage?: ContextWindowUsage | null; models: ModelOption[]; onModelChange: (model: ModelOption, reasoningEffort: string | null, serviceTier: string | null) => Promise<void>; onConnectProviders: () => void; onChange: (value: string) => void; onSend: () => void; onStop: () => void; onAddFiles: () => Promise<void>; onAddFolder: () => Promise<void>; onRemoveAttachment: (attachmentId: string) => void; running: boolean; starting: boolean; disabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [contextWindowOpen, setContextWindowOpen] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); onSend(); };

  const resizeInput = useCallback(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = "auto";
    const style = window.getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight) || 22;
    const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const eighteenLineHeight = lineHeight * 18 + verticalPadding;
    const cssMaxHeight = Number.parseFloat(style.maxHeight);
    const maxHeight = Number.isFinite(cssMaxHeight) ? Math.min(eighteenLineHeight, cssMaxHeight) : eighteenLineHeight;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => resizeInput(), [resizeInput, value]);
  useEffect(() => {
    const inputRow = ref.current?.parentElement;
    const observer = inputRow ? new ResizeObserver(resizeInput) : null;
    if (inputRow) observer?.observe(inputRow);
    window.addEventListener("resize", resizeInput);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resizeInput);
    };
  }, [resizeInput]);
  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!attachmentMenuRef.current?.contains(target)) setAttachmentMenuOpen(false);
      if (!modelMenuRef.current?.contains(target)) setModelMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!attachmentMenuOpen && !modelMenuOpen)) return;
      setAttachmentMenuOpen(false);
      setModelMenuOpen(false);
      ref.current?.focus();
    };
    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [attachmentMenuOpen, modelMenuOpen]);
  const addFiles = async () => {
    setAttachmentMenuOpen(false);
    await onAddFiles();
    ref.current?.focus();
  };
  const addFolder = async () => {
    setAttachmentMenuOpen(false);
    await onAddFolder();
    ref.current?.focus();
  };
  return <form className={`composer ${disabled || starting ? "disabled" : ""} ${attachmentMenuOpen || modelMenuOpen || contextWindowOpen ? "menu-open" : ""}`} onSubmit={submit}>
    {attachments.length > 0 && <AttachmentCards attachments={attachments} onRemove={onRemoveAttachment} />}
    {attachmentLimitExceeded && <div className="attachment-limit-note" role="alert">Only the first {MAX_COMPOSER_ATTACHMENTS} attachments were added.</div>}
    <div className="composer-input-row"><textarea ref={ref} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      onSend();
    }} placeholder={disabled ? "Connect to Electron to start a session" : starting ? "Starting Codex…" : running ? "Codex is working…" : "Message your agent…"} rows={2} disabled={disabled || running || starting} /></div>
    <div className="composer-bottom-row">
      <div className="composer-menu-anchor" ref={attachmentMenuRef}><button className="composer-icon-button" type="button" onClick={() => { setAttachmentMenuOpen((open) => !open); setModelMenuOpen(false); setContextWindowOpen(false); }} aria-label="Add files or folders" aria-expanded={attachmentMenuOpen} aria-haspopup="menu" disabled={disabled || running || starting}><Plus size={18} /></button>{attachmentMenuOpen && <div className="composer-menu attachment-menu" role="menu"><button type="button" role="menuitem" onClick={addFiles}><Paperclip size={15} /><span>Add files<small>Mention local files in this message</small></span></button><button type="button" role="menuitem" onClick={addFolder}><FolderOpen size={15} /><span>Add folder<small>Mention a local folder in this message</small></span></button></div>}</div>
      <div className="composer-actions">
        <div className="composer-context-model-group">
          <ContextWindowIndicator usage={contextWindowUsage} open={contextWindowOpen} onOpenChange={(open) => { setContextWindowOpen(open); if (open) { setModelMenuOpen(false); setAttachmentMenuOpen(false); } }} />
          <div className="composer-menu-anchor" ref={modelMenuRef}>
            <CompactModelPicker
              open={modelMenuOpen}
              disabled={disabled || running || starting}
              session={session}
              models={models}
              onOpenChange={(open) => {
                setModelMenuOpen(open);
                if (open) {
                  setAttachmentMenuOpen(false);
                  setContextWindowOpen(false);
                }
              }}
              onChange={onModelChange}
              onConnectProviders={() => { setModelMenuOpen(false); onConnectProviders(); }}
            />
          </div>
        </div>
        <button className={`send-button ${running ? "stop-button" : ""}`} type={running ? "button" : "submit"} onClick={running ? onStop : undefined} disabled={disabled || starting || (!running && !value.trim() && attachments.length === 0)} aria-label={running ? "Stop turn" : starting ? "Codex is starting" : "Send message"} title={running ? "Stop turn" : starting ? "Codex is starting" : "Send message"}>{starting ? <LoaderCircle className="spin" size={17} /> : running ? <CircleStop size={19} /> : <ArrowUp size={19} />}</button>
      </div>
    </div>
  </form>;
}

function AttachmentCards({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove?: (attachmentId: string) => void }) {
  return <div className={`attachment-tray ${onRemove ? "composer-attachments" : "message-attachments"}`} aria-label="Attachments">{attachments.map((attachment) => attachment.kind === "image" && attachment.previewUrl
    ? <div className="attachment-card image-attachment" key={attachment.id} title={attachment.path}><img src={attachment.previewUrl} alt={attachment.name} /><span>{attachment.name}</span>{onRemove && <button type="button" className="attachment-remove" onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}><X size={13} /></button>}</div>
    : <div className="attachment-card file-attachment" key={attachment.id} title={attachment.path}><div className="attachment-file-icon">{attachment.kind === "folder" ? <FolderOpen size={22} /> : attachment.kind === "audio" ? <Music2 size={21} /> : <FileText size={21} />}</div><div className="attachment-file-copy"><strong>{attachment.name}</strong><small>{attachment.kind === "folder" ? "Folder" : attachment.kind === "audio" ? "Audio" : formatFileSize(attachment.size)}</small></div>{onRemove && <button type="button" className="attachment-remove" onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}><X size={13} /></button>}</div>)}</div>;
}

function formatFileSize(size: number | null): string {
  if (size === null) return "File";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function DiagnosticBanner({ diagnostic, onRetry, busy }: { diagnostic: RuntimeDiagnostic; onRetry: () => void; busy: boolean }) {
  const auth = diagnostic.code === "auth_required";
  return <div className="diagnostic-banner"><div className="diagnostic-icon"><AlertCircle size={17} /></div><div className="diagnostic-copy"><strong>{auth ? "Codex needs authentication" : "Codex is not available"}</strong><span>{diagnostic.message}</span><small>{auth ? "Authenticate with the local Codex CLI (codex login), then retry this connection." : diagnostic.code === "codex_not_found" ? "Install the Codex CLI locally, then retry this connection." : "Check the local installation and try reconnecting."}</small></div><div className="diagnostic-actions"><button className="button retry-button" onClick={onRetry} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />} Retry</button></div></div>;
}

function RequestCard({ request, onRespond }: { request: PendingRequest; onRespond: (response: RequestResponse) => void }) {
  const [answers, setAnswers] = useState<Record<string, UserInputSelection | undefined>>({});
  const [permissionScope, setPermissionScope] = useState<"turn" | "session">("turn");
  const elicitationForm = request.elicitation && request.elicitation.mode !== "url"
    ? parseElicitationFormSchema(request.elicitation.requestedSchema, request.elicitation.mode)
    : null;
  const [elicitationValues, setElicitationValues] = useState<ElicitationFormValues>(() =>
    elicitationForm?.supported ? initialElicitationFormValues(elicitationForm) : {},
  );
  const [elicitationError, setElicitationError] = useState<string | null>(null);
  const approve = (decision: ApprovalDecision) => onRespond({ requestId: request.requestId, kind: "approval", decision });
  const answerPayload = buildUserInputAnswers(request.questions ?? [], answers);
  const answersComplete = userInputAnswersComplete(request.questions ?? [], answers);
  const denyPermission = () => onRespond({ requestId: request.requestId, kind: "permissions", permissions: {}, scope: "turn" });
  const questionRequest = request.method === "item/tool/requestUserInput";
  const permissionRequest = request.method === "item/permissions/requestApproval";
  const elicitation = request.method === "mcpServer/elicitation/request";
  const submitElicitation = () => {
    if (!elicitationForm?.supported) return;
    const result = buildElicitationContent(elicitationForm, elicitationValues);
    if (!result.ok) {
      setElicitationError(result.error);
      return;
    }
    onRespond({ requestId: request.requestId, kind: "elicitation", action: "accept", content: result.content });
  };
  const acceptUrl = () => onRespond({ requestId: request.requestId, kind: "elicitation", action: "accept", content: null });
  const approvalDecisions = effectiveApprovalDecisions(request);
  return <div className={`request-card ${questionRequest ? "input-request" : ""}`}><div className="request-head"><div className={`request-type ${questionRequest ? "input" : permissionRequest ? "permission" : elicitation ? "mcp" : "approval"}`}>{questionRequest ? <MessageSquare size={14} /> : permissionRequest ? <ShieldCheck size={14} /> : elicitation ? <Zap size={14} /> : <Terminal size={14} />}</div><div><strong>{request.title}</strong><span>{request.detail}</span></div><span className="request-badge">Needs your input</span></div>{request.command && <div className="command-block"><div><Terminal size={13} /> Command</div><code>{request.command}</code>{request.cwd && <small>in {request.cwd}</small>}</div>}{request.method === "item/fileChange/requestApproval" && <div className="file-block"><FileCode2 size={15} /><span>Codex wants to update files in this project.</span></div>}{questionRequest && <div className="questions">{(request.questions ?? []).map((question) => <Question key={question.id} question={question} value={answers[question.id]} onChange={(next) => setAnswers((current) => ({ ...current, [question.id]: next }))} />)}</div>}{permissionRequest && <label className="scope-choice"><input type="checkbox" checked={permissionScope === "session"} onChange={(event) => setPermissionScope(event.target.checked ? "session" : "turn")} /> Remember for this session</label>}{elicitation && request.elicitation?.mode === "url" && <div className="elicitation-url"><span>Complete the requested flow at this URL, then confirm below.</span><code>{request.elicitation.url}</code></div>}{elicitation && elicitationForm?.supported && <div className="elicitation-form">{elicitationForm.fields.map((field) => <ElicitationField key={field.name} field={field} value={elicitationValues[field.name]} onChange={(value) => { setElicitationError(null); setElicitationValues((current) => ({ ...current, [field.name]: value })); }} />)}{elicitationError && <span className="elicitation-error">{elicitationError}</span>}</div>}{elicitation && elicitationForm && !elicitationForm.supported && <div className="elicitation-unsupported"><AlertCircle size={14} /><span>{elicitationForm.reason} You can decline or cancel this request.</span></div>}{questionRequest ? <div className="request-actions"><button className="button secondary-button" disabled={!answersComplete} onClick={() => onRespond({ requestId: request.requestId, kind: "userInput", answers: answerPayload })}>Submit answers</button><button className="quiet-button" onClick={() => onRespond({ requestId: request.requestId, kind: "userInput", answers: {} })}>Cancel</button></div> : permissionRequest ? <div className="request-actions"><button className="button primary-button" onClick={() => onRespond({ requestId: request.requestId, kind: "permissions", permissions: request.requestedPermissions ?? {}, scope: permissionScope })}><Check size={14} /> Allow {permissionScope === "session" ? "for session" : "once"}</button><button className="button secondary-button" onClick={denyPermission}>Deny</button></div> : elicitation ? <div className="request-actions">{request.elicitation?.mode === "url" && <button className="button primary-button" onClick={acceptUrl}><Check size={14} /> I completed this flow</button>}{elicitationForm?.supported && <button className="button primary-button" onClick={submitElicitation}><Check size={14} /> Submit</button>}<button className="button secondary-button" onClick={() => onRespond({ requestId: request.requestId, kind: "elicitation", action: "decline", content: null })}>Decline</button><button className="quiet-button" onClick={() => onRespond({ requestId: request.requestId, kind: "elicitation", action: "cancel", content: null })}>Cancel</button></div> : <div className="request-actions">{approvalDecisions.map((decision, index) => <ApprovalButton key={`${approvalDecisionKey(decision)}-${index}`} decision={decision} onClick={() => approve(decision)} />)}{approvalDecisions.length === 0 && <span className="elicitation-error">Codex did not offer an actionable decision.</span>}</div>}</div>;
}

function ApprovalButton({ decision, onClick }: { decision: ApprovalDecision; onClick: () => void }) {
  if (decision === "accept") return <button className="button primary-button" onClick={onClick}><Check size={14} /> Accept once</button>;
  if (decision === "acceptForSession") return <button className="button secondary-button" onClick={onClick}>For session</button>;
  if (decision === "decline") return <button className="button secondary-button" onClick={onClick}>Decline</button>;
  if (decision === "cancel") return <button className="quiet-button" onClick={onClick}><X size={14} /> Cancel</button>;
  if ("acceptWithExecpolicyAmendment" in decision) return <button className="button secondary-button" onClick={onClick}>Accept and remember command</button>;
  return <button className="button secondary-button" onClick={onClick}>Apply network rule for {decision.applyNetworkPolicyAmendment.network_policy_amendment.host}</button>;
}

function Question({ question, value, onChange }: { question: UserInputQuestion; value?: UserInputSelection; onChange: (value: UserInputSelection) => void }) {
  if (question.options?.length) return <fieldset className="question"><legend>{question.header ?? question.question}</legend><span>{question.question}</span>{question.options.map((option) => <label key={option.label}><input type="radio" name={question.id} checked={value?.kind === "option" && value.value === option.label} onChange={() => onChange({ kind: "option", value: option.label })} /> <span>{option.label}</span>{option.description && <small>{option.description}</small>}</label>)}{question.isOther && <label><input type="radio" name={question.id} checked={value?.kind === "other"} onChange={() => onChange({ kind: "other", value: "" })} /><span>Other</span>{value?.kind === "other" && <input className="other-answer" autoFocus type={question.isSecret ? "password" : "text"} value={value.value} onChange={(event) => onChange({ kind: "other", value: event.target.value })} placeholder="Enter another answer" />}</label>}</fieldset>;
  return <label className="question"><span>{question.header ?? question.question}</span><input type={question.isSecret ? "password" : "text"} value={value?.value ?? ""} onChange={(event) => onChange({ kind: "text", value: event.target.value })} placeholder="Your answer" /></label>;
}

function ElicitationField({ field, value, onChange }: { field: ElicitationFormField; value: string | boolean | undefined; onChange: (value: string | boolean) => void }) {
  const label = <span>{field.label}{field.required ? " *" : ""}</span>;
  if (field.kind === "boolean") return <label className="elicitation-field boolean-field"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{label}{field.description && <small>{field.description}</small>}</label>;
  if (field.kind === "enum") return <label className="elicitation-field">{label}<select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} required={field.required}><option value="">Select an option</option>{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select>{field.description && <small>{field.description}</small>}</label>;
  const inputType = field.kind === "number" || field.kind === "integer" ? "number" : field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : "text";
  return <label className="elicitation-field">{label}<input type={inputType} value={typeof value === "string" ? value : ""} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} step={field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined} required={field.required} onChange={(event) => onChange(event.target.value)} />{field.description && <small>{field.description}</small>}</label>;
}

function UnsavedNavigationDialog({ onStay, onDiscard }: { onStay: () => void; onDiscard: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stayRef.current?.focus();
    const containFocus = (event: FocusEvent) => {
      if (dialogRef.current?.contains(event.target as Node)) return;
      stayRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onStay();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="modal-scrim" data-unsaved-navigation-guard onClick={(event) => { if (event.target === event.currentTarget) onStay(); }}><div ref={dialogRef} className="modal unsaved-navigation-modal" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-navigation-title" aria-describedby="unsaved-navigation-description" tabIndex={-1} onKeyDown={handleKeyDown}><div className="modal-head"><div><span className="eyebrow">Unsaved work</span><h2 id="unsaved-navigation-title">Leave this editor?</h2></div><button type="button" className="icon-button subtle" onClick={onStay} aria-label="Stay on this page"><X size={17} /></button></div><p id="unsaved-navigation-description">This editor has local changes that have not been saved. Leave without saving, or stay here to finish your edit.</p><div className="modal-actions"><button ref={stayRef} type="button" className="button secondary-button" onClick={onStay}>Stay here</button><button type="button" className="button danger-button" onClick={onDiscard}>Leave without saving</button></div></div></div>;
}

function Modal({ type, selectedProject, onClose, onCreateProject, onCreateAgent, busy, chooseDirectory }: { type: "project" | "agent"; selectedProject: ProjectRecord | null; onClose: () => void; onCreateProject: (name: string, path: string) => Promise<void>; onCreateAgent: (name: string, instructions: string) => Promise<void>; busy: boolean; chooseDirectory: () => Promise<string | null> }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [instructions, setInstructions] = useState("You are a careful, pragmatic coding partner. Explain decisions briefly and keep changes focused.");
  const submit = async (event: FormEvent) => { event.preventDefault(); if (type === "project") await onCreateProject(name.trim() || "New project", path.trim()); else await onCreateAgent(name.trim() || "New agent", instructions.trim()); };
  const choose = async () => { const chosen = await chooseDirectory(); if (chosen) { setPath(chosen); if (!name) setName(chosen.split("/").filter(Boolean).pop() ?? "New project"); } };
  const title = type === "project" ? "Add a local project" : "Create an agent";
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{type === "project" ? "Workspace" : selectedProject?.name}</span><h2>{title}</h2></div><button type="button" className="icon-button subtle" onClick={onClose} aria-label="Close"><X size={17} /></button></div>{type === "project" && <><label>Project name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Atlas web app" /></label><label>Directory<div className="path-picker"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="Choose a local folder" /><button type="button" className="button secondary-button" onClick={choose}><FolderOpen size={14} /> Browse</button></div></label></>}{type === "agent" && <><label>Agent name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Code reviewer" /></label><label>Role & instructions<textarea rows={5} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label></>}<div className="modal-actions"><button type="button" className="button secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="button primary-button" disabled={busy || (type === "project" && !path.trim())}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{type === "project" ? "Add project" : "Create agent"}</button></div></form></div>;
}

function RenameSessionDialog({ session, onClose, onRename, busy }: { session: SessionRecord; onClose: () => void; onRename: (title: string) => Promise<void>; busy: boolean }) {
  const [title, setTitle] = useState(session.title);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) return;
    await onRename(nextTitle);
  };
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal rename-session-modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">Session</span><h2>Rename session</h2></div><button type="button" className="icon-button subtle" onClick={onClose} aria-label="Close"><X size={17} /></button></div><label>Session name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onFocus={(event) => event.currentTarget.select()} /></label><div className="modal-actions"><button type="button" className="button secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="button primary-button" disabled={busy || !title.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Pencil size={14} />}Rename</button></div></form></div>;
}

function DeleteSessionDialog({ session, onClose, onDelete, busy }: { session: SessionRecord; onClose: () => void; onDelete: () => Promise<void>; busy: boolean }) {
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="modal delete-session-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title" aria-describedby="delete-session-description"><div className="modal-head"><div><span className="eyebrow">Session</span><h2 id="delete-session-title">Delete session?</h2></div><button type="button" className="icon-button subtle" onClick={onClose} aria-label="Close" disabled={busy}><X size={17} /></button></div><p id="delete-session-description">This permanently deletes “{session.title}” and its Codex thread. The project and agent will remain.</p><div className="modal-actions"><button type="button" className="button secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="button danger-button" onClick={() => void onDelete()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Delete session</button></div></div></div>;
}

function NativeTreeDialog({ target, action, busy, onClose, onSubmit }: {
  target: NativeTreeTarget; action: "rename" | "remove"; busy: boolean; onClose: () => void; onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(target.record.name);
  const removing = action === "remove";
  return <div className="modal-scrim" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <form className="modal rename-session-modal" role={removing ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="native-tree-dialog-title"
      onSubmit={event => { event.preventDefault(); void onSubmit(name.trim()); }}>
      <div className="modal-head"><h2 id="native-tree-dialog-title">{removing ? "Remove" : "Rename"} {target.kind}</h2>
        <button type="button" className="icon-button subtle" disabled={busy} onClick={onClose} aria-label="Close"><X size={17} /></button></div>
      {removing ? <p>Remove “{target.record.name}” from the sidebar? Only an empty {target.kind} can be removed. Manage its {target.kind === "project" ? "agents" : "sessions"} individually first. The project folder and its files are kept.</p>
        : <label>{target.kind === "project" ? "Project" : "Agent"} name<input autoFocus value={name} onChange={event => setName(event.target.value)} onFocus={event => event.currentTarget.select()} /></label>}
      <div className="modal-actions"><button autoFocus={removing} type="button" className="button secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className={`button ${removing ? "danger-button" : "primary-button"}`} disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : removing ? <Trash2 size={14} /> : <Pencil size={14} />}{removing ? "Remove" : "Rename"}</button></div>
    </form>
  </div>;
}
