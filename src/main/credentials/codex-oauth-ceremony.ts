import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CodexOAuthDiagnosticError, type CodexOAuthDiagnostic } from "./codex-oauth-diagnostics";

/** Host-only OAuth ceremony. Registration, account verification, and
 * availability are supplied by the caller; this ceremony grants no entitlement. */
export const CODEX_CALLBACK_PATH = "/auth/callback";
const MAX_OAUTH_SCOPE_LENGTH = 256;
const OAUTH_SCOPE_VALUE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;

export interface HostOAuthBinding {
  orgId: string;
  principalId: string;
  projectId: string;
  connectorId: string;
  windowId: string;
  sessionId: string;
  accountId: string | null;
}

export interface HostOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

export interface HostOAuthPorts {
  /** Must read authenticated host state, never renderer supplied identifiers. */
  readBinding(): HostOAuthBinding | null;
  openSystemBrowser(url: string): Promise<void>;
  exchangeCode(input: { code: string; verifier: string; redirectUri: string; clientId: string }): Promise<HostOAuthTokens>;
  /** Must verify account identity with a trusted source; decoded JWT claims alone are insufficient. */
  verifyAccount(tokens: HostOAuthTokens): Promise<string>;
  /** Synchronously consume the one-shot handoff and confirm durable connection
   * readiness in the host. The callback cannot report success before this returns. */
  completeConnection(ceremony: Pick<HostCodexOAuthCeremony, "takeTokens">): boolean;
  /** Optional local evidence sink. Values are allowlisted stage metadata and contain no secrets. */
  reportFailure?(diagnostic: CodexOAuthDiagnostic): void;
}

export interface HostOAuthRegistration {
  enabled: boolean;
  clientId: string;
  authorizeUrl: string;
  /** Exact registered loopback URI, including port and CODEX_CALLBACK_PATH. */
  redirectUri: string;
  scope: string;
  timeoutMs: number;
}

export class HostOAuthError extends Error {
  constructor(readonly code: "DISABLED" | "DENIED" | "BUSY" | "FAILED") {
    super(`OAuth ceremony ${code.toLowerCase()}`);
  }
}

interface Attempt {
  binding: HostOAuthBinding;
  state: Buffer;
  verifier: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  used: boolean;
  cancelled: boolean;
}

interface CompletedHandoff {
  tokens: HostOAuthTokens;
  binding: HostOAuthBinding;
  accountId: string;
}

const equalState = (actual: string, expected: Buffer): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  const bytes = Buffer.from(actual, "utf8");
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};

const sameBinding = (a: HostOAuthBinding, b: HostOAuthBinding | null): boolean =>
  !!b && a.orgId === b.orgId && a.principalId === b.principalId &&
  a.projectId === b.projectId && a.connectorId === b.connectorId &&
  a.windowId === b.windowId && a.sessionId === b.sessionId && a.accountId === b.accountId;

function parseScopeSet(value: string): Set<string> | null {
  if (!value || value.length > MAX_OAUTH_SCOPE_LENGTH || !OAUTH_SCOPE_VALUE.test(value)) return null;
  const scopes = value.split(" ");
  if (new Set(scopes).size !== scopes.length) return null;
  return new Set(scopes);
}

function matchesRequestedScope(value: string, requested: string): boolean {
  const actualScopes = parseScopeSet(value);
  const requestedScopes = parseScopeSet(requested);
  return !!actualScopes && !!requestedScopes && actualScopes.size === requestedScopes.size &&
    [...requestedScopes].every(scope => actualScopes.has(scope));
}

function validBinding(binding: HostOAuthBinding | null): binding is HostOAuthBinding {
  return !!binding && [binding.orgId, binding.principalId, binding.projectId, binding.connectorId,
    binding.windowId, binding.sessionId]
    .every(value => typeof value === "string" && value.length > 0) &&
    (binding.accountId === null || (typeof binding.accountId === "string" && binding.accountId.length > 0));
}

