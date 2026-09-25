import { describe, expect, it } from "vitest";
import { IPC, type DesktopWindowState, type OrchestrionDesktopApi } from "./contracts";

describe("desktop window state contract", () => {
  it("exposes native fullscreen state through a read and subscription pair", () => {
    const readMethod: keyof OrchestrionDesktopApi = "getWindowState";
    const subscribeMethod: keyof OrchestrionDesktopApi = "onWindowState";
    const state: DesktopWindowState = { isFullScreen: true };

    expect(readMethod).toBe("getWindowState");
    expect(subscribeMethod).toBe("onWindowState");
    expect(IPC.windowState).toBe("orchestrion:window-state");
    expect(state.isFullScreen).toBe(true);
  });
});
