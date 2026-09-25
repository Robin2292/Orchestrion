import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_PANEL_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
  initialWorkspacePanelState,
  updateWorkspacePanel,
  workspacePanelControlPresentations,
  workspacePanelGeometry,
  workspaceWidthForLayout,
} from "./workspace-panel-state";
import { localWorkspaceSurfaceProvider, workspaceSurfacePresentations } from "./workspace-surfaces";

describe("workspace panel layout state", () => {
  it("presents only the toggle while closed, then adds maximize and flips its icon when maximized", () => {
    const closed = workspacePanelControlPresentations(initialWorkspacePanelState());
    expect(closed).toEqual([
      { id: "toggle", label: "Show workspace panel", icon: "panel", pressed: false },
    ]);

    const open = workspacePanelControlPresentations({ ...initialWorkspacePanelState(), open: true });
    expect(open).toEqual([
      { id: "maximize", label: "Maximize workspace panel", icon: "maximize", pressed: false },
      { id: "toggle", label: "Hide workspace panel", icon: "panel", pressed: true },
    ]);

    const maximized = workspacePanelControlPresentations({ ...initialWorkspacePanelState(), open: true, maximized: true });
    expect(maximized).toEqual([
      { id: "maximize", label: "Restore workspace panel", icon: "restore", pressed: true },
      { id: "toggle", label: "Hide workspace panel", icon: "panel", pressed: true },
    ]);
  });

  it("opens and closes without forgetting its last docked width", () => {
    const opened = updateWorkspacePanel(initialWorkspacePanelState(510), { type: "toggle", sessionId: "session-1" });
    const closed = updateWorkspacePanel(opened, { type: "toggle", sessionId: "session-1" });
    expect(opened).toMatchObject({ open: true, maximized: false, dockedWidth: 510 });
    expect(closed).toMatchObject({ open: false, maximized: false, dockedWidth: 510 });
    expect(updateWorkspacePanel(closed, { type: "toggle", sessionId: "session-1" })).toMatchObject({ open: true, dockedWidth: 510 });
  });

  it("starts on the launcher and closes without sharing a surface across sessions", () => {
    const launcher = updateWorkspacePanel(initialWorkspacePanelState(), { type: "toggle", sessionId: "session-1" });
    const files = updateWorkspacePanel(launcher, { type: "select-surface", surfaceId: "files" });
    expect(launcher).toMatchObject({ open: true, activeSurfaceId: null });
    expect(files.activeSurfaceId).toBe("files");
    expect(files.openSurfaceIds).toEqual(["files"]);
    const withTerminal = updateWorkspacePanel(files, { type: "select-surface", surfaceId: "terminal" });
    expect(withTerminal.openSurfaceIds).toEqual(["files", "terminal"]);
    expect(updateWorkspacePanel(withTerminal, { type: "open-surface-picker" }).activeSurfaceId).toBeNull();
    expect(updateWorkspacePanel(withTerminal, { type: "close-surface", surfaceId: "terminal" }).activeSurfaceId).toBe("files");
    expect(updateWorkspacePanel(files, { type: "session-changed", sessionId: "session-2" })).toMatchObject({ sessionId: "session-2", open: false, activeSurfaceId: null, openSurfaceIds: [] });
  });

  it("closes an active tab to its displayed right neighbor before its left neighbor", () => {
    let state = updateWorkspacePanel(initialWorkspacePanelState(), { type: "select-surface", surfaceId: "terminal" });
    state = updateWorkspacePanel(state, { type: "select-surface", surfaceId: "files" });
    state = updateWorkspacePanel(state, { type: "select-surface", surfaceId: "side-chat" });

    expect(state.openSurfaceIds).toEqual(["terminal", "files", "side-chat"]);
    const closed = updateWorkspacePanel(state, { type: "close-surface", surfaceId: "terminal" });
    expect(closed.openSurfaceIds).toEqual(["files", "side-chat"]);
    expect(closed.activeSurfaceId).toBe("side-chat");
  });

  it("clamps pointer and keyboard resize without turning the panel into maximized mode", () => {
    const state = { ...initialWorkspacePanelState(), open: true };
    const tooWide = updateWorkspacePanel(state, { type: "resize", width: 2_000, workspaceWidth: 1_200 });
    expect(tooWide).toMatchObject({ dockedWidth: MAX_WORKSPACE_PANEL_WIDTH, maximized: false });
    expect(updateWorkspacePanel(tooWide, { type: "resize-key", key: "Home", workspaceWidth: 1_200 })).toMatchObject({
      dockedWidth: MIN_WORKSPACE_PANEL_WIDTH,
      maximized: false,
    });
    expect(updateWorkspacePanel(state, { type: "resize-key", key: "Escape", workspaceWidth: 1_200 })).toBe(state);
  });

  it("auto-collapses below the minimum and restores the last valid width on reopen", () => {
    const state = { ...initialWorkspacePanelState(510, "session-1"), open: true };
    const collapsed = updateWorkspacePanel(state, { type: "resize", width: 120, workspaceWidth: 1_200 });
    expect(collapsed).toMatchObject({ open: false, dockedWidth: 510 });
    expect(updateWorkspacePanel(collapsed, { type: "toggle", sessionId: "session-1" })).toMatchObject({ open: true, dockedWidth: 510 });
  });

  it("maximizes explicitly and restores the remembered docked width", () => {
    const docked = { ...initialWorkspacePanelState(536), open: true };
    const maximized = updateWorkspacePanel(docked, { type: "toggle-maximize" });
    expect(maximized).toMatchObject({ open: true, maximized: true, dockedWidth: 536 });
    expect(workspacePanelGeometry(maximized, 1_440, 300, false).renderedWidth).toBe(1_140);
    expect(updateWorkspacePanel(maximized, { type: "toggle-maximize" })).toEqual(docked);
  });

  it("uses all viewport width when the dynamic sidebar is collapsed", () => {
    expect(workspaceWidthForLayout(1_440, 348, false)).toBe(1_092);
    expect(workspaceWidthForLayout(1_440, 348, true)).toBe(1_440);
    const maximized = { ...initialWorkspacePanelState(), open: true, maximized: true };
    expect(workspacePanelGeometry(maximized, 1_440, 348, true).renderedWidth).toBe(1_440);
  });

  it("shrinks its docked bounds with the viewport while preserving valid geometry", () => {
    const state = { ...initialWorkspacePanelState(600), open: true };
    const geometry = workspacePanelGeometry(state, 700, 252, false);
    expect(geometry.renderedWidth).toBeLessThan(MIN_WORKSPACE_PANEL_WIDTH);
    expect(geometry.renderedWidth).toBe(geometry.maximumDockedWidth);
    expect(geometry.workspaceWidth - geometry.renderedWidth).toBeGreaterThan(0);
  });
});

