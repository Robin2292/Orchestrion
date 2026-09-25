import type { WorkspaceDirectoryEntry, WorkspaceDirectoryListing } from "../shared/contracts";

export type WorkspaceDirectoryStatus = "idle" | "loading" | "ready" | "error";

export interface WorkspaceDirectoryState {
  expanded: boolean;
  status: WorkspaceDirectoryStatus;
  entries: WorkspaceDirectoryEntry[];
  truncated: boolean;
  error: string | null;
  requestId: number;
}

export interface WorkspaceFilesState {
  sessionId: string | null;
  directories: Record<string, WorkspaceDirectoryState>;
}

export type WorkspaceFilesAction =
  | { type: "reset"; sessionId: string | null }
  | { type: "toggle"; path: string }
  | { type: "loading"; sessionId: string; path: string; requestId: number }
  | { type: "loaded"; sessionId: string; path: string; requestId: number; listing: WorkspaceDirectoryListing }
  | { type: "failed"; sessionId: string; path: string; requestId: number; error: string };

export function initialWorkspaceFilesState(sessionId: string | null = null): WorkspaceFilesState {
  return { sessionId, directories: { "": emptyDirectory(true) } };
}

export function workspaceDirectoryState(state: WorkspaceFilesState, path: string): WorkspaceDirectoryState {
  return state.directories[path] ?? emptyDirectory(false);
}

export function workspaceDirectoryNeedsLoad(state: WorkspaceFilesState, path: string): boolean {
  return workspaceDirectoryState(state, path).status === "idle";
}

export function updateWorkspaceFiles(state: WorkspaceFilesState, action: WorkspaceFilesAction): WorkspaceFilesState {
  if (action.type === "reset") return initialWorkspaceFilesState(action.sessionId);
  if (action.type === "toggle") {
    const directory = workspaceDirectoryState(state, action.path);
    return withDirectory(state, action.path, { ...directory, expanded: !directory.expanded });
  }
  if (action.sessionId !== state.sessionId) return state;
  if (action.type === "loading") {
    const directory = workspaceDirectoryState(state, action.path);
    return withDirectory(state, action.path, { ...directory, status: "loading", error: null, requestId: action.requestId });
  }
  const directory = state.directories[action.path];
  if (!directory || directory.requestId !== action.requestId) return state;
  if (action.type === "failed") {
    return withDirectory(state, action.path, { ...directory, status: "error", error: action.error });
  }
  return withDirectory(state, action.path, {
    ...directory,
    status: "ready",
    entries: action.listing.entries,
    truncated: action.listing.truncated,
    error: null,
  });
}

function emptyDirectory(expanded: boolean): WorkspaceDirectoryState {
  return { expanded, status: "idle", entries: [], truncated: false, error: null, requestId: 0 };
}

function withDirectory(state: WorkspaceFilesState, path: string, directory: WorkspaceDirectoryState): WorkspaceFilesState {
  return { ...state, directories: { ...state.directories, [path]: directory } };
}
