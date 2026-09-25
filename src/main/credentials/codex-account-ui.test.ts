import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteFoundation } from "../../storage/sqlite/foundation";
import type { HostDocument } from "../background/service";
import type { KeychainAdapter } from "./keychain";
import { HostCredentialService } from "./service";
import { CodexAccountConnection } from "./codex-account-connection";
import { CodexAccountUiService } from "./codex-account-ui";
import type { HostCodexOAuthCeremony, HostOAuthBinding } from "./codex-oauth-ceremony";

const secret = "SYNTHETIC_SECRET_MUST_STAY_IN_HOST";
const connectorId = "00000000-0000-4000-8000-000000000041";
const paths: string[] = [], stores: SqliteFoundation[] = [];
function store() {
  const path = mkdtempSync(join(tmpdir(), "orclocal-174-")); paths.push(path);
  const result = SqliteFoundation.open(path); stores.push(result); return result;
}
afterEach(() => { stores.splice(0).forEach(value => value.close()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
const document = { id: "window", isActive: () => true } as HostDocument;

describe("experimental Codex account host projection", () => {
  it("is unavailable by default and rejects secret-bearing commands", async () => {
    const service = new CodexAccountUiService(store(), connectorId);
    expect(await service.invoke({ operation: "read", projectId: "not-selected" }, document)).toEqual({ ok: true, value: {
      availability: "unavailable", state: "unavailable", accountDisplay: null, executionReady: false } });
    expect(await service.invoke({ operation: "start", projectId: "not-selected" }, document)).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await service.invoke({ operation: "start", projectId: "not-selected", explicitOptIn: true, token: secret }, document))
      .toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(JSON.stringify(await service.invoke({ operation: "read", projectId: "not-selected" }, document))).not.toContain(secret);
  });

  it("reauthenticates Project and document, projects only verified account display, and fences stale and revoked credentials", async () => {
    const db = store(), context = db.workspace;
    let now = 1_000_000, verified: string | null = "verified-account";
    let binding: HostOAuthBinding = { orgId: context.org_id, principalId: context.principal.id,
      projectId: context.project_id, connectorId, windowId: document.id, sessionId: "session", accountId: verified };
    const entries = new Map<string, Buffer>();
    const keychain: KeychainAdapter = {
      read: key => entries.has(key) ? Buffer.from(entries.get(key)!) : null,
      compareExchange: (key, expected, value) => {
        const old = entries.get(key);
        if (expected ? !old || !old.subarray(0, 32).equals(expected) : !!old) throw Error(secret);
        entries.set(key, Buffer.from(value));
      },
      remove: (key, expected) => {
        const old = entries.get(key);
        if (old && !old.subarray(0, 32).equals(expected)) throw Error(secret);
        entries.delete(key);
      },
    };
    const credentials = new HostCredentialService(db, keychain, { org_id: context.org_id, principal: context.principal },
      { isActive: () => true, allow: () => true });
    const connection = new CodexAccountConnection(db, credentials, connectorId, () => binding, () => verified, () => now);
    let pending = false, completed = false;
    const ceremony = {
      begin: async () => { pending = true; }, cancel: () => { pending = false; completed = false; },
      isPending: () => pending, hasCompleted: () => completed,
      takeTokens: () => {
        if (!completed) return null;
        completed = false;
        return { binding: { ...binding }, accountId: verified!, tokens: {
          accessToken: secret, refreshToken: secret, expiresIn: 120 } };
      },
    } as unknown as HostCodexOAuthCeremony;
    const ports = { ceremony, connection, readBinding: () => binding, readVerifiedAccount: () => verified };
    const service = new CodexAccountUiService(db, connectorId, ports);
    const projectId = context.project_id;
    expect(await service.invoke({ operation: "read", projectId: "another-project" }, document))
      .toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(await service.invoke({ operation: "start", projectId: "another-project", explicitOptIn: true }, document))
      .toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(pending).toBe(false);
    binding = { ...binding, projectId: "wrong-project" };
    expect(await service.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    binding = { ...binding, projectId: context.project_id, orgId: "wrong-org" };
    expect(await service.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    binding = { ...binding, orgId: context.org_id, principalId: "wrong-principal" };
    expect(await service.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    binding = { ...binding, principalId: context.principal.id };
    expect(await service.invoke({ operation: "start", projectId, explicitOptIn: true }, document))
      .toMatchObject({ ok: true, value: { state: "pending" } });
    expect(await service.invoke({ operation: "cancel", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "disconnected" } });
    expect(await service.invoke({ operation: "start", projectId, explicitOptIn: true }, document))
      .toMatchObject({ ok: true, value: { state: "pending" } });
    pending = false; completed = true;
    const connected = await service.invoke({ operation: "read", projectId }, document);
    expect(connected).toEqual({ ok: true, value: { availability: "available", state: "connected",
      accountDisplay: "••••", executionReady: false } });
    expect(JSON.stringify(connected)).not.toContain(secret);
    expect(JSON.stringify(connected)).not.toContain("verified-account");
    const restarted = new CodexAccountUiService(db, connectorId, ports);
    expect(await restarted.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "connected" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId: "another-project" }, document))
      .toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(await restarted.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "connected" } });
    now += 120_000;
    expect(await restarted.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "stale", accountDisplay: null } });
    // Stale material must be explicitly disconnected before UI reauth.
    expect(await restarted.invoke({ operation: "start", projectId, explicitOptIn: true }, document))
      .toMatchObject({ ok: true, value: { state: "stale" } });
    expect(pending).toBe(false);
    // Simulate older direct host state that already has a second active row.
    completed = true;
    expect(connection.connect(ceremony).ok).toBe(true);
    expect(db.transaction(tx => tx.all(`SELECT credential_ref FROM local_codex_oauth_accounts
      WHERE state='active'`))).toHaveLength(2);
    expect(await restarted.invoke({ operation: "read", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "connected" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId }, document)).toMatchObject({ ok: true, value: { state: "revoked" } });
    expect(db.transaction(tx => tx.all(`SELECT credential_ref FROM local_codex_oauth_accounts
      WHERE state='active'`))).toEqual([]);
    expect([...entries.values()].every(bytes => !bytes.includes(Buffer.from(secret)))).toBe(true);

    // A failed reauth publication can leave a pending row *and* an older stale
    // active row. One disconnect must retire both, never claim disconnected early.
    completed = true;
    expect(connection.connect(ceremony).ok).toBe(true);
    now += 120_000;
    db.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_publish BEFORE UPDATE ON local_codex_oauth_accounts
      WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`));
    completed = true;
    expect(connection.connect(ceremony).ok).toBe(false);
    db.transaction(tx => tx.run("DROP TRIGGER deny_codex_publish"));
    expect(await restarted.invoke({ operation: "read", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "stale" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId: "another-project" }, document))
      .toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "disconnected" } });
    expect(db.transaction(tx => tx.get(`SELECT state FROM local_codex_oauth_accounts
      ORDER BY rowid DESC LIMIT 1`))).toEqual({ state: "abandoned" });
    expect(db.transaction(tx => tx.all(`SELECT credential_ref FROM local_codex_oauth_accounts
      WHERE state IN ('active','pending')`))).toEqual([]);
    expect([...entries.values()].every(bytes => !bytes.includes(Buffer.from(secret)))).toBe(true);
    verified = null;
    expect(await restarted.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "disconnected" } });

    // A missing or changed trusted account selection must not strand a scoped
    // credential behind a misleading Disconnect action.
    verified = "verified-account";
    binding = { ...binding, accountId: verified };
    completed = true;
    expect(connection.connect(ceremony).ok).toBe(true);
    verified = null;
    binding = { ...binding, accountId: null };
    expect(await restarted.invoke({ operation: "read", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "stale" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "disconnected" } });
    expect(db.transaction(tx => tx.all(`SELECT credential_ref FROM local_codex_oauth_accounts
      WHERE state IN ('active','pending')`))).toEqual([]);

    verified = "verified-account";
    binding = { ...binding, accountId: verified };
    completed = true;
    expect(connection.connect(ceremony).ok).toBe(true);
    verified = "different-account";
    binding = { ...binding, accountId: verified };
    expect(await restarted.invoke({ operation: "read", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "stale" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId }, document))
      .toMatchObject({ ok: true, value: { state: "disconnected" } });
    expect(db.transaction(tx => tx.all(`SELECT credential_ref FROM local_codex_oauth_accounts
      WHERE state IN ('active','pending')`))).toEqual([]);
    expect([...entries.values()].every(bytes => !bytes.includes(Buffer.from(secret)))).toBe(true);
  });
});
