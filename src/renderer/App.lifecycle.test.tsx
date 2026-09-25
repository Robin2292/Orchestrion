// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_BRIDGE_VERSION, type DesktopSnapshot, type OrchestrionDesktopApi, type UpdaterBridgeApi, type UpdaterState } from "../shared/contracts";
import { GOVERNED_SESSION_NOT_READY_MESSAGE } from "../shared/session-tree-contracts";
import App from "./App";

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

const snapshot: DesktopSnapshot = {
  appServer: { status: "ready", codexVersion: "0.154.0", diagnostic: null },
  projects: [{ id: "project-1", name: "Atlas", path: "/work/atlas", createdAt: "2026-01-01T00:00:00.000Z" }],
  agents: [{ id: "agent-1", projectId: "project-1", name: "Builder", instructions: "", createdAt: "2026-01-01T00:00:00.000Z" }],
  sessions: [
    { id: "session-1", agentId: "agent-1", title: "First session", threadId: "thread-1", model: null, modelProvider: null, reasoningEffort: null, titleSource: "codex", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "session-2", agentId: "agent-1", title: "Second session", threadId: null, model: null, modelProvider: null, reasoningEffort: null, titleSource: "provisional", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  ],
  runtimes: {
    "session-1": { status: "idle", activeTurnId: null, messages: [], pendingRequests: [], error: null },
    "session-2": { status: "idle", activeTurnId: null, messages: [], pendingRequests: [], error: null },
  },
};

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "#/");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

async function mountDirtyFileApp(draft = "unsaved draft", withDirect = false, updaterBridge?: UpdaterBridgeApi) {
  window.history.replaceState({}, "", "#/projects/project-1/agents/agent-1/sessions/session-1");
  const file = { name: "notes.txt", path: "notes.txt", kind: "file" as const, symbolicLink: false, accessible: true };
  const api = {
    bridgeInfo: { version: DESKTOP_BRIDGE_VERSION, capabilities: { workspaceFiles: { read: true, save: true, open: true } } },
    bootstrap: vi.fn(async () => structuredClone(snapshot)),
    listModels: vi.fn(async () => []),
    getWindowState: vi.fn(async () => ({ isFullScreen: false })),
    onWindowState: vi.fn(() => vi.fn()),
    onEvent: vi.fn(() => vi.fn()),
    updaterBridge,
    loadAttachmentPreviews: vi.fn(async () => ({})),
    localAgents: withDirect ? { snapshot: vi.fn(async()=>({workspace:{projectId:"project-1",agents:[]}})) } : undefined,
    listWorkspaceDirectory: vi.fn(async () => ({ path: "", entries: [file], truncated: false })),
    readWorkspaceFile: vi.fn(async () => ({ path: file.path, name: file.name, kind: "text" as const, mimeType: "text/plain", size: 4, editable: true, status: "ready" as const, revision: "r1", content: { type: "text" as const, text: "base" } })),
    saveWorkspaceFile: vi.fn(async () => ({ path: file.path, size: 4, revision: "r2", modifiedAt: "2026-01-01T00:00:00.000Z" })),
    openWorkspaceFile: vi.fn(async ({ destination }) => ({ destination })),
  } as unknown as OrchestrionDesktopApi;
  Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Show workspace panel']")!.click());
  const filesLauncher = [...container.querySelectorAll<HTMLButtonElement>(".workspace-surface-picker-options button")]
    .find((button) => button.textContent?.includes("Files"))!;
  await act(async () => { filesLauncher.click(); await Promise.resolve(); });
  await act(async () => { container.querySelector<HTMLButtonElement>("button.workspace-file-row.file")!.click(); await Promise.resolve(); await Promise.resolve(); });
  const textarea = container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, draft);
  await act(async () => { textarea.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function pointerClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    if (target.matches("button, a, input, textarea, select, [tabindex]")) target.focus();
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
  });
}

function dispatchFileDrag(target: HTMLElement, type: "dragenter" | "dragover" | "drop", files: readonly File[]) {
  const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return { event, dataTransfer };
}

