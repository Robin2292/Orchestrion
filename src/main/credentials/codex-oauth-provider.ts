import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type { HostOAuthTokens } from "./codex-oauth-ceremony";
import { CODEX_MAX_TOKEN_LIFETIME_SECONDS } from "./codex-oauth-limits";
import { CodexOAuthDiagnosticError, safeHttpStatus,
  type CodexJwtDiagnosticRule, type CodexJwtKind } from "./codex-oauth-diagnostics";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_ACCESS_AUDIENCE = "https://api.openai.com/v1";
const ISSUER = "https://auth.openai.com";
const AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_RESPONSE_BYTES = 64 * 1024;
const accountPattern = /^[A-Za-z0-9._:-]{1,256}$/;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (): never => { throw new Error("CODEX_OAUTH_UNAVAILABLE"); };
const requireRecord = (value: unknown): JsonRecord => record(value) ? value : fail();

async function boundedJson(response: Response): Promise<unknown> {
  if (response.redirected || !response.body) fail();
  const body = response.body!;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return fail(); }
}

function tokenSet(value: unknown, initial: boolean): HostOAuthTokens {
  const data = requireRecord(value);
  if (typeof data.access_token !== "string" || !data.access_token
      || (initial && (typeof data.id_token !== "string" || !data.id_token
        || typeof data.refresh_token !== "string" || !data.refresh_token))
      || (data.id_token != null && typeof data.id_token !== "string")
      || (data.refresh_token != null && typeof data.refresh_token !== "string")) fail();
  return { accessToken: data.access_token as string,
    idToken: typeof data.id_token === "string" ? data.id_token : undefined,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined };
}

interface VerifiedJwt { claims: JsonRecord; account: string }
function failJwt(tokenKind: CodexJwtKind, rule: CodexJwtDiagnosticRule): never {
  throw new CodexOAuthDiagnosticError({ stage: "account_verification", reason: "invalid_signed_claims", tokenKind, rule });
}

function jwtRecord(part: string, kind: CodexJwtKind, rule: "header_json" | "claims_json"): JsonRecord {
  // JSON/crypto exceptions may contain input data. Discard them; never attach a cause.
  try { return requireRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))); }
  catch { return failJwt(kind, rule); }
}

function verifyJwt(jwt: string, keys: unknown, nowSeconds: number, kind: CodexJwtKind): VerifiedJwt {
  if (!jwt || jwt.length > 16_384) failJwt(kind, "token_size");
  if (!record(keys) || !Array.isArray(keys.keys)) failJwt(kind, "jwks_shape");
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) failJwt(kind, "compact_encoding");
  const header = jwtRecord(parts[0], kind, "header_json");
  const claims = jwtRecord(parts[1], kind, "claims_json");
  if (header.alg !== "RS256") failJwt(kind, "header_algorithm");
  if (typeof header.kid !== "string") failJwt(kind, "header_key_id");
  if (claims.iss !== ISSUER) failJwt(kind, "issuer");
  if (kind === "access") {
    if (!Array.isArray(claims.aud)) failJwt(kind, "audience_shape");
    if (claims.aud.length !== 1) failJwt(kind, "audience_count");
    if (claims.aud[0] !== CODEX_ACCESS_AUDIENCE) failJwt(kind, "audience_value");
    if (claims.client_id !== CODEX_CLIENT_ID) failJwt(kind, "client_id");
  } else {
    // OIDC Core §2 permits a single audience as either a string or an array.
    // Trust only this exact client; no additional audience is approved here.
    if (typeof claims.aud === "string") {
      if (claims.aud !== CODEX_CLIENT_ID) failJwt(kind, "audience_value");
    } else {
      if (!Array.isArray(claims.aud)) failJwt(kind, "audience_shape");
      if (claims.aud.length !== 1) failJwt(kind, "audience_count");
      if (claims.aud[0] !== CODEX_CLIENT_ID) failJwt(kind, "audience_value");
    }
  }
  if (!Number.isSafeInteger(claims.exp)) failJwt(kind, "expiry_type");
  if (!Number.isSafeInteger(claims.iat)) failJwt(kind, "issued_at_type");
  if ((claims.exp as number) <= nowSeconds) failJwt(kind, "expired");
  if ((claims.iat as number) > nowSeconds + 60) failJwt(kind, "issued_in_future");
  let matching = keys.keys.filter((key: unknown): key is JsonRecord => record(key) && key.kid === header.kid);
  if (!matching.length) failJwt(kind, "signing_key_id");
  matching = matching.filter(key => key.kty === "RSA");
  if (!matching.length) failJwt(kind, "signing_key_type");
  matching = matching.filter(key => key.use === "sig");
  if (!matching.length) failJwt(kind, "signing_key_use");
  matching = matching.filter(key => key.alg === "RS256");
  if (!matching.length) failJwt(kind, "signing_key_algorithm");
  if (matching.length !== 1) failJwt(kind, "signing_key_count");
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey({ key: matching[0] as JsonWebKey, format: "jwk" }); }
  catch { return failJwt(kind, "signing_key_import"); }
  let valid: boolean;
  try { valid = verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key,
    Buffer.from(parts[2], "base64url")); }
  catch { return failJwt(kind, "signature"); }
  if (!valid) failJwt(kind, "signature");
  const auth = claims[AUTH_CLAIM];
  const account = record(auth) ? auth.chatgpt_account_id : null;
  if (typeof account !== "string" || !accountPattern.test(account)) failJwt(kind, "account_claim");
  return { claims, account: account as string };
}

