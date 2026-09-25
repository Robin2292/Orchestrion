export const DEFAULT_FILE_TREE_WIDTH = 214;
export const MIN_FILE_TREE_WIDTH = 168;
export const MAX_FILE_TREE_WIDTH = 360;
export const FILE_TREE_KEYBOARD_STEP = 16;

export interface WorkspaceFileTreeLayout {
  width: number;
  collapsed: boolean;
}
export function initialWorkspaceFileTreeLayout(width = DEFAULT_FILE_TREE_WIDTH): WorkspaceFileTreeLayout {
  return { width: clamp(width, MIN_FILE_TREE_WIDTH, MAX_FILE_TREE_WIDTH), collapsed: false };
}

export function fileTreeLayoutForRequestedWidth(
  requestedWidth: number,
  lastValidWidth: number,
  maximumWidth = MAX_FILE_TREE_WIDTH,
): WorkspaceFileTreeLayout {
  const contextualMaximum = Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, maximumWidth));
  if (!Number.isFinite(requestedWidth)) return initialWorkspaceFileTreeLayout(lastValidWidth);
  if (requestedWidth < MIN_FILE_TREE_WIDTH) {
    return { width: clamp(lastValidWidth, MIN_FILE_TREE_WIDTH, MAX_FILE_TREE_WIDTH), collapsed: true };
  }
  return { width: clamp(requestedWidth, MIN_FILE_TREE_WIDTH, contextualMaximum), collapsed: false };
}

export function fileTreeLayoutForKey(
  layout: WorkspaceFileTreeLayout,
  key: string,
  maximumWidth = MAX_FILE_TREE_WIDTH,
): WorkspaceFileTreeLayout | null {
  const contextualMaximum = Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, maximumWidth));
  if (key === "Home") return { width: MIN_FILE_TREE_WIDTH, collapsed: false };
  if (key === "End") return { width: contextualMaximum, collapsed: false };
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const requested = layout.width + (key === "ArrowLeft" ? -FILE_TREE_KEYBOARD_STEP : FILE_TREE_KEYBOARD_STEP);
  const next = fileTreeLayoutForRequestedWidth(requested, layout.width);
  return next.collapsed ? next : { ...next, width: Math.min(next.width, contextualMaximum) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
