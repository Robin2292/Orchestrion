import { timestamp } from "./model";
import type { SyntheticJobService } from "./service";

/** Single synchronous synthetic executor; no unbounded promise queue or adapters.
 * Every phase checks current owner, claim epoch and lease in a fresh transaction. */
export class SyntheticJobWorker {
  private stopped = false;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private wake?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  constructor(private readonly service: SyntheticJobService, private readonly clock: () => number = Date.now) {}
  start(): void {
    if (this.stopped || this.timer) return;
    this.unsubscribe = this.service.events.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.safeTick(), 250);
    this.timer.unref();
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped || this.wake) return;
    this.wake = setTimeout(() => { this.wake = undefined; this.safeTick(); }, 0);
    this.wake.unref();
  }
  private safeTick(): void {
    try { this.tick(); } catch { /* no raw error payload; durable leases recover on next poll */ }
  }
  tick(): number {
    if (this.stopped || this.running) return 0;
    this.running = true;
    try {
      const s = this.service, owner = s.store.owner;
      s.repository((r) => r.recover(timestamp(this.clock())));
      let count = 0;
      for (; count < 8 && !this.stopped; count++) {
        const claim = s.repository((r) => r.claim(owner, timestamp(this.clock())));
        if (!claim) break;
        if (claim.mode === "retry") {
          s.repository((r) => r.retry(claim, timestamp(this.clock())));
          continue;
        }
        if (!s.repository((r) => r.begin(claim, timestamp(this.clock())))) continue;
        if (claim.mode === "success") s.repository((r) => r.confirmSynthetic(claim, timestamp(this.clock())));
        s.repository((r) => r.finish(claim, timestamp(this.clock())));
      }
      return count;
    } finally { this.running = false; }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer); clearTimeout(this.wake); this.unsubscribe?.();
    this.service.repository((r) => r.stop(this.service.store.owner, timestamp(this.clock())));
  }
}
