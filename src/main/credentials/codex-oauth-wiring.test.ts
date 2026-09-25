import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteFoundation } from "../../storage/sqlite/foundation";
import { CodexAccountRepository } from "../../storage/sqlite/codex-account";
import { HostCredentialService } from "./service";
import type { KeychainAdapter } from "./keychain";
import { CodexAccountConnection } from "./codex-account-connection";
import { CodexAccountUiService } from "./codex-account-ui";
import { HostCodexOAuthCeremony, CODEX_CALLBACK_PATH, type HostOAuthBinding } from "./codex-oauth-ceremony";
import type { CodexOAuthDiagnostic } from "./codex-oauth-diagnostics";
import { CODEX_ACCESS_AUDIENCE, CODEX_CLIENT_ID, CODEX_JWKS_URL, CODEX_TOKEN_URL,
  CodexOAuthProvider } from "./codex-oauth-provider";
import type { HostDocument } from "../background/service";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic", use: "sig", alg: "RS256" };
const connector = "4a988a73-3242-4c6e-8a88-e7a1e039d174";
const dirs: string[] = [], stores: SqliteFoundation[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close());
  dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
const token = (account: string, audience: unknown, now: number, expiry: number) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: audience,
    client_id: CODEX_CLIENT_ID,
    sub: "person", iat: Math.floor(now / 1000) - 5, exp: Math.floor(now / 1000) + expiry,
    "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
};

