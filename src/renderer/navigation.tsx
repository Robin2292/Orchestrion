import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { DesktopSnapshot } from "../shared/contracts";
import type { LocalAgentWorkspace } from "../shared/agent-ui-contracts";
import type { LocalPolicyUiWorkspace } from "../shared/policy/p2-ui-contracts";
import { useUnsavedNavigationGuard } from "../web-compat/lib/hooks/use-unsaved-navigation-guard";

export const PROJECT_SETTINGS_SECTIONS = ["overview", "automation", "capabilities", "safety", "audit"] as const;
export const AGENT_SETTINGS_SECTIONS = ["profile", "capabilities", "activity", "advanced"] as const;

export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[number];
export type AgentSettingsSection = (typeof AGENT_SETTINGS_SECTIONS)[number];

export type LocalRoute =
  | { kind: "workspace" }
  | { kind: "inbox"; projectId: string | null }
  | { kind: "session"; projectId: string; agentId: string; sessionId: string }
  | { kind: "direct-session"; projectId: string; sessionId: string | null }
  | { kind: "project-settings"; projectId: string; section: ProjectSettingsSection }
  | { kind: "agent-settings"; projectId: string; agentId: string; section: AgentSettingsSection }
  | { kind: "local-agents"; projectId: string }
  | { kind: "project-agents"; projectId: string }
  | { kind: "project-agent-add"; projectId: string; agentId: string | null }
  | { kind: "project-agent-create"; projectId: string }
  | { kind: "agent-library"; projectId: string }
  | { kind: "agent-library-detail"; projectId: string; agentId: string }
  | { kind: "agent-library-create"; projectId: string }
  | { kind: "local-agent-create"; projectId: string }
  | { kind: "local-agent"; projectId: string; agentId: string; versionId: string | null }
  | { kind: "local-policies"; projectId: string }
  | { kind: "local-policy"; projectId: string; releaseId: string }
  | { kind: "recovery"; requestedPath: string; reason: "unknown-route" | "invalid-context" };

interface LocalNavigationContextValue {
  route: LocalRoute;
  pendingRoute: LocalRoute | null;
  navigate: (route: LocalRoute, effects?: NavigationEffects) => void;
  replace: (route: LocalRoute) => void;
  confirmPending: () => void;
  cancelPending: () => void;
}

interface NavigationEffects {
  afterCommit?: () => void;
  finalizeCommit?: () => void;
}

interface PendingNavigation {
  route: LocalRoute;
  afterCommit?: () => void;
  finalizers: Array<() => void>;
}

const LocalNavigationContext = createContext<LocalNavigationContextValue | null>(null);

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function isProjectSection(value: string): value is ProjectSettingsSection {
  return PROJECT_SETTINGS_SECTIONS.includes(value as ProjectSettingsSection);
}

function isAgentSection(value: string): value is AgentSettingsSection {
  return AGENT_SETTINGS_SECTIONS.includes(value as AgentSettingsSection);
}