/** Fixed public-client compatibility route. No response body, URL or token is logged. */
export class CodexOAuthProvider {
  constructor(private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  private async post(body: URLSearchParams | string, contentType: string,
    initial: boolean, signal?: AbortSignal): Promise<HostOAuthTokens> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) fail();
      const response = await this.fetcher(CODEX_TOKEN_URL, { method: "POST", redirect: "error",
        headers: { "Content-Type": contentType, Accept: "application/json" },
        body, signal: controller.signal });
      if (!response.ok) throw new CodexOAuthDiagnosticError({ stage: "token_exchange", reason: "http_rejected",
        status: safeHttpStatus(response.status) });
      let value: unknown;
      try { value = await boundedJson(response); }
      catch { throw new CodexOAuthDiagnosticError({ stage: "token_exchange", reason: "invalid_response" }); }
      try { return tokenSet(value, initial); }
      catch { throw new CodexOAuthDiagnosticError({ stage: "token_exchange", reason: "invalid_token_shape" }); }
    } catch (error) {
      if (error instanceof CodexOAuthDiagnosticError) throw error;
      throw new CodexOAuthDiagnosticError({ stage: "token_exchange", reason: "transport" });
    }
    finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }

  exchangeCode(input: { code: string; verifier: string; redirectUri: string; clientId: string }): Promise<HostOAuthTokens> {
    if (input.redirectUri !== CODEX_REDIRECT_URI || input.clientId !== CODEX_CLIENT_ID
        || !input.code || input.code.length > 4096 || !/^[A-Za-z0-9_-]{43,128}$/.test(input.verifier)) fail();
    return this.post(new URLSearchParams({ grant_type: "authorization_code", code: input.code,
      code_verifier: input.verifier, client_id: CODEX_CLIENT_ID, redirect_uri: CODEX_REDIRECT_URI }),
    "application/x-www-form-urlencoded", true);
  }

  refresh(refreshToken: string, signal: AbortSignal): Promise<HostOAuthTokens> {
    if (!refreshToken || refreshToken.length > 8192) fail();
    return this.post(JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID }), "application/json", false, signal);
  }

  /** The signed access token selects the exact workspace account and expiry.
   * An ID token, when supplied, must be signed for this public client and agree.
   * Neither token's plan claim is treated as model entitlement. */
  async verifyAccount(tokens: HostOAuthTokens): Promise<string> {
    let keys: unknown;
    try {
      const response = await this.fetcher(CODEX_JWKS_URL, { method: "GET", redirect: "error",
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new CodexOAuthDiagnosticError({ stage: "account_verification",
        reason: "jwks_http_rejected", status: safeHttpStatus(response.status) });
      try { keys = await boundedJson(response); }
      catch { throw new CodexOAuthDiagnosticError({ stage: "account_verification", reason: "jwks_unavailable" }); }
    } catch (error) {
      if (error instanceof CodexOAuthDiagnosticError) throw error;
      throw new CodexOAuthDiagnosticError({ stage: "account_verification", reason: "jwks_unavailable" });
    }
    try {
      const nowSeconds = Math.floor(this.now() / 1000);
      const access = verifyJwt(tokens.accessToken, keys, nowSeconds, "access");
      const expiresIn = (access.claims.exp as number) - nowSeconds;
      if (expiresIn < 1 || expiresIn > CODEX_MAX_TOKEN_LIFETIME_SECONDS) failJwt("access", "access_lifetime");
      if (tokens.idToken) {
        const identity = verifyJwt(tokens.idToken, keys, nowSeconds, "identity");
        if (identity.account !== access.account) failJwt("identity", "token_account_binding");
      }
      tokens.expiresIn = expiresIn;
      return access.account;
    } catch (error) {
      if (error instanceof CodexOAuthDiagnosticError) throw error;
      throw new CodexOAuthDiagnosticError({ stage: "account_verification", reason: "invalid_signed_claims" });
    }
  }
}
