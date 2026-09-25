import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  effectiveSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  initialSidebarLayout,
  sidebarLayoutForKey,
  sidebarLayoutForRequestedWidth,
  toggleSidebarLayout,
} from "./sidebar-state";

describe("desktop sidebar layout state", () => {
  it("starts at the native desktop width", () => {
    expect(initialSidebarLayout()).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
  });

  it("clamps a drag at the maximum width", () => {
    expect(sidebarLayoutForRequestedWidth(MAX_SIDEBAR_WIDTH + 80, DEFAULT_SIDEBAR_WIDTH)).toEqual({
      width: MAX_SIDEBAR_WIDTH,
      collapsed: false,
    });
  });

  it("collapses below the minimum without forgetting the last valid width", () => {
    const collapsed = sidebarLayoutForRequestedWidth(MIN_SIDEBAR_WIDTH - 1, 318);
    expect(collapsed).toEqual({ width: 318, collapsed: true });
    expect(toggleSidebarLayout(collapsed)).toEqual({ width: 318, collapsed: false });
  });

  it("supports keyboard resizing and keyboard collapse at the minimum", () => {
    expect(sidebarLayoutForKey({ width: 300, collapsed: false }, "ArrowRight")).toEqual({ width: 316, collapsed: false });
    expect(sidebarLayoutForKey({ width: MIN_SIDEBAR_WIDTH, collapsed: false }, "ArrowLeft")).toEqual({
      width: MIN_SIDEBAR_WIDTH,
      collapsed: true,
    });
    expect(sidebarLayoutForKey({ width: 300, collapsed: false }, "Home")).toEqual({ width: MIN_SIDEBAR_WIDTH, collapsed: false });
    expect(sidebarLayoutForKey({ width: 300, collapsed: false }, "End")).toEqual({ width: MAX_SIDEBAR_WIDTH, collapsed: false });
    expect(sidebarLayoutForKey({ width: 300, collapsed: false }, "Escape")).toBeNull();
  });

  it("temporarily yields space to the main panel in a narrow window", () => {
    expect(effectiveSidebarWidth(360, 1440)).toBe(360);
    expect(effectiveSidebarWidth(360, 560)).toBe(240);
    expect(effectiveSidebarWidth(360, 520)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("resizes from the visible width and stores the result at a narrow-window maximum", () => {
    const visibleWidth = effectiveSidebarWidth(360, 560);
    const visibleLayout = { width: visibleWidth, collapsed: false };

    expect(sidebarLayoutForKey(visibleLayout, "ArrowLeft", visibleWidth)).toEqual({ width: 224, collapsed: false });
    expect(sidebarLayoutForKey(visibleLayout, "ArrowRight", visibleWidth)).toEqual({ width: 240, collapsed: false });
    expect(sidebarLayoutForKey(visibleLayout, "End", visibleWidth)).toEqual({ width: 240, collapsed: false });
  });
});
