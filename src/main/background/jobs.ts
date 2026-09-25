import type { SqliteFoundation } from "../../storage/sqlite/foundation";
import { JobEventBus } from "../../jobs/event-bus";
import { SyntheticJobService } from "../../jobs/service";
import { SyntheticJobWorker } from "../../jobs/worker";

interface FoundationBorrower { get(): SqliteFoundation }
interface JobLifetime { stop(): void; service(): SyntheticJobService }
const lifetimes = new WeakMap<FoundationBorrower, JobLifetime>();

/** One job consumer per host owner. Opening remains lazy and failure does not
 * break credential readiness or native host startup. Retry only opening the DB,
 * never uncertain effects. The owner alone closes the shared writer. */
export function startBackgroundJobs(owner: FoundationBorrower): JobLifetime {
  const existing = lifetimes.get(owner);
  if (existing) return existing;
  let service: SyntheticJobService | undefined;
  let worker: SyntheticJobWorker | undefined;
  let stopped = false;
  const initialize = () => {
    if (stopped || worker) return;
    try {
      const store = owner.get();
      service ??= new SyntheticJobService(store, store.workspace, new JobEventBus());
      worker = new SyntheticJobWorker(service);
      worker.start();
      clearInterval(retry);
    } catch { /* no paths/errors exposed; next bounded poll retries readiness */ }
  };
  const retry = setInterval(initialize, 250);
  retry.unref();
  const first = setTimeout(initialize, 0);
  first.unref();
  const lifetime = { service() {
    if (stopped) throw new Error("SERVICE_UNAVAILABLE");
    if (!service) { const store = owner.get(); service = new SyntheticJobService(store, store.workspace, new JobEventBus()); }
    return service;
  }, stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(retry); clearTimeout(first);
    worker?.stop();
  } };
  lifetimes.set(owner, lifetime);
  return lifetime;
}

/** Shared shutdown order for normal quit and SIGTERM, including failure cleanup. */
export function stopBackgroundConsumers(jobs: { stop(): void }, service: { shutdown(): void }, owner: { close(): void }): void {
  try { jobs.stop(); }
  finally { try { service.shutdown(); } finally { owner.close(); } }
}
