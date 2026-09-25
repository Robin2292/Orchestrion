import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CODEX_ACCESS_AUDIENCE, CODEX_CLIENT_ID, CODEX_JWKS_URL, CODEX_REDIRECT_URI, CODEX_TOKEN_URL,
  CodexOAuthProvider } from "./codex-oauth-provider";
import { CodexOAuthDiagnosticError, parseCodexOAuthDiagnostic,
  type CodexJwtDiagnosticRule, type CodexJwtKind } from "./codex-oauth-diagnostics";

const now = 1_800_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", use: "sig", alg: "RS256" };
const jwt = (account: string, audience: unknown, changed: Record<string, unknown> = {},
  changedHeader: Record<string, unknown> = {}) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, ...changedHeader })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: audience,
    client_id: CODEX_CLIENT_ID,
    sub: "person", iat: now / 1000 - 10, exp: now / 1000 + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: account }, ...changed })).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
};
const access = jwt("account-one", [CODEX_ACCESS_AUDIENCE]);
const identity = jwt("account-one", CODEX_CLIENT_ID);
const fixture = (response: Record<string, unknown>, keys: unknown = { keys: [jwk] }) => {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (url === CODEX_JWKS_URL) return Response.json(keys);
    if (url === CODEX_TOKEN_URL) return Response.json(response);
    throw new Error("unexpected URL");
  }) as unknown as typeof fetch;
  return { provider: new CodexOAuthProvider(fetcher, () => now), fetcher: vi.mocked(fetcher) };
};

