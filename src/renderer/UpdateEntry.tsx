import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Download, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { UpdaterBridgeApi, UpdaterState } from "../shared/contracts";

interface UpdateEntryProps {
  bridge?: UpdaterBridgeApi;
  workspaceDirty: boolean;
  onDiscardWorkspaceChanges: () => void;
}

function phaseLabel(state: UpdaterState | null, checked: boolean, bridgeError: string | null): string {
  if (bridgeError) return "Update service unavailable · Check again";
  if (!state) return "Loading update status";
  switch (state.phase) {
    case "available":
      return `Update available · v${state.availableVersion ?? ""}`.trim();
    case "downloading":
      return `Downloading · ${state.progressPercent ?? 0}%`;
    case "ready":
      return "Ready to restart";
    case "installing":
      return "Installing update";
    case "checking":
      return "Checking for updates";
    case "error":
      return "Update failed · Check again";
    default:
      return checked ? "You're up to date" : "Check for updates";
  }
}

function phaseHint(state: UpdaterState | null, checked: boolean, bridgeError: string | null): string {
  if (bridgeError) return bridgeError;
  if (!state) return "Loading update status";
  switch (state.phase) {
    case "available":
      return `Update to v${state.availableVersion ?? ""}`.trim();
    case "downloading":
      return `Downloading update, ${state.progressPercent ?? 0}%`;
    case "ready":
      return "Restart to apply the update";
    case "installing":
      return "Installing update";
    case "checking":
      return "Checking for updates";
    case "error":
      return state.error ?? "Update failed";
    default:
      return checked ? "No update available" : "Check for updates";
  }
}

function phaseIcon(phase: UpdaterState["phase"] | "loading") {
  if (phase === "loading" || phase === "checking" || phase === "downloading" || phase === "installing") {
    return <LoaderCircle className="spin" size={17} aria-hidden="true" />;
  }
  if (phase === "error") return <AlertCircle size={17} aria-hidden="true" />;
  return <Download size={17} aria-hidden="true" />;
}

function useUpdateDriver(bridge?: UpdaterBridgeApi) {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const eventVersion = useRef(0);
  const sawChecking = useRef(false);

  const accept = useCallback((next: UpdaterState) => {
    if (next.phase === "checking") { sawChecking.current = true; setChecked(false); }
    if (next.phase === "idle" && sawChecking.current) setChecked(true);
    if (next.phase === "available") setChecked(false);
    setState(next);
    setBridgeError(null);
  }, []);

  useEffect(() => {
    if (!bridge) { setBridgeError("Update service unavailable in this window."); return; }
    let active = true;
    const unsubscribe = bridge.onState((next) => {
      if (!active) return;
      eventVersion.current += 1;
      accept(next);
    });
    const before = eventVersion.current;
    void bridge.getState().then((next) => {
      if (active && eventVersion.current === before) accept(next);
    }).catch(() => {
      if (active && eventVersion.current === before) setBridgeError("Update service unavailable. Try again.");
    });
    return () => { active = false; unsubscribe(); };
  }, [accept, bridge]);

  const run = useCallback(async (command: "check" | "download" | "quitAndInstall") => {
    if (!bridge || pending) return;
    setPending(true);
    const before = eventVersion.current;
    try {
      if (command === "quitAndInstall") await bridge.quitAndInstall();
      else {
        const next = await bridge[command]();
        if (eventVersion.current === before) {
          accept(next);
          if (command === "check" && next.phase === "idle") {
            setBridgeError("Update checks are available in the installed app.");
          }
        }
      }
    } catch {
      setBridgeError("Update service unavailable. Try again.");
    } finally {
      setPending(false);
    }
  }, [accept, bridge, pending]);

  return { state, bridgeError, checked, pending, run };
}

function changelogNotes(state: UpdaterState): readonly string[] {
  return state.changelog[0]?.notes ?? [];
}