function sendCallbackResult(response: ServerResponse, connected: boolean): void {
  const nonce = randomBytes(16).toString("base64");
  const message = connected
    ? "Connection complete. You can close this tab and return to Orchestrion."
    : "Connection could not be completed. Return to Orchestrion and try again.";
  response.writeHead(connected ? 200 : 403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'` })
    .end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Orchestrion connection</title>
<p>${message}</p><script nonce="${nonce}">history.replaceState(null, "", "${CODEX_CALLBACK_PATH}");${connected ? "window.close()" : ""}</script></html>`);
}

/** No IPC registration, renderer DTO, persistent store, or token logging. */
export class HostCodexOAuthCeremony {
  private starting: { cancelled: boolean } | null = null;
  private attempt: Attempt | null = null;
  private completed: CompletedHandoff | null = null;

  constructor(private readonly registration: HostOAuthRegistration, private readonly ports: HostOAuthPorts) {}

  isPending(): boolean { return (!!this.starting && !this.starting.cancelled) ||
    (this.attempt !== null && !this.attempt.cancelled); }
  hasCompleted(): boolean { return this.completed !== null; }

  /** Single-use, synchronous host-memory handoff. Later persistence must recheck
   * authority at its own commit; this method grants no storage authority. */
  takeTokens(): CompletedHandoff | null {
    const handoff = this.completed;
    if (!handoff) return null;
    this.completed = null;
    if (this.bindingIsCurrent(handoff.binding)) return handoff;
    handoff.tokens.accessToken = "";
    handoff.tokens.refreshToken = undefined;
    handoff.tokens.idToken = undefined;
    return null;
  }

  private bindingIsCurrent(binding: HostOAuthBinding): boolean {
    try { return sameBinding(binding, this.ports.readBinding()); }
    catch { return false; }
  }

  async begin(explicitOptIn: boolean): Promise<void> {
    if (!this.registration.enabled) throw new HostOAuthError("DISABLED");
    if (explicitOptIn !== true) throw new HostOAuthError("DENIED");
    if (this.starting || this.attempt || this.completed) throw new HostOAuthError("BUSY");
    let binding: HostOAuthBinding | null;
    try { binding = this.ports.readBinding(); }
    catch { throw new HostOAuthError("DENIED"); }
    if (!validBinding(binding)) throw new HostOAuthError("DENIED");

    let redirect: URL;
    let authorize: URL;
    try {
      redirect = new URL(this.registration.redirectUri);
      authorize = new URL(this.registration.authorizeUrl);
    } catch { throw new HostOAuthError("DENIED"); }
    if (redirect.protocol !== "http:" || redirect.hostname !== "localhost" ||
        !redirect.port || redirect.pathname !== CODEX_CALLBACK_PATH || redirect.search || redirect.hash ||
        redirect.username || redirect.password || authorize.protocol !== "https:" ||
        authorize.username || authorize.password || authorize.hash ||
        !this.registration.clientId || !parseScopeSet(this.registration.scope) ||
        !Number.isSafeInteger(this.registration.timeoutMs) || this.registration.timeoutMs < 1) {
      throw new HostOAuthError("DENIED");
    }

    const state = Buffer.from(randomBytes(32).toString("base64url"));
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const server = createServer((request, response) => {
      const attempt = this.attempt;
      if (!attempt || attempt.server !== server || attempt.cancelled || attempt.used) {
        response.writeHead(410).end("Authorization unavailable");
        return;
      }
      let callback: URL;
      try { callback = new URL(request.url ?? "", this.registration.redirectUri); }
      catch { response.writeHead(400).end("Invalid callback"); return; }
      const callbackScopes = callback.searchParams.getAll("scope");
      if (request.method !== "GET" || request.headers.host !== redirect.host ||
          callback.origin !== redirect.origin || callback.pathname !== CODEX_CALLBACK_PATH || callback.hash ||
          callback.searchParams.getAll("state").length !== 1 ||
          callbackScopes.length > 1 ||
          (callbackScopes.length === 1 && !matchesRequestedScope(callbackScopes[0], this.registration.scope)) ||
          !equalState(callback.searchParams.get("state") ?? "", attempt.state)) {
        response.writeHead(400).end("Invalid callback");
        return;
      }
      if (callback.searchParams.getAll("error").length === 1 &&
          callback.searchParams.getAll("code").length === 0 &&
          callback.searchParams.getAll("error_description").length <= 1 &&
          callback.searchParams.getAll("error_uri").length <= 1 &&
          [...callback.searchParams.keys()].every(key =>
            key === "error" || key === "state" || key === "error_description" || key === "error_uri" || key === "scope")) {
        response.writeHead(403).end("Authorization denied");
        this.reportFailure({ stage: "provider_denied" });
        this.cancel();
        return;
      }
      if ([...callback.searchParams.keys()].some(key => key !== "code" && key !== "state" && key !== "scope") ||
          callback.searchParams.getAll("code").length !== 1) {
        response.writeHead(400).end("Invalid callback");
        return;
      }
      const code = callback.searchParams.get("code") ?? "";
      if (!code || code.length > 4096) {
        response.writeHead(400).end("Invalid callback");
        return;
      }
      if (!this.bindingIsCurrent(attempt.binding)) {
        response.writeHead(403).end("Authorization denied");
        this.reportFailure({ stage: "local_binding", checkpoint: "callback" });
        this.cancel();
        return;
      }
      // Consume before any await; a concurrent callback cannot exchange the code twice.
      attempt.used = true;
      void this.complete(attempt, code, response);
    });

    // Reserve before the first await. A losing begin must never cancel the owner.
    const reservation = { cancelled: false };
    this.starting = reservation;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(redirect.port), "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (reservation.cancelled) throw new Error("cancelled");
      if ((server.address() as AddressInfo | null)?.port !== Number(redirect.port)) throw new Error("redirect mismatch");
      const timer = setTimeout(() => this.cancel(), this.registration.timeoutMs);
      this.attempt = { binding: { ...binding }, state, verifier, server, timer, used: false, cancelled: false };
      this.starting = null;
      const attempt = this.attempt;
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", this.registration.clientId);
      authorize.searchParams.set("redirect_uri", this.registration.redirectUri);
      authorize.searchParams.set("scope", this.registration.scope);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state.toString("utf8"));
      authorize.searchParams.set("id_token_add_organizations", "true");
      authorize.searchParams.set("codex_cli_simplified_flow", "true");
      authorize.searchParams.set("originator", "orchestrion");
      await this.ports.openSystemBrowser(authorize.toString());
      if (attempt.cancelled) throw new HostOAuthError("DENIED");
    } catch {
      if (this.starting === reservation) this.starting = null;
      if (this.attempt?.server === server) this.cancel();
      if (server.listening) server.close();
      throw new HostOAuthError("FAILED");
    }
  }

  private async complete(attempt: Attempt, code: string, response: ServerResponse): Promise<void> {
    let tokens: HostOAuthTokens | undefined;
    let checkpoint: CodexOAuthDiagnostic = { stage: "local_binding", checkpoint: "before_exchange" };
    try {
      if (attempt.cancelled || !this.bindingIsCurrent(attempt.binding)) throw new Error();
      checkpoint = { stage: "token_exchange", reason: "transport" };
      tokens = await this.ports.exchangeCode({ code, verifier: attempt.verifier,
        redirectUri: this.registration.redirectUri, clientId: this.registration.clientId });
      checkpoint = { stage: "local_binding", checkpoint: "after_exchange" };
      if (attempt.cancelled || !this.bindingIsCurrent(attempt.binding)) throw new Error();
      if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken) {
        checkpoint = { stage: "token_exchange", reason: "invalid_token_shape" };
        throw new Error();
      }
      checkpoint = { stage: "account_verification", reason: "invalid_signed_claims" };
      const accountId = await this.ports.verifyAccount(tokens);
      if (!accountId || (attempt.binding.accountId && attempt.binding.accountId !== accountId)) {
        checkpoint = { stage: "account_verification", reason: "account_mismatch" };
        throw new Error();
      }
      checkpoint = { stage: "local_binding", checkpoint: "after_verification" };
      if (attempt.cancelled || !this.bindingIsCurrent(attempt.binding)) throw new Error();
      // The host connection consumes this handoff synchronously. Its own commit
      // checks authority again before Keychain save and SQL publication.
      this.completed = { tokens, binding: attempt.binding, accountId };
      tokens = undefined; // Ownership moved to the one-shot host handoff.
      checkpoint = { stage: "credential_connection", reason: "handoff" };
      if (!this.ports.completeConnection(this) || this.completed) throw new Error();
      sendCallbackResult(response, true);
    } catch (error) {
      if (tokens) { tokens.accessToken = ""; tokens.refreshToken = undefined; tokens.idToken = undefined; }
      // A consumed handoff is diagnosed by the F5 connection owner at the
      // actual failing save or publish stage. Report here only when no owner
      // consumed it, or when authorization failed before handoff.
      const reportHere = checkpoint.stage !== "credential_connection" || this.completed !== null;
      if (this.completed) {
        this.completed.tokens.accessToken = "";
        this.completed.tokens.refreshToken = undefined;
        this.completed.tokens.idToken = undefined;
        this.completed = null;
      }
      if (error instanceof CodexOAuthDiagnosticError) checkpoint = error.diagnostic;
      if (checkpoint.stage === "credential_connection") sendCallbackResult(response, false);
      else response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("Authorization denied. Return to Orchestrion.");
      // Only a locally constructed allowlisted diagnostic can be reported; never inspect or
      // serialize an exception from a provider, crypto API, or host binding.
      if (reportHere) this.reportFailure(checkpoint);
    } finally {
      this.finish(attempt);
    }
  }

  private reportFailure(diagnostic: CodexOAuthDiagnostic): void {
    try { this.ports.reportFailure?.(diagnostic); } catch { /* diagnostics never affect auth */ }
  }

  cancel(): void {
    if (this.starting) this.starting.cancelled = true;
    if (this.completed) {
      this.completed.tokens.accessToken = "";
      this.completed.tokens.refreshToken = undefined;
      this.completed.tokens.idToken = undefined;
    }
    this.completed = null;
    if (!this.attempt) return;
    this.attempt.cancelled = true;
    this.finish(this.attempt);
  }

  private finish(attempt: Attempt): void {
    clearTimeout(attempt.timer);
    if (this.attempt === attempt) this.attempt = null;
    if (attempt.server.listening) attempt.server.close();
  }
}
