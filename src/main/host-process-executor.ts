import { createHash } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedExecutionAuthority } from "./execution-authority";
import { sensitiveContentReason, sensitivePathReason } from "../tools/builtins/file-read";
import type { NormalizedGitInvocation } from "../tools/builtins/git-readonly";
import { GOVERNED_GIT_DIFF_TOOL, GOVERNED_TOOL_REASONS } from "../shared/governed-tool-contracts";

export const GOVERNED_GIT_MAX_OUTPUT_BYTES = 512 * 1024;
export const GOVERNED_GIT_TIMEOUT_MS = 15_000;
export const GOVERNED_GIT_TERM_GRACE_MS = 250;

export interface ProcessEvidence {
  placement: "local_trusted";
  isolation: "none";
  exit_code: number | null;
  stdout_hash: string;
  stdout_bytes: number;
  stderr_hash: string;
  stderr_bytes: number;
  truncated: boolean;
  timed_out: boolean;
  cancelled: boolean;
}
export type GitProcessOutcome =
  | { ok: true; text: string; evidence: ProcessEvidence }
  | { ok: false; code: string; evidence?: ProcessEvidence };

/** Host-minted capability. Callers cannot construct one from a cwd, argv or
 * renderer payload; it binds the exact root identity already proven by EP1-A. */
export class ProcessWorkspaceAuthority {
  private constructor(readonly lexicalRoot: string, readonly canonicalRoot: string, readonly dev: number, readonly ino: number) {}
  static fromExecutionAuthority(authority: ResolvedExecutionAuthority): ProcessWorkspaceAuthority {
    if (authority.placement.placement !== "local_trusted" || authority.placement.workspace.kind !== "local_folder"
      || authority.workspace.kind !== "local_folder" || authority.project.canonicalPath !== authority.workspace.canonical_path
      || resolve(authority.project.path) !== resolve(authority.placement.workspace.path))
      throw new Error(GOVERNED_TOOL_REASONS.gitWorkspaceDrift);
    return new ProcessWorkspaceAuthority(authority.project.path, authority.workspace.canonical_path, authority.workspace.dev, authority.workspace.ino);
  }
}

interface RunningProcess {
  child: ChildProcess;
  promise: Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer; stdoutHash: string; stderrHash: string; stdoutBytes: number; stderrBytes: number;
    truncated: boolean; timedOut: boolean; cancelled: boolean; teardownFailed: boolean }>;
  abort(reason: "timeout" | "cancelled" | "truncated" | "shutdown"): void;
}
export interface ProcessTreeSupervisorOptions {
  track?: (pid: number, active: boolean) => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
  termGraceMs?: number;
}

/** Owns detached process groups through `close`, not merely `exit`. TERM is
 * followed by a bounded KILL and pipes remain drained until Node reaps them.
 * The application parent keeps the group pid tracked for this whole interval. */
export class ProcessTreeSupervisor {
  private readonly running = new Set<RunningProcess>();
  private readonly track: (pid: number, active: boolean) => void;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly alive: (pid: number) => boolean;
  private readonly grace: number;
  constructor(options: ProcessTreeSupervisorOptions = {}) {
    this.track = options.track ?? (() => undefined);
    this.kill = options.kill ?? ((pid, signal) => process.kill(-pid, signal));
    this.alive = options.alive ?? ((pid) => {
      try { process.kill(-pid, 0); return true; }
      catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
    });
    this.grace = options.termGraceMs ?? GOVERNED_GIT_TERM_GRACE_MS;
  }