describe("Codex OAuth public-client provider", () => {
  it("exchanges an exact callback and derives expiry from signed tokens when expires_in is absent", async () => {
    const { provider, fetcher } = fixture({ access_token: access, id_token: identity, refresh_token: "refresh-secret" });
    const tokens = await provider.exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43),
      redirectUri: CODEX_REDIRECT_URI, clientId: CODEX_CLIENT_ID });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.redirect).toBe("error");
    expect(String(options.body)).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
    expect(await provider.verifyAccount(tokens)).toBe("account-one");
    expect(tokens.expiresIn).toBe(3600);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts a Codex refresh with only a new access token and JSON request body", async () => {
    const { provider, fetcher } = fixture({ access_token: access });
    const tokens = await provider.refresh("refresh-secret", new AbortController().signal);
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(options.body))).toEqual({ grant_type: "refresh_token",
      refresh_token: "refresh-secret", client_id: CODEX_CLIENT_ID });
    expect(tokens.idToken).toBeUndefined();
    expect(tokens.refreshToken).toBeUndefined();
    expect(await provider.verifyAccount(tokens)).toBe("account-one");
    expect(tokens.expiresIn).toBe(3600);
  });

  it("rejects invalid signatures, account mismatch, audience, expiry and missing account", async () => {
    for (const tokens of [
      { accessToken: `${access.split(".").slice(0, 2).join(".")}.${access.split(".")[2].startsWith("a") ? "b" : "a"}${access.split(".")[2].slice(1)}`, idToken: identity },
      { accessToken: access, idToken: jwt("account-two", CODEX_CLIENT_ID) },
      { accessToken: access, idToken: jwt("account-one", "wrong-client") },
      { accessToken: jwt("account-one", [CODEX_ACCESS_AUDIENCE], { exp: now / 1000 - 1 }), idToken: identity },
      { accessToken: jwt("", [CODEX_ACCESS_AUDIENCE]), idToken: identity },
    ]) {
      const { provider } = fixture({});
      await expect(provider.verifyAccount(tokens)).rejects.toThrow("CODEX_OAUTH_UNAVAILABLE");
    }
  });

  it("requires the exact access audience array and public client on initial and refresh tokens", async () => {
    for (const changed of [
      { aud: undefined }, { aud: CODEX_ACCESS_AUDIENCE }, { aud: ["wrong-resource"] },
      { aud: [CODEX_ACCESS_AUDIENCE, "wrong-resource"] },
      { client_id: undefined }, { client_id: "wrong-client" },
    ]) {
      const { provider } = fixture({});
      const wrong = jwt("account-one", [CODEX_ACCESS_AUDIENCE], changed);
      await expect(provider.verifyAccount({ accessToken: wrong, idToken: identity }))
        .rejects.toThrow("CODEX_OAUTH_UNAVAILABLE");
      await expect(provider.verifyAccount({ accessToken: wrong }))
        .rejects.toThrow("CODEX_OAUTH_UNAVAILABLE");
    }
  });

  it("accepts a signed ten-day Codex access token and rejects an excessive lifetime", async () => {
    const { provider } = fixture({});
    const tenDays = 10 * 24 * 60 * 60;
    await expect(provider.verifyAccount({ accessToken: jwt("account-one", [CODEX_ACCESS_AUDIENCE],
      { exp: now / 1000 + tenDays }) })).resolves.toBe("account-one");
    await expect(provider.verifyAccount({ accessToken: jwt("account-one", [CODEX_ACCESS_AUDIENCE],
      { exp: now / 1000 + 15 * 24 * 60 * 60 }) })).rejects.toThrow("CODEX_OAUTH_UNAVAILABLE");
  });

  it("fails closed on a wrong redirect, invalid token response and raw upstream error", async () => {
    const { provider, fetcher } = fixture({ access_token: access });
    expect(() => provider.exchangeCode({ code: "code", verifier: "v".repeat(43),
      clientId: CODEX_CLIENT_ID, redirectUri: "http://127.0.0.1:1455/auth/callback" }))
      .toThrow("CODEX_OAUTH_UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(provider.exchangeCode({ code: "code", verifier: "v".repeat(43),
      clientId: CODEX_CLIENT_ID, redirectUri: CODEX_REDIRECT_URI })).rejects.toThrow("CODEX_OAUTH_UNAVAILABLE");
    const broken = new CodexOAuthProvider((async () => { throw new Error("raw-upstream-secret"); }) as typeof fetch);
    await expect(broken.refresh("secret", new AbortController().signal)).rejects.toThrow("CODEX_OAUTH_UNAVAILABLE");
  });

  it("reports only token endpoint status and token response shape", async () => {
    const rejected = new CodexOAuthProvider((async () => new Response("secret upstream body", { status: 429 })) as typeof fetch);
    await expect(rejected.exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43),
      redirectUri: CODEX_REDIRECT_URI, clientId: CODEX_CLIENT_ID })).rejects.toMatchObject({
      diagnostic: { stage: "token_exchange", reason: "http_rejected", status: 429 },
    });

    const malformed = new CodexOAuthProvider((async () => Response.json({ access_token: "secret-access" })) as typeof fetch);
    await expect(malformed.exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43),
      redirectUri: CODEX_REDIRECT_URI, clientId: CODEX_CLIENT_ID })).rejects.toMatchObject({
      diagnostic: { stage: "token_exchange", reason: "invalid_token_shape" },
    });
    try {
      await rejected.refresh("secret-refresh", new AbortController().signal);
    } catch (error) {
      expect(error).toBeInstanceOf(CodexOAuthDiagnosticError);
      expect(String(error)).not.toContain("secret upstream body");
    }
  });

  it("separates JWKS fetch rejection from signed claim verification failure", async () => {
    const rejected = new CodexOAuthProvider((async () => new Response("secret JWKS body", { status: 503 })) as typeof fetch);
    await expect(rejected.verifyAccount({ accessToken: access })).rejects.toMatchObject({
      diagnostic: { stage: "account_verification", reason: "jwks_http_rejected", status: 503 },
    });
    const invalid = new CodexOAuthProvider((async () => Response.json({ keys: [jwk] })) as typeof fetch);
    await expect(invalid.verifyAccount({ accessToken: "not-a-jwt" })).rejects.toMatchObject({
      diagnostic: { stage: "account_verification", reason: "invalid_signed_claims" },
    });
  });
});

