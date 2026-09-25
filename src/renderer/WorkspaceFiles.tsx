import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DESKTOP_BRIDGE_VERSION } from "../shared/contracts";
import type { DesktopBridgeInfo, OrchestrionDesktopApi, WorkspaceDirectoryEntry, WorkspaceFileOpenDestination, WorkspaceFileOpenResult, WorkspaceFileReadResult } from "../shared/contracts";
import { AlertCircle, Check, ChevronRight, CircleAlert, File, FileCode2, Folder, FolderOpen, FolderTree, Link2, LoaderCircle, Maximize2, RefreshCw, Save, X } from "lucide-react";
import { initialWorkspaceFilesState, updateWorkspaceFiles, workspaceDirectoryNeedsLoad, workspaceDirectoryState, type WorkspaceFilesState } from "./workspace-files-state";
import { fileTreeLayoutForKey, fileTreeLayoutForRequestedWidth, initialWorkspaceFileTreeLayout, MAX_FILE_TREE_WIDTH, MIN_FILE_TREE_WIDTH, type WorkspaceFileTreeLayout } from "./workspace-files-layout-state";
import { initialWorkspaceFileEditorState, isWorkspaceFileDirty, updateWorkspaceFileEditor, type WorkspaceFileEditorAction, type WorkspaceFileEditorState } from "./workspace-files-editor-state";

export interface WorkspaceFileApi {
  bridgeInfo?: DesktopBridgeInfo;
  readWorkspaceFile?: (input: { sessionId: string; relativePath: string }) => Promise<WorkspaceFileReadResult>;
  saveWorkspaceFile?: (input: { sessionId: string; relativePath: string; content: string; expectedRevision: string }) => Promise<{ revision: string }>;
  openWorkspaceFile?: (input: { sessionId: string; relativePath: string; destination: WorkspaceFileOpenDestination }) => Promise<WorkspaceFileOpenResult>;
}

export const WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE = "Workspace file tools are out of date or incomplete. Fully quit and restart the desktop app.";

export interface WorkspaceFileBridgeAvailability {
  read: boolean;
  save: boolean;
  open: boolean;
  message: string | null;
}

const COMPLETE_WORKSPACE_FILE_BRIDGE: WorkspaceFileBridgeAvailability = { read: true, save: true, open: true, message: null };

