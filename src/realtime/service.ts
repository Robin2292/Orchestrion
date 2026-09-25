import { createLocalCommandAdapter } from "../shared/local-command-adapter";
import { RealtimeRequestSchema, RealtimeValueSchema, type RealtimeRequest } from "../shared/realtime-contracts";
import { localFailure, type LocalCommandHeader } from "../shared/local-contracts";
import { JOB_FENCE, type SyntheticJobService } from "../jobs/service";
import { EventRepository } from "./repository";
import type { HostDocument } from "../main/background/service";
import { StorageError } from "../storage/sqlite/foundation";

const gate = createLocalCommandAdapter("synthetic.realtime", RealtimeRequestSchema);
type Subscription = { document: HostDocument; generation: string; subjects: string[] };
export class RealtimeService {
  private subscriptions = new Map<string, Subscription>();
  private stopped = false;
  private readonly unsubscribe: () => void;
  constructor(private readonly jobs: SyntheticJobService,
    private readonly notify: (documentId: string, generation: string) => void) {
    this.unsubscribe = jobs.events.subscribe(() => {
      for (const [id, entry] of this.subscriptions) {
        if (!entry.document.isActive()) { this.subscriptions.delete(id); continue; }
        // No event payload or cursor authority travels in a notification.
        this.notify(id, entry.generation);
      }
    });
  }
  authority(document: HostDocument) {
    if (this.stopped || !document.isActive()) return null;
    const s = this.jobs;
    const expected = s.repository((_, tx) => new EventRepository(tx, s.context).version(JOB_FENCE));
    return { context: s.context, runtime_owner: s.store.owner, run: null,
      expected };
  }
  async handle(raw: unknown, document: HostDocument) {
    // Scope/owner authentication precedes any subject/cursor existence query.
    const shape = gate.validate(raw, null);
    if (!shape.ok && shape.error.code !== "NOT_AUTHENTICATED") return shape;
    const authority = this.authority(document);
    // Enqueue replay is fenced by the F6 durable command ledger, including the
    // original pin. Removing this document's own subscription is also pin-independent.
    // Read/subscribe commands still require the current pin.
    let parsed: ReturnType<typeof gate.schema.safeParse> | undefined;
    try { if (typeof raw === "string" && raw.length <= 32768) parsed = gate.schema.safeParse(JSON.parse(raw)); } catch { /* validated below */ }
    if (authority && parsed?.success && ["enqueue", "unsubscribe"].includes(parsed.data.payload.operation)) authority.expected = parsed.data.expected;
    const authorized = gate.validate(raw, authority);
    if (!authorized.ok) return ["CONTEXT_MISMATCH", "RUNTIME_OWNER_MISMATCH"].includes(authorized.error.code)
      ? localFailure("NOT_AUTHENTICATED") : authorized;
    try {
      if (this.stopped || !document.isActive()) return localFailure("NOT_AUTHENTICATED");
      const { command: _command, payload, ...header } = authorized.command;
      const value = this.perform(payload, header, document);
      return { ok: true as const, value: RealtimeValueSchema.parse(value) };
    } catch (error) {
      return localFailure(error instanceof StorageError && error.code === "INVALID_PAYLOAD" ? "INVALID_PAYLOAD" : "NOT_AUTHENTICATED");
    }
  }
  private perform(request: RealtimeRequest, header: LocalCommandHeader, document: HostDocument) {
    const s = this.jobs;
    if (request.operation === "enqueue") return { subject_id: s.enqueue(header, { mode: "success" }).resultRef };
    if (request.operation === "unsubscribe") {
      if (this.subscriptions.get(document.id)?.generation === request.generation) this.subscriptions.delete(document.id);
      return { subscribed: false };
    }
    return s.repository((_, tx) => {
      const repo = new EventRepository(tx, s.context);
      if (request.operation === "snapshot") return repo.snapshot(request.subject_id, s.store.owner);
      if (request.operation === "page") return repo.page(request.subject_id, request.cursor, request.limit, s.store.owner);
      for (const subject of request.subjects) repo.snapshot(subject, s.store.owner);
      if (!this.subscriptions.has(document.id) && this.subscriptions.size >= 128) throw new StorageError("NOT_AUTHENTICATED");
      this.subscriptions.set(document.id, { document, generation: request.generation, subjects: request.subjects });
      return { subscribed: true };
    });
  }
  revoke(documentId: string): void { this.subscriptions.delete(documentId); }
  stop(): void { this.stopped = true; this.unsubscribe(); this.subscriptions.clear(); }
}
