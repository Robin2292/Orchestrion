export const DEFAULT_WORKSPACE_PANEL_WIDTH = 440;
export const MIN_WORKSPACE_PANEL_WIDTH = 320;
export const MAX_WORKSPACE_PANEL_WIDTH = 720;
export const MIN_CONVERSATION_WIDTH = 360;
export const WORKSPACE_PANEL_KEYBOARD_STEP = 20;
export const WORKSPACE_SURFACE_DISPLAY_ORDER: readonly WorkspaceSurfaceId[] = ["files", "terminal", "side-chat"];

export type WorkspaceSurfaceId = "files" | "terminal" | "side-chat";

export interface WorkspacePanelState {
  sessionId: string | null;
  open: boolean;
  maximized: boolean;
  dockedWidth: number;
  activeSurfaceId: WorkspaceSurfaceId | null;
  openSurfaceIds: WorkspaceSurfaceId[];
}

export type WorkspacePanelControlId = "maximize" | "toggle";
export type WorkspacePanelControlIcon = "maximize" | "restore" | "panel";

export interface WorkspacePanelControlPresentation {
  id: WorkspacePanelControlId;
  label: string;
  icon: WorkspacePanelControlIcon;
  pressed: boolean;
}

export interface WorkspacePanelGeometry {
  workspaceWidth: number;
  minimumDockedWidth: number;
  maximumDockedWidth: number;
  renderedWidth: number;
}

export type WorkspacePanelAction =
  | { type: "toggle"; sessionId: string | null }
  | { type: "close" }
  | { type: "toggle-maximize" }
  | { type: "resize"; width: number; workspaceWidth: number }
  | { type: "resize-key"; key: string; workspaceWidth: number }
  | { type: "session-changed"; sessionId: string | null }
  | { type: "select-surface"; surfaceId: WorkspaceSurfaceId }
  | { type: "open-surface-picker" }
  | { type: "close-surface"; surfaceId: WorkspaceSurfaceId };

export function initialWorkspacePanelState(dockedWidth = DEFAULT_WORKSPACE_PANEL_WIDTH, sessionId: string | null = null): WorkspacePanelState {
  return {
    sessionId,
    open: false,
    maximized: false,
    dockedWidth: clamp(dockedWidth, MIN_WORKSPACE_PANEL_WIDTH, MAX_WORKSPACE_PANEL_WIDTH),
    activeSurfaceId: null,
    openSurfaceIds: [],
  };
}

export function workspacePanelControlPresentations(state: WorkspacePanelState): WorkspacePanelControlPresentation[] {
  const controls: WorkspacePanelControlPresentation[] = [];
  if (state.open) {
    controls.push({
      id: "maximize",
      label: state.maximized ? "Restore workspace panel" : "Maximize workspace panel",
      icon: state.maximized ? "restore" : "maximize",
      pressed: state.maximized,
    });
  }
  controls.push({
    id: "toggle",
    label: state.open ? "Hide workspace panel" : "Show workspace panel",
    icon: "panel",
    pressed: state.open,
  });
  return controls;
}

export function workspaceWidthForLayout(viewportWidth: number, sidebarWidth: number, sidebarCollapsed: boolean): number {
  if (!Number.isFinite(viewportWidth)) return 0;
  const occupiedSidebarWidth = sidebarCollapsed || !Number.isFinite(sidebarWidth) ? 0 : Math.max(0, sidebarWidth);
  return Math.max(0, viewportWidth - occupiedSidebarWidth);
}

export function workspacePanelBounds(workspaceWidth: number): Pick<WorkspacePanelGeometry, "minimumDockedWidth" | "maximumDockedWidth"> {
  const safeWorkspaceWidth = Number.isFinite(workspaceWidth) ? Math.max(0, workspaceWidth) : 0;
  const conversationReserve = Math.min(MIN_CONVERSATION_WIDTH, safeWorkspaceWidth * 0.42);
  const availableDockedWidth = Math.max(0, safeWorkspaceWidth - conversationReserve);
  const minimumDockedWidth = Math.min(MIN_WORKSPACE_PANEL_WIDTH, availableDockedWidth);
  const maximumDockedWidth = Math.max(
    minimumDockedWidth,
    Math.min(MAX_WORKSPACE_PANEL_WIDTH, availableDockedWidth),
  );
  return { minimumDockedWidth, maximumDockedWidth };
}

