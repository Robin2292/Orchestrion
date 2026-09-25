import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_MAX_COLUMNS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLUMNS,
  TERMINAL_MIN_ROWS,
  type AcknowledgeTerminalOutputInput,
  type CloseTerminalInput,
  type CreateTerminalInput,
  type ResizeTerminalInput,
  type TerminalEvent,
  type TerminalHandle,
  type TerminalInput,
} from "../shared/contracts";

export interface Disposable {
  dispose(): void;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface WorkspacePty {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExitEvent) => void): Disposable;
}

export interface SpawnWorkspacePtyOptions {
  shell: string;
  args: string[];
  cwd: string;
  columns: number;
  rows: number;
  env: Record<string, string>;
}

export interface WorkspacePtyFactory {
  spawn(options: SpawnWorkspacePtyOptions, assertActive?: () => void): WorkspacePty | Promise<WorkspacePty>;
}

export interface TerminalOwner {
  id: string;
  isActive(): boolean;
  publish(event: TerminalEvent): void;
}

interface PendingCreate {
  sessionId: string;
  ownerId: string;
  generation: number;
  cancelled: boolean;
  cancellation: Promise<void>;
  cancel(): void;
}

interface TerminalEntry {
  terminalId: string;
  sessionId: string;
  owner: TerminalOwner;
  pty: WorkspacePty;
  subscriptions: Disposable[];
  bufferedOutput: string;
  bufferedBytes: number;
  outputTruncated: boolean;
  flushScheduled: boolean;
  nextSequence: number;
  awaitingAcknowledgement: number | null;
  pendingExit: PtyExitEvent | null;
  closed: boolean;
}

type ResolveProjectPath = (sessionId: string) => string;
type Schedule = (callback: () => void) => void;
export type ScheduleTerminalCreate = (operation: () => Promise<TerminalHandle>) => Promise<TerminalHandle>;

const OUTPUT_TRUNCATED_MARKER = "\r\n[Earlier terminal output was truncated]\r\n";