  supervise(child: ChildProcess, signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number): RunningProcess {
    const pid = child.pid;
    if (!pid) throw new Error("PROCESS_SPAWN_FAILED");
    let reason: "timeout" | "cancelled" | "truncated" | "shutdown" | null = null;
    let killTimer: NodeJS.Timeout | undefined, termSentAt = 0, killSent = false;
    const chunksOut: Buffer[] = [], chunksErr: Buffer[] = [];
    const outHash = createHash("sha256"), errHash = createHash("sha256");
    let outBytes = 0, errBytes = 0, overflow = false, settled = false;
    const send = (sig: NodeJS.Signals) => {
      try { this.kill(pid, sig); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
        try { child.kill(sig); } catch { /* the application parent retains the group pid as a final backstop */ }
      }
    };
    const retire = () => {
      if (termSentAt) return;
      termSentAt = Date.now();
      send("SIGTERM");
      killTimer = setTimeout(() => { killSent = true; send("SIGKILL"); }, this.grace);
      killTimer.unref();
    };
    const abort = (next: typeof reason) => {
      if (settled || reason !== null) return;
      reason = next;
      retire();
    };
    const collect = (target: Buffer[], chunk: Buffer | string, stdout: boolean) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      (stdout ? outHash : errHash).update(bytes);
      const current = stdout ? outBytes : errBytes;
      const available = Math.max(0, maxBytes - outBytes - errBytes);
      if (available) target.push(bytes.subarray(0, available));
      if (stdout) outBytes = current + bytes.byteLength; else errBytes = current + bytes.byteLength;
      if (outBytes + errBytes > maxBytes) { overflow = true; abort("truncated"); }
    };
    child.stdout?.on("data", (chunk) => collect(chunksOut, chunk, true));
    child.stderr?.on("data", (chunk) => collect(chunksErr, chunk, false));
    child.once("exit", () => {
      // A helper may outlive the direct child while retaining a pipe. Retire the
      // process group now; `close` below is the reap/drain boundary.
      retire();
    });
    const onAbort = () => abort("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => abort("timeout"), timeoutMs); deadline.unref();
    try { this.track(pid, true); } catch { abort("shutdown"); }
    let control!: RunningProcess;
    const promise = new Promise<Awaited<RunningProcess["promise"]>>((resolvePromise) => {
      child.once("error", () => { /* close is still the single terminal boundary */ });
      child.once("close", async (exitCode) => {
        clearTimeout(deadline);
        retire();
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        const termDeadline = termSentAt + this.grace;
        while (this.alive(pid) && Date.now() < termDeadline) await delay(Math.min(10, Math.max(1, termDeadline - Date.now())));
        if (this.alive(pid) && !killSent) { killSent = true; send("SIGKILL"); }
        // `close` only proves the direct child's stdio is closed. A descendant
        // may have redirected its own pipes and can still be alive. Do not
        // settle or release the parent tracker until the detached group is gone.
        const reapDeadline = Date.now() + Math.max(1_000, this.grace * 20);
        while (this.alive(pid) && Date.now() < reapDeadline) await delay(10);
        const teardownFailed = this.alive(pid);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (!teardownFailed) try { this.track(pid, false); } catch { /* the whole process group is gone */ }
        this.running.delete(control);
        resolvePromise({ exitCode, stdout: Buffer.concat(chunksOut), stderr: Buffer.concat(chunksErr), stdoutHash: `sha256:${outHash.digest("hex")}`,
          stderrHash: `sha256:${errHash.digest("hex")}`, stdoutBytes: outBytes, stderrBytes: errBytes, truncated: overflow || reason === "truncated",
          timedOut: reason === "timeout", cancelled: reason === "cancelled" || reason === "shutdown", teardownFailed });
      });
    });
    control = { child, promise, abort };
    this.running.add(control);
    if (signal?.aborted) abort("cancelled");
    return control;
  }

  async shutdown(): Promise<void> {
    const active = [...this.running];
    active.forEach((item) => item.abort("shutdown"));
    await Promise.allSettled(active.map((item) => item.promise));
  }
}

export interface HostProcessExecutorOptions {
  gitExecutable?: string;
  spawn?: typeof nodeSpawn;
  supervisor?: ProcessTreeSupervisor;
  timeoutMs?: number;
  maxOutputBytes?: number;
  snapshotCheckpoint?: (source: string) => void | Promise<void>;
}

export class HostProcessExecutor {
  private readonly git: string;
  private readonly spawn: typeof nodeSpawn;
  private readonly supervisor: ProcessTreeSupervisor;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly snapshotCheckpoint: ((source: string) => void | Promise<void>) | undefined;
  constructor(options: HostProcessExecutorOptions = {}) {
    this.git = options.gitExecutable ?? "/usr/bin/git";
    if (!this.git.startsWith("/")) throw new Error("GIT_EXECUTABLE_NOT_ABSOLUTE");
    this.spawn = options.spawn ?? nodeSpawn;
    this.supervisor = options.supervisor ?? new ProcessTreeSupervisor();
    this.timeoutMs = options.timeoutMs ?? GOVERNED_GIT_TIMEOUT_MS;
    this.maxBytes = options.maxOutputBytes ?? GOVERNED_GIT_MAX_OUTPUT_BYTES;
    this.snapshotCheckpoint = options.snapshotCheckpoint;
  }

