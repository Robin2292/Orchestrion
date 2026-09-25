import { useEffect, useRef, useState } from "react";
import { Cable, LockKeyhole } from "lucide-react";
import type { CodexAccountUiValue } from "../shared/codex-account-ui-contracts";
import { useDesktopApi } from "./api-context";

const unavailable: CodexAccountUiValue = { availability: "unavailable", state: "unavailable",
  accountDisplay: null, executionReady: false };

/** Project-scoped experimental connection. Native Codex App Server auth is separate. */
export function CodexSubscriptionConnection({ projectId }: { projectId: string }) {
  const api = useDesktopApi();
  const [optIn, setOptIn] = useState(false);
  const [value, setValue] = useState<CodexAccountUiValue>(unavailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const displayedProject = useRef(projectId);
  displayedProject.current = projectId;
  useEffect(() => {
    let active = true;
    setOptIn(false);
    setValue(unavailable);
    setBusy(false);
    setError(false);
    if (api?.codexAccount) void api.codexAccount({ operation: "read", projectId }).then(next => {
      if (active && displayedProject.current === projectId) setValue(next);
    }, () => { if (active && displayedProject.current === projectId) setError(true); });
    return () => { active = false; };
  }, [api, projectId]);
  useEffect(() => {
    if (value.state !== "pending" || !api?.codexAccount) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.codexAccount({ operation: "read", projectId }).then(next => {
        if (active && displayedProject.current === projectId) setValue(next);
      }, () => { if (active && displayedProject.current === projectId) setError(true); });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, projectId, value.state]);

  async function act(operation: "start" | "cancel" | "disconnect") {
    if (!api?.codexAccount || busy || (operation === "start" && !optIn)) return;
    const requestedProject = projectId;
    setBusy(true); setError(false);
    try {
      const next = await api.codexAccount(operation === "start"
        ? { operation, projectId, explicitOptIn: true } : { operation, projectId });
      if (displayedProject.current !== requestedProject) return;
      setValue(next);
      if (operation === "disconnect") setOptIn(false);
    } catch { if (displayedProject.current === requestedProject) setError(true); }
    finally { if (displayedProject.current === requestedProject) setBusy(false); }
  }

  const label = value.state === "connected" ? "Credential present" : value.state === "pending"
    ? "Waiting for sign-in" : value.state === "stale" ? "Connection needs attention"
      : value.state === "revoked" ? "Disconnected" : value.availability === "unavailable"
        ? "Sign-in unavailable" : "Not connected";
  return <section className="codex-subscription-card" aria-label="Experimental Codex subscription connection">
    <div className="codex-subscription-heading"><div className="management-card-icon"><Cable size={19} /></div>
      <div><span className="eyebrow">EXPERIMENTAL · Project connection</span>
        <h2>Codex / ChatGPT subscription</h2></div></div>
    <p>This optional connection is not officially supported for third-party provider integration. It does not sign in to the native Codex App Server or enable Agent execution.</p>
    <div className="codex-subscription-state" role="status" aria-live="polite">
      <span className="codex-subscription-dot" aria-hidden="true" />
      <strong>{label}</strong>
      {value.state === "connected" && value.accountDisplay && <span>Account {value.accountDisplay}</span>}
    </div>
    {value.availability === "unavailable" && <p>Connection is unavailable for this Project in this build. A reviewed sign-in registration is not configured.</p>}
    {value.state === "connected" && <p>Connected means a local credential is present. Agent execution readiness and subscription entitlements are checked separately.</p>}
    {error && <p role="alert">Account status could not be verified. Try again.</p>}
    <label className="codex-subscription-opt-in">
      <input type="checkbox" checked={optIn} onChange={event => setOptIn(event.target.checked)} />
      <span>I choose to try this experimental connection</span>
    </label>
    <div className="codex-subscription-actions">
      {value.state === "pending" ? <button type="button" onClick={() => void act("cancel")} disabled={busy}>Cancel sign-in</button>
        : value.state === "connected" || value.state === "stale" ? <button type="button" onClick={() => void act("disconnect")} disabled={busy}>Disconnect local credential</button>
          : <button type="button" onClick={() => void act("start")} disabled={!optIn || busy || value.availability === "unavailable"}>Connect subscription</button>}
    </div>
    <div className="codex-subscription-native"><LockKeyhole size={14} aria-hidden="true" />
      <span>Native Codex App Server login is separate and remains unchanged.</span></div>
  </section>;
}