export function parseLocalRoute(hash: string): LocalRoute {
  const requestedPath = hash || "#/";
  const rawPath = requestedPath.startsWith("#") ? requestedPath.slice(1) : requestedPath;
  const path = rawPath.split("?", 1)[0].replace(/^\/+|\/+$/g, "");
  if (!path) return { kind: "workspace" };
  const parts = path.split("/");

  if (parts.length === 1 && parts[0] === "inbox") {
    return { kind: "inbox", projectId: null };
  }

  if (parts[0] !== "projects") {
    return { kind: "recovery", requestedPath, reason: "unknown-route" };
  }
  const projectId = safeDecode(parts[1] ?? "");
  if (!projectId) return { kind: "recovery", requestedPath, reason: "unknown-route" };

  if (parts.length === 3 && parts[2] === "inbox") {
    return { kind: "inbox", projectId };
  }
  if (parts.length === 4 && parts[2] === "settings" && isProjectSection(parts[3])) {
    return { kind: "project-settings", projectId, section: parts[3] };
  }
  if (parts[2] === "direct-sessions") {
    if (parts.length === 4 && parts[3] === "new") return { kind:"direct-session",projectId,sessionId:null };
    const sessionId=safeDecode(parts[3] ?? "");
    return parts.length===4 && sessionId
      ? {kind:"direct-session",projectId,sessionId}
      : {kind:"recovery",requestedPath,reason:"unknown-route"};
  }

  if (parts[2] === "policies") {
    if (parts.length === 3) return { kind:"local-policies",projectId };
    const releaseId = safeDecode(parts[3] ?? "");
    return parts.length === 4 && releaseId
      ? { kind:"local-policy",projectId,releaseId }
      : { kind:"recovery",requestedPath,reason:"unknown-route" };
  }

  if (parts[2] === "project-agents") {
    if (parts.length === 3) return { kind: "project-agents", projectId };
    if (parts.length === 4 && parts[3] === "add") return { kind: "project-agent-add", projectId, agentId: null };
    const addAgentId = safeDecode(parts[4] ?? "");
    if (parts.length === 5 && parts[3] === "add" && addAgentId)
      return { kind: "project-agent-add", projectId, agentId: addAgentId };
    if (parts.length === 4 && parts[3] === "new") return { kind: "project-agent-create", projectId };
  }
  if (parts[2] === "agent-library") {
    if (parts.length === 3) return { kind: "agent-library", projectId };
    if (parts.length === 4 && parts[3] === "new") return { kind: "agent-library-create", projectId };
    const libraryAgentId = safeDecode(parts[3] ?? "");
    if (parts.length === 4 && libraryAgentId) return { kind: "agent-library-detail", projectId, agentId: libraryAgentId };
  }

  if (parts[2] !== "agents") {
    return { kind: "recovery", requestedPath, reason: "unknown-route" };
  }
  if (parts.length === 3) return { kind: "local-agents", projectId };
  if (parts.length === 4 && parts[3] === "new") return { kind: "local-agent-create", projectId };
  const agentId = safeDecode(parts[3] ?? "");
  if (!agentId) return { kind: "recovery", requestedPath, reason: "unknown-route" };

  if (parts.length === 4) return { kind: "local-agent", projectId, agentId, versionId: null };
  if (parts.length === 6 && parts[4] === "versions") {
    const versionId = safeDecode(parts[5] ?? "");
    return versionId
      ? { kind: "local-agent", projectId, agentId, versionId }
      : { kind: "recovery", requestedPath, reason: "unknown-route" };
  }
  if (parts.length === 6 && parts[4] === "sessions") {
    const sessionId = safeDecode(parts[5] ?? "");
    return sessionId
      ? { kind: "session", projectId, agentId, sessionId }
      : { kind: "recovery", requestedPath, reason: "unknown-route" };
  }
  if (parts.length === 6 && parts[4] === "settings" && isAgentSection(parts[5])) {
    return { kind: "agent-settings", projectId, agentId, section: parts[5] };
  }
  return { kind: "recovery", requestedPath, reason: "unknown-route" };
}

