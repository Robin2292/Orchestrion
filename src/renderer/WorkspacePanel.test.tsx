// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePanel } from "./WorkspacePanel";
import {
  initialWorkspacePanelState,
  updateWorkspacePanel,
  workspacePanelGeometry,
  workspacePanelStateForSession,
  type WorkspacePanelState,
} from "./workspace-panel-state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write(_data: string, callback?: () => void) { callback?.(); }
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

class TestResizeObserver {
  observe() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => undefined });

const sessionPanelState = initialWorkspacePanelState(440, "session-1");
const geometry = workspacePanelGeometry({ ...sessionPanelState, open: true }, 1_440, 252, false);
const context = { sessionId: "session-1", project: { id: "project-1", name: "Atlas", path: "/work/atlas" } };
const api = { listWorkspaceDirectory: async () => ({ path: "", entries: [], truncated: false }) };
const dispatch = () => undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("WorkspacePanel", () => {
  it("opens on a centered picker without a duplicate header or close control", () => {
    const markup = renderToStaticMarkup(<WorkspacePanel
      state={{ ...sessionPanelState, open: true }}
      geometry={geometry}
      context={context}
      api={api}
      dispatch={dispatch}
    />);

    expect(markup).toContain("Files");
    expect(markup).toContain("Terminal");
    expect(markup).toContain("Side chat");
    expect(markup).toContain("workspace-surface-picker");
    expect(markup).not.toContain("workspace-launcher");
    expect(markup).not.toContain("Workspace tools");
    expect(markup).not.toContain("Open a surface");
    expect(markup).not.toContain("Keep the tools");
    expect(markup).toContain("workspace-surface-picker-options");
    expect(markup).not.toContain("workspace-panel-header");
    expect(markup).not.toContain("Close workspace panel");
    expect(markup).not.toContain("Local project");
  });

  it("shows not-connected state inside the selected unavailable surface", () => {
    const markup = renderToStaticMarkup(<WorkspacePanel
      state={{ ...sessionPanelState, open: true, activeSurfaceId: "terminal" }}
      geometry={geometry}
      context={context}
      api={api}
      dispatch={dispatch}
    />);

    expect(markup).toContain("workspace-surface-tabs");
    expect(markup).toContain("Not connected");
    expect(markup).not.toContain("No PTY or command execution");
  });

  it("reveals the real Files surface only for a connected saved session", () => {
    const connected = renderToStaticMarkup(<WorkspacePanel
      state={{ ...sessionPanelState, open: true, activeSurfaceId: "files" }}
      geometry={geometry}
      context={context}
      api={api}
      dispatch={dispatch}
    />);
    expect(connected).toContain("workspace-surface-tabs");
    expect(connected).toContain('aria-label="Atlas project files"');
    expect(connected).not.toContain("/work/atlas");

    const disconnected = renderToStaticMarkup(<WorkspacePanel
      state={{ ...initialWorkspacePanelState(440, null), open: true, activeSurfaceId: "files" }}
      geometry={geometry}
      context={{ sessionId: null, project: null }}
      api={api}
      dispatch={dispatch}
    />);
    expect(disconnected).toContain("workspace-surface-tabs");
    expect(disconnected).toContain("Not connected");
    expect(disconnected).toContain("Select a saved session to browse");

    const disconnectedDom = document.createElement("div");
    disconnectedDom.innerHTML = disconnected;
    const ids = [...disconnectedDom.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    const disconnectedTab = disconnectedDom.querySelector<HTMLElement>("#workspace-panel-tab-files");
    expect(disconnectedTab?.getAttribute("aria-controls")).toBe("workspace-panel-surface-files");
    expect(disconnectedDom.querySelector("#workspace-panel-surface-files")?.getAttribute("role")).toBe("tabpanel");
    expect(disconnectedDom.querySelector("#workspace-panel-surface-files")?.classList.contains("workspace-side-chat-placeholder")).toBe(false);
  });

  it("opens surfaces from the centered picker, keeps tabs visible, and closes to a neighbor", async () => {
    let state: WorkspacePanelState = { ...sessionPanelState, open: true };
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = () => root.render(<WorkspacePanel state={state} geometry={geometry} context={context} api={api} dispatch={(action) => { state = updateWorkspacePanel(state, action); render(); }} />);
    await act(async () => { render(); });
    expect(container.querySelector(".workspace-surface-picker")).not.toBeNull();
    expect(container.querySelector(".workspace-launcher")).toBeNull();

    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>(".workspace-surface-picker-options button")].find((button) => button.textContent?.includes("Files"))?.click(); });
    expect(container.querySelector(".workspace-surface-picker")).toBeNull();
    expect(container.querySelector(".workspace-surface-tab-button")?.textContent).toContain("Files");
    expect(container.querySelector(".workspace-surface-tabs")?.getAttribute("role")).toBeNull();
    expect(container.querySelector(".workspace-surface-tablist")?.getAttribute("role")).toBe("tablist");
    expect(container.querySelectorAll(".workspace-surface-tablist [role='tab']")).toHaveLength(1);
    expect(container.querySelector(".workspace-surface-tablist [aria-label='Open workspace surface picker']")).toBeNull();
    expect(container.querySelector(".workspace-surface-tablist")?.nextElementSibling?.classList.contains("workspace-surface-tab-add")).toBe(true);
    expect(container.querySelector("#workspace-panel-tab-files")?.getAttribute("role")).toBe("tab");
    expect(container.querySelector("#workspace-panel-tab-files")?.getAttribute("aria-controls")).toBe("workspace-panel-surface-files");
    expect(container.querySelector("#workspace-panel-surface-files")?.getAttribute("role")).toBe("tabpanel");
    expect(container.querySelector("#workspace-panel-surface-files")?.getAttribute("aria-labelledby")).toBe("workspace-panel-tab-files");
    expect(container.querySelector("#workspace-panel-tab-files")?.getAttribute("tabindex")).toBe("0");
    expect(container.querySelector("[aria-label='Open workspace surface picker']")).not.toBeNull();
    expect(container.querySelector(".workspace-launcher")).toBeNull();

    await act(async () => { container.querySelector<HTMLButtonElement>(".workspace-surface-tab-add")?.click(); });
    expect(container.querySelector(".workspace-surface-picker")).not.toBeNull();
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>(".workspace-surface-picker-options button")].find((button) => button.textContent?.includes("Terminal"))?.click(); });
    expect(container.querySelectorAll(".workspace-surface-tab")).toHaveLength(2);
    expect(container.querySelector("#workspace-panel-tab-files")?.getAttribute("tabindex")).toBe("-1");
    expect(container.querySelector("#workspace-panel-tab-terminal")?.getAttribute("tabindex")).toBe("0");

    await act(async () => { container.querySelector<HTMLButtonElement>("#workspace-panel-tab-files")?.click(); });
    expect(container.querySelector("#workspace-panel-surface-files")?.hasAttribute("hidden")).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>("#workspace-panel-tab-files")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(state.activeSurfaceId).toBe("terminal");
    expect(document.activeElement?.id).toBe("workspace-panel-tab-terminal");
    await act(async () => { container.querySelector<HTMLButtonElement>("#workspace-panel-tab-terminal")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(state.activeSurfaceId).toBe("files");
    expect(document.activeElement?.id).toBe("workspace-panel-tab-files");
    await act(async () => { container.querySelector<HTMLButtonElement>("#workspace-panel-tab-files")?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(state.activeSurfaceId).toBe("terminal");
    expect(document.activeElement?.id).toBe("workspace-panel-tab-terminal");
    await act(async () => { container.querySelector<HTMLButtonElement>("#workspace-panel-tab-terminal")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(state.activeSurfaceId).toBe("files");
    expect(document.activeElement?.id).toBe("workspace-panel-tab-files");
    await act(async () => { container.querySelector<HTMLButtonElement>("[aria-label='Close Files']")?.click(); });
    expect(container.querySelector("#workspace-panel-tab-terminal")).not.toBeNull();
    expect(document.activeElement?.id).toBe("workspace-panel-tab-terminal");
    expect(container.querySelector(".workspace-side-chat-placeholder")?.textContent).toContain("Not connected");

    await act(async () => { container.querySelector<HTMLButtonElement>(".workspace-surface-tab-add")?.click(); });
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>(".workspace-surface-picker-options button")].find((button) => button.textContent?.includes("Side chat"))?.click(); });
    expect(container.querySelector(".workspace-side-chat-placeholder")?.textContent).toContain("Side chat is not available");
    expect(container.querySelector("#workspace-panel-surface-side-chat")?.getAttribute("role")).toBe("tabpanel");
    expect(container.querySelector("#workspace-panel-surface-side-chat")?.getAttribute("aria-labelledby")).toBe("workspace-panel-tab-side-chat");
    await act(async () => { container.querySelector<HTMLButtonElement>("[aria-label='Close Side chat']")?.click(); });
    expect(container.querySelector("#workspace-panel-tab-terminal")).not.toBeNull();
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("closes a reverse-opened active tab to the displayed right neighbor", async () => {
    let state: WorkspacePanelState = {
      ...sessionPanelState,
      open: true,
      activeSurfaceId: "terminal",
      openSurfaceIds: ["terminal", "files", "side-chat"],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = () => root.render(<WorkspacePanel state={state} geometry={geometry} context={context} api={api} dispatch={(action) => { state = updateWorkspacePanel(state, action); render(); }} />);
    await act(async () => { render(); });

    await act(async () => { container.querySelector<HTMLButtonElement>("[aria-label='Close Terminal']")?.click(); });
    expect(state.activeSurfaceId).toBe("side-chat");
    expect(container.querySelector("#workspace-panel-tab-side-chat")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#workspace-panel-surface-side-chat")?.textContent).toContain("Not connected");
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("keeps picker-mode close focus sensible and ignores Arrow keys on a single tab", async () => {
    let state: WorkspacePanelState = {
      ...sessionPanelState,
      open: true,
      activeSurfaceId: null,
      openSurfaceIds: ["files"],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = () => root.render(<WorkspacePanel state={state} geometry={geometry} context={context} api={api} dispatch={(action) => { state = updateWorkspacePanel(state, action); render(); }} />);
    await act(async () => { render(); });

    await act(async () => { container.querySelector<HTMLButtonElement>("#workspace-panel-tab-files")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(state.activeSurfaceId).toBeNull();
    expect(container.querySelector(".workspace-surface-picker")).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>(".workspace-surface-tab-add")?.click(); });
    expect(state.activeSurfaceId).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>("[aria-label='Close Files']")?.click(); });
    expect(state.openSurfaceIds).toEqual([]);
    expect(state.activeSurfaceId).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open workspace surface picker");

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("keeps the Files child mounted across a connected to null context transition", async () => {
    let state: WorkspacePanelState = { ...sessionPanelState, open: true, activeSurfaceId: "files", openSurfaceIds: ["files"] };
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = (sessionId: string | null, project: typeof context.project | null) => root.render(<WorkspacePanel state={state} geometry={geometry} context={{ sessionId, project }} api={api} dispatch={(action) => { state = updateWorkspacePanel(state, action); }} />);

    await act(async () => { render(context.sessionId, context.project); });
    const section = container.querySelector<HTMLElement>("#workspace-panel-surface-files");
    const filesChild = section?.firstElementChild;
    expect(section).not.toBeNull();
    expect(filesChild?.classList.contains("workspace-files")).toBe(true);
    expect(section?.hasAttribute("hidden")).toBe(false);

    state = { ...state, sessionId: null, open: false, activeSurfaceId: null, openSurfaceIds: [] };
    await act(async () => { render(null, null); });
    expect(container.querySelectorAll("#workspace-panel-surface-files")).toHaveLength(1);
    expect(container.querySelector("#workspace-panel-surface-files")).toBe(section);
    expect(container.querySelector("#workspace-panel-surface-files")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector("#workspace-panel-surface-files")?.firstElementChild).toBe(filesChild);
    expect(container.querySelector("#workspace-panel-surface-files")?.textContent).toContain("Not connected");
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("shows saved Files as Not connected when the directory bridge is missing, then recovers in place", async () => {
    let state: WorkspacePanelState = { ...sessionPanelState, open: true, activeSurfaceId: "files", openSurfaceIds: ["files"] };
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    const render = (panelApi: typeof api | Record<string, never>) => root.render(<WorkspacePanel state={state} geometry={geometry} context={context} api={panelApi} dispatch={(action) => { state = updateWorkspacePanel(state, action); }} />);

    await act(async () => { render({}); });
    const section = container.querySelector<HTMLElement>("#workspace-panel-surface-files");
    const filesChild = section?.firstElementChild;
    expect(section?.hasAttribute("hidden")).toBe(false);
    expect(filesChild?.textContent).toContain("Not connected");

    await act(async () => { render(api); });
    expect(container.querySelector("#workspace-panel-surface-files")).toBe(section);
    expect(container.querySelector("#workspace-panel-surface-files")?.firstElementChild).toBe(filesChild);
    expect(container.querySelector("#workspace-panel-surface-files")?.firstElementChild?.classList.contains("workspace-files")).toBe(true);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("does not list a newly selected session until its panel and Files surface are explicitly opened", async () => {
    const calls: Array<{ sessionId: string; relativePath: string }> = [];
    const sessionOneFile = { name: "session-one.txt", path: "session-one.txt", kind: "file" as const, symbolicLink: false, accessible: true };
    const sessionTwoFile = { name: "session-two.txt", path: "session-two.txt", kind: "file" as const, symbolicLink: false, accessible: true };
    const mountedApi = {
      listWorkspaceDirectory: async (input: { sessionId: string; relativePath: string }) => {
        calls.push(input);
        return { path: input.relativePath, entries: input.sessionId === "session-2" ? [sessionTwoFile] : [sessionOneFile], truncated: false };
      },
    };
    const panel = (state: WorkspacePanelState, sessionId: string) => <WorkspacePanel
      state={workspacePanelStateForSession(state, sessionId)}
      geometry={geometry}
      context={{ sessionId, project: { id: `project-${sessionId}`, name: sessionId, path: `/work/${sessionId}` } }}
      api={mountedApi}
      dispatch={dispatch}
    />;

    let state = initialWorkspacePanelState(440, "session-1");
    state = updateWorkspacePanel(state, { type: "toggle", sessionId: "session-1" });
    state = updateWorkspacePanel(state, { type: "select-surface", surfaceId: "files" });
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    await act(async () => { root.render(panel(state, "session-1")); });
    expect(calls).toEqual([{ sessionId: "session-1", relativePath: "" }]);

    // This is the render that previously mounted Files for session-2 before App's layout reset ran.
    await act(async () => { root.render(panel(state, "session-2")); });
    expect(calls).toHaveLength(1);

    state = updateWorkspacePanel(state, { type: "session-changed", sessionId: "session-2" });
    await act(async () => { root.render(panel(state, "session-2")); });
    state = updateWorkspacePanel(state, { type: "toggle", sessionId: "session-2" });
    await act(async () => { root.render(panel(state, "session-2")); });
    expect(calls).toHaveLength(1);

    state = updateWorkspacePanel(state, { type: "select-surface", surfaceId: "files" });
    await act(async () => { root.render(panel(state, "session-2")); });
    expect(calls).toEqual([
      { sessionId: "session-1", relativePath: "" },
      { sessionId: "session-2", relativePath: "" },
    ]);
    expect(container.querySelector(".workspace-file-row.file")?.textContent).toContain("session-two.txt");

    const disconnectedState = workspacePanelStateForSession(state, null);
    await act(async () => { root.render(<WorkspacePanel state={disconnectedState} geometry={geometry} context={{ sessionId: null, project: null }} api={mountedApi} dispatch={dispatch} />); });
    expect(calls).toHaveLength(2);
    await act(async () => { root.render(panel(state, "session-2")); });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ sessionId: "session-2", relativePath: "" });
    expect(container.querySelector(".workspace-file-row.file")?.textContent).toContain("session-two.txt");
    await act(async () => { root.unmount(); });
  });

  it("creates a PTY only when Terminal is explicitly selected and cleans it up when leaving", async () => {
    const createTerminal = vi.fn(async (input: { sessionId: string; columns: number; rows: number }) => ({ terminalId: "terminal-1", sessionId: input.sessionId }));
    const closeTerminal = vi.fn(async () => undefined);
    const closeSessionTerminals = vi.fn(async () => undefined);
    const unsubscribe = vi.fn();
    const terminalApi = {
      ...api,
      createTerminal,
      sendTerminalInput: vi.fn(async () => undefined),
      acknowledgeTerminalOutput: vi.fn(async () => undefined),
      resizeTerminal: vi.fn(async () => undefined),
      closeTerminal,
      closeSessionTerminals,
      onTerminalEvent: vi.fn(() => unsubscribe),
    };
    const panel = (state: WorkspacePanelState) => <WorkspacePanel
      state={state}
      geometry={geometry}
      context={context}
      api={terminalApi}
      dispatch={dispatch}
    />;
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    const launcherState = { ...sessionPanelState, open: true };

    await act(async () => { root.render(panel(launcherState)); });
    expect(createTerminal).not.toHaveBeenCalled();

    await act(async () => { root.render(panel({ ...launcherState, activeSurfaceId: "terminal" })); });
    expect(createTerminal).toHaveBeenCalledOnce();
    expect(createTerminal).toHaveBeenCalledWith({ sessionId: "session-1", columns: 80, rows: 24 });

    await act(async () => { root.render(panel({ ...launcherState, activeSurfaceId: "terminal" })); });
    expect(createTerminal).toHaveBeenCalledOnce();
    expect(closeTerminal).not.toHaveBeenCalled();

    await act(async () => { root.render(panel({ ...launcherState, activeSurfaceId: "files" })); });
    expect(closeSessionTerminals).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(closeTerminal).toHaveBeenCalledWith({ terminalId: "terminal-1", sessionId: "session-1" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => { root.unmount(); });
  });

  it("cancels deferred creation immediately, ignores its stale resolution, and requires an explicit Terminal reopen", async () => {
    const first = deferred<{ terminalId: string; sessionId: string }>();
    const second = deferred<{ terminalId: string; sessionId: string }>();
    const createTerminal = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const closeTerminal = vi.fn(async () => undefined);
    const closeSessionTerminals = vi.fn(async () => undefined);
    const terminalApi = {
      ...api,
      createTerminal,
      sendTerminalInput: vi.fn(async () => undefined),
      acknowledgeTerminalOutput: vi.fn(async () => undefined),
      resizeTerminal: vi.fn(async () => undefined),
      closeTerminal,
      closeSessionTerminals,
      onTerminalEvent: vi.fn(() => vi.fn()),
    };
    const panel = (state: WorkspacePanelState, sessionId = "session-1") => <WorkspacePanel
      state={workspacePanelStateForSession(state, sessionId)}
      geometry={geometry}
      context={{ sessionId, project: { id: "same-project", name: "Atlas", path: "/work/atlas" } }}
      api={terminalApi}
      dispatch={dispatch}
    />;
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    const terminalState = { ...sessionPanelState, open: true, activeSurfaceId: "terminal" as const };

    await act(async () => { root.render(panel(terminalState)); });
    expect(createTerminal).toHaveBeenCalledOnce();
    await act(async () => { root.render(panel({ ...terminalState, open: false, activeSurfaceId: null })); });
    expect(closeSessionTerminals).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(closeTerminal).not.toHaveBeenCalled();

    await act(async () => { root.render(panel({ ...terminalState, activeSurfaceId: null })); });
    expect(createTerminal).toHaveBeenCalledOnce();
    await act(async () => { root.render(panel(terminalState)); });
    expect(createTerminal).toHaveBeenCalledTimes(2);

    await act(async () => { first.resolve({ terminalId: "stale-terminal", sessionId: "session-1" }); await first.promise; });
    expect(closeTerminal).toHaveBeenCalledWith({ terminalId: "stale-terminal", sessionId: "session-1" });
    second.resolve({ terminalId: "fresh-terminal", sessionId: "session-1" });
    await act(async () => { await second.promise; });

    await act(async () => { root.render(panel(terminalState, "session-2")); });
    expect(closeSessionTerminals).toHaveBeenLastCalledWith({ sessionId: "session-1" });
    expect(createTerminal).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[aria-label='Terminal']")).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
