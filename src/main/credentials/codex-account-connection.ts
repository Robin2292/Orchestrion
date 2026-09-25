import { randomUUID } from "node:crypto";
import type { SqliteFoundation } from "../../storage/sqlite/foundation";
import { CodexAccountRepository } from "../../storage/sqlite/codex-account";
import type { CredentialRequest, CredentialResult } from "../../shared/credential-contracts";
import type { HostCredentialService } from "./service";
import type { HostCodexOAuthCeremony, HostOAuthBinding } from "./codex-oauth-ceremony";

export interface HostCodexRefreshPort {
  /** Explicit host gate. A reviewed OAuth registration and trusted account verifier
   * must be supplied before any live request; this contract makes no entitlement claim. */
  enabled: boolean;
  timeoutMs: number;
  refresh(refreshToken: string, signal: AbortSignal): Promise<{
    tokens: { accessToken: string; refreshToken?: string; idToken?: string; expiresIn?: number };
    verifiedAccountId: string;
  }>;
}

const denied = (): CredentialResult => ({ ok: false, error: { code: "CREDENTIAL_UNAVAILABLE", retryable: false } });
const same = (a: HostOAuthBinding, b: HostOAuthBinding | null): boolean =>
  !!b && a.orgId === b.orgId && a.principalId === b.principalId &&
  a.projectId === b.projectId && a.connectorId === b.connectorId &&
  a.windowId === b.windowId && a.sessionId === b.sessionId && a.accountId === b.accountId;
const MAX_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MAX_REFRESH_MARGIN_MS = 60_000;
type Expiry = { issuedAtMs: number; expiresAtMs: number; refreshAfterMs: number };
type StoredCodexSecret = Expiry & { kind: "codex-oauth.v1"; accessToken: string;
  refreshToken: string | null; idToken: string | null };
/** One utility host can have multiple connection wrappers. A new process/store has
 * no live entries, so recovery can distinguish an orphan from an active exchange. */
const liveRefreshes = new WeakMap<SqliteFoundation, Map<string, AbortController | null>>();

/** Host-only bridge from a verified ceremony handoff to F5's sole Keychain owner.
 * There is deliberately no IPC registration, provider dispatch or entitlement claim.
 */
