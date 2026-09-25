import { describe, expect, it } from "vitest";
import {
  IPC,
  DESKTOP_BRIDGE_VERSION,
  WORKSPACE_DIRECTORY_ENTRY_LIMIT,
  WORKSPACE_MEDIA_PREVIEW_LIMIT,
  WORKSPACE_TEXT_FILE_LIMIT,
  type ListWorkspaceDirectoryInput,
  type OpenWorkspaceFileInput,
  type OrchestrionDesktopApi,
  type ReadWorkspaceFileInput,
  type SaveWorkspaceFileInput,
  type WorkspaceFileReadResult,
  type WorkspaceDirectoryListing,
} from "./contracts";

describe("workspace files contract", () => {
  it("exposes one bounded session-scoped directory listing call", () => {
    const method: keyof OrchestrionDesktopApi = "listWorkspaceDirectory";
    const input: ListWorkspaceDirectoryInput = { sessionId: "session-1", relativePath: "src" };
    const output: WorkspaceDirectoryListing = { path: "src", entries: [], truncated: false };

    expect(method).toBe("listWorkspaceDirectory");
    expect(input).not.toHaveProperty("projectPath");
    expect(output.entries).toEqual([]);
    expect(IPC.listWorkspaceDirectory).toBe("orchestrion:list-workspace-directory");
    expect(WORKSPACE_DIRECTORY_ENTRY_LIMIT).toBe(500);
  });

  it("exposes session-bound read, optimistic save, and reusable open destinations", () => {
    const readMethod: keyof OrchestrionDesktopApi = "readWorkspaceFile";
    const saveMethod: keyof OrchestrionDesktopApi = "saveWorkspaceFile";
    const openMethod: keyof OrchestrionDesktopApi = "openWorkspaceFile";
    const read: ReadWorkspaceFileInput = { sessionId: "session-1", relativePath: "README.md" };
    const save: SaveWorkspaceFileInput = { ...read, content: "# Updated", expectedRevision: "sha256:old" };
    const open: OpenWorkspaceFileInput = { ...read, destination: "cursor" };
    const fallback: WorkspaceFileReadResult = {
      status: "too-large", path: "movie.mp4", name: "movie.mp4", kind: "video",
      mimeType: "video/mp4", size: WORKSPACE_MEDIA_PREVIEW_LIMIT + 1, editable: false,
      maxBytes: WORKSPACE_MEDIA_PREVIEW_LIMIT,
    };

    expect([readMethod, saveMethod, openMethod]).toEqual(["readWorkspaceFile", "saveWorkspaceFile", "openWorkspaceFile"]);
    expect(read).not.toHaveProperty("projectPath");
    expect(save.expectedRevision).toBe("sha256:old");
    expect(open.destination).toBe("cursor");
    expect(fallback.status).toBe("too-large");
    expect(WORKSPACE_TEXT_FILE_LIMIT).toBe(2 * 1024 * 1024);
    expect(IPC.readWorkspaceFile).toBe("orchestrion:read-workspace-file");
    expect(IPC.saveWorkspaceFile).toBe("orchestrion:save-workspace-file");
    expect(IPC.openWorkspaceFile).toBe("orchestrion:open-workspace-file");
    expect(DESKTOP_BRIDGE_VERSION).toBe(5);
  });
});
