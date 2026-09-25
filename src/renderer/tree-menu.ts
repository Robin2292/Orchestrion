const MENU_WIDTH = 190;
const MENU_HEIGHT = 108;
const VIEWPORT_GUTTER = 8;
const ANCHOR_GAP = 4;

interface Viewport {
  width: number;
  height: number;
}

interface AnchorRect {
  right: number;
  bottom: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function pointerTreeMenuPosition(x: number, y: number, viewport: Viewport, menuHeight = MENU_HEIGHT) {
  return {
    x: clamp(x, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, viewport.width - MENU_WIDTH - VIEWPORT_GUTTER)),
    y: clamp(y, VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, viewport.height - menuHeight - VIEWPORT_GUTTER)),
  };
}

export function anchoredTreeMenuPosition(anchor: AnchorRect, viewport: Viewport, menuHeight = MENU_HEIGHT) {
  return pointerTreeMenuPosition(anchor.right - MENU_WIDTH, anchor.bottom + ANCHOR_GAP, viewport, menuHeight);
}