describe("workspace surface provider contract", () => {
  it("exposes ready Files and Terminal while Side chat remains unavailable", () => {
    const surfaces = localWorkspaceSurfaceProvider.getSurfaces({ sessionId: "session-1", project: { id: "project-1", name: "Atlas", path: "/work/atlas" } });
    expect(localWorkspaceSurfaceProvider.kind).toBe("local");
    expect(surfaces.map(({ id, availability }) => ({ id, availability }))).toEqual([
      { id: "files", availability: "ready" },
      { id: "terminal", availability: "ready" },
      { id: "side-chat", availability: "not-ready" },
    ]);
    expect(surfaces[0]?.emptyDescription).toContain("Read-only files");
    expect(surfaces[1]?.emptyDescription).toContain("local shell scoped to this session");
    expect(surfaces[2]?.emptyTitle).toBe("Not connected");
  });

  it("keeps tab selection in the pure panel state", () => {
    expect(updateWorkspacePanel(initialWorkspacePanelState(), { type: "select-surface", surfaceId: "terminal" }).activeSurfaceId).toBe("terminal");
  });

  it("keeps every tab control target mounted with one active, visible panel", () => {
    const surfaces = localWorkspaceSurfaceProvider.getSurfaces({ sessionId: null, project: null });
    const presentations = workspaceSurfacePresentations(surfaces, "terminal");
    const mountedPanelIds = new Set(presentations.map(({ panelId }) => panelId));

    expect(presentations.every(({ tabControls }) => mountedPanelIds.has(tabControls))).toBe(true);
    expect(presentations.every(({ tabId, panelLabelledBy }) => tabId === panelLabelledBy)).toBe(true);
    expect(presentations.map(({ surface, tabControls, active, hidden }) => ({ id: surface.id, tabControls, active, hidden }))).toEqual([
      { id: "files", tabControls: "workspace-panel-surface-files", active: false, hidden: true },
      { id: "terminal", tabControls: "workspace-panel-surface-terminal", active: true, hidden: false },
      { id: "side-chat", tabControls: "workspace-panel-surface-side-chat", active: false, hidden: true },
    ]);
  });

  it("keeps every real surface dormant while the launcher is active", () => {
    const presentations = workspaceSurfacePresentations(localWorkspaceSurfaceProvider.getSurfaces({ sessionId: "session-1", project: null }), null);
    expect(presentations.every(({ active, hidden }) => !active && hidden)).toBe(true);
  });
});