  async execute(authority: ProcessWorkspaceAuthority, invocation: Exclude<NormalizedGitInvocation, { ok: false }>, signal?: AbortSignal): Promise<GitProcessOutcome> {
    if (signal?.aborted) return { ok: false, code: GOVERNED_TOOL_REASONS.cancelled };
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let abortPreflight: (() => void) | undefined;
    const preflight = assertRepository(authority, invocation).then(
      (repository) => ({ kind: "ready" as const, repository }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const deadline = new Promise<{ kind: "timeout" }>((resolvePromise) => { timer = setTimeout(() => resolvePromise({ kind: "timeout" }), this.timeoutMs); timer.unref(); });
    const cancelled = new Promise<{ kind: "cancelled" }>((resolvePromise) => {
      abortPreflight = () => resolvePromise({ kind: "cancelled" }); signal?.addEventListener("abort", abortPreflight, { once: true });
    });
    const checked = await Promise.race([preflight, deadline, cancelled]);
    if (timer) clearTimeout(timer); if (abortPreflight) signal?.removeEventListener("abort", abortPreflight);
    if (checked.kind === "timeout") return { ok: false, code: GOVERNED_TOOL_REASONS.timedOut };
    if (checked.kind === "cancelled") return { ok: false, code: GOVERNED_TOOL_REASONS.cancelled };
    if (checked.kind === "failed") return { ok: false, code: checked.error instanceof GitPreflightError ? checked.error.code : GOVERNED_TOOL_REASONS.gitRepositoryRefused };
    if (signal?.aborted) return { ok: false, code: GOVERNED_TOOL_REASONS.cancelled };
    let repository: IsolatedGitRepository;
    try {
      repository = await isolateGitRepository(authority.canonicalRoot, checked.repository.fileMode, {
        signal, deadlineAt: started + this.timeoutMs, checkpoint: this.snapshotCheckpoint,
      });
    } catch (error) {
      if (error instanceof GitSnapshotInterrupted) return { ok: false, code: error.code };
      return { ok: false, code: GOVERNED_TOOL_REASONS.gitRepositoryRefused };
    }
    const dispose = async (): Promise<boolean> => {
      try { await repository.dispose(); return true; } catch { return false; }
    };
    if (signal?.aborted || Date.now() - started >= this.timeoutMs) {
      await dispose();
      return { ok: false, code: signal?.aborted ? GOVERNED_TOOL_REASONS.cancelled : GOVERNED_TOOL_REASONS.timedOut };
    }
    const argv = gitArgv(invocation);
    let child: ChildProcess;
    try {
      child = this.spawn(this.git, argv, {
        cwd: authority.canonicalRoot, shell: false, detached: true, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"], env: gitEnvironment(authority.canonicalRoot, repository.gitDir, repository.objectDirectory),
      });
    } catch { await dispose(); return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed }; }
    if (!child.pid) { child.once("error", () => undefined); await dispose(); return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed }; }
    const remaining = Math.max(1, this.timeoutMs - (Date.now() - started));
    let result: Awaited<RunningProcess["promise"]>;
    try { result = await this.supervisor.supervise(child, signal, remaining, this.maxBytes).promise; }
    catch {
      try { child.kill("SIGKILL"); } catch { /* no pid or already gone */ }
      await dispose(); return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed };
    }
    const evidence: ProcessEvidence = {
      placement: "local_trusted", isolation: "none", exit_code: result.exitCode,
      stdout_hash: result.stdoutHash, stdout_bytes: result.stdoutBytes,
      stderr_hash: result.stderrHash, stderr_bytes: result.stderrBytes,
      truncated: result.truncated, timed_out: result.timedOut, cancelled: result.cancelled,
    };
    if (!await dispose()) return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed, evidence };
    if (result.teardownFailed) return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed, evidence };
    if (result.cancelled) return { ok: false, code: GOVERNED_TOOL_REASONS.cancelled, evidence };
    if (result.timedOut) return { ok: false, code: GOVERNED_TOOL_REASONS.timedOut, evidence };
    if (result.truncated) return { ok: false, code: GOVERNED_TOOL_REASONS.gitOutputTooLarge, evidence };
    if (result.exitCode !== 0) return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed, evidence };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
    catch { return { ok: false, code: GOVERNED_TOOL_REASONS.gitOutputNotUtf8, evidence }; }
    if (invocation.tool === "git.status") {
      const status = statusOutput(text);
      if (!status.ok) return { ok: false, code: status.code, evidence };
      text = status.text;
    } else if (invocation.tool === GOVERNED_GIT_DIFF_TOOL && !exactDiffOutput(text, invocation.arguments.path)) {
      return { ok: false, code: GOVERNED_TOOL_REASONS.gitPathInvalid, evidence };
    }
    if (sensitiveContentReason(text)) return { ok: false, code: GOVERNED_TOOL_REASONS.gitSensitiveOutput, evidence };
    return { ok: true, text, evidence };
  }

  shutdown(): Promise<void> { return this.supervisor.shutdown(); }
}

