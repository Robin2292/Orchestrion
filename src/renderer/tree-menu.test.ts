import { describe, expect, it } from "vitest";
import { anchoredTreeMenuPosition, pointerTreeMenuPosition } from "./tree-menu";

describe("sidebar tree menu positioning", () => {
  it("opens a context menu at the pointer while keeping it inside the viewport", () => {
    expect(pointerTreeMenuPosition(120, 90, { width: 800, height: 600 })).toEqual({ x: 120, y: 90 });
    expect(pointerTreeMenuPosition(795, 595, { width: 800, height: 600 })).toEqual({ x: 602, y: 484 });
  });

  it("aligns an overflow menu to the fixed trigger position", () => {
    expect(anchoredTreeMenuPosition({ right: 240, bottom: 52 }, { width: 800, height: 600 }))
      .toEqual({ x: 50, y: 56 });
  });
});