export function localRouteHash(route: LocalRoute): string {
  const id = (value: string) => encodeURIComponent(value);
  if (route.kind === "workspace") return "#/";
  if (route.kind === "inbox") return route.projectId ? `#/projects/${id(route.projectId)}/inbox` : "#/inbox";
  if (route.kind === "session") {
    return `#/projects/${id(route.projectId)}/agents/${id(route.agentId)}/sessions/${id(route.sessionId)}`;
  }
  if (route.kind === "direct-session") return `#/projects/${id(route.projectId)}/direct-sessions/${route.sessionId ? id(route.sessionId) : "new"}`;
  if (route.kind === "project-settings") {
    return `#/projects/${id(route.projectId)}/settings/${route.section}`;
  }
  if (route.kind === "local-policies") return `#/projects/${id(route.projectId)}/policies`;
  if (route.kind === "local-policy") return `#/projects/${id(route.projectId)}/policies/${id(route.releaseId)}`;
  if (route.kind === "local-agents") return `#/projects/${id(route.projectId)}/agents`;
  if (route.kind === "project-agents") return `#/projects/${id(route.projectId)}/project-agents`;
  if (route.kind === "project-agent-add") return `#/projects/${id(route.projectId)}/project-agents/add${route.agentId ? `/${id(route.agentId)}` : ""}`;
  if (route.kind === "project-agent-create") return `#/projects/${id(route.projectId)}/project-agents/new`;
  if (route.kind === "agent-library") return `#/projects/${id(route.projectId)}/agent-library`;
  if (route.kind === "agent-library-create") return `#/projects/${id(route.projectId)}/agent-library/new`;
  if (route.kind === "agent-library-detail") return `#/projects/${id(route.projectId)}/agent-library/${id(route.agentId)}`;
  if (route.kind === "local-agent-create") return `#/projects/${id(route.projectId)}/agents/new`;
  if (route.kind === "local-agent") return route.versionId
    ? `#/projects/${id(route.projectId)}/agents/${id(route.agentId)}/versions/${id(route.versionId)}`
    : `#/projects/${id(route.projectId)}/agents/${id(route.agentId)}`;
  if (route.kind === "agent-settings") {
    return `#/projects/${id(route.projectId)}/agents/${id(route.agentId)}/settings/${route.section}`;
  }
  return route.requestedPath.startsWith("#") ? route.requestedPath : `#${route.requestedPath}`;
}

export function validateRouteContext(route: LocalRoute, snapshot: DesktopSnapshot, localAgents?: LocalAgentWorkspace | null,
  localPolicies?: LocalPolicyUiWorkspace | null): LocalRoute {
  if (route.kind === "workspace" || route.kind === "recovery") return route;
  if (route.kind === "inbox" && route.projectId === null) return route;
  if (route.kind === "direct-session" || route.kind === "local-agents" || route.kind === "local-agent-create" || route.kind === "local-agent" || route.kind === "project-agents" || route.kind === "project-agent-add" || route.kind === "project-agent-create" || route.kind === "agent-library" || route.kind === "agent-library-create" || route.kind === "agent-library-detail") {
    if (!localAgents) return route;
    if (localAgents.projectId !== route.projectId) {
      return { kind: "recovery", requestedPath: localRouteHash(route), reason: "invalid-context" };
    }
    // Agent detail is resolved by the authenticated host using its identity.
    // A list snapshot is navigation context, not an authorization/membership oracle.
    return route;
  }
  if (route.kind === "local-policies" || route.kind === "local-policy") {
    if (!localPolicies) return route;
    return localPolicies.projectId === route.projectId
      ? route
      : { kind:"recovery",requestedPath:localRouteHash(route),reason:"invalid-context" };
  }
  const project = snapshot.projects.find((candidate) => candidate.id === route.projectId);
  if (!project) return { kind: "recovery", requestedPath: localRouteHash(route), reason: "invalid-context" };
  if (route.kind === "inbox" || route.kind === "project-settings") return route;
  const agent = snapshot.agents.find((candidate) => candidate.id === route.agentId && candidate.projectId === project.id);
  if (!agent) return { kind: "recovery", requestedPath: localRouteHash(route), reason: "invalid-context" };
  if (route.kind === "agent-settings") return route;
  const session = snapshot.sessions.find((candidate) => candidate.id === route.sessionId && candidate.agentId === agent.id);
  return session ? route : { kind: "recovery", requestedPath: localRouteHash(route), reason: "invalid-context" };
}

function routeEquals(left: LocalRoute, right: LocalRoute): boolean {
  return localRouteHash(left) === localRouteHash(right);
}