interface IsolatedGitRepository { gitDir: string; objectDirectory: string; dispose(): Promise<void> }
interface SnapshotControl { signal?: AbortSignal; deadlineAt: number; checkpoint?: (source: string) => void | Promise<void> }
const safeGitConfig = (fileMode: boolean): string =>
  `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = ${fileMode ? "true" : "false"}\n`;
/** Git has no supported switch that disables only `$GIT_DIR/config`. A random,
 * host-owned metadata view is therefore the execution boundary: Git receives
 * copied index/ref snapshots and the original object database, but its local
 * config, hooks and info/attributes locations are the empty isolated tree.
 * Mutating workspace config or attributes at spawn can no longer introduce a
 * helper command because no helper-bearing config is in Git's actual view. */
async function isolateGitRepository(root: string, fileMode: boolean, control: SnapshotControl): Promise<IsolatedGitRepository> {
  const source = join(root, ".git"), objectDirectory = join(source, "objects");
  await snapshotCheckpoint(control, source);
  const objects = await lstat(objectDirectory).catch(() => null);
  await snapshotCheckpoint(control, objectDirectory);
  const objectCanonical = await realpath(objectDirectory).catch(() => null);
  await snapshotCheckpoint(control, objectDirectory);
  if (!objects?.isDirectory() || objects.isSymbolicLink() || objectCanonical !== objectDirectory)
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  const gitDir = await mkdtemp(join(tmpdir(), "orchestrion-git-readonly-"));
  try {
    await snapshotCheckpoint(control, gitDir);
    await writeFile(join(gitDir, "config"), safeGitConfig(fileMode), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await snapshotCheckpoint(control, gitDir);
    await copySnapshotFile(join(source, "HEAD"), join(gitDir, "HEAD"), 64 * 1024, true, control);
    await copySnapshotFile(join(source, "index"), join(gitDir, "index"), 16 * 1024 * 1024, false, control);
    await copySnapshotFile(join(source, "packed-refs"), join(gitDir, "packed-refs"), 8 * 1024 * 1024, false, control);
    await copySnapshotFile(join(source, "shallow"), join(gitDir, "shallow"), 8 * 1024 * 1024, false, control);
    await copyInfoExclude(source, gitDir, control);
    const budget = { entries: 10_000, bytes: 8 * 1024 * 1024 };
    await copyReferenceDirectory(join(source, "refs"), join(gitDir, "refs"), budget, 0, control);
    await snapshotCheckpoint(control, gitDir);
    return { gitDir, objectDirectory, dispose: () => rm(gitDir, { recursive: true, force: true, maxRetries: 2 }) };
  } catch (error) {
    await rm(gitDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
    throw error;
  }
}

async function copySnapshotFile(source: string, target: string, limit: number, required: boolean, control: SnapshotControl): Promise<void> {
  const value = await readSnapshotBuffer(source, limit, required, control);
  if (value === null) return;
  await snapshotCheckpoint(control, source);
  await writeFile(target, value, { mode: 0o600, flag: "wx" });
  await snapshotCheckpoint(control, source);
}

async function copyInfoExclude(sourceGitDir: string, targetGitDir: string, control: SnapshotControl): Promise<void> {
  const source = join(sourceGitDir, "info"), target = join(targetGitDir, "info");
  await snapshotCheckpoint(control, source);
  const info = await lstat(source).catch(() => null);
  if (!info) return;
  await snapshotCheckpoint(control, source);
  const canonical = await realpath(source).catch(() => null);
  await snapshotCheckpoint(control, source);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== source)
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  await mkdir(target, { mode: 0o700 });
  await snapshotCheckpoint(control, source);
  await copySnapshotFile(join(source, "exclude"), join(target, "exclude"), 1024 * 1024, false, control);
}

async function copyReferenceDirectory(source: string, target: string, budget: { entries: number; bytes: number }, depth: number, control: SnapshotControl): Promise<void> {
  await snapshotCheckpoint(control, source);
  const info = await lstat(source).catch(() => null);
  if (!info) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await snapshotCheckpoint(control, source);
    return;
  }
  await snapshotCheckpoint(control, source);
  if (!info.isDirectory() || info.isSymbolicLink() || depth > 32) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  await mkdir(target, { mode: 0o700 });
  await snapshotCheckpoint(control, source);
  const directory = await opendir(source);
  try {
    while (true) {
      await snapshotCheckpoint(control, source);
      const entry = await directory.read();
      await snapshotCheckpoint(control, source);
      if (!entry) break;
      await snapshotCheckpoint(control, join(source, entry.name));
      if (--budget.entries < 0 || /[\u0000-\u001f\u007f\\/]/.test(entry.name)) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      const from = join(source, entry.name), to = join(target, entry.name), current = await lstat(from).catch(() => null);
      await snapshotCheckpoint(control, from);
      if (!current || current.isSymbolicLink()) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      if (current.isDirectory()) { await copyReferenceDirectory(from, to, budget, depth + 1, control); continue; }
      if (!current.isFile()) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      const value = await readSnapshotBuffer(from, Math.min(64 * 1024, budget.bytes), true, control);
      if (value === null) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      budget.bytes -= value.byteLength;
      if (budget.bytes < 0) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      await snapshotCheckpoint(control, from);
      await writeFile(to, value, { mode: 0o600, flag: "wx" });
      await snapshotCheckpoint(control, from);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function readSnapshotBuffer(path: string, limit: number, required: boolean, control: SnapshotControl): Promise<Buffer | null> {
  return readRegularBuffer(path, limit, required, control);
}

async function readRegularBuffer(path: string, limit: number, required: boolean, control?: SnapshotControl): Promise<Buffer | null> {
  const checkpoint = async (): Promise<void> => { if (control) await snapshotCheckpoint(control, path); };
  await checkpoint();
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW); }
  catch (error) {
    await checkpoint();
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  }
  try {
    await checkpoint();
    const info = await handle.stat();
    await checkpoint();
    if (!info.isFile() || info.size > limit) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
    const chunks: Buffer[] = [];
    let total = 0, position = 0;
    while (true) {
      await checkpoint();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
      await checkpoint();
      if (!bytesRead) break;
      total += bytesRead; position += bytesRead;
      if (total > limit) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close().catch(() => undefined); }
}

class GitSnapshotInterrupted extends Error {
  constructor(readonly code: string) { super(code); }
}
async function snapshotCheckpoint(control: SnapshotControl, source: string): Promise<void> {
  if (control.signal?.aborted) throw new GitSnapshotInterrupted(GOVERNED_TOOL_REASONS.cancelled);
  if (Date.now() >= control.deadlineAt) throw new GitSnapshotInterrupted(GOVERNED_TOOL_REASONS.timedOut);
  await control.checkpoint?.(source);
  if (control.signal?.aborted) throw new GitSnapshotInterrupted(GOVERNED_TOOL_REASONS.cancelled);
  if (Date.now() >= control.deadlineAt) throw new GitSnapshotInterrupted(GOVERNED_TOOL_REASONS.timedOut);
}

export function gitEnvironment(root: string, gitDir: string, objectDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin", HOME: "/var/empty", XDG_CONFIG_HOME: "/var/empty",
    LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_SSH: "/usr/bin/false",
    GIT_PAGER: "cat", PAGER: "cat", GIT_EDITOR: "/usr/bin/false", GIT_SEQUENCE_EDITOR: "/usr/bin/false",
    GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
    GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, "index"), GIT_WORK_TREE: root,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_CEILING_DIRECTORIES: root, GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
  };
}