export function workspaceFileBridgeAvailability(api: WorkspaceFileApi | undefined): WorkspaceFileBridgeAvailability {
  const info = api?.bridgeInfo as unknown;
  if (!isRecord(info) || info.version !== DESKTOP_BRIDGE_VERSION) {
    return { read: false, save: false, open: false, message: WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE };
  }
  const capabilities = isRecord(info) && isRecord(info.capabilities) && isRecord(info.capabilities.workspaceFiles)
    ? info.capabilities.workspaceFiles
    : {};
  const availability = {
    read: capabilities.read === true && typeof api?.readWorkspaceFile === "function",
    save: capabilities.save === true && typeof api?.saveWorkspaceFile === "function",
    open: capabilities.open === true && typeof api?.openWorkspaceFile === "function",
  };
  return { ...availability, message: availability.read && availability.save && availability.open ? null : WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkspaceFilesSurfaceProps { active: boolean; sessionId: string | null; project: { name: string; path: string } | null; api?: Pick<OrchestrionDesktopApi, "listWorkspaceDirectory"> & WorkspaceFileApi; onDirtyStateChange?: (dirty: boolean, discard: () => void) => void }
interface WorkspaceFilesViewProps {
  sessionId: string | null; project: { name: string; path: string } | null; state: WorkspaceFilesState; onToggle: (path: string) => void; onRetry: (path: string) => void;
  selectedPath?: string | null; editor?: WorkspaceFileEditorState; fileTreeLayout?: WorkspaceFileTreeLayout; bridgeAvailability?: WorkspaceFileBridgeAvailability; onSelectFile?: (entry: WorkspaceDirectoryEntry) => void; onToggleFileTree?: () => void; onResizeFileTree?: (requestedWidth: number, maximumWidth?: number) => void; onResizeFileTreeKey?: (key: string, maximumWidth?: number) => void; onDraftChange?: (value: string) => void; onModeChange?: (mode: "preview" | "source") => void; onSave?: () => void; onReload?: () => void; onClearError?: () => void; onOpen?: (destination: WorkspaceFileOpenDestination) => void | Promise<void>;
}

export function WorkspaceFilesSurface({ active, sessionId, project, api, onDirtyStateChange }: WorkspaceFilesSurfaceProps) {
  const [state, dispatch] = useReducer(updateWorkspaceFiles, sessionId, initialWorkspaceFilesState);
  const [editorsBySession, setEditorsBySession] = useState<Record<string, WorkspaceFileEditorState>>({});
  const [treeLayout, setTreeLayout] = useState(initialWorkspaceFileTreeLayout);
  const requestId = useRef(0);
  const fileGenerationByKey = useRef<Record<string, number>>({});
  const saveGenerationByKey = useRef<Record<string, number>>({});
  const editorKey = (value: string | null) => value ?? "__no-session__";
  const currentEditor = editorsBySession[editorKey(sessionId)] ?? initialWorkspaceFileEditorState(sessionId);
  const currentState = state.sessionId === sessionId ? state : initialWorkspaceFilesState(sessionId);
  const bridgeAvailability = workspaceFileBridgeAvailability(api);
  const hasDirtyEditor = Object.values(editorsBySession).some(isWorkspaceFileDirty);
  const discardDirtyEditors = useCallback(() => {
    setEditorsBySession((current) => Object.fromEntries(Object.entries(current).map(([key, editor]) => {
      if (!isWorkspaceFileDirty(editor) || editor.document?.status !== "ready" || editor.document.content.type !== "text") return [key, editor];
      return [key, { ...editor, status: "ready", draft: editor.document.content.text, error: null }];
    })));
  }, []);
  const updateEditorSlice = useCallback((targetSessionId: string | null, action: WorkspaceFileEditorAction) => {
    setEditorsBySession((current) => {
      const key = editorKey(targetSessionId);
      const previous = current[key] ?? initialWorkspaceFileEditorState(targetSessionId);
      const next = updateWorkspaceFileEditor(previous, action);
      return next === previous ? current : { ...current, [key]: next };
    });
  }, []);
  const load = useCallback((path: string) => {
    if (!sessionId) return; const nextRequestId = ++requestId.current; dispatch({ type: "loading", sessionId, path, requestId: nextRequestId });
    if (!api) { dispatch({ type: "failed", sessionId, path, requestId: nextRequestId, error: "The desktop bridge is unavailable." }); return; }
    void api.listWorkspaceDirectory({ sessionId, relativePath: path }).then((listing) => dispatch({ type: "loaded", sessionId, path, requestId: nextRequestId, listing })).catch((error: unknown) => dispatch({ type: "failed", sessionId, path, requestId: nextRequestId, error: error instanceof Error ? error.message : "This directory could not be loaded." }));
  }, [api, sessionId]);
  const loadFile = useCallback((path: string) => {
    if (!sessionId) return;
    const requestSessionId = sessionId;
    const generationKey = `${editorKey(requestSessionId)}::${path}`;
    const nextGeneration = (fileGenerationByKey.current[generationKey] ?? 0) + 1;
    fileGenerationByKey.current[generationKey] = nextGeneration;
    updateEditorSlice(requestSessionId, { type: "select", sessionId: requestSessionId, path });
    if (!bridgeAvailability.read || !api?.readWorkspaceFile) {
      updateEditorSlice(requestSessionId, { type: "failed", sessionId: requestSessionId, path, error: bridgeAvailability.message ?? WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE });
      return;
    }
    const isLatest = () => fileGenerationByKey.current[generationKey] === nextGeneration;
    void api.readWorkspaceFile({ sessionId: requestSessionId, relativePath: path }).then((document) => {
      if (isLatest()) updateEditorSlice(requestSessionId, { type: "loaded", sessionId: requestSessionId, path, document });
    }).catch((error: unknown) => {
      if (isLatest()) updateEditorSlice(requestSessionId, { type: "failed", sessionId: requestSessionId, path, error: error instanceof Error ? error.message : "This file could not be opened." });
    });
  }, [api, bridgeAvailability.message, bridgeAvailability.read, sessionId, updateEditorSlice]);
  useEffect(() => {
    onDirtyStateChange?.(hasDirtyEditor, discardDirtyEditors);
  }, [discardDirtyEditors, hasDirtyEditor, onDirtyStateChange]);
  useEffect(() => () => onDirtyStateChange?.(false, discardDirtyEditors), [discardDirtyEditors, onDirtyStateChange]);
  const rootStatus = workspaceDirectoryState(currentState, "").status;
  useEffect(() => { dispatch({ type: "reset", sessionId }); }, [sessionId]);
  useEffect(() => { if (active && sessionId && rootStatus === "idle") load(""); }, [active, load, rootStatus, sessionId]);
  const toggle = (path: string) => { const directory = workspaceDirectoryState(currentState, path); dispatch({ type: "toggle", path }); if (!directory.expanded && workspaceDirectoryNeedsLoad(currentState, path)) load(path); };
  const saveFile = () => {
    const document = currentEditor.document;
    if (!sessionId || !currentEditor.selectedPath) return;
    if (!bridgeAvailability.save || !api?.saveWorkspaceFile) {
      updateEditorSlice(sessionId, { type: "failed", sessionId, path: currentEditor.selectedPath, error: bridgeAvailability.message ?? WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE });
      return;
    }
    if (!document || document.status !== "ready" || document.content.type !== "text" || !currentEditor.revision) return;
    const path = currentEditor.selectedPath;
    const draftAtSave = currentEditor.draft;
    const requestSessionId = sessionId;
    const generationKey = `${editorKey(requestSessionId)}::${path}`;
    const nextGeneration = (saveGenerationByKey.current[generationKey] ?? 0) + 1;
    saveGenerationByKey.current[generationKey] = nextGeneration;
    updateEditorSlice(requestSessionId, { type: "saving", sessionId: requestSessionId });
    void api.saveWorkspaceFile({ sessionId: requestSessionId, relativePath: path, content: draftAtSave, expectedRevision: currentEditor.revision }).then((saved) => {
      if (saveGenerationByKey.current[generationKey] === nextGeneration) updateEditorSlice(requestSessionId, { type: "saved", sessionId: requestSessionId, path, revision: saved.revision, text: draftAtSave });
    }).catch((error: unknown) => {
      if (saveGenerationByKey.current[generationKey] === nextGeneration) updateEditorSlice(requestSessionId, { type: "failed", sessionId: requestSessionId, path, error: error instanceof Error ? error.message : "This file could not be saved." });
    });
  };
  return <WorkspaceFilesView sessionId={sessionId} project={project} state={currentState} onToggle={toggle} onRetry={load} selectedPath={currentEditor.selectedPath} editor={currentEditor} fileTreeLayout={treeLayout} bridgeAvailability={bridgeAvailability} onSelectFile={(entry) => { if (isWorkspaceFileDirty(currentEditor) && !window.confirm("Discard unsaved changes to this file?")) return; loadFile(entry.path); }} onToggleFileTree={() => setTreeLayout((current) => ({ ...current, collapsed: !current.collapsed }))} onResizeFileTree={(requestedWidth, maximumWidth) => setTreeLayout((current) => fileTreeLayoutForRequestedWidth(requestedWidth, current.width, maximumWidth))} onResizeFileTreeKey={(key, maximumWidth) => setTreeLayout((current) => fileTreeLayoutForKey(current, key, maximumWidth) ?? current)} onDraftChange={(value) => updateEditorSlice(sessionId, { type: "draft", sessionId, value })} onModeChange={(mode) => updateEditorSlice(sessionId, { type: "mode", sessionId, mode })} onSave={saveFile} onReload={() => { if (currentEditor.selectedPath) loadFile(currentEditor.selectedPath); }} onClearError={() => updateEditorSlice(sessionId, { type: "clear-error", sessionId })} onOpen={async (destination) => { if (!bridgeAvailability.open || !api?.openWorkspaceFile) throw new Error(bridgeAvailability.message ?? WORKSPACE_FILE_BRIDGE_RESTART_MESSAGE); if (!sessionId || !currentEditor.selectedPath) throw new Error("Select a workspace file before opening it externally."); await api.openWorkspaceFile({ sessionId, relativePath: currentEditor.selectedPath, destination }); }} />;
}

export function WorkspaceFilesView({ sessionId, project, state, onToggle, onRetry, selectedPath = null, editor, fileTreeLayout = initialWorkspaceFileTreeLayout(), bridgeAvailability = COMPLETE_WORKSPACE_FILE_BRIDGE, onSelectFile, onToggleFileTree, onResizeFileTree, onResizeFileTreeKey, onDraftChange, onModeChange, onSave, onReload, onClearError, onOpen }: WorkspaceFilesViewProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!splitRef.current || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(splitRef.current);
    return () => observer.disconnect();
  }, []);
  if (!sessionId || !project) return <div className="workspace-not-connected" role="status"><span>Not connected</span><small>Select a saved session to browse its project files.</small></div>;
  const root = workspaceDirectoryState(state, "");
  const canSplit = availableWidth === null || availableWidth >= MIN_FILE_TREE_WIDTH + 10 + 150;
  const treeVisible = Boolean(selectedPath) && !fileTreeLayout.collapsed && canSplit;
  const treeMaximum = availableWidth === null ? MAX_FILE_TREE_WIDTH : Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, availableWidth - 10 - 150));
  return <div className={`workspace-files ${fileTreeLayout.collapsed ? "file-tree-collapsed" : ""}`} aria-label={`${project.name} project files`}>
    <div className="workspace-files-toolbar"><div><span className="eyebrow">Files</span><strong>{project.name}</strong></div><button type="button" className="workspace-files-tree-toggle" aria-label={treeVisible ? "Hide file tree" : "Show file tree"} disabled={!selectedPath || !canSplit} onClick={onToggleFileTree} aria-expanded={treeVisible} aria-controls="workspace-file-tree-panel" title={!selectedPath ? "Select a file to split the view" : !canSplit ? "File tree stays collapsed while the panel is narrow" : treeVisible ? "Hide file tree" : "Show file tree"}><FolderTree size={14} /></button></div>
    <div ref={splitRef} className={`workspace-files-split ${selectedPath ? treeVisible ? "" : "workspace-files-tree-hidden" : "workspace-files-tree-only"}`} style={{ "--workspace-file-tree-width": `${treeVisible ? Math.min(fileTreeLayout.width, treeMaximum) : 0}px` } as CSSProperties}>
      <aside id="workspace-file-tree-panel" className="workspace-file-tree-panel" aria-label="File tree"><div className="workspace-files-scroll">{root.status === "loading" && <LoadingDirectory label="Loading project files" />}{root.status === "error" && <DirectoryError error={root.error} onRetry={() => onRetry("")} />}{root.status === "ready" && root.entries.length === 0 && <div className="workspace-files-message compact empty"><div className="workspace-files-message-icon"><Folder size={19} /></div><h2>This project is empty</h2><p>No files or folders were found at the project root.</p></div>}{root.status === "ready" && root.entries.length > 0 && <div className="workspace-file-tree" role="tree" aria-label={`${project.name} files`}><DirectoryEntries entries={root.entries} state={state} depth={0} selectedPath={selectedPath} onToggle={onToggle} onRetry={onRetry} onSelectFile={onSelectFile} />{root.truncated && <TruncatedNotice />}</div>}</div></aside>
      {treeVisible && <div className="workspace-file-tree-resize-handle" role="separator" aria-label="Resize file tree" aria-orientation="vertical" aria-valuemin={MIN_FILE_TREE_WIDTH} aria-valuemax={Math.round(treeMaximum)} aria-valuenow={Math.round(Math.min(fileTreeLayout.width, treeMaximum))} aria-valuetext={`${Math.round(Math.min(fileTreeLayout.width, treeMaximum))} pixels`} tabIndex={0} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); onResizeFileTreeKey?.(event.key, treeMaximum); } }} onPointerDown={(event) => { if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = event.currentTarget.parentElement?.getBoundingClientRect(); onResizeFileTree?.(event.clientX - (bounds?.left ?? 0), treeMaximum); } }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />}
      {selectedPath && <section className="workspace-file-content" aria-label="File content"><FileContentHeader editor={editor} bridgeAvailability={bridgeAvailability} onModeChange={onModeChange} onSave={onSave} onOpen={onOpen} />{bridgeAvailability.message && <div className="workspace-file-bridge-status" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{bridgeAvailability.message}</span></div>}{editor ? <FileContent editor={editor} editingAvailable={bridgeAvailability.save} onDraftChange={onDraftChange} onModeChange={onModeChange} onReload={onReload} onClearError={onClearError} /> : <EmptyFileContent />}</section>}
    </div>
  </div>;
}