export function LocalNavigationProvider({
  isDirty,
  onDiscard,
  children,
}: {
  isDirty: boolean;
  onDiscard: () => void;
  children: ReactNode;
}) {
  const initialHash = typeof window === "undefined" ? "#/" : window.location.hash;
  const [route, setRoute] = useState<LocalRoute>(() => parseLocalRoute(initialHash));
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const acceptedHashRef = useRef(localRouteHash(parseLocalRoute(initialHash)));
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;

  const updatePendingNavigation = useCallback((next: PendingNavigation | null) => {
    pendingNavigationRef.current = next;
    setPendingNavigation(next);
  }, []);

  const requestFor = useCallback((next: LocalRoute, effects?: NavigationEffects): PendingNavigation => {
    const finalizers = [...(pendingNavigationRef.current?.finalizers ?? [])];
    if (effects?.finalizeCommit && !finalizers.includes(effects.finalizeCommit)) {
      finalizers.push(effects.finalizeCommit);
    }
    return { route: next, afterCommit: effects?.afterCommit, finalizers };
  }, []);

  const commitRequest = useCallback((request: PendingNavigation, mode: "push" | "replace" | "external" | "current" = "push") => {
    updatePendingNavigation(null);
    const hash = localRouteHash(request.route);
    if (mode === "push" || mode === "replace") {
      window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", hash);
    }
    acceptedHashRef.current = hash;
    setRoute(request.route);
    try {
      request.afterCommit?.();
    } finally {
      request.finalizers.forEach((finalize) => finalize());
    }
  }, [updatePendingNavigation]);

  const navigate = useCallback((next: LocalRoute, effects?: NavigationEffects) => {
    if (routeEquals(route, next) && !effects && !pendingNavigationRef.current) return;
    const request = requestFor(next, effects);
    if (dirtyRef.current) {
      updatePendingNavigation(request);
      return;
    }
    commitRequest(request, routeEquals(route, next) ? "current" : "push");
  }, [commitRequest, requestFor, route, updatePendingNavigation]);

  const replace = useCallback((next: LocalRoute) => {
    commitRequest(requestFor(next), "replace");
  }, [commitRequest, requestFor]);

  const attemptHref = useCallback((href: string) => {
    const destination = new URL(href, window.location.href);
    updatePendingNavigation(requestFor(parseLocalRoute(destination.hash || destination.pathname)));
  }, [requestFor, updatePendingNavigation]);

  useUnsavedNavigationGuard({ isDirty, onNavigationAttempt: attemptHref });

  useEffect(() => {
    const syncLocation = () => {
      const candidateHash = window.location.hash || "#/";
      if (candidateHash === acceptedHashRef.current) return;
      const candidate = parseLocalRoute(candidateHash);
      if (dirtyRef.current) {
        window.history.pushState({}, "", acceptedHashRef.current);
        updatePendingNavigation(requestFor(candidate));
        return;
      }
      commitRequest(requestFor(candidate), "external");
    };
    window.addEventListener("popstate", syncLocation);
    window.addEventListener("hashchange", syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener("hashchange", syncLocation);
    };
  }, [commitRequest, requestFor, updatePendingNavigation]);

  const confirmPending = useCallback(() => {
    const request = pendingNavigationRef.current;
    if (!request) return;
    updatePendingNavigation(null);
    onDiscard();
    commitRequest(request, localRouteHash(request.route) === acceptedHashRef.current ? "current" : "push");
  }, [commitRequest, onDiscard, updatePendingNavigation]);

  const cancelPending = useCallback(() => updatePendingNavigation(null), [updatePendingNavigation]);

  const value = {
    route,
    pendingRoute: pendingNavigation?.route ?? null,
    navigate,
    replace,
    confirmPending,
    cancelPending,
  };
  return <LocalNavigationContext.Provider value={value}>{children}</LocalNavigationContext.Provider>;
}

export function useLocalNavigation(): LocalNavigationContextValue {
  const context = useContext(LocalNavigationContext);
  if (!context) throw new Error("Local navigation must be used inside LocalNavigationProvider");
  return context;
}

export function LocalRouteLink({
  to,
  onClick,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: LocalRoute }) {
  const { navigate } = useLocalNavigation();
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...props} href={localRouteHash(to)} onClick={handleClick} />;
}
