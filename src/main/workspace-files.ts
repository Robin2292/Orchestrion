import { constants, lstatSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, opendir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import {
  WORKSPACE_DIRECTORY_ENTRY_LIMIT,
  WORKSPACE_MEDIA_PREVIEW_LIMIT,
  WORKSPACE_TEXT_FILE_LIMIT,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectoryListing,
  type WorkspaceEntryKind,
  type WorkspaceFileKind,
  type WorkspaceFileReadResult,
  type WorkspaceFileSaveResult,
} from "../shared/contracts";

const MAX_WORKSPACE_RELATIVE_PATH_LENGTH = 4_096;

export interface WorkspaceFileSystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  readDirectory(path: string): Promise<Dirent[]>;
}

export interface WorkspaceDirectoryOptions {
  entryLimit?: number;
  fileSystem?: WorkspaceFileSystem;
}

export const nodeWorkspaceFileSystem: WorkspaceFileSystem = {
  lstat,
  realpath,
  stat,
  async readDirectory(path) {
    const directory = await opendir(path);
    const entries: Dirent[] = [];
    for await (const entry of directory) entries.push(entry);
    return entries;
  },
};

interface PathSnapshot {
  lexicalIdentity: Stats;
  canonicalPath: string;
  targetIdentity: Stats;
}

interface WorkspaceFileType {
  kind: WorkspaceFileKind;
  mimeType: string | null;
}

interface ResolvedWorkspaceFile {
  fileSystem: WorkspaceFileSystem;
  rootPath: string;
  lexicalPath: string;
  relativePath: string;
  rootSnapshot: PathSnapshot;
  targetSnapshot: PathSnapshot;
}

const TEXT_TYPES: Readonly<Record<string, string>> = {
  ".c": "text/x-c", ".cc": "text/x-c++", ".conf": "text/plain", ".cpp": "text/x-c++",
  ".css": "text/css", ".csv": "text/csv", ".env": "text/plain", ".go": "text/x-go",
  ".graphql": "text/plain", ".h": "text/x-c", ".hpp": "text/x-c++", ".html": "text/html",
  ".ini": "text/plain", ".java": "text/x-java", ".js": "text/javascript", ".json": "application/json",
  ".jsx": "text/jsx", ".log": "text/plain", ".markdown": "text/markdown", ".md": "text/markdown", ".mdx": "text/markdown",
  ".mjs": "text/javascript", ".py": "text/x-python", ".rb": "text/x-ruby", ".rs": "text/x-rust",
  ".scss": "text/x-scss", ".sh": "text/x-shellscript", ".sql": "text/x-sql", ".svelte": "text/plain",
  ".toml": "application/toml", ".ts": "text/typescript", ".tsx": "text/tsx", ".txt": "text/plain",
  ".vue": "text/plain", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".zsh": "text/x-shellscript",
};