const COMMON = [
  "--no-pager", "--no-optional-locks", "--no-replace-objects", "--literal-pathspecs",
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null", "-c", "core.alternateRefsCommand=", "-c", "log.showSignature=false",
  "-c", "mailmap.file=/dev/null", "-c", "mailmap.blob=", "-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "credential.interactive=never",
] as const;
export function gitArgv(invocation: Exclude<NormalizedGitInvocation, { ok: false }>): string[] {
  if (invocation.tool === "git.status") return [...COMMON, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=all"];
  if (invocation.tool === GOVERNED_GIT_DIFF_TOOL) return [...COMMON, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all",
    ...(invocation.arguments.cached ? ["--cached"] : []), ...(invocation.arguments.revision ? [invocation.arguments.revision] : []), "--", invocation.arguments.path];
  const format = invocation.arguments.format === "detailed" ? "%H%x09%aI%x09%an%x09%ae%x09%s" : "%h%x09%s";
  return [...COMMON, "log", `--max-count=${invocation.arguments.max_count}`, "--no-decorate", "--no-show-signature", `--format=${format}`, "HEAD"];
}

class GitPreflightError extends Error { constructor(readonly code: string) { super(code); } }
const UNSAFE_SECTION = /\[\s*(?:include|includeif|filter)(?:[.\s\]\"])/i;
const UNSAFE_ASSIGNMENT = /(?:^|[^A-Za-z0-9_-])(?:worktree|fsmonitor|hookspath|alternaterefscommand|external|textconv|objectformat|refstorage|splitindex)\s*=/im;
const BARE_REPOSITORY = /(?:^|[^A-Za-z0-9_-])bare\s*=\s*(?:true|yes|on|1)(?:\s|$|[#;])/im;
function unsafeRepositoryConfig(value: string): boolean {
  // Conservative by design. Git accepts flexible whitespace and subsection
  // layouts, including assignments on a section-header line, so line-start
  // matching is not an authority boundary.
  return UNSAFE_SECTION.test(value) || UNSAFE_ASSIGNMENT.test(value) || BARE_REPOSITORY.test(value);
}

function validatedCoreFileMode(config: string, worktreeConfig: string): boolean {
  const base = validatedGitBoolean(config, "core", "filemode") ?? true;
  const worktreeEnabled = validatedGitBoolean(config, "extensions", "worktreeconfig") ?? false;
  return worktreeEnabled ? validatedGitBoolean(worktreeConfig, "core", "filemode") ?? base : base;
}

function validatedGitBoolean(config: string, wantedSection: string, wantedKey: string): boolean | undefined {
  let result: boolean | undefined, section = "";
  for (const rawLine of config.split(/\r?\n/)) {
    let statement = stripConfigComment(rawLine).trim();
    if (!statement) continue;
    if (statement.startsWith("[")) {
      const close = statement.indexOf("]");
      if (close < 0) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      const header = statement.slice(1, close).trim();
      if (!/^[A-Za-z0-9-]+(?:\s+"(?:[^"\\]|\\.)*"|\.[A-Za-z0-9.-]+)?$/.test(header))
        throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      section = header.toLowerCase() === wantedSection ? wantedSection : "";
      statement = statement.slice(close + 1).trim();
      if (!statement) continue;
    }
    if (section !== wantedSection) continue;
    const assignment = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(.*))?$/.exec(statement);
    if (!assignment) {
      if (new RegExp(wantedKey, "i").test(statement)) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      continue;
    }
    if (assignment[1].toLowerCase() !== wantedKey) continue;
    const value = (assignment[2] ?? "true").trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(value)) result = true;
    else if (["false", "no", "off", "0"].includes(value)) result = false;
    else throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  }
  return result;
}

function stripConfigComment(line: string): string {
  let quoted = false, escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && (char === "#" || char === ";")) return line.slice(0, index);
  }
  return line;
}

async function assertRepository(authority: ProcessWorkspaceAuthority, invocation: Exclude<NormalizedGitInvocation, { ok: false }>): Promise<{ fileMode: boolean }> {
  const lexical = resolve(authority.lexicalRoot);
  const rootLexical = await lstat(lexical).catch(() => null), canonical = await realpath(lexical).catch(() => null), root = await stat(lexical).catch(() => null);
  if (!rootLexical || rootLexical.isSymbolicLink() || !root?.isDirectory() || canonical !== authority.canonicalRoot
    || root.dev !== authority.dev || root.ino !== authority.ino) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitWorkspaceDrift);
  const dotGit = join(canonical, ".git"), dotGitLexical = await lstat(dotGit).catch(() => null);
  // v1 intentionally refuses linked worktrees: their `.git` authority lives
  // outside the bound workspace and is not covered by EP1-A's folder identity.
  if (!dotGitLexical || dotGitLexical.isSymbolicLink() || !dotGitLexical.isDirectory()) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  const dotGitCanonical = await realpath(dotGit).catch(() => null), dotGitIdentity = await stat(dotGit).catch(() => null);
  if (dotGitCanonical !== dotGit || !dotGitIdentity?.isDirectory()) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  for (const critical of ["config", "config.worktree", "index", "objects", "objects/info", "objects/pack", "refs", "refs/heads", "refs/tags", "HEAD", "packed-refs"]) {
    const value = await lstat(join(dotGit, critical)).catch(() => null);
    if (value?.isSymbolicLink()) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  }
  // v1 supports only a self-contained ordinary repository. These files are
  // indirection mechanisms even when they are regular files, not symlinks.
  for (const indirection of ["commondir", "gitdir"]) if (await lstat(join(dotGit, indirection)).catch(() => null))
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  const config = await readBounded(join(dotGit, "config"), 256 * 1024);
  const worktreeConfig = await readBounded(join(dotGit, "config.worktree"), 256 * 1024, true);
  if (unsafeRepositoryConfig(config) || unsafeRepositoryConfig(worktreeConfig))
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  const fileMode = validatedCoreFileMode(config, worktreeConfig);
  for (const name of ["alternates", "http-alternates"]) if (await lstat(join(dotGit, "objects", "info", name)).catch(() => null))
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  if (invocation.tool === GOVERNED_GIT_DIFF_TOOL) await assertLiteralPath(canonical, dotGit, invocation.arguments.path);
  // Close the broad root drift window immediately before spawn. Individual Git
  // metadata remains same-user local_trusted state; the attestation says no OS isolation.
  const final = await stat(canonical).catch(() => null), finalDotGit = await lstat(dotGit).catch(() => null);
  if (!final || final.dev !== authority.dev || final.ino !== authority.ino) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitWorkspaceDrift);
  if (!finalDotGit?.isDirectory() || finalDotGit.isSymbolicLink() || finalDotGit.dev !== dotGitIdentity.dev || finalDotGit.ino !== dotGitIdentity.ino)
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  return { fileMode };
}