function DirectoryEntries({ entries, state, depth, selectedPath, onToggle, onRetry, onSelectFile }: { entries: WorkspaceDirectoryEntry[]; state: WorkspaceFilesState; depth: number; selectedPath: string | null; onToggle: (path: string) => void; onRetry: (path: string) => void; onSelectFile?: (entry: WorkspaceDirectoryEntry) => void }) {
  return <>{entries.map((entry) => { if (entry.kind !== "directory" || !entry.accessible) return <FileRow key={entry.path} entry={entry} depth={depth} selected={selectedPath === entry.path} onSelect={onSelectFile} />; const directory = workspaceDirectoryState(state, entry.path); return <div className="workspace-directory" key={entry.path} role="none"><button className={`workspace-file-row directory ${directory.expanded ? "expanded" : ""}`} type="button" role="treeitem" aria-expanded={directory.expanded} style={{ "--file-depth": depth } as CSSProperties} onClick={() => onToggle(entry.path)} title={entry.path}><ChevronRight className="workspace-file-chevron" size={13} />{directory.expanded ? <FolderOpen className="workspace-file-icon" size={15} /> : <Folder className="workspace-file-icon" size={15} />}<span>{entry.name}</span>{entry.symbolicLink && <Link2 className="workspace-file-link" size={11} aria-label="Symbolic link" />}</button>{directory.expanded && <div role="group">{directory.status === "loading" && <LoadingDirectory label={`Loading ${entry.name}`} depth={depth + 1} />}{directory.status === "error" && <DirectoryError error={directory.error} onRetry={() => onRetry(entry.path)} depth={depth + 1} />}{directory.status === "ready" && directory.entries.length === 0 && <div className="workspace-directory-empty" style={{ "--file-depth": depth + 1 } as CSSProperties}>Empty folder</div>}{directory.status === "ready" && <DirectoryEntries entries={directory.entries} state={state} depth={depth + 1} selectedPath={selectedPath} onToggle={onToggle} onRetry={onRetry} onSelectFile={onSelectFile} />}{directory.status === "ready" && directory.truncated && <TruncatedNotice depth={depth + 1} />}</div>}</div>; })}</>;
}

