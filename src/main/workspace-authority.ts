import { createHash } from "node:crypto";
import { GOVERNED_FILE_READ_MAX_BYTES, GOVERNED_TOOL_REASONS } from "../shared/governed-tool-contracts";
import type { LocalFolderIdentity } from "../shared/execution-attempt-contracts";
import { normalizeFileReadPath, sensitiveContentReason, sensitivePathReason } from "../tools/builtins/file-read";
import type { ResolvedExecutionAuthority } from "./execution-authority";
import { nodeWorkspaceFileSystem, readWorkspaceFileBounded, WorkspaceReadError, type WorkspaceFileSystem } from "./workspace-files";

export type WorkspaceReadOutcome =
  | { ok: true; relativePath: string; text: string; bytes: number; hash: string }
  | { ok: false; code: string };

const construction = Symbol("workspace-authority");
const READ_CODES: Readonly<Record<WorkspaceReadError["code"], string>> = {
  root_invalid: GOVERNED_TOOL_REASONS.workspaceDrift, outside_root: GOVERNED_TOOL_REASONS.pathInvalid, not_found: GOVERNED_TOOL_REASONS.notFound,
  not_a_file: GOVERNED_TOOL_REASONS.notAFile, too_large: GOVERNED_TOOL_REASONS.tooLarge, drift: GOVERNED_TOOL_REASONS.workspaceDrift,
  cancelled: GOVERNED_TOOL_REASONS.cancelled,
};

/** Opaque, non-forgeable capability to read inside exactly one bound project folder.
 * It can only be minted from an EP1-A ResolvedExecutionAuthority by the trusted
 * host; renderer, model and config input never construct or receive one. It
 * exposes no path and no filesystem handle: the sole operation is a bounded,
 * descriptor-based text read that re-proves the live root identity (canonical
 * path, dev, ino) against the identity the attempt was bound to. */
export class WorkspaceAuthority {
  readonly #root: LocalFolderIdentity;
  readonly #projectPath: string;
  readonly #fileSystem: WorkspaceFileSystem;
  private constructor(token: symbol, root: LocalFolderIdentity, projectPath: string, fileSystem: WorkspaceFileSystem) {
    if (token !== construction) throw new Error("WorkspaceAuthority is host-minted only");
    this.#root = structuredClone(root); this.#projectPath = projectPath; this.#fileSystem = fileSystem;
  }
  static fromExecutionAuthority(authority: ResolvedExecutionAuthority, fileSystem: WorkspaceFileSystem = nodeWorkspaceFileSystem): WorkspaceAuthority {
    if (authority.placement.placement !== "local_trusted" || authority.workspace.kind !== "local_folder") throw new Error("EXECUTION_PLACEMENT_UNSUPPORTED");
    return new WorkspaceAuthority(construction, authority.workspace, authority.project.path, fileSystem);
  }
  get identity(): LocalFolderIdentity { return structuredClone(this.#root); }
  /** Reads one UTF-8 text file. `path` is workspace-relative; both the requested
   * and the realpath-resolved relative path must pass the sensitive-path denial. */
  async read(path: unknown, maxBytes = GOVERNED_FILE_READ_MAX_BYTES, signal?: AbortSignal): Promise<WorkspaceReadOutcome> {
    const normalized = normalizeFileReadPath(path);
    if (!normalized.ok) return { ok: false, code: normalized.code };
    if (signal?.aborted) return { ok: false, code: GOVERNED_TOOL_REASONS.cancelled };
    let read;
    try { read = await readWorkspaceFileBounded(this.#projectPath, normalized.relative, maxBytes, this.#fileSystem, signal); }
    catch (error) {
      if (error instanceof WorkspaceReadError) return { ok: false, code: READ_CODES[error.code] };
      return { ok: false, code: GOVERNED_TOOL_REASONS.workspaceDrift };
    }
    if (read.root.canonicalPath !== this.#root.canonical_path || read.root.dev !== this.#root.dev || read.root.ino !== this.#root.ino) {
      return { ok: false, code: GOVERNED_TOOL_REASONS.workspaceDrift };
    }
    // Policy admitted the lexical /workspace/<path> resource. A symbolic link at
    // any component would make the bytes come from a different resource than the
    // one authorized, so aliases are refused outright rather than re-mapped.
    if (read.symlinked || read.canonicalRelativePath !== normalized.relative) return { ok: false, code: GOVERNED_TOOL_REASONS.symlinkRefused };
    const sensitive = sensitivePathReason(read.canonicalRelativePath.split(/[\\/]/).filter(Boolean));
    if (sensitive) return { ok: false, code: sensitive };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes); }
    catch { return { ok: false, code: GOVERNED_TOOL_REASONS.notUtf8 }; }
    // The bytes are in memory and nothing has left this method: a private key
    // under a non-sensitive name is refused here, after the name rules.
    const sensitiveContent = sensitiveContentReason(text);
    if (sensitiveContent) return { ok: false, code: sensitiveContent };
    return { ok: true, relativePath: normalized.relative, text, bytes: read.bytes.byteLength, hash: `sha256:${createHash("sha256").update(read.bytes).digest("hex")}` };
  }
}