async function readBounded(path: string, limit: number, missing = false): Promise<string> {
  const value = await readRegularBuffer(path, limit, !missing);
  if (value === null) return "";
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused); }
}
async function assertLiteralPath(root: string, dotGit: string, relative: string): Promise<void> {
  const segments = relative.split("/");
  if (sensitivePathReason(segments)) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitSensitiveOutput);
  if (!await trackedRegularIndexPath(dotGit, relative)) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitPathInvalid);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    const value = await lstat(current).catch(() => null);
    if (!value) return; // the exact tracked file and any missing parent are a deletion
    if (value.isSymbolicLink() || (i < segments.length - 1 && !value.isDirectory()) || (i === segments.length - 1 && value.isDirectory()))
      throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitPathInvalid);
  }
}

async function trackedRegularIndexPath(dotGit: string, relative: string): Promise<boolean> {
  const index = await readBoundedBuffer(join(dotGit, "index"), 16 * 1024 * 1024);
  if (index.byteLength < 32 || index.subarray(0, 4).toString("ascii") !== "DIRC") throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  const version = index.readUInt32BE(4), count = index.readUInt32BE(8), checksumStart = index.byteLength - 20;
  if ((version !== 2 && version !== 3) || count > 1_000_000 || !createHash("sha1").update(index.subarray(0, checksumStart)).digest().equals(index.subarray(checksumStart)))
    throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  const wanted = Buffer.from(relative, "utf8");
  let offset = 12, found = false;
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    if (start + 62 > checksumStart) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
    const mode = index.readUInt32BE(start + 24), flags = index.readUInt16BE(start + 60);
    let nameStart = start + 62;
    if (flags & 0x4000) {
      if (version < 3 || nameStart + 2 > checksumStart) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
      nameStart += 2;
    }
    const nul = index.indexOf(0, nameStart);
    if (nul < 0 || nul >= checksumStart) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
    const name = index.subarray(nameStart, nul);
    if (name.equals(wanted) && (flags & 0x3000) === 0 && (mode & 0xf000) === 0x8000) found = true;
    offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
    if (offset > checksumStart) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  }
  while (offset < checksumStart) {
    if (offset + 8 > checksumStart) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
    const signature = index.subarray(offset, offset + 4).toString("ascii"), size = index.readUInt32BE(offset + 4);
    if (signature === "link" || offset + 8 + size > checksumStart) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
    offset += 8 + size;
  }
  return found;
}

