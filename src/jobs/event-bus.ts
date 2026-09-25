/** Host-internal EventBus for advisory dispatch wakeups only. Durable intent lives
 * in SQLite; this carries no domain/Run fact or renderer-visible F2 event. */
export class JobEventBus {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  publish(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* polling recovers notification failure */ }
    }
  }
}