export function UpdateEntry({ bridge, workspaceDirty, onDiscardWorkspaceChanges }: UpdateEntryProps) {
  const { state, bridgeError, checked, pending, run } = useUpdateDriver(bridge);
  const [open, setOpen] = useState(false);
  const [restartAfterDiscard, setRestartAfterDiscard] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const phase = bridgeError ? "error" : state?.phase ?? "loading";

  useEffect(() => {
    if (!restartAfterDiscard) return;
    setRestartAfterDiscard(false);
    if (!workspaceDirty && !pending && state?.phase === "ready") void run("quitAndInstall");
  }, [restartAfterDiscard, workspaceDirty, pending, run, state?.phase]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const startDownload = () => { void run("download"); };

  const handleTriggerClick = () => setOpen((value) => !value);

  const handleRetry = () => {
    void run("check");
  };

  const handleInstall = () => {
    if (workspaceDirty) {
      if (!window.confirm("Discard unsaved changes and restart to update?")) return;
      onDiscardWorkspaceChanges();
      setRestartAfterDiscard(true);
      return;
    }
    void run("quitAndInstall");
  };

  const dismiss = () => setOpen(false);

  return (
    <div className={`update-entry-anchor phase-${phase}`} ref={anchorRef}>
      <button
        type="button"
        className={`update-entry-trigger phase-${phase}`}
        data-phase={phase}
        aria-label={phaseHint(state, checked, bridgeError)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="update-entry-popover"
        title={phaseHint(state, checked, bridgeError)}
        onClick={handleTriggerClick}
      >
        {phaseIcon(phase)}
        <span className="update-entry-tooltip" aria-hidden="true">{phaseLabel(state, checked, bridgeError)}</span>
      </button>

      {open && (
        <div id="update-entry-popover" className={`update-popover phase-${phase}`} role="dialog" aria-label="Software update">
          <header className="update-popover-head">
            <span className="update-popover-icon">{phaseIcon(phase)}</span>
            <div className="update-popover-title">
              <strong>{bridgeError ? "Update unavailable" : state ? popoverTitle(state, checked) : "Loading update status"}</strong>
              <span>{state ? popoverSubtitle(state) : "Waiting for the desktop app"}</span>
            </div>
            <button type="button" className="icon-button update-popover-close" onClick={dismiss} aria-label="Close update panel" title="Close">
              <X size={14} aria-hidden="true" />
            </button>
          </header>

          {!bridgeError && state && (state.phase === "available" || state.phase === "downloading" || state.phase === "ready") && (
            <>
              <dl className="update-version-row">
                <div><dt>New version</dt><dd>v{state.availableVersion}</dd></div>
                <div><dt>Current version</dt><dd>v{state.currentVersion}</dd></div>
              </dl>
              <span className="update-changelog-heading">What's new</span>
              {changelogNotes(state).length ? <ul className="update-changelog">
                {changelogNotes(state).map((note) => <li key={note}>{note}</li>)}
              </ul> : <p className="update-popover-note">Release notes are unavailable.</p>}
              {state.phase === "available" && (
                <footer className="update-popover-actions">
                  <button type="button" className="button primary-button" onClick={startDownload} disabled={pending}>
                    <Download size={13} aria-hidden="true" /> Download update
                  </button>
                  <button type="button" className="button secondary-button" onClick={dismiss}>Later</button>
                </footer>
              )}

              {state.phase === "downloading" && (
                <>
                  <div
                    className="update-progress"
                    role="progressbar"
                    aria-label="Update download"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={state.progressPercent ?? 0}
                  >
                    <span style={{ width: `${state.progressPercent ?? 0}%` }} />
                  </div>
                  <p className="update-popover-note" aria-live="polite">{state.progressPercent ?? 0}% downloaded</p>
                  <footer className="update-popover-actions">
                    <button type="button" className="button secondary-button" onClick={dismiss}>Later</button>
                  </footer>
                </>
              )}

              {state.phase === "ready" && (
                <>
                  <p className="update-popover-note">v{state.availableVersion ?? ""} is ready. Restarting applies it now.</p>
                  <footer className="update-popover-actions">
                    <button type="button" className="button primary-button" onClick={handleInstall} disabled={pending}>Restart to update</button>
                    <button type="button" className="button secondary-button" onClick={dismiss}>Later</button>
                  </footer>
                </>
              )}
            </>
          )}

          {phase === "idle" && state && (
            <>
              <p className="update-popover-note">{checked ? "You're up to date." : "Check for a newer version of Orchestrion."}</p>
              <footer className="update-popover-actions">
                <button type="button" className="button primary-button" onClick={() => void run("check")} disabled={pending}>Check for updates</button>
                <button type="button" className="button secondary-button" onClick={dismiss}>Later</button>
              </footer>
            </>
          )}

          {phase === "error" && (
            <>
              <p className="update-popover-note error">{bridgeError ?? state?.error ?? "Update failed."}</p>
              <footer className="update-popover-actions">
                <button type="button" className="button retry-button" onClick={handleRetry} disabled={!bridge || pending}>
                  <RotateCcw size={13} aria-hidden="true" /> Check again
                </button>
                <button type="button" className="button secondary-button" onClick={dismiss}>Later</button>
              </footer>
            </>
          )}

          {phase === "installing" && (
            <p className="update-popover-note">Installing the update…</p>
          )}
        </div>
      )}
    </div>
  );
}

function popoverTitle(state: UpdaterState, checked: boolean): string {
  switch (state.phase) {
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "ready":
      return "Ready to restart";
    case "installing":
      return "Installing update";
    case "checking":
      return "Checking for updates";
    case "error":
      return "Update failed";
    default:
      return checked ? "You're up to date" : "Software update";
  }
}

function popoverSubtitle(state: UpdaterState): string {
  switch (state.phase) {
    case "available":
      return `v${state.currentVersion} → v${state.availableVersion ?? ""}`;
    case "downloading":
    case "ready":
    case "installing":
      return `v${state.availableVersion ?? ""}`;
    default:
      return `Current version v${state.currentVersion}`;
  }
}