async function readBoundedBuffer(path: string, limit: number): Promise<Buffer> {
  const value = await readRegularBuffer(path, limit, true);
  if (value === null) throw new GitPreflightError(GOVERNED_TOOL_REASONS.gitRepositoryRefused);
  return value;
}

function statusOutput(text: string): { ok: true; text: string } | { ok: false; code: string } {
  const fields = text.split("\0");
  if (fields.at(-1) !== "") return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed };
  fields.pop();
  const lines: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith("## ")) {
      if (/[\r\n\0]/.test(field)) return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed };
      lines.push(field); continue;
    }
    if (field.length < 4 || field[2] !== " ") return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed };
    const status = field.slice(0, 2), paths = [field.slice(3)];
    if (/[RC]/.test(status)) {
      const source = fields[++i];
      if (source === undefined) return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed };
      paths.push(source);
    }
    for (const path of paths) {
      const segments = path.split("/");
      if (!path || path.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(path) || segments.some((part) => !part || part === "." || part === ".."))
        return { ok: false, code: GOVERNED_TOOL_REASONS.gitProcessFailed };
      if (sensitivePathReason(segments)) return { ok: false, code: GOVERNED_TOOL_REASONS.gitSensitiveOutput };
    }
    lines.push(paths.length === 1 ? `${status} ${JSON.stringify(paths[0])}` : `${status} ${JSON.stringify(paths[0])} <- ${JSON.stringify(paths[1])}`);
  }
  return { ok: true, text: lines.length ? `${lines.join("\n")}\n` : "" };
}