describe("App session lifecycle", () => {
  it("keeps unsaved files on cancelled update restart and clears the unload guard before confirmed restart", async () => {
    const ready: UpdaterState = { phase: "ready", currentVersion: "0.1.0", availableVersion: "0.2.0", progressPercent: 100, changelog: [], error: null };
    const quitAndInstall = vi.fn(async () => {
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
    });
    const updaterBridge: UpdaterBridgeApi = {
      getState: vi.fn(async () => ready),
      onState: vi.fn(() => () => undefined),
      check: vi.fn(async () => ready),
      download: vi.fn(async () => ready),
      quitAndInstall,
    };
    const container = await mountDirtyFileApp("keep this edit", false, updaterBridge);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const trigger = container.querySelector<HTMLButtonElement>(".update-entry-trigger")!;
    await act(async () => trigger.click());
    const restart = () => [...container.querySelectorAll<HTMLButtonElement>("#update-entry-popover button")]
      .find((button) => button.textContent === "Restart to update")!;

    await act(async () => restart().click());
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe("keep this edit");
    const blockedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(blockedUnload);
    expect(blockedUnload.defaultPrevented).toBe(true);

    await act(async () => { restart().click(); await Promise.resolve(); });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe("base");
    expect(quitAndInstall).toHaveBeenCalledOnce();
    container.remove();
  });

  it("guards the top-right Direct New Session route when Files has unsaved edits", async () => {
    const container=await mountDirtyFileApp("keep this edit",true);
    const create=container.querySelector<HTMLButtonElement>(".direct-topbar-create")!;
    expect(create?.textContent).toContain("New Session");
    await act(async()=>create.click());
    expect(container.querySelector("[role='alertdialog']")).not.toBeNull();
    expect(window.location.hash).toContain("sessions/session-1");
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe("keep this edit");
    await act(async()=>container.querySelector<HTMLButtonElement>("[role='alertdialog'] .secondary-button")!.click());
    expect(container.querySelector("[role='alertdialog']")).toBeNull();
    expect(window.location.hash).toContain("sessions/session-1");
    container.remove();
  });
  it("keeps each session's context window display when switching away and back", async () => {
    window.history.replaceState({}, "", "#/projects/project-1/agents/agent-1/sessions/session-1");
    const withUsage = structuredClone(snapshot);
    withUsage.runtimes["session-1"].contextWindowUsage = { turnId: "turn-1", usedTokens: 140_000, contextWindowTokens: 1_000_000 };
    withUsage.runtimes["session-2"].contextWindowUsage = { turnId: "turn-2", usedTokens: 72_000, contextWindowTokens: 258_400 };
    const api = {
      bootstrap: vi.fn(async () => withUsage), listModels: vi.fn(async () => []),
      getWindowState: vi.fn(async () => ({ isFullScreen: false })), onWindowState: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()), loadAttachmentPreviews: vi.fn(async () => ({})),
    } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector('[aria-label="Context window: 140k of 1M, 14%"]')).not.toBeNull();
    const second = [...container.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((button) => button.textContent?.includes("Second session"))!;
    await act(async () => second.click());
    expect(container.querySelector('[aria-label="Context window: 72k of 258k, 28%"]')).not.toBeNull();
    const first = [...container.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((button) => button.textContent?.includes("First session"))!;
    await act(async () => first.click());
    expect(container.querySelector('[aria-label="Context window: 140k of 1M, 14%"]')).not.toBeNull();
    container.remove();
  });

  it("accepts dropped media from the whole active session surface", async () => {
    window.history.replaceState({}, "", "#/projects/project-1/agents/agent-1/sessions/session-1");
    const image = { id: "image-1", path: "/tmp/reference.png", name: "reference.png", kind: "image" as const, mimeType: "image/png", size: 12, previewUrl: "data:image/png;base64,AA==" };
    const resolveDroppedAttachments = vi.fn(async () => [image]);
    const api = {
      bootstrap: vi.fn(async () => structuredClone(snapshot)), listModels: vi.fn(async () => []),
      getWindowState: vi.fn(async () => ({ isFullScreen: false })), onWindowState: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()), loadAttachmentPreviews: vi.fn(async () => ({})), resolveDroppedAttachments,
    } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });
    const viewport = container.querySelector<HTMLElement>(".message-viewport")!;
    const file = new File(["image"], "reference.png", { type: "image/png" });

    await act(async () => { dispatchFileDrag(viewport, "dragenter", [file]); });
    expect(container.querySelector(".session-drop-overlay")?.textContent).toContain("Drop files into this session");
    await act(async () => { dispatchFileDrag(viewport, "drop", [file]); await Promise.resolve(); await Promise.resolve(); });

    expect(resolveDroppedAttachments).toHaveBeenCalledExactlyOnceWith([file]);
    expect(container.querySelector(".composer-attachments")?.textContent).toContain("reference.png");
    expect(container.querySelector(".session-drop-overlay")).toBeNull();
    container.remove();
  });

  it("separates product navigation from the project chat tree and restores the last session", async () => {
    window.history.replaceState({}, "", "#/projects/project-1/agents/agent-1/sessions/session-2");
    const api = {
      bootstrap: vi.fn(async () => structuredClone(snapshot)),
      listModels: vi.fn(async () => []),
      getWindowState: vi.fn(async () => ({ isFullScreen: false })),
      onWindowState: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()),
      loadAttachmentPreviews: vi.fn(async () => ({})),
    } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });

    const productNavigation = container.querySelector<HTMLElement>("[aria-label='Product navigation']")!;
    const workspaceSidebar = container.querySelector<HTMLElement>("#workspace-sidebar")!;
    expect(productNavigation).not.toBeNull();
    expect(productNavigation.querySelector("[aria-label='Chats']")?.getAttribute("aria-current")).toBe("page");
    expect(workspaceSidebar.textContent).toContain("Atlas");
    expect(workspaceSidebar.textContent).toContain("Second session");
    expect(workspaceSidebar.querySelector("[aria-label='Primary navigation']")).toBeNull();

    await act(async () => productNavigation.querySelector<HTMLButtonElement>("[aria-label='Inbox']")!.click());
    expect(window.location.hash).toBe("#/projects/project-1/inbox");
    expect(productNavigation.querySelector("[aria-label='Inbox']")?.getAttribute("aria-current")).toBe("page");
    expect(workspaceSidebar.classList.contains("collapsed")).toBe(true);

    await act(async () => productNavigation.querySelector<HTMLButtonElement>("[aria-label='Chats']")!.click());
    expect(window.location.hash).toBe("#/projects/project-1/agents/agent-1/sessions/session-2");
    expect(productNavigation.querySelector("[aria-label='Chats']")?.getAttribute("aria-current")).toBe("page");
    expect(workspaceSidebar.classList.contains("collapsed")).toBe(false);
    container.remove();
  });

  it("keeps the product rail and auto-collapses chat context at the 560px minimum window width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 560 });
    window.history.replaceState({}, "", "#/projects/project-1/agents/agent-1/sessions/session-1");
    const api = {
      bootstrap: vi.fn(async () => structuredClone(snapshot)),
      listModels: vi.fn(async () => []),
      getWindowState: vi.fn(async () => ({ isFullScreen: false })),
      onWindowState: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()),
      loadAttachmentPreviews: vi.fn(async () => ({})),
    } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });

    const shell = container.querySelector<HTMLElement>(".app-shell")!;
    const workspaceSidebar = container.querySelector<HTMLElement>("#workspace-sidebar")!;
    expect(container.querySelector("[aria-label='Product navigation']")).not.toBeNull();
    expect(workspaceSidebar.classList.contains("collapsed")).toBe(true);
    expect(container.querySelector("[aria-label='Show sidebar']")).toBeNull();
    expect(container.querySelector("[aria-label='Resize workspace sidebar']")).toBeNull();
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("0px");
    expect(shell.style.getPropertyValue("--left-navigation-width")).toBe("58px");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 760 });
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(workspaceSidebar.classList.contains("collapsed")).toBe(false);
    expect(container.querySelector("[aria-label='Hide sidebar']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Resize workspace sidebar']")).not.toBeNull();
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("252px");
    expect(shell.style.getPropertyValue("--left-navigation-width")).toBe("310px");
    container.remove();
  });

  it("renders Inbox as one continuous management canvas without duplicate topbar copy", async () => {
    window.history.replaceState({}, "", "#/projects/project-1/inbox");
    const api = {
      bootstrap: vi.fn(async () => structuredClone(snapshot)),
      listModels: vi.fn(async () => []),
      getWindowState: vi.fn(async () => ({ isFullScreen: false })),
      onWindowState: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()),
      loadAttachmentPreviews: vi.fn(async () => ({})),
    } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector(".app-shell")?.classList.contains("streamlined-management-shell")).toBe(true);
    expect(container.querySelector(".topbar-context")).toBeNull();
    expect(container.querySelector(".inbox-host .local-page-heading h1")?.textContent).toBe("Inbox");
    expect(container.querySelector(".inbox-host .local-page-heading .eyebrow")).toBeNull();
    expect(container.querySelector(".inbox-host .local-page-heading p")).toBeNull();
    container.remove();
  });

  it("keeps the exact governed readiness remediation visible and restores the unsent draft", async () => {
    window.history.replaceState({}, "", "#/projects/project-1/agents/agent-1/sessions/session-1");
    const sendMessage = vi.fn().mockRejectedValue(Object.assign(new Error(GOVERNED_SESSION_NOT_READY_MESSAGE), { code: "GOVERNED_SESSION_NOT_READY", retryable: false }));
    const governed = structuredClone(snapshot); governed.sessions[0].executionMode = "governed"; governed.sessions[0].threadId = null;
    const api = { bootstrap: vi.fn(async () => governed), listModels: vi.fn(async () => []), getWindowState: vi.fn(async () => ({ isFullScreen: false })),
      onWindowState: vi.fn(() => vi.fn()), onEvent: vi.fn(() => vi.fn()), loadAttachmentPreviews: vi.fn(async () => ({})), sendMessage } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<App />));
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-input-row textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Read README");
    await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", text: "Read README", attachments: [] });
    expect(container.querySelector(".action-error")?.textContent).toBe(GOVERNED_SESSION_NOT_READY_MESSAGE);
    expect(textarea.value).toBe("Read README");
    expect(container.textContent).not.toContain("OUTCOME_UNKNOWN");
  });
  it("confirms deletion, clears the selected terminal, and selects a sibling without eager workspace activity", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const createTerminal = vi.fn(async (input: { sessionId: string }) => ({ terminalId: "terminal-1", sessionId: input.sessionId }));
    const closeSessionTerminals = vi.fn(async () => undefined);
    const api = {
      bootstrap: vi.fn(async () => structuredClone(snapshot)),
      listModels: vi.fn(async () => []),
      getWindowState: vi.fn(async () => ({ isFullScreen: false })),
      onWindowState: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()),
      loadAttachmentPreviews: vi.fn(async () => ({})),
      listWorkspaceDirectory: vi.fn(async () => ({ path: "", entries: [], truncated: false })),
      createTerminal,
      sendTerminalInput: vi.fn(async () => undefined),
      acknowledgeTerminalOutput: vi.fn(async () => undefined),
      resizeTerminal: vi.fn(async () => undefined),
      closeTerminal: vi.fn(async () => undefined),
      closeSessionTerminals,
      onTerminalEvent: vi.fn(() => vi.fn()),
      deleteSession,
    } as unknown as OrchestrionDesktopApi;
    Object.defineProperty(window, "orchestrion", { configurable: true, value: api });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<App />); await Promise.resolve(); await Promise.resolve(); });

    const showPanel = container.querySelector<HTMLButtonElement>("[aria-label='Show workspace panel']")!;
    await act(async () => showPanel.click());
    const terminalLauncher = [...container.querySelectorAll<HTMLButtonElement>(".workspace-surface-picker-options button")]
      .find((button) => button.textContent?.includes("Terminal"))!;
    await act(async () => terminalLauncher.click());
    expect(createTerminal).toHaveBeenCalledWith({ sessionId: "session-1", columns: 80, rows: 24 });

    const firstSession = [...container.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((button) => button.textContent?.includes("First session"))!;
    await act(async () => { firstSession.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })); });
    const menuDelete = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent?.includes("Delete session"))!;
    await act(async () => menuDelete.click());
    expect(deleteSession).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alertdialog']")?.textContent).toContain("First session");

    const confirm = container.querySelector<HTMLButtonElement>("[role='alertdialog'] .danger-button")!;
    await act(async () => { confirm.click(); await Promise.resolve(); });

    expect(deleteSession).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(closeSessionTerminals).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(container.textContent).not.toContain("First session");
    expect(container.querySelector<HTMLButtonElement>(".session-row.selected")?.textContent).toContain("Second session");
    expect(container.querySelector("#workspace-panel")).toBeNull();
    expect(createTerminal).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it("guards the complete New session transition, traps modal focus, and discards through one beforeunload owner", async () => {
    const container = await mountDirtyFileApp();
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    const preventUnload = vi.spyOn(dirtyUnload, "preventDefault");
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    expect(preventUnload).toHaveBeenCalledOnce();

    const agentRow = container.querySelector<HTMLButtonElement>(".agent-row")!;
    await act(async () => agentRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
    const newSession = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent?.includes("New session"))!;
    newSession.focus();
    await act(async () => newSession.click());
    let dialog = container.querySelector<HTMLDivElement>("[role='alertdialog']")!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Stay here");
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe("unsaved draft");
    expect(container.querySelector<HTMLButtonElement>(".session-row.selected")?.textContent).toContain("First session");
    expect(window.location.hash).toContain("sessions/session-1");

    const leave = dialog.querySelector<HTMLButtonElement>(".danger-button")!;
    leave.focus();
    leave.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    const firstDialogButton = dialog.querySelector<HTMLButtonElement>("button")!;
    expect(document.activeElement).toBe(firstDialogButton);
    firstDialogButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(leave);
    const behindOverlay = container.querySelector<HTMLButtonElement>(".tree-action.primary")!;
    behindOverlay.focus();
    expect(document.activeElement?.textContent).toBe("Stay here");

    await act(async () => { dialog.querySelector<HTMLButtonElement>(".secondary-button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(container.querySelector("[role='alertdialog']")).toBeNull();
    expect(document.activeElement).toBe(newSession);
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe("unsaved draft");
    expect(window.location.hash).toContain("sessions/session-1");

    await act(async () => newSession.click());
    dialog = container.querySelector<HTMLDivElement>("[role='alertdialog']")!;
    await act(async () => { dialog.querySelector<HTMLButtonElement>(".danger-button")!.click(); await Promise.resolve(); });
    expect(container.querySelector("[role='alertdialog']")).toBeNull();
    expect(container.querySelector(".welcome-state")?.textContent).toContain("New session");
    expect(container.querySelector("[aria-label='Edit notes.txt']")).toBeNull();
    expect(window.location.hash).toBe("#/");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    container.remove();
  });

  it.each([
    {
      scope: "Project",
      row: ".project-row",
      item: "Project overview",
      route: "#/projects/project-1/settings/overview",
      host: "Atlas project settings",
    },
    {
      scope: "Project advanced",
      row: ".project-row",
      item: "Advanced settings",
      route: "#/projects/project-1/settings/capabilities",
      host: "Atlas project settings",
    },
    {
      scope: "Agent",
      row: ".agent-row",
      item: "Agent profile",
      route: "#/projects/project-1/agents/agent-1/settings/profile",
      host: "Builder agent settings",
    },
    {
      scope: "Agent capabilities",
      row: ".agent-row",
      item: "Capabilities",
      route: "#/projects/project-1/agents/agent-1/settings/capabilities",
      host: "Builder agent settings",
    },
  ])("keeps the guarded $scope menu invoker through pointer cancel or confirmed navigation", async ({ row, item, route, host }) => {
    const container = await mountDirtyFileApp(`${item} draft`);
    const treeRow = container.querySelector<HTMLButtonElement>(row)!;
    await act(async () => treeRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
    const menuItem = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((button) => button.textContent?.includes(item))!;
    await pointerClick(menuItem);

    let dialog = container.querySelector<HTMLDivElement>("[role='alertdialog']")!;
    expect(dialog).not.toBeNull();
    expect(container.querySelector("[role='menu']")).not.toBeNull();
    expect(window.location.hash).toContain("sessions/session-1");
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe(`${item} draft`);
    await pointerClick(dialog.querySelector<HTMLButtonElement>(".secondary-button")!);

    expect(container.querySelector("[role='alertdialog']")).toBeNull();
    expect(container.querySelector("[role='menu']")).not.toBeNull();
    expect(document.activeElement).toBe(menuItem);
    expect(window.location.hash).toContain("sessions/session-1");
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe(`${item} draft`);

    await pointerClick(menuItem);
    dialog = container.querySelector<HTMLDivElement>("[role='alertdialog']")!;
    await pointerClick(container.querySelector<HTMLDivElement>("[data-unsaved-navigation-guard]")!);
    expect(container.querySelector("[role='alertdialog']")).toBeNull();
    expect(container.querySelector("[role='menu']")).not.toBeNull();
    expect(document.activeElement).toBe(menuItem);
    expect(window.location.hash).toContain("sessions/session-1");
    expect(container.querySelector<HTMLTextAreaElement>("[aria-label='Edit notes.txt']")?.value).toBe(`${item} draft`);

    await pointerClick(menuItem);
    dialog = container.querySelector<HTMLDivElement>("[role='alertdialog']")!;
    await pointerClick(dialog.querySelector<HTMLButtonElement>(".danger-button")!);
    expect(container.querySelector("[role='alertdialog']")).toBeNull();
    expect(container.querySelector("[role='menu']")).toBeNull();
    expect(window.location.hash).toBe(route);
    expect(container.querySelector(`[aria-label='${host}']`)).not.toBeNull();
    expect(container.querySelector("[aria-label='Edit notes.txt']")).toBeNull();

    container.remove();
  });
});
