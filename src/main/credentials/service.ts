import { createHash, timingSafeEqual } from "node:crypto";
import { CredentialMetadataService } from "../../services/credential-metadata";
import { CredentialScopeSchema, type CredentialMetadata, type CredentialScope } from "../../storage/sqlite/credential-metadata";
import { SqliteFoundation } from "../../storage/sqlite/foundation";
import { CredentialRequestSchema, type CredentialRequest, type CredentialResult } from "../../shared/credential-contracts";
import type { KeychainAdapter } from "./keychain";
import { CredentialAccessRepository } from "../../storage/sqlite/credential-access";
import { CredentialStagingRepository } from "../../storage/sqlite/credential-staging";

type Operation = "create" | "rotate" | "revoke" | "tombstone" | "resolve" | "inspect" | "cleanup" | "repair";
export interface CredentialAuthority {
  /** Host-owned live Connector permission/ToolInvocation admission, never IPC claims.
   * resolve must be supplied by the governed Tool caller, not by renderer code. */
  allow(operation: Operation, connector: string): boolean;
  isActive(): boolean;
}
const unavailable = () => new Error("CREDENTIAL_UNAVAILABLE");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();
const equal = (a: Buffer | null, b: Buffer) => !!a && a.length === b.length && timingSafeEqual(a, b);
const identity = (p: CredentialRequest) => ({ credential_ref: p.credential_ref, connector_id: p.connector_id });

/** One utility-host service over F4's exclusive writer. No secret return value,
 * logger, event publisher, IPC input, fallback env, cache or second SQL store.
 * Keychain I/O is synchronous and OUTSIDE SQLite transactions. A partial commit
 * deliberately disables resolution until explicit host repair/replacement.
 */