function exactDiffOutput(text: string, relative: string): boolean {
  if (!text) return true;
  const lines = text.split("\n"), expected = `diff --git a/${relative} b/${relative}`;
  const diffHeaders = lines.flatMap((line, index) => line.startsWith("diff --git ") ? [index] : []);
  if (diffHeaders.length !== 1 || lines[diffHeaders[0]] !== expected) return false;
  // Filename markers live only in the extended-header region before the first
  // hunk. A removed line whose content starts `-- ` is rendered as `--- ` in
  // the hunk body and must not be confused with the old-file marker.
  const hunk = lines.findIndex((line, index) => index > diffHeaders[0] && (line.startsWith("@@ ") || line === "GIT binary patch"));
  const headerEnd = hunk < 0 ? lines.length : hunk;
  const header = lines.slice(diffHeaders[0] + 1, headerEnd);
  const oldNames = header.flatMap((line, index) => line.startsWith("--- ") ? [index] : []);
  const newNames = header.flatMap((line, index) => line.startsWith("+++ ") ? [index] : []);
  if (oldNames.length !== newNames.length || oldNames.length > 1) return false;
  if (!oldNames.length) return true; // mode-only or binary summary
  return newNames[0] === oldNames[0] + 1
    && (header[oldNames[0]] === `--- a/${relative}` || header[oldNames[0]] === "--- /dev/null")
    && (header[newNames[0]] === `+++ b/${relative}` || header[newNames[0]] === "+++ /dev/null");
}

function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
