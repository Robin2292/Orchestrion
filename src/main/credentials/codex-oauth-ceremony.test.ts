import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CALLBACK_PATH, HostCodexOAuthCeremony,
  type HostOAuthBinding, type HostOAuthPorts, type HostOAuthTokens } from "./codex-oauth-ceremony";
import { CodexOAuthDiagnosticError, type CodexOAuthDiagnostic } from "./codex-oauth-diagnostics";

const binding: HostOAuthBinding = {
  orgId: "org-1", principalId: "person-1", projectId: "project-1", connectorId: "connector-1",
  windowId: "window-1", sessionId: "session-1", accountId: "account-1",
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const active: HostCodexOAuthCeremony[] = [];
afterEach(() => { for (const ceremony of active) ceremony.cancel(); active.length = 0; });

async function fixture(options?: { timeoutMs?: number; enabled?: boolean;
  exchange?: HostOAuthPorts["exchangeCode"]; verifyAccount?: HostOAuthPorts["verifyAccount"];
  completeConnection?: HostOAuthPorts["completeConnection"] }) {
  const port = await freePort();
  const redirectUri = `http://localhost:${port}${CODEX_CALLBACK_PATH}`;
  let current: HostOAuthBinding | null = { ...binding };
  let browserUrl = "";
  let browserOpens = 0;
  const diagnostics: CodexOAuthDiagnostic[] = [];
  const exchanges: Array<Parameters<HostOAuthPorts["exchangeCode"]>[0]> = [];
  let verifiedAccount = "account-1";
  let completedHandoff: ReturnType<HostCodexOAuthCeremony["takeTokens"]> = null;
  const ports: HostOAuthPorts = {
    readBinding: () => current,
    openSystemBrowser: async url => { browserUrl = url; browserOpens++; },
    exchangeCode: async input => {
      exchanges.push(input);
      return options?.exchange ? options.exchange(input) : { accessToken: "secret-access", refreshToken: "secret-refresh" };
    },
    verifyAccount: async tokens => options?.verifyAccount ? options.verifyAccount(tokens) : verifiedAccount,
    completeConnection: ceremony => options?.completeConnection
      ? options.completeConnection(ceremony)
      : !!(completedHandoff = ceremony.takeTokens()),
    reportFailure: diagnostic => diagnostics.push(diagnostic),
  };
  const ceremony = new HostCodexOAuthCeremony({
    enabled: options?.enabled ?? true, clientId: "synthetic-local-client",
    authorizeUrl: "https://auth.example.test/oauth/authorize", redirectUri,
    scope: "openid profile email offline_access", timeoutMs: options?.timeoutMs ?? 5000,
  }, ports);
  active.push(ceremony);
  const callback = async (params: string, path = CODEX_CALLBACK_PATH, host?: string) => {
    const url = `http://127.0.0.1:${port}${path}?${params}`;
    return new Promise<Response>((resolve, reject) => {
      const call = request(url, { headers: { Host: host ?? `localhost:${port}` } }, reply => {
        const chunks: Buffer[] = [];
        reply.on("data", chunk => chunks.push(Buffer.from(chunk)));
        reply.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: reply.statusCode })));
      });
      call.on("error", reject);
      call.end();
    });
  };
  const start = async () => { await ceremony.begin(true); return new URL(browserUrl); };
  const validParams = (url: URL, code = "synthetic-code") =>
    new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" }).toString();
  return { ceremony, start, callback, validParams, redirectUri, exchanges,
    browserUrl: () => browserUrl,
    browserOpens: () => browserOpens,
    diagnostics,
    completedHandoff: () => completedHandoff,
    setBinding(value: HostOAuthBinding | null) { current = value; },
    setVerifiedAccount(value: string) { verifiedAccount = value; } };
}

