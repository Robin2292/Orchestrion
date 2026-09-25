import { describe, expect, it, vi } from "vitest";
import { installResizeGestureCleanup, resizeRailMounted, workspacePanelResizeEnabled } from "./resize-rail-state";

describe("full-height resize rail lifecycle", () => {
  it("keeps a captured rail mounted when its sidebar or panel becomes unavailable", () => {
    expect(resizeRailMounted(false, true)).toBe(true);
    expect(resizeRailMounted(false, false)).toBe(false);
    expect(resizeRailMounted(true, false)).toBe(true);
  });

  it("blocks workspace panel resize updates after close or maximize", () => {
    expect(workspacePanelResizeEnabled(true, false)).toBe(true);
    expect(workspacePanelResizeEnabled(false, false)).toBe(false);
    expect(workspacePanelResizeEnabled(true, true)).toBe(false);
  });

  it.each(["pointerup", "pointercancel", "blur"])("cleans up a resize gesture on %s", (eventName) => {
    const target = new EventTarget();
    const cleanup = vi.fn();
    const uninstall = installResizeGestureCleanup(target, cleanup);

    target.dispatchEvent(new Event(eventName));
    expect(cleanup).toHaveBeenCalledOnce();

    uninstall();
    target.dispatchEvent(new Event(eventName));
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
