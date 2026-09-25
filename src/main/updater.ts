import type { UpdaterState } from "../shared/contracts";

interface UpdateInfo {
  version: string;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
}

interface DownloadProgress { percent: number }

/** The narrow electron-updater surface also lets tests drive the real state machine. */
export interface AutoUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "checking-for-update", listener: () => void): this;
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: UpdateInfo) => void): this;
  on(event: "download-progress", listener: (progress: DownloadProgress) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdaterTimers {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

const realTimers: UpdaterTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: timer => clearInterval(timer),
};
const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function changelog(info: UpdateInfo): UpdaterState["changelog"] {
  const notes = info.releaseNotes;
  if (typeof notes === "string") return [{ version: info.version, notes: notes.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 20).map(line => line.slice(0, 500)) }];
  if (Array.isArray(notes)) return notes.slice(0, 10).map(item => ({ version: item.version.slice(0, 80), notes: (item.note ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 20).map(line => line.slice(0, 500)) }));
  return [];
}

/** Main-process update lifecycle. Network and install operations stay disabled in development. */
export class DesktopUpdater {
  private state: UpdaterState;
  private listeners = new Set<(state: UpdaterState) => void>();
  private started = false;
  private stopped = false;
  private checkInFlight: Promise<UpdaterState> | null = null;
  private downloadInFlight: Promise<UpdaterState> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly packaged: boolean, currentVersion: string,
    private readonly updater: AutoUpdaterPort | null, private readonly timers: UpdaterTimers = realTimers) {
    this.state = { phase: "idle", currentVersion, availableVersion: null, progressPercent: null, changelog: [], error: null };
  }

  getState(): UpdaterState { return this.state; }
  subscribe(listener: (state: UpdaterState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.stopped || !this.packaged || !this.updater) return;
    this.started = true;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.on("checking-for-update", () => {
      if (this.state.phase === "checking") this.emit(this.state);
    });
    this.updater.on("update-available", info => {
      if (this.stopped || this.state.phase !== "checking") return;
      this.emit({ ...this.state, phase: "available", availableVersion: info.version, changelog: changelog(info), error: null });
    });
    this.updater.on("update-not-available", () => {
      if (this.stopped || this.state.phase !== "checking") return;
      this.emit({ ...this.state, phase: "idle", availableVersion: null, changelog: [], error: null });
    });
    this.updater.on("download-progress", progress => {
      if (this.stopped || this.state.phase !== "downloading" || !Number.isFinite(progress.percent)) return;
      this.emit({ ...this.state, progressPercent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
    });
    this.updater.on("update-downloaded", info => {
      if (this.stopped || this.state.phase !== "downloading" || info.version !== this.state.availableVersion) return;
      this.emit({ ...this.state, phase: "ready", progressPercent: 100 });
    });
    this.updater.on("error", () => {
      if (this.stopped || !["checking", "downloading", "installing"].includes(this.state.phase)) return;
      const message = this.state.phase === "checking" ? "Update check failed"
        : this.state.phase === "downloading" ? "Update download failed" : "Update installation failed";
      this.fail(message);
    });
    this.delayTimer = this.timers.setTimeout(() => { void this.check(); }, CHECK_DELAY_MS);
    this.intervalTimer = this.timers.setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS);
  }

  check(): Promise<UpdaterState> {
    if (!this.started || !this.updater || this.stopped || this.state.phase === "downloading" || this.state.phase === "ready" || this.state.phase === "installing")
      return Promise.resolve(this.state);
    if (this.checkInFlight) return this.checkInFlight;
    this.emit({ ...this.state, phase: "checking", availableVersion: null, progressPercent: null, changelog: [], error: null });
    const task = this.updater.checkForUpdates().then(() => this.state, () => {
      if (this.state.phase === "checking") this.fail("Update check failed");
      return this.state;
    });
    this.checkInFlight = task.finally(() => { this.checkInFlight = null; });
    return this.checkInFlight;
  }

  download(): Promise<UpdaterState> {
    if (!this.started || !this.updater || this.stopped || this.state.phase !== "available") return Promise.resolve(this.state);
    if (this.downloadInFlight) return this.downloadInFlight;
    this.emit({ ...this.state, phase: "downloading", progressPercent: 0, error: null });
    const task = this.updater.downloadUpdate().then(() => this.state, () => {
      if (this.state.phase === "downloading") this.fail("Update download failed");
      return this.state;
    });
    this.downloadInFlight = task.finally(() => { this.downloadInFlight = null; });
    return this.downloadInFlight;
  }

  quitAndInstall(): void {
    if (!this.started || !this.updater || this.stopped || this.state.phase !== "ready") return;
    this.emit({ ...this.state, phase: "installing" });
    try { this.updater.quitAndInstall(); }
    catch { this.fail("Update installation failed"); }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.delayTimer) this.timers.clearTimeout(this.delayTimer);
    if (this.intervalTimer) this.timers.clearInterval(this.intervalTimer);
    this.listeners.clear();
  }

  private fail(message: string): void { this.emit({ ...this.state, phase: "error", progressPercent: null, error: message }); }
  private emit(state: UpdaterState): void {
    if (this.stopped) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
