// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_BRIDGE_VERSION, type WorkspaceDirectoryEntry, type WorkspaceFileOpenDestination } from "../shared/contracts";
import { WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE, WorkspaceFilesSurface, WorkspaceFilesView, workspaceFileBridgeAvailability, type WorkspaceFileApi } from "./WorkspaceFiles";
import { WorkspacePanel } from "./WorkspacePanel";
import { initialWorkspacePanelState, workspacePanelGeometry, type WorkspacePanelState } from "./workspace-panel-state";
import { initialWorkspaceFileEditorState, isWorkspaceFileDirty, updateWorkspaceFileEditor } from "./workspace-files-editor-state";
import { initialWorkspaceFilesState, updateWorkspaceFiles } from "./workspace-files-state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xterm/xterm", () => ({ Terminal: class { cols = 80; rows = 24; options: Record<string, unknown> = {}; loadAddon() {} open() {} onData() { return { dispose() {} }; } write(_data: string, callback?: () => void) { callback?.(); } focus() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const project = { name: "Atlas", path: "/work/atlas" };
const file: WorkspaceDirectoryEntry = { name: "README.md", path: "README.md", kind: "file", symbolicLink: false, accessible: true };
const plainFile: WorkspaceDirectoryEntry = { name: "notes.txt", path: "notes.txt", kind: "file", symbolicLink: false, accessible: true };
const currentBridge = {
  bridgeInfo: {
    version: DESKTOP_BRIDGE_VERSION,
    capabilities: { workspaceFiles: { read: true, save: true, open: true }, sessionTree: { bindSessionAgent: true },
      localAgents:{ directToolGrants:true },localToolsets:{ review:true,activate:true,disable:true } },
  },
  saveWorkspaceFile: async () => ({ revision: "r2" }),
  openWorkspaceFile: async ({ destination }: { destination: WorkspaceFileOpenDestination }) => ({ destination }),
} as const;
const rootState = updateWorkspaceFiles(
  updateWorkspaceFiles(initialWorkspaceFilesState("session-1"), { type: "loading", sessionId: "session-1", path: "", requestId: 1 }),
  { type: "loaded", sessionId: "session-1", path: "", requestId: 1, listing: { path: "", entries: [file], truncated: false } },
);
function textDocument(path: string, text: string, revision = "r1") {
  return { path, name: path, kind: "text" as const, mimeType: "text/plain", size: text.length, editable: true, status: "ready" as const, revision, content: { type: "text" as const, text } };
}

describe("workspace file editor", () => {
  it("fails closed for missing, old, and partial runtime bridge metadata", () => {
    const methods = {
      readWorkspaceFile: async () => textDocument("notes.txt", "safe"),
      saveWorkspaceFile: async () => ({ revision: "r2" }),
      openWorkspaceFile: async ({ destination }: { destination: WorkspaceFileOpenDestination }) => ({ destination }),
    };
    const missing = workspaceFileBridgeAvailability(methods);
    const old = workspaceFileBridgeAvailability({
      ...methods,
      bridgeInfo: { version: 0, capabilities: { workspaceFiles: { read: true, save: true, open: true } } },
    } as unknown as WorkspaceFileApi);
    const partial = workspaceFileBridgeAvailability({
      ...methods,
      bridgeInfo: { version: DESKTOP_BRIDGE_VERSION, capabilities: { workspaceFiles: { read: true } } },
    } as unknown as WorkspaceFileApi);

    expect(missing).toEqual({ read: false, save: false, open: false, message: WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE });
    expect(old).toEqual({ read: false, save: false, open: false, message: WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE });
    expect(partial).toEqual({ read: true, save: false, open: false, message: WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE });
  });

  it.each([
    ["missing", undefined],
    ["old", { version: 0, capabilities: { workspaceFiles: { read: true, save: true, open: true } } }],
  ])("blocks file selection with a full-restart message for a %s bridge", async (_label, bridgeInfo) => {
    const readWorkspaceFile = vi.fn(async () => textDocument(plainFile.path, "safe"));
    const api = {
      ...(bridgeInfo ? { bridgeInfo } : {}),
      listWorkspaceDirectory: async () => ({ path: "", entries: [plainFile], truncated: false }),
      readWorkspaceFile,
    } as unknown as WorkspaceFileApi & { listWorkspaceDirectory: () => Promise<{ path: string; entries: WorkspaceDirectoryEntry[]; truncated: boolean }> };
    const container = document.createElement("div"); const root = createRoot(container);

    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); });

    expect(readWorkspaceFile).not.toHaveBeenCalled();
    const status = container.querySelector(".workspace-file-bridge-status");
    expect(status?.textContent).toContain("Fully quit and restart the desktop app.");
    expect(status?.getAttribute("role")).toBe("alert");
    expect(container.querySelector(".workspace-open-error")).toBeNull();
    await act(async () => root.unmount());
  });

  it("allows partial-bridge reads but disables edit, Save, and Open In", async () => {
    const readWorkspaceFile = vi.fn(async () => textDocument(plainFile.path, "safe"));
    const saveWorkspaceFile = vi.fn(async () => ({ revision: "r2" }));
    const openWorkspaceFile = vi.fn(async ({ destination }: { destination: WorkspaceFileOpenDestination }) => ({ destination }));
    const api = {
      bridgeInfo: { version: DESKTOP_BRIDGE_VERSION, capabilities: { workspaceFiles: { read: true } } },
      listWorkspaceDirectory: async () => ({ path: "", entries: [plainFile], truncated: false }),
      readWorkspaceFile,
      saveWorkspaceFile,
      openWorkspaceFile,
    } as unknown as WorkspaceFileApi & { listWorkspaceDirectory: () => Promise<{ path: string; entries: WorkspaceDirectoryEntry[]; truncated: boolean }> };
    const container = document.createElement("div"); const root = createRoot(container);

    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); await Promise.resolve(); });

    expect(readWorkspaceFile).toHaveBeenCalledOnce();
    expect((container.querySelector("textarea") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(container.querySelector(".workspace-file-save")).toBeNull();
    expect((container.querySelector(".workspace-open-button") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".workspace-file-bridge-status")?.textContent).toContain("Fully quit and restart the desktop app.");
    expect(container.querySelector(".workspace-open-error")).toBeNull();
    expect(saveWorkspaceFile).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("defaults Markdown and JSON to preview while ordinary text remains source", () => {
    const markdown = updateWorkspaceFileEditor(initialWorkspaceFileEditorState("session-1"), { type: "select", sessionId: "session-1", path: file.path });
    const loadedMarkdown = updateWorkspaceFileEditor(markdown, { type: "loaded", sessionId: "session-1", path: file.path, document: { ...file, path: file.path, name: file.name, kind: "text", mimeType: "text/markdown", size: 12, editable: true, status: "ready", revision: "r1", content: { type: "text", text: "# Hello\n\nA **note**." } } });
    expect(loadedMarkdown.mode).toBe("preview");
    expect(isWorkspaceFileDirty(updateWorkspaceFileEditor(loadedMarkdown, { type: "draft", sessionId: "session-1", value: "changed" }))).toBe(true);
    const plain = updateWorkspaceFileEditor(initialWorkspaceFileEditorState("session-1"), { type: "select", sessionId: "session-1", path: "notes.txt" });
    expect(updateWorkspaceFileEditor(plain, { type: "loaded", sessionId: "session-1", path: "notes.txt", document: { ...file, path: "notes.txt", name: "notes.txt", kind: "text", mimeType: "text/plain", size: 4, editable: true, status: "ready", revision: "r1", content: { type: "text", text: "note" } } }).mode).toBe("source");
  });

  it("retains edits made during an in-flight save and keeps conflict drafts recoverable", () => {
    const loaded = updateWorkspaceFileEditor(updateWorkspaceFileEditor(initialWorkspaceFileEditorState("session-1"), { type: "select", sessionId: "session-1", path: "notes.txt" }), { type: "loaded", sessionId: "session-1", path: "notes.txt", document: { path: "notes.txt", name: "notes.txt", kind: "text", mimeType: "text/plain", size: 4, editable: true, status: "ready", revision: "r1", content: { type: "text", text: "base" } } });
    const saving = updateWorkspaceFileEditor(updateWorkspaceFileEditor(loaded, { type: "draft", sessionId: "session-1", value: "saved" }), { type: "saving", sessionId: "session-1" });
    const typedDuringSave = updateWorkspaceFileEditor(saving, { type: "draft", sessionId: "session-1", value: "newer" });
    const saved = updateWorkspaceFileEditor(typedDuringSave, { type: "saved", sessionId: "session-1", path: "notes.txt", revision: "r2", text: "saved" });
    expect(saved.status).toBe("ready");
    expect(saved.draft).toBe("newer");
    expect(isWorkspaceFileDirty(saved)).toBe(true);
    const conflict = updateWorkspaceFileEditor(updateWorkspaceFileEditor(loaded, { type: "draft", sessionId: "session-1", value: "keep this" }), { type: "failed", sessionId: "session-1", path: "notes.txt", error: "File changed on disk." });
    expect(conflict.status).toBe("error");
    expect(conflict.draft).toBe("keep this");
    expect(updateWorkspaceFileEditor(conflict, { type: "clear-error", sessionId: "session-1" }).status).toBe("ready");
    expect(updateWorkspaceFileEditor(loaded, { type: "loaded", sessionId: "session-2", path: "notes.txt", document: { path: "notes.txt", name: "notes.txt", kind: "text", mimeType: "text/plain", size: 5, editable: true, status: "ready", revision: "r2", content: { type: "text", text: "wrong" } } })).toBe(loaded);
  });

  it("renders the split tree/content surface and graceful too-large state", () => {
    const editor = updateWorkspaceFileEditor(initialWorkspaceFileEditorState("session-1"), { type: "select", sessionId: "session-1", path: file.path });
    const loaded = updateWorkspaceFileEditor(editor, { type: "loaded", sessionId: "session-1", path: file.path, document: { path: file.path, name: file.name, kind: "text", mimeType: "text/markdown", size: 9, editable: true, status: "ready", revision: "r1", content: { type: "text", text: "# Hello" } } });
    const markup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={rootState} onToggle={() => undefined} onRetry={() => undefined} selectedPath={file.path} editor={loaded} onToggleFileTree={() => undefined} onResizeFileTree={() => undefined} onResizeFileTreeKey={() => undefined} />);
    expect(markup).toContain("workspace-files-split");
    expect(markup).toContain("workspace-file-tree-resize-handle");
    expect(markup).toContain("workspace-file-tree-panel");
    expect(markup).toContain("workspace-files-scroll");
    expect(markup).toContain('aria-label="Hide file tree"');
    expect(markup).not.toContain("Hide tree");
    expect(markup).not.toContain("Show tree");
    expect(markup).toContain("Preview");
    expect(markup).toContain("Hello");

    const large = updateWorkspaceFileEditor(editor, { type: "loaded", sessionId: "session-1", path: file.path, document: { path: file.path, name: file.name, kind: "text", mimeType: "text/markdown", size: 3_000_000, editable: false, status: "too-large", maxBytes: 2_000_000 } });
    const largeMarkup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={rootState} onToggle={() => undefined} onRetry={() => undefined} selectedPath={file.path} editor={large} />);
    expect(largeMarkup).toContain("File is too large to preview");
    expect(largeMarkup).toContain('class="workspace-open-button"');
    expect(largeMarkup).not.toContain("disabled=\"\"");
    const initialMarkup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={rootState} onToggle={() => undefined} onRetry={() => undefined} />);
    expect(initialMarkup).toContain("workspace-files-tree-only");
    expect(initialMarkup).not.toContain("workspace-file-tree-resize-handle");

    const collapsedMarkup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={rootState} selectedPath={file.path} editor={loaded} fileTreeLayout={{ width: 214, collapsed: true }} onToggle={() => undefined} onRetry={() => undefined} />);
    expect(collapsedMarkup).toContain("workspace-files-tree-hidden");
    expect(collapsedMarkup).not.toContain("workspace-file-tree-resize-handle");

    const loading = updateWorkspaceFileEditor(editor, { type: "loading", sessionId: "session-1", path: file.path });
    const loadingMarkup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={rootState} onToggle={() => undefined} onRetry={() => undefined} selectedPath={file.path} editor={loading} />);
    expect(loadingMarkup).toContain("README.md");
    expect(loadingMarkup).not.toContain("No file selected");
  });

  it("keeps external open available for bounded-out files", async () => {
    const onOpen = vi.fn();
    const editor = updateWorkspaceFileEditor(initialWorkspaceFileEditorState("session-1"), { type: "select", sessionId: "session-1", path: file.path });
    const large = updateWorkspaceFileEditor(editor, { type: "loaded", sessionId: "session-1", path: file.path, document: { path: file.path, name: file.name, kind: "text", mimeType: "text/markdown", size: 3_000_000, editable: false, status: "too-large", maxBytes: 2_000_000 } });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<WorkspaceFilesView sessionId="session-1" project={project} state={rootState} onToggle={() => undefined} onRetry={() => undefined} selectedPath={file.path} editor={large} onOpen={onOpen} />); });
    await act(async () => { (container.querySelector(".workspace-open-button") as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector("[role='menuitem']") as HTMLButtonElement).click(); });
    expect(onOpen).toHaveBeenCalledWith("vscode");
    await act(async () => root.unmount());
  });

  it("asks before switching away from a dirty draft", async () => {
    const second: WorkspaceDirectoryEntry = { name: "notes.txt", path: "notes.txt", kind: "file", symbolicLink: false, accessible: true };
    const readWorkspaceFile = vi.fn(async ({ relativePath }: { relativePath: string }) => ({ path: relativePath, name: relativePath, kind: "text" as const, mimeType: "text/plain", size: 4, editable: true, status: "ready" as const, revision: "r1", content: { type: "text" as const, text: relativePath === file.path ? "note" : "other" } }));
    const api = { ...currentBridge, listWorkspaceDirectory: async () => ({ path: "", entries: [file, second], truncated: false }), readWorkspaceFile };
    const container = document.createElement("div");
    const root: Root = createRoot(container);
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelectorAll("button.workspace-file-row.file")[1] as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "changed");
    await act(async () => { textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const rows = container.querySelectorAll("button.workspace-file-row.file");
    await act(async () => { (rows[0] as HTMLButtonElement).click(); });
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to this file?");
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await act(async () => { (rows[0] as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
    await act(async () => root.unmount());
  });

  it("preserves the dirty editor when the outer panel hides and when sessions switch", async () => {
    const readWorkspaceFile = vi.fn(async ({ sessionId, relativePath }: { sessionId: string; relativePath: string }) => ({ path: relativePath, name: relativePath, kind: "text" as const, mimeType: "text/plain", size: 4, editable: true, status: "ready" as const, revision: "r1", content: { type: "text" as const, text: sessionId === "session-1" ? "one" : "two" } }));
    const api = { ...currentBridge, listWorkspaceDirectory: async () => ({ path: "", entries: [{ ...file, name: "notes.txt", path: "notes.txt" }], truncated: false }), readWorkspaceFile };
    const container = document.createElement("div"); const root: Root = createRoot(container);
    const geometry = workspacePanelGeometry({ ...initialWorkspacePanelState(440, "session-1"), open: true }, 1_440, 252, false);
    const dispatch = () => undefined;
    const renderPanel = (state: WorkspacePanelState, sessionId: string) => <WorkspacePanel state={state} geometry={geometry} context={{ sessionId, project: { id: "project-1", ...project } }} api={api} dispatch={dispatch} />;
    const openFiles = { ...initialWorkspacePanelState(440, "session-1"), open: true, activeSurfaceId: "files" as const };
    await act(async () => { root.render(renderPanel(openFiles, "session-1")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("one");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "draft survives");
    await act(async () => { textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { root.render(renderPanel({ ...openFiles, open: false, activeSurfaceId: null }, "session-1")); });
    await act(async () => { root.render(renderPanel(openFiles, "session-1")); });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("draft survives");
    await act(async () => { root.render(renderPanel({ ...openFiles, open: false, activeSurfaceId: null, sessionId: "session-2" }, "session-2")); });
    await act(async () => { root.render(renderPanel({ ...openFiles, sessionId: "session-2" }, "session-2")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { root.render(renderPanel({ ...openFiles, open: false, activeSurfaceId: null, sessionId: "session-2" }, "session-2")); });
    await act(async () => { root.render(renderPanel({ ...openFiles, sessionId: "session-1" }, "session-1")); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("draft survives");
    await act(async () => root.unmount());
  });

  it("keeps late reads scoped to their session without an effect-window overwrite", async () => {
    const pending: Array<(document: ReturnType<typeof textDocument>) => void> = [];
    const readWorkspaceFile = vi.fn(({ relativePath }: { sessionId: string; relativePath: string }) => new Promise<ReturnType<typeof textDocument>>((resolve) => pending.push(resolve)));
    const api = { ...currentBridge, listWorkspaceDirectory: async () => ({ path: "", entries: [plainFile], truncated: false }), readWorkspaceFile };
    const container = document.createElement("div"); const root = createRoot(container);
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); });
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-2" project={project} api={api} />); });
    await act(async () => { pending[0](textDocument(plainFile.path, "from old session")); await Promise.resolve(); });
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("from old session");
    await act(async () => root.unmount());
  });

  it("accepts only the newest same-session read when responses resolve in reverse", async () => {
    const pending: Array<(document: ReturnType<typeof textDocument>) => void> = [];
    const readWorkspaceFile = vi.fn(({ relativePath }: { sessionId: string; relativePath: string }) => new Promise<ReturnType<typeof textDocument>>((resolve) => pending.push(resolve)));
    const api = { ...currentBridge, listWorkspaceDirectory: async () => ({ path: "", entries: [plainFile], truncated: false }), readWorkspaceFile };
    const container = document.createElement("div"); const root = createRoot(container);
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); });
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
    await act(async () => { pending[1](textDocument(plainFile.path, "newest")); await Promise.resolve(); });
    await act(async () => { pending[0](textDocument(plainFile.path, "stale")); await Promise.resolve(); });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("newest");
    await act(async () => root.unmount());
  });

  it("keeps all session drafts dirty across a null-session render while deferring beforeunload to the owner", async () => {
    const api = { ...currentBridge, listWorkspaceDirectory: async () => ({ path: "", entries: [plainFile], truncated: false }), readWorkspaceFile: async ({ relativePath }: { sessionId: string; relativePath: string }) => textDocument(relativePath, "saved") };
    const container = document.createElement("div"); const root = createRoot(container);
    const dirtyStates: boolean[] = [];
    const onDirtyStateChange = (dirty: boolean) => dirtyStates.push(dirty);
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} onDirtyStateChange={onDirtyStateChange} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); await Promise.resolve(); });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "draft kept while disconnected");
    await act(async () => { textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(dirtyStates.at(-1)).toBe(true);
    await act(async () => { root.render(<WorkspaceFilesSurface active={false} sessionId={null} project={null} api={api} onDirtyStateChange={onDirtyStateChange} />); });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dirtyStates.at(-1)).toBe(true);
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} onDirtyStateChange={onDirtyStateChange} />); });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("draft kept while disconnected");
    await act(async () => root.unmount());
  });

  it("keeps component edits typed during save and exposes recoverable save conflicts", async () => {
    const saves: Array<{ resolve: (value: { revision: string }) => void; reject: (reason: Error) => void }> = [];
    const api = {
      ...currentBridge,
      listWorkspaceDirectory: async () => ({ path: "", entries: [plainFile], truncated: false }),
      readWorkspaceFile: async ({ relativePath }: { sessionId: string; relativePath: string }) => textDocument(relativePath, "base"),
      saveWorkspaceFile: vi.fn(() => new Promise<{ revision: string }>((resolve, reject) => saves.push({ resolve, reject }))),
    };
    const container = document.createElement("div"); const root = createRoot(container);
    await act(async () => { root.render(<WorkspaceFilesSurface active sessionId="session-1" project={project} api={api} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { (container.querySelector("button.workspace-file-row.file") as HTMLButtonElement).click(); await Promise.resolve(); });
    const changeDraft = async (value: string) => {
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
      await act(async () => { textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    await changeDraft("saved draft");
    await act(async () => { (container.querySelector(".workspace-file-save") as HTMLButtonElement).click(); });
    await changeDraft("typed while saving");
    await act(async () => { saves[0].resolve({ revision: "r2" }); await Promise.resolve(); });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("typed while saving");
    expect(container.querySelector(".workspace-file-save")?.textContent).toContain("Save");
    await changeDraft("keep after conflict");
    await act(async () => { (container.querySelector(".workspace-file-save") as HTMLButtonElement).click(); });
    await act(async () => { saves[1].reject(new Error("File changed on disk.")); await Promise.resolve(); });
    expect(container.querySelector(".workspace-file-save-error")?.textContent).toContain("File changed on disk.");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("keep after conflict");
    await act(async () => root.unmount());
  });
});