function FileRow({ entry, depth, selected, onSelect }: { entry: WorkspaceDirectoryEntry; depth: number; selected: boolean; onSelect?: (entry: WorkspaceDirectoryEntry) => void }) {
  const blocked = !entry.accessible; const extension = entry.name.includes(".") ? entry.name.split(".").pop()?.toLowerCase() : ""; const codeFile = ["css", "html", "js", "jsx", "json", "md", "py", "ts", "tsx", "yaml", "yml"].includes(extension ?? "");
  return <button className={`workspace-file-row file ${blocked ? "blocked" : ""} ${selected ? "selected" : ""}`} type="button" role="treeitem" aria-disabled={blocked || undefined} aria-current={selected || undefined} style={{ "--file-depth": depth } as CSSProperties} title={blocked ? `${entry.name} cannot be opened because its target is unavailable or outside this project.` : entry.path} disabled={blocked} onClick={() => onSelect?.(entry)}><span className="workspace-file-chevron-spacer" />{blocked ? <AlertCircle className="workspace-file-icon" size={14} /> : codeFile ? <FileCode2 className="workspace-file-icon" size={14} /> : <File className="workspace-file-icon" size={14} />}<span>{entry.name}</span>{entry.symbolicLink && <Link2 className="workspace-file-link" size={11} aria-label="Symbolic link" />}</button>;
}