describe("ORCLOCAL-208 closed JWT rule diagnostics", () => {
  const canary = "PRIVATE_CLAIM_CANARY";
  type Rejection = { rule: CodexJwtDiagnosticRule; token?: string;
    claims?: Record<string, unknown>; header?: Record<string, unknown>; keys?: unknown };
  const malformedPart = Buffer.from(`{${canary}`).toString("base64url");
  const failures: Rejection[] = [
    { rule: "token_size", token: "" },
    { rule: "token_size", token: "a".repeat(16_385) },
    { rule: "jwks_shape", keys: null },
    { rule: "jwks_shape", keys: { keys: {} } },
    { rule: "compact_encoding", token: "not-a-jwt" },
    { rule: "compact_encoding", token: "a.b.!" },
    { rule: "header_json", token: `${malformedPart}.e30.c2ln` },
    { rule: "header_json", token: "W10.e30.c2ln" },
    { rule: "claims_json", token: `e30.${malformedPart}.c2ln` },
    { rule: "claims_json", token: "e30.bnVsbA.c2ln" },
    { rule: "header_algorithm", header: { alg: canary } },
    { rule: "header_key_id", header: { kid: undefined } },
    { rule: "issuer", claims: { iss: canary } },
    { rule: "expiry_type", claims: { exp: `${now / 1000 + 3600}` } },
    { rule: "expiry_type", claims: { exp: Number.MAX_SAFE_INTEGER + 1 } },
    { rule: "issued_at_type", claims: { iat: null } },
    { rule: "expired", claims: { exp: now / 1000 } },
    { rule: "issued_in_future", claims: { iat: now / 1000 + 61 } },
    { rule: "signing_key_id", keys: { keys: [{ ...jwk, kid: canary }] } },
    { rule: "signing_key_type", keys: { keys: [{ ...jwk, kty: canary }] } },
    { rule: "signing_key_use", keys: { keys: [{ ...jwk, use: undefined }] } },
    { rule: "signing_key_algorithm", keys: { keys: [{ ...jwk, alg: undefined }] } },
    { rule: "signing_key_count", keys: { keys: [jwk, jwk] } },
    { rule: "signing_key_import", keys: { keys: [{ ...jwk, n: undefined }] } },
    { rule: "account_claim", claims: { "https://api.openai.com/auth": null } },
    { rule: "account_claim", claims: { "https://api.openai.com/auth": { chatgpt_account_id: `!${canary}` } } },
  ];
  for (const tokenKind of ["access", "identity"] as const) {
    // Missing/empty ID tokens are gated by the initial exchange parser, not verifyJwt.
    it.each(failures.filter(failure => tokenKind === "access" || (failure.rule !== "jwks_shape" && failure.token !== "")))(
      `${tokenKind} rejects $rule with only allowlisted metadata`, async failure => {
      const identityKeyFailure = tokenKind === "identity" && failure.keys !== undefined;
      const token = failure.token ?? jwt("account-one", tokenKind === "access" ? [CODEX_ACCESS_AUDIENCE] : CODEX_CLIENT_ID,
        { private_claim: canary, ...failure.claims },
        { ...(identityKeyFailure ? { kid: "identity-key" } : {}), ...failure.header });
      // A separate ID signing key lets access verification succeed before the ID key check fails.
      const keys = identityKeyFailure ? { keys: [jwk, ...(failure.keys as { keys: Record<string, unknown>[] }).keys
        .map(key => ({ ...key, kid: key.kid === jwk.kid ? "identity-key" : key.kid }))] }
        : failure.keys === undefined ? { keys: [jwk] } : failure.keys;
      const { provider } = fixture({}, keys);
      const tokens = tokenKind === "access" ? { accessToken: token, idToken: identity }
        : { accessToken: access, idToken: token };
      const error = await provider.verifyAccount(tokens).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CodexOAuthDiagnosticError);
      expect(error).toMatchObject({ diagnostic: {
        stage: "account_verification", reason: "invalid_signed_claims", tokenKind, rule: failure.rule,
      } });
      const diagnostic = (error as CodexOAuthDiagnosticError).diagnostic;
      expect(parseCodexOAuthDiagnostic(diagnostic)).toEqual(diagnostic);
      expect(Object.keys(diagnostic).sort()).toEqual(["reason", "rule", "stage", "tokenKind"]);
      expect(String(error)).toBe("CodexOAuthDiagnosticError: CODEX_OAUTH_UNAVAILABLE");
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(error).not.toHaveProperty("cause");
      expect(tokens).not.toHaveProperty("expiresIn");
    });
  }

  it.each<{ kind: CodexJwtKind; claims: Record<string, unknown>; rule: CodexJwtDiagnosticRule }>([
    { kind: "access", claims: { aud: CODEX_ACCESS_AUDIENCE }, rule: "audience_shape" },
    { kind: "access", claims: { aud: [] }, rule: "audience_count" },
    { kind: "access", claims: { aud: [CODEX_ACCESS_AUDIENCE, canary] }, rule: "audience_count" },
    { kind: "access", claims: { aud: [canary] }, rule: "audience_value" },
    { kind: "access", claims: { client_id: undefined }, rule: "client_id" },
    { kind: "access", claims: { client_id: canary }, rule: "client_id" },
    { kind: "identity", claims: { aud: [canary] }, rule: "audience_value" },
    { kind: "identity", claims: { aud: canary }, rule: "audience_value" },
    { kind: "access", claims: { exp: now / 1000 + 14 * 86400 + 1 }, rule: "access_lifetime" },
    { kind: "identity", claims: { "https://api.openai.com/auth": { chatgpt_account_id: canary } }, rule: "token_account_binding" },
  ])("distinguishes $kind $rule without relaxing the predicate", async ({ kind, claims, rule }) => {
    const token = jwt("account-one", kind === "access" ? [CODEX_ACCESS_AUDIENCE] : CODEX_CLIENT_ID, claims);
    const { provider } = fixture({});
    await expect(provider.verifyAccount(kind === "access" ? { accessToken: token, idToken: identity }
      : { accessToken: access, idToken: token })).rejects.toMatchObject({ diagnostic: {
      stage: "account_verification", reason: "invalid_signed_claims", tokenKind: kind, rule,
    } });
  });

  it.each(["access", "identity"] as const)("identifies a corrupt %s signature", async kind => {
    const good = kind === "access" ? access : identity;
    const parts = good.split(".");
    const signature = Buffer.from(parts[2], "base64url");
    signature[0] ^= 1;
    const bad = `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`;
    const { provider } = fixture({});
    await expect(provider.verifyAccount(kind === "access" ? { accessToken: bad, idToken: identity }
      : { accessToken: access, idToken: bad })).rejects.toMatchObject({ diagnostic: {
      stage: "account_verification", reason: "invalid_signed_claims", tokenKind: kind, rule: "signature",
    } });
  });

  it("preserves valid boundaries and filters irrelevant JWKS keys before requiring uniqueness", async () => {
    const { provider } = fixture({}, { keys: [null, {}, { ...jwk, use: "enc" }, { ...jwk, alg: "RS512" }, jwk] });
    const tokens = { accessToken: jwt("account-one", [CODEX_ACCESS_AUDIENCE],
      { exp: now / 1000 + 14 * 86400, iat: now / 1000 + 60 }), idToken: identity };
    await expect(provider.verifyAccount(tokens)).resolves.toBe("account-one");
    expect(tokens).toHaveProperty("expiresIn", 14 * 86400);
  });
});