describe("real host Codex OAuth service wiring with synthetic credentials", () => {
  it.each([
    { shape: "string", identityAudience: CODEX_CLIENT_ID, lifetime: 120 },
    { shape: "singleton array", identityAudience: [CODEX_CLIENT_ID], lifetime: 120 },
    { shape: "singleton array and ten-day lifetime", identityAudience: [CODEX_CLIENT_ID], lifetime: 10 * 86400 },
    { shape: "singleton array and maximum lifetime", identityAudience: [CODEX_CLIENT_ID], lifetime: 14 * 86400 },
    { shape: "failed Keychain save", identityAudience: CODEX_CLIENT_ID, lifetime: 120, saveFails: true },
    { shape: "failed account publish", identityAudience: CODEX_CLIENT_ID, lifetime: 120, publishFails: true },
    { shape: "unreadable saved credential", identityAudience: CODEX_CLIENT_ID, lifetime: 120, readFails: true },
  ])("connects, refreshes, restarts and revokes only the pinned Local Project with $shape ID audience", async ({ identityAudience, lifetime, saveFails, publishFails, readFails }) => {
    const path = mkdtempSync(join(tmpdir(), "orclocal-152-wiring-")); dirs.push(path);
    const store = SqliteFoundation.open(path); stores.push(store);
    const c = store.workspace, document = { id: "document", isActive: () => true } as HostDocument;
    const entries = new Map<string, Buffer>();
    const keychain: KeychainAdapter = {
      read: key => !readFails && entries.has(key) ? Buffer.from(entries.get(key)!) : null,
      compareExchange: (key, expected, value) => {
        if (saveFails) throw Error("PRIVATE_KEYCHAIN_FAILURE");
        const previous = entries.get(key);
        if (expected ? !previous || !previous.subarray(0, 32).equals(expected) : !!previous) throw Error("CAS");
        entries.set(key, Buffer.from(value));
      },
      remove: (key, expected) => {
        const previous = entries.get(key);
        if (previous && !previous.subarray(0, 32).equals(expected)) throw Error("CAS");
        entries.delete(key);
      },
    };
    let now = 1_800_000_000_000, browser = "", account = "account-one", refreshes = 0;
    const selected = () => {
      const pins = store.transaction(tx => new CodexAccountRepository(tx,
        { org_id: c.org_id, principal: c.principal }, c.project_id, connector).activePins());
      return new Set(pins.map(pin => pin.accountId)).size === 1 ? pins[0].accountId : null;
    };
    const binding = (): HostOAuthBinding => ({ orgId: c.org_id, principalId: c.principal.id,
      projectId: c.project_id, connectorId: connector, windowId: document.id, sessionId: document.id,
      accountId: selected() });
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (url === CODEX_JWKS_URL) return Response.json({ keys: [jwk] });
      if (url !== CODEX_TOKEN_URL) throw Error("unexpected endpoint");
      const isRefresh = String(init?.body).includes("refresh_token\"");
      if (isRefresh) refreshes++;
      return Response.json(isRefresh ? { access_token: token(account, [CODEX_ACCESS_AUDIENCE], now, lifetime) } : {
        access_token: token(account, [CODEX_ACCESS_AUDIENCE], now, lifetime),
        id_token: token(account, identityAudience, now, lifetime), refresh_token: "synthetic-refresh" });
    }) as typeof fetch;
    const provider = new CodexOAuthProvider(fetcher, () => now);
    const diagnostics: CodexOAuthDiagnostic[] = [];
    const localPort = await port(), redirectUri = `http://localhost:${localPort}${CODEX_CALLBACK_PATH}`;
    let ui!: CodexAccountUiService;
    const ceremony = new HostCodexOAuthCeremony({ enabled: true, clientId: CODEX_CLIENT_ID,
      authorizeUrl: "https://auth.openai.com/oauth/authorize", redirectUri,
      scope: "openid profile email offline_access", timeoutMs: 5000 }, {
      readBinding: binding, openSystemBrowser: async url => { browser = url; },
      exchangeCode: async input => {
        // The production port requires the fixed 1455 redirect. This fixture
        // substitutes only its loopback address so tests do not occupy that port.
        const response = await fetcher(CODEX_TOKEN_URL, { method: "POST", body: new URLSearchParams(input) });
        const value = await response.json();
        return { accessToken: value.access_token, refreshToken: value.refresh_token,
          idToken: value.id_token, expiresIn: lifetime };
      },
      verifyAccount: tokens => provider.verifyAccount(tokens),
      completeConnection: handoff => ui.completeFromCallback(document, handoff),
      reportFailure: diagnostic => diagnostics.push(diagnostic),
    });
    const connection = () => new CodexAccountConnection(store,
      new HostCredentialService(store, keychain, { org_id: c.org_id, principal: c.principal }, {
        isActive: () => document.isActive(), allow: (_operation, id) => id === connector,
      }), connector, binding, selected, () => now, diagnostic => diagnostics.push(diagnostic));
    const ports = { ceremony, connection: () => connection(), readBinding: () => binding(),
      readVerifiedAccount: selected,
      reportFailure: (diagnostic: CodexOAuthDiagnostic) => diagnostics.push(diagnostic),
      refreshDue: (_document: HostDocument, pin: { credential_ref: string; connector_id: string; revision: number }) => connection().needsRefresh(pin),
      refresh: async (_document: HostDocument, pin: { credential_ref: string; connector_id: string; revision: number }) => {
        await connection().refresh(pin, { enabled: true, timeoutMs: 5000, refresh: async (value, signal) => {
          const tokens = await provider.refresh(value, signal);
          return { tokens, verifiedAccountId: await provider.verifyAccount(tokens) };
        } });
      } };
    ui = new CodexAccountUiService(store, connector, ports);
    const projectId = c.project_id;
    expect(await ui.invoke({ operation: "start", projectId: "wrong", explicitOptIn: true }, document))
      .toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    expect(await ui.invoke({ operation: "start", projectId, explicitOptIn: true }, document))
      .toMatchObject({ ok: true, value: { state: "pending" } });
    if (publishFails) store.transaction(tx => tx.run(`CREATE TRIGGER deny_codex_publish BEFORE UPDATE ON local_codex_oauth_accounts
      WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'PRIVATE_SQL_FAILURE'); END`));
    const state = new URL(browser).searchParams.get("state")!;
    const callback = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const call = request(`http://127.0.0.1:${localPort}${CODEX_CALLBACK_PATH}?code=synthetic&state=${state}`,
        { headers: { Host: `localhost:${localPort}` } }, reply => {
          const chunks: Buffer[] = [];
          reply.on("data", chunk => chunks.push(Buffer.from(chunk)));
          reply.on("end", () => resolve({ status: reply.statusCode!, body: Buffer.concat(chunks).toString() }));
        });
      call.on("error", reject); call.end();
    });
    if (saveFails || publishFails || readFails) {
      expect(callback.status).toBe(403);
      expect(callback.body).toContain("Connection could not be completed");
      expect(callback.body).not.toContain("PRIVATE_KEYCHAIN_FAILURE");
      expect(callback.body).not.toContain("PRIVATE_SQL_FAILURE");
      expect(callback.body).not.toContain(state);
      expect(callback.body).not.toContain("code=synthetic");
      expect(callback.body).toContain("history.replaceState");
      expect(diagnostics).toEqual([{ stage: "credential_connection",
        reason: saveFails ? "credential_save" : publishFails ? "account_publish" : "readiness" }]);
      expect(store.transaction(tx => tx.all(`SELECT * FROM local_codex_oauth_accounts WHERE state='active'`)))
        .toHaveLength(readFails ? 1 : 0);
      expect(await ui.invoke({ operation: "read", projectId }, document))
        .not.toMatchObject({ ok: true, value: { state: "connected" } });
      ceremony.cancel();
      return;
    }
    expect(callback.status).toBe(200);
    expect(callback.body).toContain("Connection complete");
    expect(callback.body).toContain("window.close()");
    expect(callback.body).toContain("history.replaceState");
    expect(callback.body).toContain("You can close this tab");
    expect(callback.body).not.toContain("account-one");
    expect(callback.body).not.toContain("synthetic-refresh");
    expect(callback.body).not.toContain(state);
    expect(callback.body).not.toContain("code=synthetic");
    expect(store.transaction(tx => tx.all(`SELECT * FROM local_codex_oauth_accounts WHERE state='active'`))).toHaveLength(1);
    const connected = await ui.invoke({ operation: "read", projectId }, document);
    expect(connected).toMatchObject({ ok: true, value: {
      state: "connected", accountDisplay: "••••", executionReady: false } });
    expect(JSON.stringify(connected)).not.toContain("account-one");
    expect(JSON.stringify(connected)).not.toContain("synthetic-refresh");
    expect(JSON.stringify(store.transaction(tx => tx.all("SELECT * FROM local_codex_oauth_accounts"))))
      .not.toContain("synthetic-refresh");
    now += (lifetime - Math.min(60, lifetime / 10) + 1) * 1000;
    expect(await ui.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "connected" } });
    expect(refreshes).toBe(1);
    const restarted = new CodexAccountUiService(store, connector, ports);
    expect(await restarted.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "connected" } });
    account = "account-two"; now += (lifetime - Math.min(60, lifetime / 10) + 1) * 1000;
    expect(await restarted.invoke({ operation: "read", projectId }, document)).toMatchObject({ ok: true, value: { state: "stale" } });
    expect(await restarted.invoke({ operation: "disconnect", projectId }, document)).toMatchObject({ ok: true, value: {
      state: "disconnected", executionReady: false } });
    expect([...entries.values()].every(bytes => !bytes.includes(Buffer.from("synthetic-refresh")))).toBe(true);
    ceremony.cancel();
  });
});