function FileContentHeader({ editor, bridgeAvailability, onModeChange, onSave, onOpen }: { editor?: WorkspaceFileEditorState; bridgeAvailability: WorkspaceFileBridgeAvailability; onModeChange?: (mode: "preview" | "source") => void; onSave?: () => void; onOpen?: (destination: WorkspaceFileOpenDestination) => void | Promise<void> }) {
  const document = editor?.document; const path = document?.path ?? editor?.selectedPath; const name = document?.name ?? path?.split("/").pop() ?? "No file selected"; const editable = bridgeAvailability.save && document?.status === "ready" && document.editable && document.content.type === "text"; const extension = name.split(".").pop()?.toLowerCase(); const showMode = document?.kind === "text" && ["md", "markdown", "mdx", "json"].includes(extension ?? ""); const canSave = editable && editor && isWorkspaceFileDirty(editor) && editor.status !== "saving";
  return <header className="workspace-file-content-header"><div className="workspace-file-heading"><span className="workspace-file-breadcrumb">{path ? path.split("/").slice(0, -1).join(" / ") || "root" : "Workspace files"}</span><strong title={path ?? undefined}>{name}</strong></div>{showMode && <div className="workspace-file-mode" role="group" aria-label="File view"><button type="button" className={editor?.mode === "preview" ? "active" : ""} onClick={() => onModeChange?.("preview")}>Preview</button><button type="button" className={editor?.mode === "source" ? "active" : ""} onClick={() => onModeChange?.("source")}>Source</button></div>}<div className="workspace-file-actions"><OpenInMenu onOpen={onOpen} disabled={!document || !bridgeAvailability.open} />{editable && <button type="button" className="workspace-file-save" onClick={onSave} disabled={!canSave} aria-label={editor?.status === "saving" ? "Saving file" : "Save file"}>{editor?.status === "saving" ? <LoaderCircle className="spin" size={13} /> : canSave ? <Save size={13} /> : <Check size={13} />}<span>{editor?.status === "saving" ? "Saving" : "Save"}</span></button>}</div></header>;
}