export const nodePtyFactory: WorkspacePtyFactory = {
  async spawn(options, assertActive) {
    const { spawn } = await import("node-pty");
    assertActive?.();
    return spawn(options.shell, options.args, {
      name: "xterm-256color",
      cols: options.columns,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
  },
};

export class WorkspaceTerminalService {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly terminalBySession = new Map<string, string>();
  private readonly sessionOperations = new Map<string, Promise<void>>();
  private readonly pendingCreates = new Set<PendingCreate>();
  private generation = 0;

  constructor(
    private readonly resolveProjectPath: ResolveProjectPath,
    private readonly factory: WorkspacePtyFactory = nodePtyFactory,
    private readonly schedule: Schedule = (callback) => setImmediate(callback),
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async create(
    owner: TerminalOwner,
    input: CreateTerminalInput,
    scheduleCreate: ScheduleTerminalCreate = (operation) => operation(),
  ): Promise<TerminalHandle> {
    const sessionId = validId(input?.sessionId, "Session id");
    const columns = validDimension(input?.columns, "Terminal columns", TERMINAL_MIN_COLUMNS, TERMINAL_MAX_COLUMNS);
    const rows = validDimension(input?.rows, "Terminal rows", TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS);
    validOwner(owner);
    let signalCancellation!: () => void;
    const pending: PendingCreate = {
      sessionId,
      ownerId: owner.id,
      generation: this.generation,
      cancelled: false,
      cancellation: new Promise<void>((resolve) => { signalCancellation = resolve; }),
      cancel: () => {
        pending.cancelled = true;
        signalCancellation();
      },
    };
    this.pendingCreates.add(pending);

    try {
      return await scheduleCreate(() => this.withSessionLock(sessionId, async () => {
        this.assertCreateActive(pending, owner);
        const existingId = this.terminalBySession.get(sessionId);
        if (existingId) {
          const existing = this.terminals.get(existingId);
          if (existing && existing.owner.id !== owner.id) throw new Error("This session terminal belongs to another renderer");
          if (existing) this.closeEntry(existing, "closed");
        }

        const cwd = this.resolveProjectPath(sessionId);
        if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Session project path must be absolute");
        const spawning = Promise.resolve(this.factory.spawn({
          ...defaultShell(this.platform, this.environment),
          cwd,
          columns,
          rows,
          env: terminalEnvironment(this.environment),
        }, () => this.assertCreateActive(pending, owner)));
        const result = await Promise.race([
          spawning.then((pty) => ({ cancelled: false as const, pty })),
          pending.cancellation.then(() => ({ cancelled: true as const })),
        ]);
        if (result.cancelled) {
          void spawning.then(killPty, () => undefined);
          throw new Error("Terminal creation was cancelled");
        }
        const pty = result.pty;
        try {
          this.assertCreateActive(pending, owner);
        } catch (error) {
          killPty(pty);
          throw error;
        }
        const terminalId = randomUUID();
        const entry: TerminalEntry = {
          terminalId,
          sessionId,
          owner,
          pty,
          subscriptions: [],
          bufferedOutput: "",
          bufferedBytes: 0,
          outputTruncated: false,
          flushScheduled: false,
          nextSequence: 1,
          awaitingAcknowledgement: null,
          pendingExit: null,
          closed: false,
        };
        this.terminals.set(terminalId, entry);
        this.terminalBySession.set(sessionId, terminalId);
        entry.subscriptions.push(
          pty.onData((data) => this.enqueueOutput(entry, data)),
          pty.onExit((event) => this.handleExit(entry, event)),
        );
        return { terminalId, sessionId };
      }));
    } finally {
      this.pendingCreates.delete(pending);
    }
  }

  input(ownerId: string, input: TerminalInput): void {
    const entry = this.ownedEntry(ownerId, input);
    if (typeof input.data !== "string") throw new Error("Terminal input must be a string");
    const size = Buffer.byteLength(input.data, "utf8");
    if (size === 0) return;
    if (size > TERMINAL_MAX_INPUT_BYTES) throw new Error(`Terminal input exceeds ${TERMINAL_MAX_INPUT_BYTES} bytes`);
    entry.pty.write(input.data);
  }

  resize(ownerId: string, input: ResizeTerminalInput): void {
    const entry = this.ownedEntry(ownerId, input);
    const columns = validDimension(input.columns, "Terminal columns", TERMINAL_MIN_COLUMNS, TERMINAL_MAX_COLUMNS);
    const rows = validDimension(input.rows, "Terminal rows", TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS);
    entry.pty.resize(columns, rows);
  }

  acknowledgeOutput(ownerId: string, input: AcknowledgeTerminalOutputInput): void {
    const terminalId = validId(input?.terminalId, "Terminal id");
    const sessionId = validId(input?.sessionId, "Session id");
    const entry = this.terminals.get(terminalId);
    if (!entry || entry.closed) return;
    this.assertOwnership(entry, ownerId, sessionId);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("Terminal output sequence is invalid");
    if (entry.awaitingAcknowledgement !== input.sequence) throw new Error("Terminal output acknowledgement is out of sequence");
    entry.awaitingAcknowledgement = null;
    if (entry.bufferedBytes > 0) this.scheduleFlush(entry);
    else this.completeNaturalExit(entry);
  }

  close(ownerId: string, input: CloseTerminalInput): void {
    const terminalId = validId(input?.terminalId, "Terminal id");
    const sessionId = validId(input?.sessionId, "Session id");
    const existing = this.terminals.get(terminalId);
    if (!existing) return;
    this.assertOwnership(existing, ownerId, sessionId);
    this.closeEntry(existing, "closed");
  }

  closeSessionForOwner(ownerId: string, sessionId: string): void {
    const normalizedOwner = validId(ownerId, "Terminal owner id");
    const normalizedSession = validId(sessionId, "Session id");
    this.cancelPending((pending) => pending.ownerId === normalizedOwner && pending.sessionId === normalizedSession);
    for (const entry of [...this.terminals.values()]) {
      if (entry.owner.id === normalizedOwner && entry.sessionId === normalizedSession) this.closeEntry(entry, "closed");
    }
  }

  closeSession(sessionId: string): void {
    const normalized = validId(sessionId, "Session id");
    this.cancelPending((pending) => pending.sessionId === normalized);
    for (const entry of [...this.terminals.values()]) {
      if (entry.sessionId === normalized) this.closeEntry(entry, "closed");
    }
  }

  closeOwner(ownerId: string): void {
    this.cancelPending((pending) => pending.ownerId === ownerId);
    for (const entry of [...this.terminals.values()]) {
      if (entry.owner.id === ownerId) this.closeEntry(entry, "closed", false);
    }
  }

  closeAll(): void {
    this.generation += 1;
    this.cancelPending(() => true);
    for (const entry of [...this.terminals.values()]) this.closeEntry(entry, "closed", false);
  }

  get activeTerminalCount(): number {
    return this.terminals.size;
  }

  private ownedEntry(ownerId: string, input: { terminalId: string; sessionId: string }): TerminalEntry {
    const terminalId = validId(input?.terminalId, "Terminal id");
    const sessionId = validId(input?.sessionId, "Session id");
    const entry = this.terminals.get(terminalId);
    if (!entry || entry.closed) throw new Error("Terminal is closed or unavailable");
    this.assertOwnership(entry, ownerId, sessionId);
    return entry;
  }

  private assertOwnership(entry: TerminalEntry, ownerId: string, sessionId: string): void {
    if (entry.owner.id !== ownerId || entry.sessionId !== sessionId) throw new Error("Terminal ownership mismatch");
  }

  private enqueueOutput(entry: TerminalEntry, data: string): void {
    if (entry.closed || entry.pendingExit || typeof data !== "string" || data.length === 0) return;
    const incomingBytes = Buffer.byteLength(data, "utf8");
    const next = `${entry.bufferedOutput}${utf8Tail(data, TERMINAL_MAX_BUFFERED_OUTPUT_BYTES)}`;
    const nextBytes = Buffer.byteLength(next, "utf8");
    if (incomingBytes > TERMINAL_MAX_BUFFERED_OUTPUT_BYTES || nextBytes > TERMINAL_MAX_BUFFERED_OUTPUT_BYTES) {
      entry.bufferedOutput = utf8Tail(next, TERMINAL_MAX_BUFFERED_OUTPUT_BYTES);
      entry.bufferedBytes = Buffer.byteLength(entry.bufferedOutput, "utf8");
      entry.outputTruncated = true;
    } else {
      entry.bufferedOutput = next;
      entry.bufferedBytes = nextBytes;
    }
    this.scheduleFlush(entry);
  }

  private scheduleFlush(entry: TerminalEntry): void {
    if (entry.closed || entry.bufferedBytes === 0 || entry.flushScheduled || entry.awaitingAcknowledgement !== null) return;
    entry.flushScheduled = true;
    this.schedule(() => this.flushOutput(entry));
  }

  private flushOutput(entry: TerminalEntry): void {
    entry.flushScheduled = false;
    if (entry.closed || entry.bufferedBytes === 0 || entry.awaitingAcknowledgement !== null) return;
    let data = entry.bufferedOutput;
    if (entry.outputTruncated) {
      const available = TERMINAL_MAX_BUFFERED_OUTPUT_BYTES - Buffer.byteLength(OUTPUT_TRUNCATED_MARKER, "utf8");
      data = `${OUTPUT_TRUNCATED_MARKER}${utf8Tail(data, available)}`;
    }
    entry.bufferedOutput = "";
    entry.bufferedBytes = 0;
    entry.outputTruncated = false;
    const sequence = entry.nextSequence++;
    entry.awaitingAcknowledgement = sequence;
    try {
      entry.owner.publish({ type: "output", terminalId: entry.terminalId, sessionId: entry.sessionId, sequence, data });
    } catch {
      this.closeEntry(entry, "closed", false);
    }
  }

  private handleExit(entry: TerminalEntry, event: PtyExitEvent): void {
    if (entry.closed || entry.pendingExit) return;
    entry.pendingExit = event;
    if (entry.awaitingAcknowledgement === null && entry.bufferedBytes > 0) this.flushOutput(entry);
    else this.completeNaturalExit(entry);
  }

  private closeEntry(entry: TerminalEntry, reason: "closed", publish = true): void {
    if (entry.closed) return;
    this.finalize(entry);
    killPty(entry.pty);
    if (publish) this.publishExit(entry, null, null, reason);
  }

  private finalize(entry: TerminalEntry): void {
    entry.closed = true;
    entry.bufferedOutput = "";
    entry.bufferedBytes = 0;
    entry.outputTruncated = false;
    for (const subscription of entry.subscriptions.splice(0)) subscription.dispose();
    this.terminals.delete(entry.terminalId);
    if (this.terminalBySession.get(entry.sessionId) === entry.terminalId) this.terminalBySession.delete(entry.sessionId);
  }

  private completeNaturalExit(entry: TerminalEntry): void {
    if (entry.closed || !entry.pendingExit || entry.awaitingAcknowledgement !== null || entry.bufferedBytes > 0) return;
    const event = entry.pendingExit;
    this.finalize(entry);
    this.publishExit(entry, event.exitCode, event.signal ?? null, "exit");
  }

  private cancelPending(predicate: (pending: PendingCreate) => boolean): void {
    for (const pending of this.pendingCreates) {
      if (predicate(pending)) pending.cancel();
    }
  }

  private assertCreateActive(pending: PendingCreate, owner: TerminalOwner): void {
    if (pending.cancelled || pending.generation !== this.generation || !owner.isActive()) {
      throw new Error("Terminal creation was cancelled");
    }
  }

  private publishExit(entry: TerminalEntry, exitCode: number | null, signal: number | null, reason: "exit" | "closed"): void {
    try {
      entry.owner.publish({ type: "exit", terminalId: entry.terminalId, sessionId: entry.sessionId, exitCode, signal, reason });
    } catch {
      // A destroyed renderer has no remaining subscriber and is cleaned up above.
    }
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.sessionOperations.set(sessionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionOperations.get(sessionId) === queued) this.sessionOperations.delete(sessionId);
    }
  }
}

export function defaultShell(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): { shell: string; args: string[] } {
  if (platform === "win32") return { shell: environment.ComSpec?.trim() || "powershell.exe", args: [] };
  const configured = environment.SHELL?.trim();
  return { shell: configured && isAbsolute(configured) ? configured : platform === "darwin" ? "/bin/zsh" : "/bin/sh", args: [] };
}

function terminalEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string" && key !== "ELECTRON_RUN_AS_NODE") result[key] = value;
  }
  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  return result;
}

function validDimension(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validId(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes("\0")) throw new Error(`${label} is invalid`);
  return normalized;
}

function validOwner(owner: TerminalOwner): void {
  if (!owner || typeof owner.id !== "string" || !owner.id || owner.id.length > 256 || typeof owner.isActive !== "function" || typeof owner.publish !== "function") {
    throw new Error("Terminal renderer owner is invalid");
  }
}

function killPty(pty: WorkspacePty): void {
  try {
    pty.kill();
  } catch {
    // Ownership is already revoked even if the OS process exited concurrently.
  }
}

function utf8Tail(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