describe("ORCLOCAL-208 ID token single-audience compatibility", () => {
  it.each([
    { shape: "string", aud: CODEX_CLIENT_ID },
    { shape: "singleton array", aud: [CODEX_CLIENT_ID] },
  ])("accepts a signed ID token with the exact client as a $shape", async ({ aud }) => {
    const { provider } = fixture({ access_token: access, id_token: jwt("account-one", aud), refresh_token: "synthetic-refresh" });
    const tokens = await provider.exchangeCode({ code: "synthetic-code", verifier: "v".repeat(43),
      redirectUri: CODEX_REDIRECT_URI, clientId: CODEX_CLIENT_ID });
    await expect(provider.verifyAccount(tokens)).resolves.toBe("account-one");
    expect(tokens.expiresIn).toBe(3600);
  });

  it.each<{ aud: unknown; rule: CodexJwtDiagnosticRule }>([
    { aud: undefined, rule: "audience_shape" }, { aud: null, rule: "audience_shape" },
    { aud: 42, rule: "audience_shape" }, { aud: { 0: CODEX_CLIENT_ID, length: 1 }, rule: "audience_shape" },
    { aud: [], rule: "audience_count" },
    { aud: [CODEX_CLIENT_ID, "other-client"], rule: "audience_count" },
    { aud: ["other-client", CODEX_CLIENT_ID], rule: "audience_count" },
    { aud: [CODEX_CLIENT_ID, CODEX_CLIENT_ID], rule: "audience_count" },
    { aud: [CODEX_CLIENT_ID, null], rule: "audience_count" },
    { aud: "other-client", rule: "audience_value" }, { aud: ["other-client"], rule: "audience_value" },
    { aud: [CODEX_ACCESS_AUDIENCE], rule: "audience_value" },
    { aud: [CODEX_CLIENT_ID.toLowerCase()], rule: "audience_value" },
    { aud: [` ${CODEX_CLIENT_ID}`], rule: "audience_value" },
    { aud: [[CODEX_CLIENT_ID]], rule: "audience_value" },
    { aud: [null], rule: "audience_value" }, { aud: [42], rule: "audience_value" },
  ])("rejects an ID audience outside the exact single-client contract ($rule)", async ({ aud, rule }) => {
    const { provider } = fixture({});
    const tokens = { accessToken: access, idToken: jwt("account-one", aud, { azp: CODEX_CLIENT_ID }) };
    await expect(provider.verifyAccount(tokens)).rejects.toMatchObject({ diagnostic: {
      stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "identity", rule,
    } });
    expect(tokens).not.toHaveProperty("expiresIn");
  });

  it.each<{ claims: Record<string, unknown>; rule: CodexJwtDiagnosticRule }>([
    { claims: { iss: "https://other-issuer.example" }, rule: "issuer" },
    { claims: { exp: now / 1000 }, rule: "expired" },
    { claims: { iat: now / 1000 + 61 }, rule: "issued_in_future" },
    { claims: { "https://api.openai.com/auth": null }, rule: "account_claim" },
    { claims: { "https://api.openai.com/auth": { chatgpt_account_id: "other-account" } }, rule: "token_account_binding" },
  ])("still enforces $rule for a singleton-array ID audience", async ({ claims, rule }) => {
    const { provider } = fixture({});
    await expect(provider.verifyAccount({ accessToken: access,
      idToken: jwt("account-one", [CODEX_CLIENT_ID], claims) })).rejects.toMatchObject({ diagnostic: {
      stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "identity", rule,
    } });
  });

  it("requires a valid signature for a singleton-array ID audience", async () => {
    const parts = jwt("account-one", [CODEX_CLIENT_ID]).split(".");
    const signature = Buffer.from(parts[2], "base64url"); signature[0] ^= 1;
    const { provider } = fixture({});
    await expect(provider.verifyAccount({ accessToken: access,
      idToken: `${parts[0]}.${parts[1]}.${signature.toString("base64url")}` })).rejects.toMatchObject({ diagnostic: {
      stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "identity", rule: "signature",
    } });
  });
});