export function OpenInMenu({ onOpen, disabled }: { onOpen?: (destination: WorkspaceFileOpenDestination) => void | Promise<void>; disabled?: boolean }) { const [open, setOpen] = useState(false); const [error, setError] = useState<string | null>(null); const menuRef = useRef<HTMLDivElement>(null); useEffect(() => { if (!open) return undefined; const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false); }; const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); }; document.addEventListener("mousedown", close); document.addEventListener("keydown", key); return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); }; }, [open]); const launch = (destination: WorkspaceFileOpenDestination) => { setOpen(false); setError(null); try { const result = onOpen?.(destination); if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "The file could not be opened externally.")); } catch (reason) { setError(reason instanceof Error ? reason.message : "The file could not be opened externally."); } }; return <div className="workspace-open-menu" ref={menuRef}><button type="button" className="workspace-open-button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Open in…<ChevronRight size={12} /></button>{open && <div className="workspace-open-popover" role="menu"><button type="button" role="menuitem" onClick={() => launch("vscode")}>VS Code</button><button type="button" role="menuitem" onClick={() => launch("cursor")}>Cursor</button><button type="button" role="menuitem" onClick={() => launch("system")}>Default app</button></div>}{error && <span className="workspace-open-error" role="alert">{error}</span>}</div>; }