export function workspacePanelGeometry(
  state: WorkspacePanelState,
  viewportWidth: number,
  sidebarWidth: number,
  sidebarCollapsed: boolean,
): WorkspacePanelGeometry {
  const workspaceWidth = workspaceWidthForLayout(viewportWidth, sidebarWidth, sidebarCollapsed);
  const bounds = workspacePanelBounds(workspaceWidth);
  return {
    workspaceWidth,
    ...bounds,
    renderedWidth: state.maximized
      ? workspaceWidth
      : clamp(state.dockedWidth, bounds.minimumDockedWidth, bounds.maximumDockedWidth),
  };
}

export function updateWorkspacePanel(state: WorkspacePanelState, action: WorkspacePanelAction): WorkspacePanelState {
  if (action.type === "toggle") {
    const scoped = workspacePanelStateForSession(state, action.sessionId);
    return scoped.open
      ? { ...scoped, open: false, maximized: false, activeSurfaceId: null }
      : { ...scoped, open: true, maximized: false };
  }
  if (action.type === "session-changed") {
    return { ...state, sessionId: action.sessionId, open: false, maximized: false, activeSurfaceId: null, openSurfaceIds: [] };
  }
  if (action.type === "close") {
    return { ...state, open: false, maximized: false, activeSurfaceId: null };
  }
  if (action.type === "toggle-maximize") {
    return state.open && state.maximized
      ? { ...state, maximized: false }
      : { ...state, open: true, maximized: true };
  }
  if (action.type === "select-surface") return {
    ...state,
    activeSurfaceId: action.surfaceId,
    openSurfaceIds: state.openSurfaceIds.includes(action.surfaceId) ? state.openSurfaceIds : [...state.openSurfaceIds, action.surfaceId],
  };
  if (action.type === "open-surface-picker") return { ...state, activeSurfaceId: null };
  if (action.type === "close-surface") {
    const currentOpenSurfaceIds = state.openSurfaceIds.length > 0 ? state.openSurfaceIds : state.activeSurfaceId ? [state.activeSurfaceId] : [];
    const displayOpenSurfaceIds = WORKSPACE_SURFACE_DISPLAY_ORDER.filter((surfaceId) => currentOpenSurfaceIds.includes(surfaceId));
    const index = displayOpenSurfaceIds.indexOf(action.surfaceId);
    if (index < 0) return state;
    const openSurfaceIds = currentOpenSurfaceIds.filter((surfaceId) => surfaceId !== action.surfaceId);
    const activeSurfaceId = state.activeSurfaceId === action.surfaceId
      ? displayOpenSurfaceIds[index + 1] ?? displayOpenSurfaceIds[index - 1] ?? null
      : state.activeSurfaceId;
    return { ...state, openSurfaceIds, activeSurfaceId };
  }
  if (action.type === "resize") {
    const bounds = workspacePanelBounds(action.workspaceWidth);
    if (!Number.isFinite(action.width)) return state;
    if (action.width < bounds.minimumDockedWidth) {
      return { ...state, open: false, maximized: false, activeSurfaceId: null };
    }
    return {
      ...state,
      open: true,
      maximized: false,
      dockedWidth: clamp(action.width, bounds.minimumDockedWidth, bounds.maximumDockedWidth),
    };
  }
  const bounds = workspacePanelBounds(action.workspaceWidth);
  if (action.key === "Home") {
    return { ...state, open: true, maximized: false, dockedWidth: bounds.minimumDockedWidth };
  }
  if (action.key === "End") {
    return { ...state, open: true, maximized: false, dockedWidth: bounds.maximumDockedWidth };
  }
  if (action.key !== "ArrowLeft" && action.key !== "ArrowRight") return state;
  const delta = action.key === "ArrowLeft" ? WORKSPACE_PANEL_KEYBOARD_STEP : -WORKSPACE_PANEL_KEYBOARD_STEP;
  if (state.dockedWidth + delta < bounds.minimumDockedWidth) {
    return { ...state, open: false, maximized: false, activeSurfaceId: null };
  }
  return {
    ...state,
    open: true,
    maximized: false,
    dockedWidth: clamp(state.dockedWidth + delta, bounds.minimumDockedWidth, bounds.maximumDockedWidth),
  };
}

export function workspacePanelStateForSession(state: WorkspacePanelState, sessionId: string | null): WorkspacePanelState {
  return state.sessionId === sessionId
    ? state
    : { ...state, sessionId, open: false, maximized: false, activeSurfaceId: null, openSurfaceIds: [] };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
