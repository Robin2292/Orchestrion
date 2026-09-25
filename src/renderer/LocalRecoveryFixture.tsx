import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeChannel } from "../web-compat/lib/hooks/use-realtime-channel";
import { LocalRealtimeTransport, OrderedJobFeed, realtimeRequest } from "../shared/local-realtime-transport";
import { type JobEvent } from "../shared/realtime-contracts";
import { useDesktopApi } from "./api-context";

const localUrl = () => "local:synthetic-jobs";
export function LocalRecoveryFixture() {
  const api = useDesktopApi()?.localRealtime;
  const [subject, setSubject] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [event, setEvent] = useState<JobEvent | null>(null);
  const [invalidCursor, setInvalidCursor] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const cache = useRef(new Map<string, OrderedJobFeed>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (api) void api.bootstrap().then(authority => {
      if (alive.current) setSubject(sessionStorage.getItem(`synthetic-fixture:${JSON.stringify(authority.context)}`));
    }).catch(() => { if (alive.current) setError(true); });
    return () => { alive.current = false; cache.current.clear(); };
  }, [api]);
  const transport = useCallback(() => new LocalRealtimeTransport(api!, [subject!], cache.current), [api, subject]);
  const channel = useRealtimeChannel({ enabled: !!api && !!subject && connected, getUrl: localUrl,
    channelIdentity: `${subject}:${generation}`, createTransport: transport,
    shouldReconnect: e => e.code === 4009 ? false : e.code === 1008 ? "unauthenticated" : true,
    onClose: e => { if (e.code === 4009) setInvalidCursor(true); if (e.code === 1008) setEvent(null); },
    onMessage: message => setEvent((message.data as JobEvent[])[0]),
  });
  async function queue() {
    if (!api) return;
    setBusy(true); setError(false); setInvalidCursor(false);
    try {
      const authority = await api.bootstrap();
      const result = await realtimeRequest(api, authority, { operation: "enqueue" });
      if (!alive.current) return;
      if (!("subject_id" in result)) throw new Error("INVALID_PAYLOAD");
      sessionStorage.setItem(`synthetic-fixture:${JSON.stringify(authority.context)}`, result.subject_id);
      cache.current.clear(); setEvent(null); setSubject(result.subject_id);
    } catch { if (alive.current) setError(true); }
    finally { if (alive.current) setBusy(false); }
  }
  if (!api) return null;
  return <section className="management-card wide" aria-label="Local recovery proof">
    <div>
      <span className="eyebrow">Personal Local workspace · synthetic fixture</span>
      <h2>Recover a missed result</h2>
      <p>Pause updates, queue a test job, then reconnect. The saved result is recovered even when its notification was missed.</p>
      <div className="management-summary-row">
        <button className="button" onClick={() => setConnected(value => !value)}>{connected ? "Pause updates" : "Reconnect updates"}</button>
        <button className="button" disabled={busy} onClick={() => { void queue(); }}>{busy ? "Queuing…" : "Queue synthetic job"}</button>
      </div>
      <p role="status">{error ? "The local fixture is unavailable. Try again." : !connected
        ? "Updates paused. Reconnect to recover the saved result."
        : event ? `Synthetic job: ${event.data.status}` : subject ? "Recovering saved status…" : "No test job queued."}</p>
      {invalidCursor && <p>Saved cursor is invalid. <button className="button" onClick={() => { cache.current.clear(); setEvent(null); setInvalidCursor(false); setGeneration(v => v + 1); }}>Reload saved status</button></p>}
      {!invalidCursor && subject && connected && channel.connectionState === "disconnected" && <p>{channel.unauthenticated ? "Local context is no longer available." : "Connection interrupted. Recovery will retry."}</p>}
    </div>
  </section>;
}
