import { describe, expect, it } from "vitest";
import { fileTreeLayoutForKey, fileTreeLayoutForRequestedWidth, initialWorkspaceFileTreeLayout, MIN_FILE_TREE_WIDTH } from "./workspace-files-layout-state";

describe("workspace file tree layout", () => {
  it("collapses below the minimum while restoring the last valid width", () => {
    const layout = initialWorkspaceFileTreeLayout(224);
    expect(fileTreeLayoutForRequestedWidth(120, layout.width)).toEqual({ width: 224, collapsed: true });
    expect(fileTreeLayoutForRequestedWidth(190, layout.width)).toEqual({ width: 190, collapsed: false });
  });

  it("supports keyboard resizing and Home restores the minimum", () => {
    const layout = initialWorkspaceFileTreeLayout(224);
    expect(fileTreeLayoutForKey(layout, "ArrowLeft")?.width).toBe(208);
    expect(fileTreeLayoutForKey(layout, "Home")).toEqual({ width: MIN_FILE_TREE_WIDTH, collapsed: false });
    expect(fileTreeLayoutForKey(layout, "End", 280)?.width).toBe(280);
  });
});