const MEDIA_TYPES: Readonly<Record<string, WorkspaceFileType>> = {
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".bmp": { kind: "image", mimeType: "image/bmp" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".ico": { kind: "image", mimeType: "image/x-icon" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".m4v": { kind: "video", mimeType: "video/mp4" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".oga": { kind: "audio", mimeType: "audio/ogg" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
  ".ogv": { kind: "video", mimeType: "video/ogg" },
  ".pdf": { kind: "pdf", mimeType: "application/pdf" },
  ".png": { kind: "image", mimeType: "image/png" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".webp": { kind: "image", mimeType: "image/webp" },
};

const TEXT_FILENAMES = new Set([
  ".editorconfig", ".gitattributes", ".gitignore", ".npmrc", "dockerfile", "gemfile", "makefile", "procfile",
]);

const saveLocks = new Map<string, Promise<void>>();

export async function listProjectDirectory(
  projectRoot: string,
  relativePath: string,
  options: WorkspaceDirectoryOptions = {},
): Promise<WorkspaceDirectoryListing> {
  const fileSystem = options.fileSystem ?? nodeWorkspaceFileSystem;
  const root = resolve(requiredPath(projectRoot, "Project root"));
  const requestedPath = validateRelativePath(relativePath);
  const lexicalTarget = resolve(root, requestedPath || ".");
  if (!contains(root, lexicalTarget)) throw new Error("Workspace path escapes the project root");
  const normalizedRequestedPath = relative(root, lexicalTarget);

  const rootSnapshot = await snapshotPath(fileSystem, root, "Project root does not exist or cannot be accessed");
  if (!rootSnapshot.targetIdentity.isDirectory()) throw new Error("Project root is not a directory");

  const targetSnapshot = await snapshotPath(fileSystem, lexicalTarget, "Workspace path does not exist or cannot be accessed");
  if (!contains(rootSnapshot.canonicalPath, targetSnapshot.canonicalPath)) {
    throw new Error("Workspace path resolves outside the project root");
  }
  if (!targetSnapshot.targetIdentity.isDirectory()) throw new Error("Workspace path is not a directory");

  // The directory handle pins the directory being enumerated. Portable Node APIs do not
  // provide openat-style child stats, so canonical path and dev/ino are also checked before
  // and after enumeration and around every returned child. Any observed race fails closed.
  const children = await fileSystem.readDirectory(targetSnapshot.canonicalPath);
  await assertStablePath(fileSystem, lexicalTarget, targetSnapshot, "Workspace directory changed while it was being read");
  await assertStablePath(fileSystem, root, rootSnapshot, "Project root changed while workspace files were being read");

  children.sort((left, right) => {
    const directoryOrder = Number(right.isDirectory()) - Number(left.isDirectory());
    return directoryOrder || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
  const requestedEntryLimit = options.entryLimit;
  const requestedLimit = typeof requestedEntryLimit === "number" && Number.isFinite(requestedEntryLimit)
    ? Math.floor(requestedEntryLimit)
    : WORKSPACE_DIRECTORY_ENTRY_LIMIT;
  const boundedLimit = Math.max(1, Math.min(WORKSPACE_DIRECTORY_ENTRY_LIMIT, requestedLimit));
  const entries: WorkspaceDirectoryEntry[] = [];
  for (const child of children.slice(0, boundedLimit)) {
    entries.push(await describeEntry(
      fileSystem,
      rootSnapshot.canonicalPath,
      targetSnapshot.canonicalPath,
      normalizedRequestedPath,
      child.name,
    ));
  }

  await assertStablePath(fileSystem, lexicalTarget, targetSnapshot, "Workspace directory changed while entries were validated");
  await assertStablePath(fileSystem, root, rootSnapshot, "Project root changed while entries were validated");
  return { path: normalizedRequestedPath, entries, truncated: children.length > boundedLimit };
}

export async function readProjectFile(projectRoot: string, relativePath: string): Promise<WorkspaceFileReadResult> {
  const resolved = await resolveWorkspaceFile(projectRoot, relativePath);
  const type = classifyWorkspaceFile(resolved.relativePath);
  const metadata = {
    path: resolved.relativePath,
    name: basename(resolved.relativePath),
    kind: type.kind,
    mimeType: type.mimeType,
    size: safeFileSize(resolved.targetSnapshot.targetIdentity),
    editable: type.kind === "text",
  };
  if (type.kind === "unsupported") return { ...metadata, status: "unsupported", reason: "This file type is not supported in the workspace preview" };

  const maxBytes = type.kind === "text" ? WORKSPACE_TEXT_FILE_LIMIT : WORKSPACE_MEDIA_PREVIEW_LIMIT;
  if (metadata.size > maxBytes) return { ...metadata, status: "too-large", maxBytes };
  const bytes = await readResolvedFile(resolved, maxBytes);
  if (bytes.byteLength > maxBytes) return { ...metadata, size: bytes.byteLength, status: "too-large", maxBytes };
  const revision = revisionFor(bytes);
  if (type.kind === "text") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ...metadata,
        kind: "unsupported",
        mimeType: null,
        editable: false,
        status: "unsupported",
        reason: "This file is not valid UTF-8 text",
      };
    }
    return { ...metadata, status: "ready", revision, content: { type: "text", text } };
  }
  return {
    ...metadata,
    status: "ready",
    revision,
    content: { type: "data-url", dataUrl: `data:${type.mimeType};base64,${bytes.toString("base64")}` },
  };
}

export async function saveProjectTextFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  expectedRevision: string,
  assertActive: () => void = () => {},
): Promise<WorkspaceFileSaveResult> {
  if (typeof content !== "string") throw new Error("Workspace file content must be a string");
  if (typeof expectedRevision !== "string" || !expectedRevision) throw new Error("Expected workspace file revision is required");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > WORKSPACE_TEXT_FILE_LIMIT) throw new Error(`Workspace text file exceeds the ${WORKSPACE_TEXT_FILE_LIMIT}-byte save limit`);

  assertActive();
  const initial = await resolveWorkspaceFile(projectRoot, relativePath);
  return withSaveLock(initial.targetSnapshot.canonicalPath, async () => {
    assertActive();
    const resolved = await resolveWorkspaceFile(projectRoot, relativePath);
    return saveResolvedProjectTextFile(resolved, bytes, expectedRevision, assertActive);
  });
}

async function saveResolvedProjectTextFile(
  resolved: ResolvedWorkspaceFile,
  bytes: Buffer,
  expectedRevision: string,
  assertActive: () => void = () => {},
): Promise<WorkspaceFileSaveResult> {
  if (resolved.targetSnapshot.lexicalIdentity.isSymbolicLink()) throw new Error("Workspace file saves do not follow symbolic links");
  if (classifyWorkspaceFile(resolved.relativePath).kind !== "text") throw new Error("Only supported text workspace files can be saved");
  const current = await readResolvedFile(resolved, WORKSPACE_TEXT_FILE_LIMIT);
  if (revisionFor(current) !== expectedRevision) throw new Error("Workspace file changed since it was opened; reload before saving");

  const temporaryPath = join(dirname(resolved.targetSnapshot.canonicalPath), `.orchestrion-${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    assertActive();
    const temporary = await open(temporaryPath, "wx", resolved.targetSnapshot.targetIdentity.mode & 0o777);
    temporaryExists = true;
    try {
      await temporary.chmod(resolved.targetSnapshot.targetIdentity.mode & 0o777);
      assertActive();
      await temporary.writeFile(bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    // Re-read immediately before the atomic replacement. The per-path lock closes
    // the check/rename gap for every renderer and session in this process. Portable
    // Node has no filesystem compare-and-swap, so a non-cooperating external process
    // can still race this final check; rename() at least never follows a last-moment
    // symlink replacement outside the root. Completed external edits are conflicts.
    await assertResolvedWorkspaceFileStable(resolved, "Workspace file changed while it was being saved");
    const latest = await readResolvedFile(resolved, WORKSPACE_TEXT_FILE_LIMIT);
    if (revisionFor(latest) !== expectedRevision) throw new Error("Workspace file changed since it was opened; reload before saving");
    assertActive(); // no await between live document check and target replacement
    await rename(temporaryPath, resolved.targetSnapshot.canonicalPath);
    temporaryExists = false;
    await syncParentDirectory(dirname(resolved.targetSnapshot.canonicalPath));
    const saved = await stat(resolved.targetSnapshot.canonicalPath);
    return {
      path: resolved.relativePath,
      size: safeFileSize(saved),
      revision: revisionFor(bytes),
      modifiedAt: saved.mtime.toISOString(),
    };
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function resolveProjectFilePath(projectRoot: string, relativePath: string): Promise<string> {
  const resolved = await resolveWorkspaceFile(projectRoot, relativePath);
  await assertResolvedWorkspaceFileStable(resolved, "Workspace file changed while it was being opened");
  return resolved.targetSnapshot.canonicalPath;
}

export interface WorkspaceRootIdentity { canonicalPath: string; dev: number; ino: number }

/** Identity of the project root itself, for frozen placement bindings. The same
 * double-read snapshot makes a root swapped mid-read fail closed. */
export async function snapshotProjectRoot(
  projectRoot: string,
  fileSystem: WorkspaceFileSystem = nodeWorkspaceFileSystem,
): Promise<WorkspaceRootIdentity> {
  const root = resolve(requiredPath(projectRoot, "Project root"));
  const snapshot = await snapshotPath(fileSystem, root, "Project root does not exist or cannot be accessed");
  if (!snapshot.targetIdentity.isDirectory()) throw new Error("Project root is not a directory");
  const { dev, ino } = snapshot.targetIdentity;
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || dev < 0 || ino < 0) throw new Error("Project root identity is invalid");
  return { canonicalPath: snapshot.canonicalPath, dev, ino };
}

/** Final synchronous root check for a caller holding its release transaction.
 * No await may separate this observation from the caller's decision. */
export function snapshotProjectRootSync(projectRoot: string): WorkspaceRootIdentity {
  const root = resolve(requiredPath(projectRoot, "Project root"));
  const read = (): PathSnapshot => {
    const lexicalIdentity = lstatSync(root);
    const canonicalPath = realpathSync(root);
    return { lexicalIdentity, canonicalPath, targetIdentity: statSync(canonicalPath) };
  };
  const first=read(),second=read();
  if (first.canonicalPath!==second.canonicalPath
    || !sameIdentity(first.lexicalIdentity,second.lexicalIdentity)
    || !sameIdentity(first.targetIdentity,second.targetIdentity)
    || !second.targetIdentity.isDirectory()) throw new Error("Project root changed");
  const {dev,ino}=second.targetIdentity;
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || dev<0 || ino<0)
    throw new Error("Project root identity is invalid");
  return {canonicalPath:second.canonicalPath,dev,ino};
}

export type WorkspaceReadErrorCode = "root_invalid" | "outside_root" | "not_found" | "not_a_file" | "too_large" | "drift" | "cancelled";
/** Internal cancellation signal for the bounded read loop; never leaves this module. */
class ReadCancelled extends Error { constructor() { super("cancelled"); this.name = "ReadCancelled"; } }
/** Closed-code failure for the governed read lane. Messages never carry paths. */
export class WorkspaceReadError extends Error {
  constructor(readonly code: WorkspaceReadErrorCode) { super(code); this.name = "WorkspaceReadError"; }
}
export interface BoundedWorkspaceRead {
  relativePath: string;
  /** Path of the realpath-resolved target relative to the realpath-resolved root. */
  canonicalRelativePath: string;
  /** True when the final component itself is a symbolic link. Intermediate link
   * components show up as a canonicalRelativePath that differs from relativePath. */
  symlinked: boolean;
  root: WorkspaceRootIdentity;
  file: { dev: number; ino: number; size: number };
  bytes: Buffer;
}
/** One bounded, descriptor-based read for the governed file.read lane. It reuses
 * the exact double-snapshot resolution and open/fstat/read/fstat/recheck path of
 * the workspace preview, and fails closed with a typed code instead of a message.
 * Callers must still prove the returned root identity against their own bound
 * folder identity; this function proves nothing about which folder was expected. */
export async function readWorkspaceFileBounded(
  projectRoot: string,
  relativePath: string,
  maxBytes: number,
  fileSystem: WorkspaceFileSystem = nodeWorkspaceFileSystem,
  signal?: AbortSignal,
): Promise<BoundedWorkspaceRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new WorkspaceReadError("too_large");
  if (signal?.aborted) throw new WorkspaceReadError("cancelled");
  let rootPath: string, requestedPath: string;
  try { rootPath = resolve(requiredPath(projectRoot, "Project root")); requestedPath = validateRelativePath(relativePath); }
  catch { throw new WorkspaceReadError("outside_root"); }
  const lexicalPath = resolve(rootPath, requestedPath || ".");
  if (!requestedPath || !contains(rootPath, lexicalPath)) throw new WorkspaceReadError("outside_root");
  let rootSnapshot: PathSnapshot;
  try { rootSnapshot = await snapshotPath(fileSystem, rootPath, "root"); } catch { throw new WorkspaceReadError("root_invalid"); }
  if (!rootSnapshot.targetIdentity.isDirectory()) throw new WorkspaceReadError("root_invalid");
  let targetSnapshot: PathSnapshot;
  try { targetSnapshot = await snapshotPath(fileSystem, lexicalPath, "target"); } catch { throw new WorkspaceReadError("not_found"); }
  if (!contains(rootSnapshot.canonicalPath, targetSnapshot.canonicalPath)) throw new WorkspaceReadError("outside_root");
  if (!targetSnapshot.targetIdentity.isFile()) throw new WorkspaceReadError("not_a_file");
  const resolved: ResolvedWorkspaceFile = { fileSystem, rootPath, lexicalPath, relativePath: relative(rootPath, lexicalPath), rootSnapshot, targetSnapshot };
  let size: number;
  try { size = safeFileSize(targetSnapshot.targetIdentity); } catch { throw new WorkspaceReadError("drift"); }
  if (size > maxBytes) throw new WorkspaceReadError("too_large");
  if (signal?.aborted) throw new WorkspaceReadError("cancelled");
  let bytes: Buffer;
  try { bytes = await readResolvedFile(resolved, maxBytes, signal); }
  catch (error) { throw new WorkspaceReadError(error instanceof ReadCancelled ? "cancelled" : "drift"); }
  if (bytes.byteLength > maxBytes) throw new WorkspaceReadError("too_large");
  const { dev, ino } = rootSnapshot.targetIdentity;
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || dev < 0 || ino < 0) throw new WorkspaceReadError("root_invalid");
  return {
    relativePath: resolved.relativePath,
    canonicalRelativePath: relative(rootSnapshot.canonicalPath, targetSnapshot.canonicalPath),
    symlinked: targetSnapshot.lexicalIdentity.isSymbolicLink(),
    root: { canonicalPath: rootSnapshot.canonicalPath, dev, ino },
    file: { dev: targetSnapshot.targetIdentity.dev, ino: targetSnapshot.targetIdentity.ino, size: bytes.byteLength },
    bytes,
  };
}

export function classifyWorkspaceFile(relativePath: string): WorkspaceFileType {
  const name = basename(relativePath).toLowerCase();
  if (
    TEXT_FILENAMES.has(name)
    || name.startsWith(".env.")
    || /^(authors|changelog|contributors|license|readme)(\..*)?$/.test(name)
  ) return { kind: "text", mimeType: "text/plain" };
  const extension = extname(name);
  const textMimeType = TEXT_TYPES[extension];
  if (textMimeType) return { kind: "text", mimeType: textMimeType };
  return MEDIA_TYPES[extension] ?? { kind: "unsupported", mimeType: null };
}

async function resolveWorkspaceFile(
  projectRoot: string,
  relativePath: string,
  fileSystem: WorkspaceFileSystem = nodeWorkspaceFileSystem,
): Promise<ResolvedWorkspaceFile> {
  const rootPath = resolve(requiredPath(projectRoot, "Project root"));
  const requestedPath = validateRelativePath(relativePath);
  const lexicalPath = resolve(rootPath, requestedPath || ".");
  if (!contains(rootPath, lexicalPath)) throw new Error("Workspace path escapes the project root");
  const rootSnapshot = await snapshotPath(fileSystem, rootPath, "Project root does not exist or cannot be accessed");
  if (!rootSnapshot.targetIdentity.isDirectory()) throw new Error("Project root is not a directory");
  const targetSnapshot = await snapshotPath(fileSystem, lexicalPath, "Workspace file does not exist or cannot be accessed");
  if (!contains(rootSnapshot.canonicalPath, targetSnapshot.canonicalPath)) throw new Error("Workspace file resolves outside the project root");
  if (!targetSnapshot.targetIdentity.isFile()) throw new Error("Workspace path is not a file");
  return {
    fileSystem,
    rootPath,
    lexicalPath,
    relativePath: relative(rootPath, lexicalPath),
    rootSnapshot,
    targetSnapshot,
  };
}

async function readResolvedFile(resolved: ResolvedWorkspaceFile, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new ReadCancelled();
  // O_NONBLOCK: a path swapped for a FIFO after the snapshot must not park this
  // host on open() until a writer appears. The descriptor is then proved to be
  // the snapshotted regular file before a single byte is read.
  const handle = await open(resolved.targetSnapshot.canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Workspace path is not a regular file");
    if (!sameIdentity(opened, resolved.targetSnapshot.targetIdentity)) throw new Error("Workspace file changed while it was being read");
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, safeFileSize(opened) + 1));
    let length = 0;
    while (length < buffer.byteLength) {
      if (signal?.aborted) throw new ReadCancelled();
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const closedSnapshot = await handle.stat();
    if (!sameIdentity(opened, closedSnapshot) || opened.size !== closedSnapshot.size || opened.mtimeMs !== closedSnapshot.mtimeMs) {
      throw new Error("Workspace file changed while it was being read");
    }
    await assertResolvedWorkspaceFileStable(resolved, "Workspace file changed while it was being read");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function assertResolvedWorkspaceFileStable(resolved: ResolvedWorkspaceFile, message: string): Promise<void> {
  await assertStablePath(resolved.fileSystem, resolved.lexicalPath, resolved.targetSnapshot, message);
  await assertStablePath(resolved.fileSystem, resolved.rootPath, resolved.rootSnapshot, message);
}

function revisionFor(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeFileSize(stats: Stats): number {
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error("Workspace file size is invalid");
  return stats.size;
}

async function withSaveLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = saveLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const queued = previous.then(() => current);
  saveLocks.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (saveLocks.get(path) === queued) saveLocks.delete(path);
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  // POSIX directory fsync makes the rename durable. Some supported platforms do
  // not allow directory handles, in which case the file itself was still fsynced
  // before the atomic rename.
  let directory;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR") throw error;
  } finally {
    await directory?.close();
  }
}

async function describeEntry(
  fileSystem: WorkspaceFileSystem,
  realRoot: string,
  realParent: string,
  relativeParent: string,
  name: string,
): Promise<WorkspaceDirectoryEntry> {
  const childPath = join(realParent, name);
  const snapshot = await snapshotPath(fileSystem, childPath, "Workspace entry disappeared or cannot be accessed");
  if (!contains(realRoot, snapshot.canonicalPath)) throw new Error("Workspace entry resolves outside the project root");
  await assertStablePath(fileSystem, childPath, snapshot, "Workspace entry changed while it was being validated");

  const kind: WorkspaceEntryKind = snapshot.targetIdentity.isDirectory()
    ? "directory"
    : snapshot.targetIdentity.isFile()
      ? "file"
      : "other";
  const path = relativeParent ? join(relativeParent, name) : name;
  return {
    name,
    path,
    kind,
    symbolicLink: snapshot.lexicalIdentity.isSymbolicLink(),
    accessible: kind !== "other",
  };
}

async function snapshotPath(fileSystem: WorkspaceFileSystem, path: string, message: string): Promise<PathSnapshot> {
  try {
    const first = await readPathSnapshot(fileSystem, path);
    const second = await readPathSnapshot(fileSystem, path);
    if (
      second.canonicalPath !== first.canonicalPath
      || !sameIdentity(second.lexicalIdentity, first.lexicalIdentity)
      || !sameIdentity(second.targetIdentity, first.targetIdentity)
    ) {
      throw new Error(message);
    }
    return second;
  } catch {
    throw new Error(message);
  }
}

async function readPathSnapshot(fileSystem: WorkspaceFileSystem, path: string): Promise<PathSnapshot> {
  const lexicalIdentity = await fileSystem.lstat(path);
  const canonicalPath = await fileSystem.realpath(path);
  const targetIdentity = await fileSystem.stat(canonicalPath);
  return { lexicalIdentity, canonicalPath, targetIdentity };
}

async function assertStablePath(
  fileSystem: WorkspaceFileSystem,
  path: string,
  before: PathSnapshot,
  message: string,
): Promise<void> {
  const after = await snapshotPath(fileSystem, path, message);
  if (
    after.canonicalPath !== before.canonicalPath
    || !sameIdentity(after.lexicalIdentity, before.lexicalIdentity)
    || !sameIdentity(after.targetIdentity, before.targetIdentity)
  ) {
    throw new Error(message);
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateRelativePath(value: string): string {
  if (value.includes("\0")) throw new Error("Workspace path contains an invalid character");
  if (value.length > MAX_WORKSPACE_RELATIVE_PATH_LENGTH) throw new Error("Workspace path is too long");
  if (isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error("Workspace path must be relative to the project root");
  }
  return value === "." ? "" : value;
}

function requiredPath(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function contains(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}
