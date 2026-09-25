const RESIZE_END_EVENTS = ["pointerup", "pointercancel", "blur"] as const;

export function resizeRailMounted(surfaceAvailable: boolean, resizing: boolean): boolean {
  return surfaceAvailable || resizing;
}

export function workspacePanelResizeEnabled(open: boolean, maximized: boolean): boolean {
  return open && !maximized;
}

export function installResizeGestureCleanup(target: EventTarget, cleanup: () => void): () => void {
  for (const eventName of RESIZE_END_EVENTS) target.addEventListener(eventName, cleanup);
  return () => {
    for (const eventName of RESIZE_END_EVENTS) target.removeEventListener(eventName, cleanup);
  };
}