function FileContent({ editor, editingAvailable, onDraftChange, onModeChange, onReload, onClearError }: { editor: WorkspaceFileEditorState; editingAvailable: boolean; onDraftChange?: (value: string) => void; onModeChange?: (mode: "preview" | "source") => void; onReload?: () => void; onClearError?: () => void }) {
  const document = editor.document; if (editor.status === "loading") return <ContentMessage icon={<LoaderCircle className="spin" size={18} />} title="Opening file" detail="Reading a bounded copy from the project workspace…" />; if (editor.status === "error" && (!document || document.status !== "ready")) return <ContentMessage icon={<CircleAlert size={18} />} title="Could not open file" detail={editor.error ?? "The file is unavailable."} />; if (!document) return <EmptyFileContent />; if (document.status === "too-large") return <ContentMessage icon={<Maximize2 size={18} />} title="File is too large to preview" detail={`This file is ${formatBytes(document.size)}. The preview limit is ${formatBytes(document.maxBytes)}.`} />; if (document.status === "unsupported") return <ContentMessage icon={<X size={18} />} title="Preview unavailable" detail="This file type is not supported in the workspace preview." />; if (document.kind !== "text") return <MediaPreview document={document} />; const extension = document.name.split(".").pop()?.toLowerCase(); if (editor.mode === "preview" && ["md", "markdown", "mdx"].includes(extension ?? "")) return <MarkdownPreview source={editor.draft} onEdit={() => onModeChange?.("source")} />; if (editor.mode === "preview" && extension === "json") return <JsonPreview source={editor.draft} onEdit={() => onModeChange?.("source")} />; const canEdit = editingAvailable && document.editable; return <div className="workspace-file-editor">{editor.status === "error" && <div className="workspace-file-save-error" role="alert"><CircleAlert size={13} /><span>{editor.error ?? "Save failed; your draft is still here."}</span><button type="button" onClick={onReload}>Reload from disk</button><button type="button" className="workspace-file-error-dismiss" onClick={onClearError}>Keep draft</button></div>}<textarea aria-label={`${canEdit ? "Edit" : "Read"} ${document.name}`} value={editor.draft} readOnly={!canEdit} onChange={(event) => { if (canEdit) onDraftChange?.(event.target.value); }} spellCheck={false} /><span className="workspace-file-editor-footnote">{canEdit ? "Local draft · save to write changes" : "Read-only text preview"}</span></div>;
}

