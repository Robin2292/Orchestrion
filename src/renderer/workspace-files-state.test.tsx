import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceFilesView } from "./WorkspaceFiles";
import {
  initialWorkspaceFilesState,
  updateWorkspaceFiles,
  workspaceDirectoryNeedsLoad,
  workspaceDirectoryState,
} from "./workspace-files-state";

const project = { name: "Atlas", path: "/work/atlas" };
const noop = () => undefined;

describe("workspace files state", () => {
  it("keeps children idle until their directory is expanded and loaded", () => {
    let state = initialWorkspaceFilesState("session-1");
    state = updateWorkspaceFiles(state, { type: "loading", sessionId: "session-1", path: "", requestId: 1 });
    state = updateWorkspaceFiles(state, {
      type: "loaded",
      sessionId: "session-1",
      path: "",
      requestId: 1,
      listing: {
        path: "",
        truncated: false,
        entries: [{ name: "src", path: "src", kind: "directory", symbolicLink: false, accessible: true }],
      },
    });

    expect(workspaceDirectoryState(state, "src")).toMatchObject({ expanded: false, status: "idle", entries: [] });
    expect(workspaceDirectoryNeedsLoad(state, "src")).toBe(true);
    state = updateWorkspaceFiles(state, { type: "toggle", path: "src" });
    expect(workspaceDirectoryState(state, "src").expanded).toBe(true);
    expect(workspaceDirectoryNeedsLoad(state, "src")).toBe(true);
  });

  it("ignores stale directory results from a previous session or request", () => {
    let state = initialWorkspaceFilesState("session-2");
    state = updateWorkspaceFiles(state, { type: "loading", sessionId: "session-2", path: "", requestId: 8 });
    const staleSession = updateWorkspaceFiles(state, {
      type: "loaded", sessionId: "session-1", path: "", requestId: 8,
      listing: { path: "", entries: [], truncated: false },
    });
    const staleRequest = updateWorkspaceFiles(state, {
      type: "loaded", sessionId: "session-2", path: "", requestId: 7,
      listing: { path: "", entries: [], truncated: false },
    });
    expect(staleSession).toBe(state);
    expect(staleRequest).toBe(state);
  });
});

describe("WorkspaceFilesView", () => {
  it("renders stable no-session, loading, error, and empty states", () => {
    const noSession = renderToStaticMarkup(<WorkspaceFilesView sessionId={null} project={null} state={initialWorkspaceFilesState()} onToggle={noop} onRetry={noop} />);
    expect(noSession).toContain("Not connected");

    const loadingState = updateWorkspaceFiles(initialWorkspaceFilesState("session-1"), { type: "loading", sessionId: "session-1", path: "", requestId: 1 });
    expect(renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={loadingState} onToggle={noop} onRetry={noop} />)).toContain("Loading project files");

    const errorState = updateWorkspaceFiles(loadingState, { type: "failed", sessionId: "session-1", path: "", requestId: 1, error: "Permission denied" });
    const errorMarkup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={errorState} onToggle={noop} onRetry={noop} />);
    expect(errorMarkup).toContain("Permission denied");
    expect(errorMarkup).toContain("Retry");

    const emptyState = updateWorkspaceFiles(loadingState, { type: "loaded", sessionId: "session-1", path: "", requestId: 1, listing: { path: "", entries: [], truncated: false } });
    expect(renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={emptyState} onToggle={noop} onRetry={noop} />)).toContain("This project is empty");
  });

  it("presents files, collapsed folders, blocked links, and bounded-result notices", () => {
    let state = initialWorkspaceFilesState("session-1");
    state = updateWorkspaceFiles(state, { type: "loading", sessionId: "session-1", path: "", requestId: 1 });
    state = updateWorkspaceFiles(state, {
      type: "loaded", sessionId: "session-1", path: "", requestId: 1,
      listing: { path: "", truncated: true, entries: [
        { name: "src", path: "src", kind: "directory", symbolicLink: false, accessible: true },
        { name: ".env", path: ".env", kind: "file", symbolicLink: false, accessible: true },
        { name: "outside", path: "outside", kind: "other", symbolicLink: true, accessible: false },
      ] },
    });
    const markup = renderToStaticMarkup(<WorkspaceFilesView sessionId="session-1" project={project} state={state} onToggle={noop} onRetry={noop} />);
    expect(markup).toContain('role="tree"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(".env");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Showing the first 500 entries");
  });
});