export class CodexAccountConnection {
  constructor(private readonly store: SqliteFoundation, private readonly credentials: HostCredentialService,
    private readonly connectorId: string, private readonly readBinding: () => HostOAuthBinding | null,
    private readonly readVerifiedAccount: () => string | null,
    private readonly now: () => number = Date.now) {}

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("CREDENTIAL_UNAVAILABLE");
    return now;
  }
  private expiry(expiresIn: number | undefined): Expiry {
    if (!Number.isSafeInteger(expiresIn) || !expiresIn || expiresIn < 1
        || expiresIn > MAX_TOKEN_LIFETIME_SECONDS) throw new Error("CREDENTIAL_UNAVAILABLE");
    const issuedAtMs = this.clock(), lifetime = expiresIn * 1000;
    const expiresAtMs = issuedAtMs + lifetime;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error("CREDENTIAL_UNAVAILABLE");
    const refreshAfterMs = expiresAtMs - Math.min(MAX_REFRESH_MARGIN_MS, Math.floor(lifetime / 10));
    return { issuedAtMs, expiresAtMs, refreshAfterMs };
  }
  private stored(bytes: Buffer): StoredCodexSecret {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "codex-oauth.v1"
        || !("accessToken" in value) || typeof value.accessToken !== "string" || !value.accessToken
        || !("refreshToken" in value) || (value.refreshToken !== null && typeof value.refreshToken !== "string")
        || !("idToken" in value) || (value.idToken !== null && typeof value.idToken !== "string")
        || !("issuedAtMs" in value) || !Number.isSafeInteger(value.issuedAtMs)
        || !("expiresAtMs" in value) || !Number.isSafeInteger(value.expiresAtMs)
        || !("refreshAfterMs" in value) || !Number.isSafeInteger(value.refreshAfterMs))
      throw new Error("CREDENTIAL_UNAVAILABLE");
    const secret = value as StoredCodexSecret;
    if (secret.issuedAtMs < 0 || secret.expiresAtMs <= secret.issuedAtMs
        || secret.expiresAtMs - secret.issuedAtMs > MAX_TOKEN_LIFETIME_SECONDS * 1000
        || secret.refreshAfterMs !== secret.expiresAtMs - Math.min(MAX_REFRESH_MARGIN_MS,
          Math.floor((secret.expiresAtMs - secret.issuedAtMs) / 10)))
      throw new Error("CREDENTIAL_UNAVAILABLE");
    return secret;
  }
  private usable(secret: StoredCodexSecret): boolean {
    const now = this.clock();
    return now >= secret.issuedAtMs && now < secret.refreshAfterMs && now < secret.expiresAtMs;
  }
  private refreshes(): Map<string, AbortController | null> {
    let entries = liveRefreshes.get(this.store);
    if (!entries) { entries = new Map(); liveRefreshes.set(this.store, entries); }
    return entries;
  }
  private currentPinned(binding: HostOAuthBinding, accountId: string): boolean {
    try {
      const live = this.readBinding();
      return !!live && this.scopeMatches(live) && same(binding, live)
        && live.accountId === accountId && this.readVerifiedAccount() === accountId;
    } catch { return false; }
  }
  private revokeRefreshIntent(pin: CredentialRequest, accountId: string): void {
    try { this.repo(r => r.claimRevoke(pin.credential_ref, pin.revision, accountId)); }
    catch { /* Existing terminal state still denies the stale refresh. */ }
  }

  private scopeMatches(live: HostOAuthBinding | null): boolean {
    try {
      const c = this.store.workspace;
      return c.principal.type === "user" && !!live && live.orgId === c.org_id &&
        live.principalId === c.principal.id && live.projectId === c.project_id &&
        live.connectorId === this.connectorId;
    } catch { return false; }
  }
  private scopeCurrent(): boolean {
    try { return this.scopeMatches(this.readBinding()); }
    catch { return false; }
  }
  private current(binding?: HostOAuthBinding, accountId?: string): boolean {
    try {
      const live = this.readBinding();
      if (!this.scopeMatches(live) || !live || (binding && !same(binding, live))) return false;
      const verified = this.readVerifiedAccount();
      // The handoff itself has a trusted verified account. An initial sign-in may
      // have no selected account yet; subsequent lookups require a live exact ID.
      if (binding) return !!accountId && (verified === null || verified === accountId) &&
        (live.accountId === null || live.accountId === accountId);
      return !!verified && (!accountId || verified === accountId) &&
        (live.accountId === null || live.accountId === verified);
    } catch { return false; }
  }
  private repo<T>(work: (r: CodexAccountRepository) => T): T {
    const c = this.store.workspace;
    return this.store.transaction(tx => work(new CodexAccountRepository(tx,
      { org_id: c.org_id, principal: c.principal }, c.project_id, this.connectorId)));
  }

  /** Consumes the handoff exactly once. A pending SQL row precedes all Keychain I/O.
   * A crash before publication leaves a durable, non-resolvable repair obligation.
   */
  connect(ceremony: Pick<HostCodexOAuthCeremony, "takeTokens">): CredentialResult {
    const handoff = ceremony.takeTokens();
    if (!handoff) return denied();
    const { tokens, binding, accountId } = handoff;
    let secret: Buffer | undefined;
    try {
      if (!this.current(binding, accountId)) return denied();
      const ref = randomUUID(), pin: CredentialRequest = { credential_ref: ref, connector_id: this.connectorId, revision: 0 };
      this.repo(r => r.begin(ref, accountId));
      const expiry = this.expiry(tokens.expiresIn);
      secret = Buffer.from(JSON.stringify({ kind: "codex-oauth.v1", accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null, idToken: tokens.idToken ?? null,
        ...expiry }), "utf8");
      if (!tokens.accessToken || !this.current(binding, accountId)) return denied();
      const owned = secret;
      secret = undefined; // F5 takes ownership and erases the buffer.
      let saved: CredentialResult;
      try { saved = this.credentials.save(pin, () => owned); }
      finally { owned.fill(0); } // Also covers denial before F5 invokes the source.
      if (!saved.ok || !this.current(binding, accountId)) return denied();
      this.repo(r => r.publish(ref, accountId));
      return saved;
    } catch { return denied(); }
    finally {
      secret?.fill(0);
      tokens.accessToken = "";
      tokens.refreshToken = undefined;
      tokens.idToken = undefined;
    }
  }

  /** Only a trusted host account selection may resolve the exact active pin. */
  inspect(pin: CredentialRequest): CredentialResult {
    try {
      if (!this.current()) return denied();
      const account = this.readVerifiedAccount();
      if (!account) return denied();
      this.repo(r => r.active(pin.credential_ref, pin.revision, account));
      if (!this.current(undefined, account)) return denied();
      const inspection = this.credentials.inspect(pin);
      if (!inspection.ok || inspection.value.state !== "ready") return inspection;
      const usable = this.credentials.consume(pin, secret => {
        this.repo(r => r.active(pin.credential_ref, pin.revision, account));
        if (!this.current(undefined, account) || !this.usable(this.stored(secret)))
          throw new Error("CREDENTIAL_UNAVAILABLE");
      });
      return usable.ok ? inspection : { ok: true, value: { ...inspection.value, state: "unavailable" } };
    } catch { return denied(); }
  }
  consume(pin: CredentialRequest, sink: (secret: Buffer) => unknown): CredentialResult {
    try {
      if (!this.current()) return denied();
      const account = this.readVerifiedAccount();
      if (!account) return denied();
      this.repo(r => r.active(pin.credential_ref, pin.revision, account));
      if (!this.current(undefined, account)) return denied();
      return this.credentials.consume(pin, secret => {
        this.repo(r => r.active(pin.credential_ref, pin.revision, account));
        if (!this.current(undefined, account) || !this.usable(this.stored(secret)))
          throw new Error("CREDENTIAL_UNAVAILABLE");
        return sink(secret);
      });
    } catch { return denied(); }
  }

  /** Bounded, host-only refresh. The durable SQL intent fences all readers before
   * network work; F5 advances Keychain authority and metadata by exact revision CAS. */
  async refresh(pin: CredentialRequest, port: HostCodexRefreshPort): Promise<CredentialResult> {
    let refreshToken = "";
    let response: Awaited<ReturnType<HostCodexRefreshPort["refresh"]>> | undefined;
    let reserved = false;
    try {
      if (!port.enabled || !Number.isInteger(port.timeoutMs) || port.timeoutMs < 1 || port.timeoutMs > 30_000
          || !this.current()) return denied();
      const binding = this.readBinding(), account = this.readVerifiedAccount();
      if (!binding || !account || !this.currentPinned(binding, account)) return denied();
      this.repo(r => r.reserve(pin.credential_ref, pin.revision, account, "refresh"));
      reserved = true;
      this.refreshes().set(pin.credential_ref, null);
      const read = this.credentials.consume(pin, bytes => {
        const parsed = this.stored(bytes);
        if (!parsed.refreshToken || this.clock() < parsed.issuedAtMs)
          throw new Error("CREDENTIAL_UNAVAILABLE");
        refreshToken = parsed.refreshToken;
      });
      const accountStillCurrent = this.currentPinned(binding, account);
      if (!read.ok || !refreshToken || !accountStillCurrent) {
        if (!accountStillCurrent) this.revokeRefreshIntent(pin, account);
        return denied();
      }
      this.repo(r => r.requireRefresh(pin.credential_ref, pin.revision, account));
      const controller = new AbortController();
      this.refreshes().set(pin.credential_ref, controller);
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exchange = Promise.resolve().then(() => port.refresh(refreshToken, controller.signal))
        .then(value => {
          if (expired || controller.signal.aborted) {
            if (value?.tokens) {
              value.tokens.accessToken = "";
              value.tokens.refreshToken = undefined;
              value.tokens.idToken = undefined;
            }
            throw new Error("CREDENTIAL_UNAVAILABLE");
          }
          return value;
        });
      try {
        response = await Promise.race([exchange, new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            controller.abort();
            reject(new Error("CREDENTIAL_UNAVAILABLE"));
          }, port.timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); controller.abort(); }
      const accountVerified = this.currentPinned(binding, account);
      if (!response || !response.tokens || response.verifiedAccountId !== account
          || typeof response.tokens.accessToken !== "string" || !response.tokens.accessToken
          || (response.tokens.refreshToken !== undefined && typeof response.tokens.refreshToken !== "string")
          || (response.tokens.idToken !== undefined && typeof response.tokens.idToken !== "string")
          || !accountVerified) {
        if (!accountVerified || response?.verifiedAccountId !== account)
          this.revokeRefreshIntent(pin, account);
        return denied();
      }
      this.repo(r => r.requireRefresh(pin.credential_ref, pin.revision, account));
      const expiry = this.expiry(response.tokens.expiresIn);
      const nextSecret = Buffer.from(JSON.stringify({ kind: "codex-oauth.v1",
        accessToken: response.tokens.accessToken, refreshToken: response.tokens.refreshToken ?? refreshToken,
        idToken: response.tokens.idToken ?? null, ...expiry }), "utf8");
      let saved: CredentialResult;
      try { saved = this.credentials.save(pin, () => nextSecret, true); }
      finally { nextSecret.fill(0); }
      const accountAtCommit = this.currentPinned(binding, account);
      if (!saved.ok || !accountAtCommit) {
        if (!accountAtCommit) this.revokeRefreshIntent(pin, account);
        return denied();
      }
      this.repo(r => r.requireRefresh(pin.credential_ref, pin.revision, account));
      if (!this.credentials.cleanup(pin)) return denied();
      this.repo(r => r.completeRefresh(pin.credential_ref, pin.revision));
      return saved;
    } catch { return denied(); }
    finally {
      refreshToken = "";
      if (response?.tokens) {
        response.tokens.accessToken = "";
        response.tokens.refreshToken = undefined;
        response.tokens.idToken = undefined;
      }
      if (reserved) this.refreshes().delete(pin.credential_ref);
    }
  }

  /** Disconnect locally and retain a terminal account pin. Remote provider
   * revocation is outside this host-only contract until registration is reviewed. */
  disconnect(pin: CredentialRequest): CredentialResult {
    try {
      if (!this.current()) return denied();
      const account = this.readVerifiedAccount();
      if (!account || !this.current(undefined, account)) return denied();
      return this.retireRecorded(pin, account);
    } catch { return denied(); }
  }

  /** Explicit local cleanup of every pin in this trusted org/principal/Project
   * and connector. No selected account or renderer ref is required for deletion. */
  disconnectStored(): boolean {
    try {
      if (!this.scopeCurrent()) return false;
      this.repairPending();
      const pins = this.repo(r => r.activePins());
      for (const pin of pins) {
        if (!this.scopeCurrent() || !this.retireRecorded({ credential_ref: pin.ref,
          connector_id: this.connectorId, revision: pin.revision }, pin.accountId).ok) return false;
      }
      return this.scopeCurrent() && !this.repo(r => r.hasLive());
    } catch { return false; }
  }

  private retireRecorded(pin: CredentialRequest, account: string): CredentialResult {
    let reserved = false;
    try {
      if (!this.scopeCurrent()) return denied();
      this.repo(r => r.claimRevoke(pin.credential_ref, pin.revision, account));
      reserved = true;
      this.refreshes().get(pin.credential_ref)?.abort();
      if (!this.scopeCurrent()) return denied();
      const result = this.credentials.retire(pin);
      if (result.ok && this.credentials.confirmRetired(pin)) {
        this.repo(r => r.completeRevoke(pin.credential_ref, pin.revision, pin.revision + 1));
        return result;
      }
      const next = { ...pin, revision: pin.revision + 1 };
      const successor = this.credentials.retire(next);
      if (successor.ok && this.credentials.confirmRetired(next) && this.credentials.cleanup(pin)) {
        this.repo(r => r.completeRevoke(pin.credential_ref, pin.revision, next.revision + 1));
        return successor;
      }
      return denied();
    } catch { return denied(); }
    finally { if (reserved) this.repairOperations(); }
  }

  /** Reconcile only recorded exact revisions, without Keychain enumeration.
   * Mismatched partial writes are tombstoned, never replayed or republished. */
  repairOperations(): number {
    if (!this.scopeCurrent()) return 0;
    let repaired = 0;
    let operations: ReturnType<CodexAccountRepository["pendingOperations"]>;
    try { operations = this.repo(r => r.pendingOperations()); }
    catch { return 0; }
    for (const operation of operations) {
      if (operation.kind === "refresh" && this.refreshes().has(operation.ref)) continue;
      const old: CredentialRequest = { credential_ref: operation.ref,
        connector_id: this.connectorId, revision: operation.revision };
      const next = { ...old, revision: old.revision + 1 };
      try {
        if (this.credentials.confirmRetired(next) && this.credentials.cleanup(old)) {
          this.repo(r => r.completeRevoke(old.credential_ref, old.revision, next.revision + 1));
          repaired++; continue;
        }
        const nextInspection = this.credentials.inspect(next);
        if (nextInspection.ok && nextInspection.value.state === "ready") {
          const binding = this.readBinding();
          if (operation.kind === "refresh" && binding
              && this.currentPinned(binding, operation.accountId)) {
            if (!this.credentials.cleanup(old)) continue;
            this.repo(r => r.completeRefresh(old.credential_ref, old.revision));
            repaired++; continue;
          }
          if (this.credentials.retire(next).ok && this.credentials.confirmRetired(next)
              && this.credentials.cleanup(old)) {
            this.repo(r => r.completeRevoke(old.credential_ref, old.revision, next.revision + 1));
            repaired++;
          }
          continue;
        }
        if (this.credentials.confirmRetired(old) && this.credentials.cleanup(next)) {
          this.repo(r => r.completeRevoke(old.credential_ref, old.revision, next.revision));
          repaired++; continue;
        }
        const oldInspection = this.credentials.inspect(old);
        if (oldInspection.ok && oldInspection.value.state === "ready") {
          if (this.credentials.retire(old).ok && this.credentials.confirmRetired(old)
              && this.credentials.cleanup(next)) {
            this.repo(r => r.completeRevoke(old.credential_ref, old.revision, next.revision)); repaired++;
          }
          continue;
        }
        if (this.credentials.repair(old).ok && this.credentials.confirmRetired(old)
            && this.credentials.cleanup(next)) {
          this.repo(r => r.completeRevoke(old.credential_ref, old.revision, next.revision));
          repaired++; continue;
        }
        if (this.credentials.repair(next).ok && this.credentials.confirmRetired(next)
            && this.credentials.cleanup(old)) {
          this.repo(r => r.completeRevoke(old.credential_ref, old.revision, next.revision + 1));
          repaired++;
        }
      } catch { /* Durable pending intent remains denied for a later repair. */ }
    }
    return repaired;
  }

  /** Explicit host repair after a crash or failed publication. No resurrection. */
  repairPending(): number {
    if (!this.scopeCurrent()) return 0;
    let cleared = 0;
    for (const ref of this.repo(r => r.pending())) {
      const pin: CredentialRequest = { credential_ref: ref, connector_id: this.connectorId, revision: 0 };
      try {
        // F5 may have completed retirement before this account-row CAS or a
        // process crash. Confirm its exact terminal marker and erased old slot
        // before attempting any stale revision-zero operation.
        if (this.credentials.confirmRetired(pin)) {
          this.repo(r => r.abandon(ref)); cleared++; continue;
        }
        const inspection = this.credentials.inspect(pin);
        const unstaged = !inspection.ok && this.repo(r => r.abandonUnstaged(ref));
        const safe = inspection.ok
          ? (this.credentials.retire(pin).ok || this.credentials.repair(pin).ok)
          : (unstaged || this.credentials.abandonCreate(pin));
        if (!safe) continue;
        if (inspection.ok && !this.credentials.confirmRetired(pin)) continue;
        if (!unstaged) this.repo(r => r.abandon(ref));
        cleared++;
      } catch { /* Keep the pending denial for a later repair. */ }
    }
    return cleared;
  }
}