function MediaPreview({ document }: { document: Extract<WorkspaceFileReadResult, { status: "ready" }> }) { if (document.content.type !== "data-url") return <ContentMessage title="Preview unavailable" detail="This media file did not include a preview payload." />; if (document.kind === "image") return <div className="workspace-media-preview"><img src={document.content.dataUrl} alt={document.name} /></div>; if (document.kind === "pdf") return <iframe className="workspace-pdf-preview" src={document.content.dataUrl} title={document.name} sandbox="allow-scripts" />; if (document.kind === "audio") return <div className="workspace-media-preview workspace-audio-preview"><audio controls src={document.content.dataUrl} /></div>; return <div className="workspace-media-preview"><video controls src={document.content.dataUrl} /></div>; }
function MarkdownPreview({ source, onEdit }: { source: string; onEdit: () => void }) {
  const elements: ReactNode[] = []; let fenced = false; let fence: string[] = []; let list: ReactNode[] = [];
  const flushList = () => { if (list.length) { elements.push(<ul key={`list-${elements.length}`}>{list}</ul>); list = []; } };
  source.split("\n").forEach((line, index) => {
    if (line.trim().startsWith("```")) { if (fenced) { elements.push(<pre key={`code-${index}`}><code>{fence.join("\n")}</code></pre>); fence = []; } fenced = !fenced; return; }
    if (fenced) { fence.push(line); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/); const item = line.match(/^\s*[-*+]\s+(.+)$/); const quote = line.match(/^>\s?(.*)$/);
    if (heading) { flushList(); const Heading = heading[1].length === 1 ? "h1" : "h2"; elements.push(<Heading key={index}>{inlineMarkdown(heading[2])}</Heading>); return; }
    if (item) { list.push(<li key={index} className={line.startsWith("  ") ? "nested" : undefined}>{inlineMarkdown(item[1])}</li>); return; }
    flushList(); if (quote) elements.push(<blockquote key={index}>{inlineMarkdown(quote[1])}</blockquote>); else if (line.trim()) elements.push(<p key={index}>{inlineMarkdown(line)}</p>); else elements.push(<span className="workspace-preview-spacer" key={index} />);
  }); flushList(); if (fenced && fence.length) elements.push(<pre key="open-code"><code>{fence.join("\n")}</code></pre>);
  return <article className="workspace-rich-preview" onDoubleClick={onEdit}>{elements}</article>;
}

function inlineMarkdown(value: string): ReactNode[] {
  const parts = value.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/); if (!link) return part;
    if (/^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <span key={index} title="Only web links can be opened from preview">{link[1]}</span>;
  });
}
function JsonPreview({ source, onEdit }: { source: string; onEdit: () => void }) { try { return <div className="workspace-json-preview"><div className="workspace-json-valid"><Check size={12} />Valid JSON</div><pre onDoubleClick={onEdit}>{JSON.stringify(JSON.parse(source), null, 2)}</pre></div>; } catch (error) { return <div className="workspace-json-preview"><div className="workspace-json-invalid"><AlertCircle size={12} />Invalid JSON · {error instanceof Error ? error.message : "check the source"}</div><pre onDoubleClick={onEdit}>{source}</pre></div>; } }
function ContentMessage({ icon, title, detail }: { icon?: ReactNode; title: string; detail: string }) { return <div className="workspace-file-message"><div className="workspace-file-message-icon">{icon ?? <File size={18} />}</div><h2>{title}</h2><p>{detail}</p></div>; }
function EmptyFileContent() { return <div className="workspace-file-empty"><File size={20} /><p>Select a file to inspect its contents.</p><small>Markdown, JSON, and text files can be edited here.</small></div>; }
function LoadingDirectory({ label, depth = 0 }: { label: string; depth?: number }) { return <div className="workspace-directory-loading" role="status" style={{ "--file-depth": depth } as CSSProperties}><LoaderCircle className="spin" size={13} /><span>{label}…</span></div>; }
function DirectoryError({ error, onRetry, depth = 0 }: { error: string | null; onRetry: () => void; depth?: number }) { return <div className="workspace-directory-error" role="alert" style={{ "--file-depth": depth } as CSSProperties}><AlertCircle size={13} /><span>{error ?? "This directory could not be loaded."}</span><button type="button" onClick={onRetry}><RefreshCw size={11} />Retry</button></div>; }
function TruncatedNotice({ depth = 0 }: { depth?: number }) { return <div className="workspace-files-truncated" style={{ "--file-depth": depth } as CSSProperties}>Showing the first 500 entries</div>; }
function formatBytes(size: number): string { if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`; return `${(size / (1024 * 1024)).toFixed(1)} MB`; }
