export const DEFAULT_SIDEBAR_WIDTH = 252;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;
export const SIDEBAR_KEYBOARD_STEP = 16;
export const MIN_MAIN_PANEL_WIDTH = 320;

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function initialSidebarLayout(width = DEFAULT_SIDEBAR_WIDTH): SidebarLayout {
  return { width: clampSidebarWidth(width), collapsed: false };
}

export function sidebarLayoutForRequestedWidth(requestedWidth: number, lastValidWidth: number): SidebarLayout {
  if (!Number.isFinite(requestedWidth)) return initialSidebarLayout(lastValidWidth);
  if (requestedWidth < MIN_SIDEBAR_WIDTH) {
    return { width: clampSidebarWidth(lastValidWidth), collapsed: true };
  }
  return { width: clampSidebarWidth(requestedWidth), collapsed: false };
}

export function toggleSidebarLayout(layout: SidebarLayout): SidebarLayout {
  return { width: clampSidebarWidth(layout.width), collapsed: !layout.collapsed };
}

export function effectiveSidebarWidth(width: number, viewportWidth: number): number {
  const availableWidth = Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_MAIN_PANEL_WIDTH);
  return Math.min(clampSidebarWidth(width), availableWidth);
}

export function sidebarLayoutForKey(layout: SidebarLayout, key: string, maximumWidth = MAX_SIDEBAR_WIDTH): SidebarLayout | null {
  const contextualMaximum = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, maximumWidth));
  if (key === "Home") return { width: MIN_SIDEBAR_WIDTH, collapsed: false };
  if (key === "End") return { width: contextualMaximum, collapsed: false };
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const requestedWidth = layout.width + (key === "ArrowLeft" ? -SIDEBAR_KEYBOARD_STEP : SIDEBAR_KEYBOARD_STEP);
  const next = sidebarLayoutForRequestedWidth(requestedWidth, layout.width);
  return next.collapsed ? next : { ...next, width: Math.min(next.width, contextualMaximum) };
}
