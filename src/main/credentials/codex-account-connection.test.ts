import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteFoundation } from "../../storage/sqlite/foundation";
import { migrate, SQLITE_MIGRATIONS } from "../../storage/sqlite/migrations";
import { HostCredentialService } from "./service";
import { CodexAccountConnection, type HostCodexRefreshPort } from "./codex-account-connection";
import type { HostCodexOAuthCeremony, HostOAuthBinding } from "./codex-oauth-ceremony";
import type { KeychainAdapter } from "./keychain";

const CANARY = "SYNTHETIC_CODEX_TOKEN_NEVER_PROJECT";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const connectorId = uuid(41);
const dirs: string[] = [], stores: SqliteFoundation[] = [];
function open(path = mkdtempSync(join(tmpdir(), "orclocal-172-"))) {
  if (!dirs.includes(path)) dirs.push(path);
  const store = SqliteFoundation.open(path); stores.push(store); return store;
}
class MemoryKeychain implements KeychainAdapter {
  items = new Map<string, Buffer>(); calls = 0; failAt = -1; failAfter = false;
  private step<T>(work: () => T): T {
    const fail = ++this.calls === this.failAt;
    if (fail && !this.failAfter) throw Error(CANARY);
    const result = work();
    if (fail && this.failAfter) throw Error(CANARY);
    return result;
  }
  read(key: string) { return this.step(() => this.items.has(key) ? Buffer.from(this.items.get(key)!) : null); }
  compareExchange(key: string, expected: Buffer | null, value: Buffer) {
    this.step(() => {
      const prior = this.items.get(key);
      if (expected ? !prior || !prior.subarray(0, 32).equals(expected) : !!prior) throw Error(CANARY);
      this.items.set(key, Buffer.from(value));
    });
  }
  remove(key: string, expected: Buffer) {
    this.step(() => {
      const prior = this.items.get(key);
      if (prior && !prior.subarray(0, 32).equals(expected)) throw Error(CANARY);
      this.items.delete(key);
    });
  }
  reset() { this.calls = 0; this.failAt = -1; this.failAfter = false; }
}
function fixture(store = open(), keychain = new MemoryKeychain(), now: () => number = Date.now) {
  const c = store.workspace;
  let selected: HostOAuthBinding | null = { orgId: c.org_id, principalId: c.principal.id,
    projectId: c.project_id, connectorId, windowId: "window", sessionId: "session", accountId: "account-one" };
  let verified: string | null = "account-one";
  const credentials = new HostCredentialService(store, keychain, { org_id: c.org_id, principal: c.principal },
    { isActive: () => true, allow: (_op, connector) => connector === connectorId });
  const connection = new CodexAccountConnection(store, credentials, connectorId, () => selected, () => verified, now);
  function ceremony(accountId = "account-one", accessToken = CANARY) {
    let handoff: unknown = { binding: { ...selected }, accountId,
      tokens: { accessToken, refreshToken: CANARY + "-refresh", idToken: CANARY + "-id",
        expiresIn: 3600 } };
    return { takeTokens: () => { const result = handoff; handoff = null; return result; } } as HostCodexOAuthCeremony;
  }
  return { store, keychain, connection, ceremony,
    select(value: HostOAuthBinding | null) { selected = value; },
    selected: () => selected,
    verify(value: string | null) { verified = value; } };
}
afterEach(() => { for (const store of stores.splice(0)) try { store.close(); } catch { /* closed by test */ }
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("ORCLOCAL-172 host account pin", () => {
  it("stores only a scoped account pin in SQLite and Keychain bytes behind F5", () => {
    const f = fixture();
    const created = f.connection.connect(f.ceremony());
    expect(created).toMatchObject({ ok: true, value: { connector_id: connectorId, revision: 0, state: "ready" } });
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    expect(f.connection.inspect(pin)).toMatchObject({ ok: true, value: { state: "ready" } });
    let calls = 0;
    expect(f.connection.consume(pin, bytes => {
      calls++;
      expect(JSON.parse(bytes.toString())).toMatchObject({ kind: "codex-oauth.v1", accessToken: CANARY });
    }).ok).toBe(true);
    expect(calls).toBe(1);
    const row = f.store.transaction(tx => tx.get("SELECT * FROM local_codex_oauth_accounts WHERE credential_ref=?", pin.credential_ref));
    expect(row).toMatchObject({ state: "active", project_id: f.store.workspace.project_id,
      account_id: "account-one", account_display: "account-one", provenance: "trusted_account_verifier" });
    expect(JSON.stringify(row)).not.toContain(CANARY);
    expect(JSON.stringify(created)).not.toContain(CANARY);
    expect(f.keychain.items.size).toBe(2);
  });

  it("denies selected Project, connector, account and stale revision before any secret sink", () => {
    const f = fixture(), created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    const sink = () => { throw Error("sink must not run"); };
    expect(f.connection.consume({ ...pin, revision: 1 }, sink).ok).toBe(false);
    expect(f.connection.consume({ ...pin, connector_id: uuid(42) }, sink).ok).toBe(false);
    for (const change of [
      { ...f.selected()!, projectId: uuid(43) }, { ...f.selected()!, connectorId: uuid(42) },
      { ...f.selected()!, orgId: uuid(44) }, { ...f.selected()!, principalId: uuid(45) },
    ]) {
      f.select(change); expect(f.connection.consume(pin, sink).ok).toBe(false);
    }
    f.select({ ...f.selected()!, orgId: f.store.workspace.org_id, principalId: f.store.workspace.principal.id,
      projectId: f.store.workspace.project_id, connectorId });
    f.verify("account-two"); expect(f.connection.consume(pin, sink).ok).toBe(false);
    f.verify(null); expect(f.connection.inspect(pin).ok).toBe(false);
    f.verify("account-one"); expect(f.connection.inspect(pin).ok).toBe(true);
  });

  it("rejects account replacement between callback and handoff publication", () => {
    const f = fixture(), handoff = f.ceremony();
    f.verify("account-two");
    const result = f.connection.connect(handoff);
    expect(result.ok).toBe(false);
    expect(f.keychain.items.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("pins the verified callback account on first sign-in before account selection exists", () => {
    const f = fixture();
    f.select({ ...f.selected()!, accountId: null }); f.verify(null);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    expect(f.connection.inspect(pin).ok).toBe(false);
    f.select({ ...f.selected()!, accountId: "account-one" }); f.verify("account-one");
    expect(f.connection.inspect(pin)).toMatchObject({ ok: true, value: { state: "ready" } });
  });

  it("closes a pre-stage invalid handoff without touching Keychain", () => {
    const f = fixture();
    expect(f.connection.connect(f.ceremony("account-one", "")).ok).toBe(false);
    expect(f.keychain.items.size).toBe(0);
    expect(f.connection.repairPending()).toBe(1);
    expect(f.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts")))
      .toEqual({ state: "abandoned" });
  });

  it.each([false, true])("repairs pre/post Keychain faults after restart without publishing (%s)", after => {
    for (const failAt of [1, 2]) {
      const path = mkdtempSync(join(tmpdir(), "orclocal-172-restart-")); dirs.push(path);
      const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
      keychain.failAt = failAt; keychain.failAfter = after;
      const result = f.connection.connect(f.ceremony());
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(CANARY);
      f.store.close(); keychain.reset();
      const restarted = fixture(open(path), keychain);
      restarted.verify(null); // cleanup must remain possible without a selected account
      expect(restarted.connection.repairPending()).toBe(1);
      expect(restarted.connection.repairPending()).toBe(0);
      expect(restarted.store.transaction(tx => tx.all("SELECT state FROM local_codex_oauth_accounts")))
        .toEqual([{ state: "abandoned" }]);
      expect([...keychain.items.values()].every(bytes => !bytes.includes(Buffer.from(CANARY)))).toBe(true);
    }
  });

  it("leaves a failed publication pending and retires the saved secret on restart", () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-172-publish-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    f.store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_publish BEFORE UPDATE ON local_codex_oauth_accounts
      WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`));
    expect(f.connection.connect(f.ceremony()).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts"))).toEqual({ state: "pending" });
    f.store.transaction(tx => tx.run("DROP TRIGGER deny_codex_publish"));
    f.store.close();
    const restarted = fixture(open(path), keychain);
    expect(restarted.connection.repairPending()).toBe(1);
    expect(restarted.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts")))
      .toEqual({ state: "abandoned" });
  });

  it.each(["retire", "repair"] as const)("closes a pending row after crash between F5 %s and account abandonment", mode => {
    const path = mkdtempSync(join(tmpdir(), `orclocal-172-${mode}-`)); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    f.store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_publish BEFORE UPDATE ON local_codex_oauth_accounts
      WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END`));
    expect(f.connection.connect(f.ceremony()).ok).toBe(false);
    f.store.transaction(tx => tx.run("DROP TRIGGER deny_codex_publish"));
    const markerKey = [...keychain.items.keys()].find(key => !key.includes(":"))!;
    const originalMarker = Buffer.from(keychain.items.get(markerKey)!);
    if (mode === "repair") keychain.items.set(markerKey, Buffer.alloc(32, 7));
    f.store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_abandon BEFORE UPDATE ON local_codex_oauth_accounts
      WHEN NEW.state='abandoned' BEGIN SELECT RAISE(ABORT,'synthetic crash boundary'); END`));
    expect(f.connection.repairPending()).toBe(0);
    expect(f.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts")))
      .toEqual({ state: "pending" });
    const terminal = f.store.transaction(tx => tx.get("SELECT revision,state FROM credential_metadata"));
    expect(terminal).toEqual({ revision: 1, state: mode === "retire" ? "revoked" : "tombstoned" });
    const terminalMarker = Buffer.from(keychain.items.get(markerKey)!);
    expect(terminalMarker.equals(originalMarker)).toBe(false);
    f.store.transaction(tx => tx.run("DROP TRIGGER deny_codex_abandon"));
    f.store.close();
    const restarted = fixture(open(path), keychain);
    keychain.items.set(markerKey, originalMarker); // stale authority cannot certify clearance
    expect(restarted.connection.repairPending()).toBe(0);
    expect(restarted.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts")))
      .toEqual({ state: "pending" });
    keychain.items.set(markerKey, terminalMarker);
    expect(restarted.connection.repairPending()).toBe(1);
    expect(restarted.connection.repairPending()).toBe(0);
    expect(restarted.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts")))
      .toEqual({ state: "abandoned" });
    expect([...keychain.items.keys()].some(key => key.includes(":"))).toBe(false);
  });

  it("keeps the exact active pin after restart and guards a populated downgrade", () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-172-active-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    f.store.close();
    const reopened = fixture(open(path), keychain);
    expect(reopened.connection.inspect(pin)).toMatchObject({ ok: true, value: { state: "ready" } });
    reopened.store.close();
    const db = new DatabaseSync(join(path, "foundation.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys=ON");
      expect(() => migrate(db, 21)).toThrow();
      expect(() => migrate(db, 20)).toThrow();
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_MIGRATIONS.length);
    } finally { db.close(); }
  });

  it("round trips the empty SQLite 20→21→20 migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrate(db, 20); migrate(db, 21); migrate(db, 20);
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(20);
      migrate(db, 21);
      expect(db.prepare("SELECT * FROM local_codex_oauth_accounts").all()).toEqual([]);
    } finally { db.close(); }
  });
});

describe("ORCLOCAL-173 host credential lifecycle", () => {
  function port(accessToken = CANARY + "-rotated", verifiedAccountId = "account-one"): HostCodexRefreshPort {
    return { enabled: true, timeoutMs: 1000,
      refresh: async (refreshToken, signal) => {
        expect(signal.aborted).toBe(false);
        expect(refreshToken).toBe(CANARY + "-refresh");
        return { tokens: { accessToken, refreshToken: CANARY + "-refresh-rotated",
          expiresIn: 3600 }, verifiedAccountId };
      } };
  }
  it("rotates by exact CAS, retires old bytes, and recovers the new pin after restart", async () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-173-rotation-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const old = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    const rotated = await f.connection.refresh(old, port());
    expect(rotated).toMatchObject({ ok: true, value: { revision: 1, state: "ready" } });
    const next = { ...old, revision: 1 };
    expect(f.connection.inspect(old).ok).toBe(false);
    let seen = "";
    expect(f.connection.consume(next, bytes => { seen = JSON.parse(bytes.toString()).accessToken; }).ok).toBe(true);
    expect(seen).toBe(CANARY + "-rotated");
    expect([...keychain.items.keys()].some(key => key.endsWith(":0"))).toBe(false);
    const row = f.store.transaction(tx => tx.get("SELECT * FROM local_codex_oauth_accounts WHERE credential_ref=?", old.credential_ref));
    expect(row).toMatchObject({ account_id: "account-one", credential_revision: 1, pending_kind: null,
      pending_revision: null, state: "active" });
    expect(JSON.stringify(row)).not.toContain(CANARY);
    f.store.close();
    const restarted = fixture(open(path), keychain);
    expect(restarted.connection.inspect(next)).toMatchObject({ ok: true, value: { state: "ready" } });
    expect(restarted.connection.inspect(old).ok).toBe(false);
  });

  it("fences concurrent refresh, repair and reads while a bounded exchange is pending", async () => {
    const f = fixture(), created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    let release!: (value: Awaited<ReturnType<HostCodexRefreshPort["refresh"]>>) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const slow: HostCodexRefreshPort = { enabled: true, timeoutMs: 1000, refresh: async () => {
      calls++; entered();
      return new Promise(resolve => { release = resolve; });
    } };
    const first = f.connection.refresh(pin, slow);
    await started;
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(f.connection.consume(pin, () => { throw Error("stale sink"); }).ok).toBe(false);
    expect((await f.connection.refresh(pin, slow)).ok).toBe(false);
    expect(f.connection.repairOperations()).toBe(0);
    expect(fixture(f.store, f.keychain).connection.repairOperations()).toBe(0);
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(calls).toBe(1);
    release({ tokens: { accessToken: CANARY + "-rotated", expiresIn: 3600 },
      verifiedAccountId: "account-one" });
    expect(await first).toMatchObject({ ok: true, value: { revision: 1 } });
  });

  it("lets disconnect durably win over an in-flight refresh", async () => {
    const f = fixture(), created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    let release!: (value: Awaited<ReturnType<HostCodexRefreshPort["refresh"]>>) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const slow: HostCodexRefreshPort = { enabled: true, timeoutMs: 1000, refresh: async () => {
      entered();
      return new Promise(resolve => { release = resolve; });
    } };
    const refreshing = f.connection.refresh(pin, slow);
    await started;
    expect(f.connection.disconnect(pin)).toMatchObject({ ok: true, value: { state: "revoked" } });
    expect(f.connection.inspect(pin).ok).toBe(false);
    release({ tokens: { accessToken: CANARY + "-late", expiresIn: 3600 },
      verifiedAccountId: "account-one" });
    expect((await refreshing).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT state,pending_kind FROM local_codex_oauth_accounts")))
      .toEqual({ state: "revoked", pending_kind: null });
    expect([...f.keychain.items.values()].every(bytes => !bytes.includes(Buffer.from(CANARY + "-late"))))
      .toBe(true);
  });

  it("rejects a verified account becoming null during exchange", async () => {
    const f = fixture(), created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    let release!: (value: Awaited<ReturnType<HostCodexRefreshPort["refresh"]>>) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const slow: HostCodexRefreshPort = { enabled: true, timeoutMs: 1000, refresh: async () => {
      entered();
      return new Promise(resolve => { release = resolve; });
    } };
    const refreshing = f.connection.refresh(pin, slow);
    await started;
    f.verify(null);
    release({ tokens: { accessToken: CANARY + "-late", expiresIn: 3600 },
      verifiedAccountId: "account-one" });
    expect((await refreshing).ok).toBe(false);
    f.verify("account-one");
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(f.connection.repairOperations()).toBe(1);
    expect(f.connection.inspect(pin).ok).toBe(false);
  });

  it("enforces absolute expiry and refresh margin across restart", async () => {
    let now = 1_000_000;
    const path = mkdtempSync(join(tmpdir(), "orclocal-173-expiry-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain, () => now);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    now += 3_540_000; // 60 seconds before expiry: inside the refresh margin.
    expect(f.connection.inspect(pin)).toMatchObject({ ok: true, value: { state: "unavailable" } });
    expect(f.connection.consume(pin, () => { throw Error("expired sink"); }).ok).toBe(false);
    f.store.close();
    now += 60_001;
    const restarted = fixture(open(path), keychain, () => now);
    expect(restarted.connection.inspect(pin)).toMatchObject({ ok: true, value: { state: "unavailable" } });
    expect(restarted.connection.consume(pin, () => { throw Error("expired sink"); }).ok).toBe(false);
    expect(await restarted.connection.refresh(pin, port())).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(restarted.connection.inspect({ ...pin, revision: 1 }))
      .toMatchObject({ ok: true, value: { state: "ready" } });
  });

  it("denies a legacy relative-expiry payload without an absolute deadline", () => {
    const f = fixture(), created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    const slot = [...f.keychain.items.keys()].find(key => key.endsWith(":0"))!;
    const tag = f.keychain.items.get(slot)!.subarray(0, 32);
    f.keychain.items.set(slot, Buffer.concat([tag, Buffer.from(JSON.stringify({
      kind: "codex-oauth.v1", accessToken: CANARY, refreshToken: CANARY + "-refresh",
      idToken: null, expiresIn: 3600,
    }))]));
    expect(f.connection.inspect(pin)).toMatchObject({ ok: true, value: { state: "unavailable" } });
    expect(f.connection.consume(pin, () => { throw Error("legacy sink"); }).ok).toBe(false);
  });

  it("requires a bounded lifetime before accepting a new handoff", () => {
    const f = fixture();
    const handoff = { binding: { ...f.selected()! }, accountId: "account-one",
      tokens: { accessToken: CANARY, refreshToken: CANARY + "-refresh" } };
    expect(f.connection.connect({ takeTokens: () => handoff } as HostCodexOAuthCeremony).ok).toBe(false);
    expect(f.keychain.items.size).toBe(0);
    expect(f.connection.repairPending()).toBe(1);
  });

  it("keeps an ambiguous account mismatch denied until explicit local retirement", async () => {
    const f = fixture(), created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    expect((await f.connection.refresh(pin, port(CANARY + "-wrong", "account-two"))).ok).toBe(false);
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT pending_kind FROM local_codex_oauth_accounts")))
      .toEqual({ pending_kind: "revoke" });
    expect(f.connection.repairOperations()).toBe(1);
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT state FROM local_codex_oauth_accounts")))
      .toEqual({ state: "revoked" });
  });

  it("times out once, keeps the old token fenced, and denies late exchange completion after restart", async () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-173-timeout-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    let release!: (value: Awaited<ReturnType<HostCodexRefreshPort["refresh"]>>) => void;
    const timeout: HostCodexRefreshPort = { enabled: true, timeoutMs: 1,
      refresh: () => new Promise(resolve => { release = resolve; }) };
    expect((await f.connection.refresh(pin, timeout)).ok).toBe(false);
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT credential_revision,pending_kind FROM local_codex_oauth_accounts")))
      .toEqual({ credential_revision: 0, pending_kind: "refresh" });
    f.store.close();
    const restarted = fixture(open(path), keychain);
    expect(restarted.connection.inspect(pin).ok).toBe(false);
    expect(restarted.connection.repairOperations()).toBe(1);
    release({ tokens: { accessToken: CANARY + "-late", expiresIn: 3600 },
      verifiedAccountId: "account-one" });
    await Promise.resolve();
    expect(restarted.connection.inspect(pin).ok).toBe(false);
    expect([...keychain.items.values()].every(bytes => !bytes.includes(Buffer.from(CANARY + "-late"))))
      .toBe(true);
  });

  it.each([false, true])("repairs a Keychain fault before or after rotation write (%s)", async after => {
    for (const offset of [4, 5]) {
      const f = fixture(), created = f.connection.connect(f.ceremony());
      if (!created.ok) throw Error("connection failed");
      const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
      const faulty: HostCodexRefreshPort = { enabled: true, timeoutMs: 1000, refresh: async () => {
        f.keychain.failAt = f.keychain.calls + offset;
        f.keychain.failAfter = after;
        return { tokens: { accessToken: CANARY + "-rotated", expiresIn: 3600 },
          verifiedAccountId: "account-one" };
      } };
      const result = await f.connection.refresh(pin, faulty);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(CANARY);
      f.keychain.reset();
      expect(f.connection.inspect(pin).ok).toBe(false);
      expect(f.connection.repairOperations()).toBe(1);
      expect(f.connection.inspect({ ...pin, revision: 1 }).ok).toBe(false);
      expect([...f.keychain.items.values()].every(bytes => !bytes.includes(Buffer.from(CANARY + "-rotated"))))
        .toBe(true);
    }
  });

  it("recovers a failed account CAS after F5 rotation without accepting stale reads", async () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-173-cas-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const old = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    f.store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_rotation BEFORE UPDATE OF credential_revision
      ON local_codex_oauth_accounts WHEN NEW.credential_revision=1
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`));
    expect((await f.connection.refresh(old, port())).ok).toBe(false);
    expect(f.connection.inspect(old).ok).toBe(false);
    expect(f.connection.inspect({ ...old, revision: 1 }).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT pending_kind FROM local_codex_oauth_accounts")))
      .toEqual({ pending_kind: "refresh" });
    f.store.transaction(tx => tx.run("DROP TRIGGER deny_codex_rotation"));
    f.store.close();
    const restarted = fixture(open(path), keychain);
    expect(restarted.connection.repairOperations()).toBe(1);
    expect(restarted.connection.inspect({ ...old, revision: 1 }))
      .toMatchObject({ ok: true, value: { state: "ready" } });
    expect(restarted.connection.inspect(old).ok).toBe(false);
  });

  it("disconnects locally, then completes a failed SQLite CAS after restart", () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-173-revoke-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const pin = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    f.store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_disconnect BEFORE UPDATE OF state
      ON local_codex_oauth_accounts WHEN NEW.state='revoked'
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`));
    expect(f.connection.disconnect(pin).ok).toBe(false);
    expect(f.connection.inspect(pin).ok).toBe(false);
    expect(f.store.transaction(tx => tx.get("SELECT pending_kind FROM local_codex_oauth_accounts")))
      .toEqual({ pending_kind: "revoke" });
    f.store.transaction(tx => tx.run("DROP TRIGGER deny_codex_disconnect"));
    f.store.close();
    const restarted = fixture(open(path), keychain);
    expect(restarted.connection.repairOperations()).toBe(1);
    expect(restarted.store.transaction(tx => tx.get("SELECT state,credential_revision FROM local_codex_oauth_accounts")))
      .toEqual({ state: "revoked", credential_revision: 1 });
    expect(restarted.connection.inspect(pin).ok).toBe(false);
    expect([...keychain.items.keys()].some(key => key.endsWith(":0"))).toBe(false);
  });

  it("recovers disconnect after a rotated successor was retired before its account CAS", async () => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-173-successor-revoke-")); dirs.push(path);
    const keychain = new MemoryKeychain(), f = fixture(open(path), keychain);
    const created = f.connection.connect(f.ceremony());
    if (!created.ok) throw Error("connection failed");
    const old = { credential_ref: created.value.credential_ref, connector_id: connectorId, revision: 0 };
    f.store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_successor BEFORE UPDATE OF credential_revision
      ON local_codex_oauth_accounts WHEN NEW.credential_revision>0
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`));
    expect((await f.connection.refresh(old, port())).ok).toBe(false);
    expect(f.connection.disconnect(old).ok).toBe(false);
    expect(f.connection.inspect(old).ok).toBe(false);
    expect(f.connection.inspect({ ...old, revision: 1 }).ok).toBe(false);
    f.store.transaction(tx => tx.run("DROP TRIGGER deny_codex_successor"));
    f.store.close();
    const restarted = fixture(open(path), keychain);
    expect(restarted.connection.repairOperations()).toBe(1);
    expect(restarted.store.transaction(tx => tx.get("SELECT state,credential_revision FROM local_codex_oauth_accounts")))
      .toEqual({ state: "revoked", credential_revision: 2 });
    expect([...keychain.items.keys()].some(key => key.endsWith(":0") || key.endsWith(":1"))).toBe(false);
  });

  it("guards populated downgrade and round trips an empty 21→22→21 migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrate(db, 21); migrate(db, 22); migrate(db, 21);
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(21);
      migrate(db, 22);
      expect(db.prepare("SELECT * FROM local_codex_oauth_accounts").all()).toEqual([]);
    } finally { db.close(); }
  });
});
