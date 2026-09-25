import type { RealtimeTransport } from "../web-compat/lib/realtime/ws-utils";
import { LOCAL_CONTRACT_VERSION } from "./local-contracts";
import { PageSchema, SnapshotSchema, type Cursor, type JobEvent, type LocalRealtimeApi, type RealtimeRequest } from "./realtime-contracts";
import type { LocalAuthoritySnapshot } from "./local-command-adapter";

export async function realtimeRequest(api: LocalRealtimeApi, authority: LocalAuthoritySnapshot, payload: RealtimeRequest) {
  return api.request(JSON.stringify({ ...authority, schema_version: LOCAL_CONTRACT_VERSION,
    request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), command: "synthetic.realtime", payload }));
}

/** Ordered durable-page mechanism independent of Web RunEvent business state.
 * Notifications NEVER advance cursors. Only validated contiguous DB pages do.
 */
export class OrderedJobFeed {
  cursor: Cursor | null = null;
  event: JobEvent | null = null;
  constructor(readonly context: LocalAuthoritySnapshot["context"], readonly subject: string) {}
  private accepts(event: JobEvent): boolean {
    return JSON.stringify(event.context) === JSON.stringify(this.context) && event.data.subject_id === this.subject;
  }
  snapshot(raw: unknown): void {
    const snapshot = SnapshotSchema.parse(raw);
    if (!this.accepts(snapshot.event) || snapshot.cursor.event_id !== snapshot.event.event_id
      || snapshot.cursor.ordinal !== snapshot.event.data.ordinal || snapshot.cursor.sequence !== snapshot.event.recorded_sequence
      || JSON.stringify(snapshot.cursor.context) !== JSON.stringify(this.context) || snapshot.cursor.subject_id !== this.subject)
      throw new Error("INVALID_PAYLOAD");
    this.cursor = snapshot.cursor; this.event = snapshot.event;
  }
  page(raw: unknown): boolean {
    const page = PageSchema.parse(raw);
    let ordinal = this.cursor?.ordinal ?? 0, sequence = this.cursor?.sequence ?? 0;
    for (const event of page.events) {
      if (!this.accepts(event) || event.data.ordinal !== ordinal + 1 || event.recorded_sequence! <= sequence)
        throw new Error("INVALID_PAYLOAD");
      ordinal++; sequence = event.recorded_sequence!;
    }
    const last = page.events.at(-1);
    if (last) {
      if (!page.cursor || page.cursor.ordinal !== ordinal || page.cursor.sequence !== sequence || page.cursor.event_id !== last.event_id
        || JSON.stringify(page.cursor.context) !== JSON.stringify(this.context) || page.cursor.subject_id !== this.subject)
        throw new Error("INVALID_PAYLOAD");
    } else if (page.has_more || JSON.stringify(page.cursor) !== JSON.stringify(this.cursor)) throw new Error("INVALID_PAYLOAD");
    if (last) { this.cursor = page.cursor; this.event = last; }
    return page.has_more;
  }
}

/** Physical IPC adapter; shared useRealtimeChannel owns reconnect/backoff/generation.
 * One document subscription, root plus selected child at most. Polling is bounded
 * and recovers advisory notification loss, including a quiet terminal transition.
 */
export class LocalRealtimeTransport implements RealtimeTransport {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: RealtimeTransport["onopen"] = null;
  onmessage: RealtimeTransport["onmessage"] = null;
  onclose: RealtimeTransport["onclose"] = null;
  onerror: RealtimeTransport["onerror"] = null;
  private generation = crypto.randomUUID();
  private off?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private authority?: LocalAuthoritySnapshot;
  private feeds: OrderedJobFeed[] = [];
  constructor(private readonly api: LocalRealtimeApi, private readonly subjects: string[], private readonly cache = new Map<string, OrderedJobFeed>()) {
    queueMicrotask(() => { void this.open(); });
  }
  private async request(payload: RealtimeRequest) {
    const authority = await this.api.bootstrap();
    if (this.readyState === 3) throw new Error("NOT_AUTHENTICATED");
    if (this.authority && JSON.stringify(authority.context) !== JSON.stringify(this.authority.context)) throw new Error("NOT_AUTHENTICATED");
    if (this.authority && JSON.stringify(authority.runtime_owner) !== JSON.stringify(this.authority.runtime_owner)) throw new Error("RUNTIME_OWNER_MISMATCH");
    this.authority = authority;
    const result = await realtimeRequest(this.api, authority, payload);
    const events = "events" in result ? result.events : "event" in result ? [result.event] : [];
    if (events.some(event => JSON.stringify(event.runtime_owner) !== JSON.stringify(authority.runtime_owner)))
      throw new Error("NOT_AUTHENTICATED");
    return result;
  }
  private async open() {
    try {
      await this.request({ operation: "subscribe", subjects: this.subjects, generation: this.generation });
      if (this.readyState === 3) { this.unsubscribe(); return; }
      this.off = this.api.onNotice(notice => { if (notice.generation === this.generation) void this.catchUp(); });
      const keys = this.subjects.map(subject => JSON.stringify([this.authority!.context, subject]));
      for (const key of this.cache.keys()) if (!keys.includes(key)) this.cache.delete(key);
      this.feeds = this.subjects.map(subject => {
        const key = JSON.stringify([this.authority!.context, subject]);
        const feed = this.cache.get(key) ?? new OrderedJobFeed(this.authority!.context, subject);
        this.cache.set(key, feed); return feed;
      });
      let snapshotRead = false;
      for (const feed of this.feeds) {
        if (feed.cursor) continue;
        const snapshot = await this.request({ operation: "snapshot", subject_id: feed.subject });
        if (this.readyState === 3) return;
        feed.snapshot(snapshot); snapshotRead = true;
      }
      this.readyState = 1; this.onopen?.(new Event("open"));
      if (snapshotRead) this.emit();
      this.timer = setInterval(() => { void this.catchUp(); }, 1000);
      await this.catchUp(); // subscribe-before-snapshot closes the handoff race
    } catch (error) { this.fail(error); }
  }
  private emit() {
    if (this.readyState === 1) this.onmessage?.(new MessageEvent("message", { data: this.feeds.map(f => f.event) }));
  }
  async catchUp(): Promise<void> {
    if (this.readyState !== 1) return;
    if (this.busy) return;
    this.busy = true;
    try {
      for (const feed of this.feeds) {
        // One page/subject/turn bounds work even under sustained event production.
        const old = feed.cursor?.event_id;
        const page = await this.request({ operation: "page", subject_id: feed.subject, cursor: feed.cursor, limit: 50 });
        if (this.readyState !== 1) return;
        feed.page(page);
        if (feed.cursor?.event_id !== old) this.emit();
      }
    } catch (error) { this.fail(error); }
    finally {
      this.busy = false;
      // A coalesced hint is handled by the bounded next poll, not a hot loop.
    }
  }
  private fail(error: unknown) {
    if (this.readyState === 3) return;
    const code = error instanceof Error ? error.message : "";
    this.close(code === "INVALID_PAYLOAD" ? 4009 : code === "NOT_AUTHENTICATED" ? 1008 : 1011, "realtime unavailable");
  }
  send(): void { throw new Error("INVALID_PAYLOAD"); }
  private unsubscribe() {
    void this.api.bootstrap().then(authority => realtimeRequest(this.api, authority,
      { operation: "unsubscribe", generation: this.generation })).catch(() => {});
  }
  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) return;
    this.readyState = 3; clearInterval(this.timer); this.off?.(); this.unsubscribe();
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}