describe("host Codex OAuth ceremony", () => {
  it("requires the flag and explicit opt-in before opening the browser", async () => {
    const disabled = await fixture({ enabled: false });
    await expect(disabled.ceremony.begin(true)).rejects.toMatchObject({ code: "DISABLED" });
    const enabled = await fixture();
    await expect(enabled.ceremony.begin(false)).rejects.toMatchObject({ code: "DENIED" });
    expect(enabled.ceremony.isPending()).toBe(false);
  });

  it("reserves a single start before listen and leaves the winner active", async () => {
    const f = await fixture();
    const first = f.ceremony.begin(true);
    await expect(f.ceremony.begin(true)).rejects.toMatchObject({ code: "BUSY" });
    await first;
    expect(f.browserOpens()).toBe(1);
    expect(f.ceremony.isPending()).toBe(true);
    const url = new URL(f.browserUrl());
    expect((await f.callback(f.validParams(url))).status).toBe(200);
    expect(f.completedHandoff()?.accountId).toBe("account-1");
  });

  it("cancels a start before listen without opening the browser", async () => {
    const f = await fixture();
    const starting = f.ceremony.begin(true);
    f.ceremony.cancel();
    await expect(starting).rejects.toMatchObject({ code: "FAILED" });
    expect(f.browserOpens()).toBe(0);
    expect(f.ceremony.isPending()).toBe(false);
  });

  it("uses S256, unpredictable state, exact redirect and an in-memory host token handoff", async () => {
    const f = await fixture();
    const url = await f.start();
    expect(url.searchParams.get("client_id")).toBe("synthetic-local-client");
    expect(url.searchParams.get("redirect_uri")).toBe(f.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("orchestrion");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await f.callback(f.validParams(url));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("secret");
    expect(f.exchanges).toHaveLength(1);
    expect(createHash("sha256").update(f.exchanges[0].verifier).digest("base64url"))
      .toBe(url.searchParams.get("code_challenge"));
    expect(f.exchanges[0]).toMatchObject({ code: "synthetic-code", redirectUri: f.redirectUri, clientId: "synthetic-local-client" });
    expect(f.completedHandoff()).toEqual({ tokens: { accessToken: "secret-access", refreshToken: "secret-refresh" },
      binding, accountId: "account-1" });
    expect(f.ceremony.takeTokens()).toBeNull();
    expect(f.ceremony.isPending()).toBe(false);
  });

  it("accepts one OpenAI callback scope with the requested tokens in a different order", async () => {
    const f = await fixture();
    const url = await f.start();
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    const params = new URLSearchParams({
      code: "synthetic-code",
      state: url.searchParams.get("state") ?? "",
      scope: "openid email offline_access profile",
    });

    expect((await f.callback(params.toString())).status).toBe(200);
    expect(f.exchanges).toHaveLength(1);
  });

  it("rejects mismatched, duplicate, malformed, oversized and unknown callback parameters", async () => {
    const f = await fixture();
    const url = await f.start();
    const state = url.searchParams.get("state") ?? "";
    const invalid = [
      `code=synthetic-code&state=${state}&scope=openid%20profile`,
      `code=synthetic-code&state=${state}&scope=openid%20profile%20email%20offline_access&scope=openid%20profile%20email%20offline_access`,
      `code=synthetic-code&state=${state}&scope=openid%20%20profile%20email%20offline_access`,
      `code=synthetic-code&state=${state}&scope=${"x".repeat(257)}`,
      `code=synthetic-code&state=${state}&unexpected=value`,
    ];

    for (const params of invalid) expect((await f.callback(params)).status).toBe(400);
    expect(f.exchanges).toHaveLength(0);
    expect(f.ceremony.isPending()).toBe(true);
  });

  it("rejects wrong path, state, duplicate fields, host and replay without another exchange", async () => {
    const f = await fixture();
    const url = await f.start();
    const params = f.validParams(url);
    expect((await f.callback(params, "/oauth/other/callback")).status).toBe(400);
    expect((await f.callback("code=x&state=wrong")).status).toBe(400);
    expect((await f.callback(`${params}&code=another`)).status).toBe(400);
    expect((await f.callback(params, CODEX_CALLBACK_PATH, "localhost:9999")).status).toBe(400);
    expect((await f.callback(params, CODEX_CALLBACK_PATH, new URL(f.redirectUri).host.replace("localhost", "127.0.0.1"))).status).toBe(400);
    expect(f.exchanges).toHaveLength(0);
    const first = f.callback(params);
    const replay = f.callback(params).then(value => ({ status: "fulfilled" as const, value }),
      () => ({ status: "rejected" as const }));
    expect((await first).status).toBe(200);
    const replayResult = await replay;
    expect(replayResult.status === "rejected" ||
      (replayResult.status === "fulfilled" && replayResult.value.status === 410)).toBe(true);
    expect(f.exchanges).toHaveLength(1);
  });

  it("denies cancellation and timeout before token exchange", async () => {
    const cancelled = await fixture();
    await cancelled.start();
    cancelled.ceremony.cancel();
    expect(cancelled.ceremony.isPending()).toBe(false);
    expect(cancelled.exchanges).toHaveLength(0);
    const expired = await fixture({ timeoutMs: 20 });
    await expired.start();
    await vi.waitFor(() => expect(expired.ceremony.isPending()).toBe(false));
    expect(expired.exchanges).toHaveLength(0);
  });

  it("consumes a provider cancellation callback without reflecting its error", async () => {
    const f = await fixture();
    const url = await f.start();
    const response = await f.callback(new URLSearchParams({
      state: url.searchParams.get("state") ?? "", error: "access_denied",
      error_description: "secret-access raw provider text",
    }).toString());
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain("access_denied");
    expect(body).not.toContain("secret-access");
    expect(f.diagnostics).toEqual([{ stage: "provider_denied" }]);
    expect(f.ceremony.isPending()).toBe(false);
    expect(f.exchanges).toHaveLength(0);
  });

  it.each(["orgId", "principalId", "projectId", "connectorId", "windowId", "sessionId", "accountId"] as const)(
    "denies a %s switch at callback", async field => {
      const f = await fixture();
      const url = await f.start();
      f.setBinding({ ...binding, [field]: `${field}-changed` });
      const response = await f.callback(f.validParams(url));
      expect(response.status).toBe(403);
      expect(f.exchanges).toHaveLength(0);
      expect(f.ceremony.takeTokens()).toBeNull();
    });

  it("denies a switch during exchange and a verified account mismatch", async () => {
    let release!: (tokens: HostOAuthTokens) => void;
    const f = await fixture({ exchange: () => new Promise(resolve => { release = resolve; }) });
    const url = await f.start();
    const response = f.callback(f.validParams(url));
    await vi.waitFor(() => expect(f.exchanges).toHaveLength(1));
    f.setBinding({ ...binding, windowId: "another-window" });
    release({ accessToken: "secret-access" });
    expect((await response).status).toBe(403);
    expect(f.ceremony.takeTokens()).toBeNull();

    const other = await fixture();
    const otherUrl = await other.start();
    other.setVerifiedAccount("different-account");
    expect((await other.callback(other.validParams(otherUrl))).status).toBe(403);
    expect(other.ceremony.takeTokens()).toBeNull();
    expect(other.diagnostics).toEqual([{ stage: "account_verification", reason: "account_mismatch" }]);
  });

  it("denies cancellation during exchange and never publishes tokens", async () => {
    let release!: (tokens: HostOAuthTokens) => void;
    const f = await fixture({ exchange: () => new Promise(resolve => { release = resolve; }) });
    const url = await f.start();
    const response = f.callback(f.validParams(url));
    await vi.waitFor(() => expect(f.exchanges).toHaveLength(1));
    f.ceremony.cancel();
    release({ accessToken: "secret-access" });
    expect((await response).status).toBe(403);
    expect(f.ceremony.takeTokens()).toBeNull();
  });

  it("cannot publish a deferred account result after cancellation or timeout", async () => {
    for (const timeoutMs of [5000, 20]) {
      let release!: (accountId: string) => void;
      let verifying = false;
      const f = await fixture({ timeoutMs, verifyAccount: () => new Promise(resolve => {
        verifying = true;
        release = resolve;
      }) });
      const url = await f.start();
      const response = f.callback(f.validParams(url));
      await vi.waitFor(() => expect(verifying).toBe(true));
      if (timeoutMs === 5000) f.ceremony.cancel();
      else await vi.waitFor(() => expect(f.ceremony.isPending()).toBe(false));
      release("account-1");
      expect((await response).status).toBe(403);
      expect(f.ceremony.takeTokens()).toBeNull();
    }
  });

  it("denies a callback when finalization fails and erases its unconsumed handoff", async () => {
    const f = await fixture({ completeConnection: () => false });
    const url = await f.start();
    const response = await f.callback(f.validParams(url));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Connection could not be completed");
    expect(f.ceremony.takeTokens()).toBeNull();
    expect(f.diagnostics).toEqual([{ stage: "credential_connection", reason: "handoff" }]);
  });

  it("denies a binding switch at the host persistence boundary", async () => {
    let switchBinding!: () => void;
    const f = await fixture({ completeConnection: ceremony => {
      switchBinding();
      return ceremony.takeTokens() !== null;
    } });
    switchBinding = () => f.setBinding({ ...binding, windowId: "other-window" });
    const url = await f.start();
    expect((await f.callback(f.validParams(url))).status).toBe(403);
    expect(f.ceremony.takeTokens()).toBeNull();
    expect(f.completedHandoff()).toBeNull();
  });

  it("returns only generic errors when upstream exchange fails", async () => {
    const f = await fixture({ exchange: async () => { throw new Error("secret-access raw upstream response"); } });
    const url = await f.start();
    const response = await f.callback(f.validParams(url));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain("secret-access");
    expect(body).not.toContain("upstream");
    expect(f.diagnostics).toEqual([{ stage: "token_exchange", reason: "transport" }]);
    expect(f.ceremony.takeTokens()).toBeNull();
  });

  it("keeps detailed JWT diagnostics host-only and clears rejected credentials", async () => {
    const tokens: HostOAuthTokens = { accessToken: "PRIVATE_ACCESS", idToken: "PRIVATE_ID", refreshToken: "PRIVATE_REFRESH" };
    const diagnostic: CodexOAuthDiagnostic = { stage: "account_verification", reason: "invalid_signed_claims",
      tokenKind: "identity", rule: "token_account_binding" };
    const f = await fixture({ exchange: async () => tokens,
      verifyAccount: async () => { throw new CodexOAuthDiagnosticError(diagnostic); } });
    const url = await f.start();
    const response = await f.callback(f.validParams(url));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Authorization denied. Return to Orchestrion.");
    expect(f.diagnostics).toEqual([diagnostic]);
    expect(JSON.stringify(f.diagnostics)).not.toContain("PRIVATE_");
    expect(tokens).toEqual({ accessToken: "", idToken: undefined, refreshToken: undefined });
    expect(f.ceremony.takeTokens()).toBeNull();
  });

  it("classifies binding lapses without including binding identifiers", async () => {
    const f = await fixture();
    const url = await f.start();
    f.setBinding({ ...binding, windowId: "private-window-id" });
    expect((await f.callback(f.validParams(url))).status).toBe(403);
    expect(f.diagnostics).toEqual([{ stage: "local_binding", checkpoint: "callback" }]);
    expect(JSON.stringify(f.diagnostics)).not.toContain("private-window-id");
  });
});
