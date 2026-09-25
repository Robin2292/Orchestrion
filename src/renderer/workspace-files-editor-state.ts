import type { WorkspaceFileReadResult } from "../shared/contracts";

export interface WorkspaceFileEditorState {
  sessionId: string | null;
  selectedPath: string | null;
  status: "idle" | "loading" | "ready" | "saving" | "error";
  document: WorkspaceFileReadResult | null;
  draft: string;
  revision: string | null;
  mode: "preview" | "source";
  error: string | null;
}

export type WorkspaceFileEditorAction =
  | { type: "select"; sessionId: string | null; path: string }
  | { type: "loading"; sessionId: string | null; path: string }
  | { type: "loaded"; sessionId: string | null; path: string; document: WorkspaceFileReadResult }
  | { type: "failed"; sessionId: string | null; path: string; error: string }
  | { type: "draft"; sessionId: string | null; value: string }
  | { type: "mode"; sessionId: string | null; mode: WorkspaceFileEditorState["mode"] }
  | { type: "saving"; sessionId: string | null }
  | { type: "saved"; sessionId: string | null; path: string; revision: string; text: string }
  | { type: "clear-error"; sessionId: string | null };

export function initialWorkspaceFileEditorState(sessionId: string | null = null): WorkspaceFileEditorState {
  return {
    sessionId,
    selectedPath: null,
    status: "idle",
    document: null,
    draft: "",
    revision: null,
    mode: "preview",
    error: null,
  };
}

export function updateWorkspaceFileEditor(
  state: WorkspaceFileEditorState,
  action: WorkspaceFileEditorAction,
): WorkspaceFileEditorState {
  if (action.type === "select") {
    return { ...initialWorkspaceFileEditorState(action.sessionId), selectedPath: action.path, status: "loading" };
  }
  if (action.type === "loading") {
    return action.sessionId === state.sessionId ? { ...state, selectedPath: action.path, status: "loading", document: null, error: null } : state;
  }
  if (action.type === "loaded") {
    if (action.sessionId !== state.sessionId || action.path !== state.selectedPath) return state;
    const text = action.document.status === "ready" && action.document.content.type === "text"
      ? action.document.content.text
      : "";
    return {
      ...state,
      status: "ready",
      document: action.document,
      draft: text,
      revision: action.document.status === "ready" ? action.document.revision : null,
      mode: action.document.kind === "text"
        ? /\.(md|markdown|mdx|json)$/i.test(action.document.name) ? "preview" : "source"
        : "preview",
      error: null,
    };
  }
  if (action.type === "failed") return action.sessionId === state.sessionId && action.path === state.selectedPath ? { ...state, status: "error", error: action.error } : state;
  if (action.type === "draft") return action.sessionId === state.sessionId ? { ...state, draft: action.value } : state;
  if (action.type === "mode") return action.sessionId === state.sessionId ? { ...state, mode: action.mode } : state;
  if (action.type === "saving") return action.sessionId === state.sessionId ? { ...state, status: "saving", error: null } : state;
  if (action.type === "saved") {
    if (action.sessionId !== state.sessionId || action.path !== state.selectedPath || state.document?.status !== "ready" || state.document.content.type !== "text") return state;
    return {
      ...state,
      status: "ready",
      revision: action.revision,
      document: { ...state.document, revision: action.revision, content: { type: "text", text: action.text } },
    };
  }
  if (action.type === "clear-error") return action.sessionId === state.sessionId ? { ...state, status: "ready", error: null } : state;
  return state;
}

export function isWorkspaceFileDirty(state: WorkspaceFileEditorState): boolean {
  return Boolean(state.document?.status === "ready"
    && state.document.content.type === "text"
    && state.draft !== state.document.content.text);
}