export class HostCredentialService {
  readonly #scope: CredentialScope;
  readonly #owner: string;
  #busy = false;
  constructor(private readonly store: SqliteFoundation, private readonly keychain: KeychainAdapter,
    scope: CredentialScope, private readonly authority: CredentialAuthority) {
    const parsed = CredentialScopeSchema.safeParse(scope);
    if (!parsed.success) throw unavailable();
    this.#scope = parsed.data;
    this.#owner = JSON.stringify(store.owner);
  }
  private guard(operation: Operation, p: CredentialRequest): void {
    if (!this.authority.isActive() || JSON.stringify(this.store.owner) !== this.#owner
        || this.authority.allow(operation, p.connector_id) !== true) throw unavailable();
    // The repository repeats membership checks with every actual read/write.
    this.store.transaction(tx => new CredentialAccessRepository(tx, this.#scope).requireMembership());
  }
  private metadata<T>(work: (s: CredentialMetadataService) => T): T {
    return this.store.transaction(tx => work(new CredentialMetadataService(tx, this.#scope)));
  }
  private staging<T>(work: (r: CredentialStagingRepository) => T): T {
    return this.store.transaction(tx => work(new CredentialStagingRepository(tx,this.#scope)));
  }
  private account(p: CredentialRequest): string {
    return digest([this.#scope.org_id, this.#scope.principal.type, this.#scope.principal.id,
      p.connector_id, p.credential_ref]).toString("hex");
  }
  private slot(p: CredentialRequest): string { return `${this.account(p)}:${p.revision}`; }
  private tag(row: Pick<CredentialMetadata, "credential_ref" | "connector_id" | "revision" | "state" | "locator_ref">): Buffer {
    return digest([this.#scope, row.credential_ref, row.connector_id, row.revision, row.state, row.locator_ref]);
  }
  private locator(p: CredentialRequest): string {
    // Opaque deterministic version locator enables cleanup without enumeration.
    const h = digest([this.account(p), p.revision, "locator"]).toString("hex");
    return `keychain-ref:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  private result(row: CredentialMetadata, ready = false): CredentialResult {
    return { ok: true, value: { credential_ref: row.credential_ref, connector_id: row.connector_id,
      revision: row.revision, mask: "••••••••", state: row.state === "active" ? ready ? "ready" : "unavailable" : row.state } };
  }
  private run(raw: unknown, op: Operation, work: (p: CredentialRequest) => CredentialResult): CredentialResult {
    const parsed = CredentialRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: "CREDENTIAL_INVALID", retryable: false } };
    if (this.#busy) return { ok: false, error: { code: "CREDENTIAL_UNAVAILABLE", retryable: false } };
    this.#busy = true;
    try { this.guard(op, parsed.data); return work(parsed.data); }
    catch { return { ok: false, error: { code: "CREDENTIAL_UNAVAILABLE", retryable: false } }; }
    finally { this.#busy = false; }
  }
  private pinned(p: CredentialRequest): CredentialMetadata {
    const row = this.metadata(s => s.inspect(identity(p)));
    if (row.revision !== p.revision) throw unavailable();
    return row;
  }
  /** Non-secret authoritative version for the F2 read endpoint, independent of
   * the claimed expected revision/hash in the command envelope. */
  version(raw: unknown): { revision: number; hash: string } | null {
    let value: { revision: number; hash: string } | null = null;
    this.run(raw, "inspect", p => {
      const row = this.metadata(s => s.inspect(identity(p)));
      value = { revision: row.revision, hash: `sha256:${this.tag(row).toString("hex")}` };
      return this.result(row);
    });
    return value;
  }
  private active(p: CredentialRequest): CredentialMetadata { return this.metadata(s => s.requireActive(p)); }
  private checkedSecret(p: CredentialRequest, row: CredentialMetadata): Buffer {
    const tag = this.tag(row), marker = this.keychain.read(this.account(p));
    if (!equal(marker, tag)) throw unavailable();
    const value = this.keychain.read(this.slot(p));
    if (!value) throw unavailable();
    try {
      if (value.length <= 32 || value.length > 65568 || !equal(value.subarray(0, 32), tag)
          || !equal(this.keychain.read(this.account(p)), tag)) throw unavailable();
      return value;
    } catch { value.fill(0); throw unavailable(); }
  }
  inspect(raw: unknown): CredentialResult {
    return this.run(raw, "inspect", p => {
      const row = this.pinned(p);
      if (row.state !== "active") return this.result(row);
      try { const bytes = this.checkedSecret(p, row); bytes.fill(0); return this.result(row, true); }
      catch { return this.result(row); }
    });
  }
  /** Source is a host-owned, synchronous in-process secret ingress, NEVER an IPC
   * DTO. Ownership of the returned Buffer transfers here; it is always erased.
   * Caller selects a fresh UUID for create and retains it for crash cleanup. */
  save(raw: unknown, source: () => Buffer, rotate = false): CredentialResult {
    const op = rotate ? "rotate" : "create";
    return this.run(raw, op, p => {
      let previous: CredentialMetadata | undefined;
      if (rotate) {
        previous = this.active(p);
        const bytes = this.checkedSecret(p, previous); bytes.fill(0);
      } else if (p.revision !== 0 || this.store.transaction(tx => new CredentialAccessRepository(tx,this.#scope).exists(p.credential_ref))) throw unavailable();
      const next = { ...p, revision: rotate ? p.revision + 1 : 0 };
      if (!Number.isSafeInteger(next.revision)) throw unavailable();
      if (this.staging(r => r.state(next)) !== null) throw unavailable();
      const locator_ref = this.locator(next), nextRow = { ...next, state: "active" as const, locator_ref };
      let secret: Buffer | undefined, record: Buffer | undefined;
      try {
        secret = source();
        if (!Buffer.isBuffer(secret) || !secret.length || secret.length > 65536) throw unavailable();
        this.guard(op, p);
        if (previous) this.active(p); // callbacks cannot silently supersede the pin
        // Commit before the first external write. A crash/metadata rollback cannot
        // erase this obligation; no secret or locator is stored in the journal.
        this.staging(r => r.stage(next));
        record = Buffer.concat([this.tag(nextRow), secret]);
        this.keychain.compareExchange(this.slot(next), null, record); // immutable staged version
        this.guard(op, p);
        this.keychain.compareExchange(this.account(p), previous ? this.tag(previous) : null, this.tag(nextRow));
        this.guard(op, p);
        const committed = this.store.transaction(tx => {
          const s = new CredentialMetadataService(tx,this.#scope);
          const row = rotate ? s.rotate({ ...p,locator_ref }) : s.create({ ...identity(p),locator_ref });
          new CredentialStagingRepository(tx,this.#scope).finish(next,"published");
          return row;
        });
        if (previous) this.removeRetired(p); // best effort; authority already advanced
        return this.result(committed, true);
      } finally { if (Buffer.isBuffer(secret)) secret.fill(0); record?.fill(0); }
    });
  }
  /** Advance non-secret Keychain authority before DB CAS; never roll it back.
   * No secret deletion is required for current or restored DBs to reject it. */
  retire(raw: unknown, tombstone = false): CredentialResult {
    const op = tombstone ? "tombstone" : "revoke";
    return this.run(raw, op, p => {
      const row = this.pinned(p);
      if (row.state === "tombstoned" || (!tombstone && row.state !== "active")) throw unavailable();
      const next = { ...row, revision: row.revision + 1,
        state: tombstone ? "tombstoned" as const : "revoked" as const,
        locator_ref: tombstone ? null : row.locator_ref };
      if (!Number.isSafeInteger(next.revision)) throw unavailable();
      this.guard(op, p);
      this.keychain.compareExchange(this.account(p), this.tag(row), this.tag(next));
      this.guard(op, p);
      const committed = this.metadata(s => tombstone ? s.tombstone(p) : s.revoke(p));
      this.removeRetired(p);
      return this.result(committed);
    });
  }
  private removeRetired(p: CredentialRequest): boolean {
    let bytes: Buffer | null = null;
    try {
      bytes = this.keychain.read(this.slot(p));
      if (!bytes) return true;
      const marker = this.keychain.read(this.account(p));
      if (equal(marker, bytes.subarray(0, 32))) return false;
      this.keychain.remove(this.slot(p), bytes.subarray(0, 32));
      return true;
    } catch { return false; }
    finally { bytes?.fill(0); }
  }
  private clearRetired(p: CredentialRequest): boolean {
    const pending = this.staging(r => r.state(p)) === "pending";
    // A missing payload alone does not clear a still-authoritative staged marker.
    if (pending && equal(this.keychain.read(this.account(p)),this.tag({ ...p,state:"active",locator_ref:this.locator(p) }))) return false;
    if (!this.removeRetired(p)) return false;
    if (pending) this.staging(r => r.finish(p,"cleared"));
    return true;
  }
  /** Confirm the exact successor is terminal and Keychain no longer retains the
   * original secret. This is host-only crash recovery, never a readiness claim.
   * A stale DB pin alone is insufficient: restored Keychain authority must agree.
   */
  confirmRetired(raw: unknown): boolean {
    let confirmed = false;
    this.run(raw, "cleanup", p => {
      const row = this.metadata(s => s.inspect(identity(p)));
      if (row.revision !== p.revision + 1 ||
          (row.state !== "revoked" && row.state !== "tombstoned")) throw unavailable();
      const terminal = this.tag(row);
      if (!equal(this.keychain.read(this.account(p)), terminal) || !this.clearRetired(p) ||
          !equal(this.keychain.read(this.account(p)), terminal)) throw unavailable();
      confirmed = true;
      return this.result(row);
    });
    return confirmed;
  }
  /** Deterministic bounded cleanup, called with an exact known version, never a
   * Keychain listing. An item referenced by the authority marker is never deleted.
   * Returns only a boolean; unavailable cleanup can be retried after restart. */
  cleanup(raw: unknown): boolean {
    let cleaned = false;
    this.run(raw, "cleanup", p => {
      const staged = this.staging(r => r.state(p));
      cleaned = p.revision === 0 && (staged === "pending" || staged === "cleared")
        && !this.store.transaction(tx => new CredentialAccessRepository(tx,this.#scope).exists(p.credential_ref))
        ? this.abandon(p,"cleanup") : this.clearRetired(p);
      return { ok: false, error: { code: "CREDENTIAL_UNAVAILABLE", retryable: false } };
    });
    return cleaned;
  }
  /** Explicit recovery of a mismatched two-system commit. It is destructive:
   * invalidate this reference, never replay a secret write or resurrect old bytes.
   * Retained authority marker also prevents a pre-create backup recreating the ID.
   */
  repair(raw: unknown): CredentialResult {
    return this.run(raw, "repair", p => {
      const row = this.pinned(p), marker = this.keychain.read(this.account(p));
      if (row.state === "tombstoned" || !marker || equal(marker, this.tag(row))) throw unavailable();
      const next = { ...row, revision: row.revision + 1, state: "tombstoned" as const, locator_ref: null };
      if (!Number.isSafeInteger(next.revision)) throw unavailable();
      this.guard("repair", p);
      this.keychain.compareExchange(this.account(p), marker, this.tag(next));
      this.guard("repair", p);
      const committed = this.metadata(s => s.tombstone(p));
      this.clearRetired(p); this.clearRetired({ ...p, revision: p.revision + 1 });
      return this.result(committed);
    });
  }
  /** Known failed create only; never enumerate. Keep a durable denial in SQLite,
   * retire then remove both external entries, and only then record clearance.
   * Pending survives a crash before/after any external or SQLite mutation. */
  abandonCreate(raw: unknown): boolean {
    let done = false;
    this.run(raw, "repair", p => {
      done = this.abandon(p,"repair");
      return { ok: false, error: { code: "CREDENTIAL_UNAVAILABLE", retryable: false } };
    });
    return done;
  }
  private abandon(p: CredentialRequest, op: "repair" | "cleanup"): boolean {
    if (p.revision !== 0 || this.store.transaction(tx => new CredentialAccessRepository(tx,this.#scope).exists(p.credential_ref))) throw unavailable();
    const state = this.staging(r => r.state(p));
    if (state === "cleared") return true; // exact replay has no external/DB writes
    if (state === "published") throw unavailable();
    const marker = this.keychain.read(this.account(p));
    const active = this.tag({ ...p,state:"active",locator_ref:this.locator(p) });
    const terminal = this.tag({ ...p,revision:1,state:"tombstoned",locator_ref:null });
    if (marker && !equal(marker,active) && !equal(marker,terminal)) throw unavailable();
    if (state === null) {
      // Explicit recovery of a known pre-journal failed create, including an old
      // C0 tombstone. Adopt only its deterministic tag, never arbitrary entries.
      let bytes: Buffer | null = null;
      try {
        bytes = this.keychain.read(this.slot(p));
        if (!marker && (!bytes || !equal(bytes.subarray(0,32),active))) throw unavailable();
        if (bytes && !equal(bytes.subarray(0,32),active)) throw unavailable();
      } finally { bytes?.fill(0); }
      this.guard(op,p); this.staging(r => r.stage(p));
    }
    this.guard(op,p);
    if (equal(marker,active)) this.keychain.compareExchange(this.account(p),active,terminal);
    this.guard(op,p);
    if (!this.removeRetired(p)) return false;
    this.guard(op,p);
    const retired = this.keychain.read(this.account(p));
    if (retired) {
      if (!equal(retired,terminal)) throw unavailable();
      this.keychain.remove(this.account(p),terminal);
    }
    // Authoritative absence, not a best-effort delete or caller-provided proof.
    if (this.keychain.read(this.account(p))) throw unavailable();
    const remaining = this.keychain.read(this.slot(p));
    if (remaining) { remaining.fill(0); throw unavailable(); }
    this.guard(op,p); this.staging(r => r.finish(p,"cleared"));
    return true;
  }
  /** Only the already-governed host adapter receives bytes. Callback return values,
   * promises, provider errors and secret material never become a public result.
   * A consumer must copy/use synchronously; no Tool or network dispatch lives here. */
  consume(raw: unknown, sink: (secret: Buffer) => unknown): CredentialResult {
    return this.run(raw, "resolve", p => {
      const row = this.active(p), bytes = this.checkedSecret(p, row);
      try {
        this.guard("resolve", p); this.active(p);
        if (!equal(this.keychain.read(this.account(p)), this.tag(row))) throw unavailable();
        const result = sink(bytes.subarray(32));
        // Avoid unhandled rejections without exposing provider exceptions.
        if (result && typeof result === "object" && "then" in result) void Promise.resolve(result).catch(() => undefined);
        return this.result(row, true);
      } finally { bytes.fill(0); }
    });
  }
}
