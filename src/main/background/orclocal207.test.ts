import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { BackgroundHost, type HostProcess } from "./client";
import { CODEX_CONNECTION_DIAGNOSTIC_REASONS, CODEX_JWT_DIAGNOSTIC_RULES,
  parseCodexOAuthDiagnostic } from "../credentials/codex-oauth-diagnostics";

class Child extends EventEmitter implements HostProcess {
  postMessage(_message: unknown) {}
  kill() { this.emit("exit", 0); return true; }
}

describe("ORCLOCAL-207 utility-host OAuth diagnostics", () => {
  it("forwards only validated, canonical metadata from the utility host", async () => {
    const child = new Child();
    const host = new BackgroundHost(() => child, async () => "",
      { start: 100, request: 1000, stop: 100, maxPending: 8 });
    const received: unknown[] = [];
    host.on("codex-oauth-diagnostic", value => received.push(value));

    const starting = host.start();
    child.emit("message", { type: "ready" });
    expect(await starting).toBe(true);
    child.emit("message", { type: "codex-oauth-diagnostic",
      diagnostic: { stage: "token_exchange", reason: "http_rejected", status: 401 } });
    expect(received).toEqual([{ stage: "token_exchange", reason: "http_rejected", status: 401 }]);

    const detailed = { stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "access", rule: "audience_count" };
    child.emit("message", { type: "codex-oauth-diagnostic", diagnostic: detailed });
    expect(received[1]).toEqual(detailed);
    expect(received[1]).not.toBe(detailed);
    const connection = { stage: "credential_connection", reason: "expiry" };
    child.emit("message", { type: "codex-oauth-diagnostic", diagnostic: connection });
    expect(received[2]).toEqual(connection);
    expect(received[2]).not.toBe(connection);

    const secret = "PRIVATE_CANARY";
    for (const message of [
      { type: "codex-oauth-diagnostic", diagnostic: { stage: "token_exchange", reason: "http_rejected", status: 600 } },
      { type: "codex-oauth-diagnostic", diagnostic: { stage: "token_exchange", reason: "http_rejected", token: secret } },
      { type: "codex-oauth-diagnostic", diagnostic: { stage: "account_verification", reason: "unknown_reason" } },
      { type: "codex-oauth-diagnostic", diagnostic: { stage: "local_binding", checkpoint: "callback", state: secret } },
      { type: "codex-oauth-diagnostic", diagnostic: { stage: "provider_denied", status: 401 } },
      { type: "codex-oauth-diagnostic", diagnostic: { stage: "provider_denied" }, state: secret },
      { type: "codex-oauth-diagnostic", diagnostic: { ...detailed, rule: secret } },
      { type: "codex-oauth-diagnostic", diagnostic: { ...detailed, tokenKind: secret } },
      { type: "codex-oauth-diagnostic", diagnostic: { ...detailed, claims: { account: secret } } },
      { type: "codex-oauth-diagnostic", diagnostic: detailed, token: secret },
      { type: "codex-oauth-diagnostic", diagnostic: { ...connection, reason: secret } },
      { type: "codex-oauth-diagnostic", diagnostic: { ...connection, accountId: secret } },
      { type: "codex-oauth-diagnostic", diagnostic: connection, token: secret },
    ]) child.emit("message", message);
    expect(received).toHaveLength(3);
    expect(JSON.stringify(received)).not.toContain(secret);

    const stopped = host.stop();
    child.emit("exit", 0);
    await stopped;
  });

  it("admits only closed connection reasons with exactly stage and reason", () => {
    for (const reason of CODEX_CONNECTION_DIAGNOSTIC_REASONS) {
      const diagnostic = { stage: "credential_connection", reason };
      expect(parseCodexOAuthDiagnostic(diagnostic)).toEqual(diagnostic);
      for (const key of ["token", "state", "code", "body", "cause", "accountId", "expiry", "status", "rule", "tokenKind"])
        expect(parseCodexOAuthDiagnostic({ ...diagnostic, [key]: "PRIVATE_CANARY" })).toBeNull();
    }
    expect(parseCodexOAuthDiagnostic({ stage: "credential_connection" })).toBeNull();
    expect(parseCodexOAuthDiagnostic({ stage: "credential_connection", reason: "unknown" })).toBeNull();
    expect(parseCodexOAuthDiagnostic({ stage: "account_verification", reason: "expiry" })).toBeNull();
  });

  it("round-trips every closed JWT rule and rejects extra or partial fields", () => {
    for (const tokenKind of ["access", "identity"]) {
      for (const rule of CODEX_JWT_DIAGNOSTIC_RULES) {
        const diagnostic = { stage: "account_verification", reason: "invalid_signed_claims", tokenKind, rule };
        expect(parseCodexOAuthDiagnostic(diagnostic)).toEqual(diagnostic);
        for (const extra of ["status", "token", "claims", "header", "key", "account", "code", "state", "url", "body", "cause"])
          expect(parseCodexOAuthDiagnostic({ ...diagnostic, [extra]: "PRIVATE_CANARY" })).toBeNull();
      }
    }
    for (const diagnostic of [
      { stage: "account_verification", reason: "invalid_signed_claims", rule: "signature" },
      { stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "access" },
      { stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "access", rule: "unknown" },
      { stage: "account_verification", reason: "invalid_signed_claims", tokenKind: "refresh", rule: "signature" },
      { stage: "account_verification", reason: "jwks_unavailable", tokenKind: "access", rule: "signature" },
      { stage: "token_exchange", reason: "transport", tokenKind: "access", rule: "signature" },
    ]) expect(parseCodexOAuthDiagnostic(diagnostic)).toBeNull();
    expect(parseCodexOAuthDiagnostic({ stage: "account_verification", reason: "invalid_signed_claims" }))
      .toEqual({ stage: "account_verification", reason: "invalid_signed_claims" });
  });

  it("rejects unknown diagnostic fields and unsafe status values", () => {
    expect(parseCodexOAuthDiagnostic({ stage: "provider_denied" })).toEqual({ stage: "provider_denied" });
    expect(parseCodexOAuthDiagnostic({ stage: "local_binding", checkpoint: "after_exchange" }))
      .toEqual({ stage: "local_binding", checkpoint: "after_exchange" });
    expect(parseCodexOAuthDiagnostic({ stage: "account_verification", reason: "jwks_http_rejected", status: 502 }))
      .toEqual({ stage: "account_verification", reason: "jwks_http_rejected", status: 502 });
    expect(parseCodexOAuthDiagnostic({ stage: "token_exchange", reason: "transport", token: "secret" })).toBeNull();
    expect(parseCodexOAuthDiagnostic({ stage: "token_exchange", reason: "transport", status: 99 })).toBeNull();
    expect(parseCodexOAuthDiagnostic({ stage: "token_exchange", reason: "transport", status: 600 })).toBeNull();
  });
});
