import { createHash, randomUUID } from "node:crypto";
import { LocalContextSchema, LocalIdSchema, LocalCommandHeaderSchema, type LocalCommandHeader, type LocalContext } from "../shared/local-contracts";
import { SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";
import { JobRepository } from "./repository";
import { SyntheticJobSchema, timestamp } from "./model";
import { JobEventBus } from "./event-bus";

export const JOB_FENCE = "synthetic-jobs";
export const JOB_INITIAL_HASH = `sha256:${"0".repeat(64)}`;
/** Trusted service only; no IPC registration or authority inferred from input. */
export class SyntheticJobService {
  readonly context: LocalContext;
  constructor(readonly store: SqliteFoundation, context: LocalContext, readonly events: JobEventBus,
    private readonly clock: () => number = Date.now) {
    this.context = LocalContextSchema.parse(context);
    store.transaction((tx) => {
      new JobRepository(tx, this.context);
      if (!tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
        this.context.org_id, this.context.project_id, JOB_FENCE))
        SqliteFoundation.createFence(tx, this.context, JOB_FENCE, JOB_INITIAL_HASH);
    });
  }
  repository<T>(work: (repo: JobRepository, tx: SqliteUnit) => T): T {
    let changed = false;
    const result = this.store.transaction((tx) => {
      const repo = new JobRepository(tx, this.context);
      const value = work(repo, tx); changed = repo.changed; return value;
    });
    if (changed) this.events.publish(); // committed status facts only, never reads/deltas
    return result;
  }
  enqueue(header: LocalCommandHeader, raw: unknown) {
    header = LocalCommandHeaderSchema.parse(header);
    if (header.run !== null) throw new Error("INVALID_PAYLOAD");
    const job = SyntheticJobSchema.parse(raw), now = timestamp(this.clock());
    const canonicalContent = JSON.stringify(job);
    const result = this.store.commit({ trustedContext: this.context, header, command: "synthetic.enqueue",
      resourceKey: JOB_FENCE, canonicalContent,
      nextHash: `sha256:${createHash("sha256").update(canonicalContent).digest("hex")}` }, (tx) => {
      const id = randomUUID();
      // Business job state, dispatch intent, revision and command replay are ONE commit.
      new JobRepository(tx, this.context).insert(id, job, now);
      return id;
    });
    this.events.publish(); // only after commit, including harmless duplicate wakeups
    return result;
  }
  cancel(header: LocalCommandHeader, rawId: unknown) {
    header = LocalCommandHeaderSchema.parse(header);
    if (header.run !== null) throw new Error("INVALID_PAYLOAD");
    const id = LocalIdSchema.parse(rawId);
    const result = this.store.commit({ trustedContext: this.context, header, command: "synthetic.cancel",
      resourceKey: JOB_FENCE, canonicalContent: JSON.stringify(id),
      nextHash: `sha256:${createHash("sha256").update(`cancel:${id}`).digest("hex")}` }, (tx) => {
      const status = new JobRepository(tx, this.context).cancel(id);
      if (!status) throw new Error("JOB_NOT_FOUND");
      return id;
    });
    this.events.publish();
    return result;
  }
}
