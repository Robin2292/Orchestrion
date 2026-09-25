/** Rule names only: never add observed header, claim, key or token values. */
export const CODEX_JWT_DIAGNOSTIC_RULES = [
  "token_size", "jwks_shape", "compact_encoding", "header_json", "claims_json",
  "header_algorithm", "header_key_id", "issuer", "audience_shape", "audience_count",
  "audience_value", "client_id", "expiry_type", "issued_at_type", "expired", "issued_in_future",
  "signing_key_id", "signing_key_type", "signing_key_use", "signing_key_algorithm",
  "signing_key_count", "signing_key_import", "signature", "account_claim",
  "access_lifetime", "token_account_binding",
] as const;
export type CodexJwtDiagnosticRule = typeof CODEX_JWT_DIAGNOSTIC_RULES[number];
export type CodexJwtKind = "access" | "identity";
export const CODEX_CONNECTION_DIAGNOSTIC_REASONS = [
  "handoff", "binding_before_pin", "account_pin", "expiry", "secret_encoding",
  "binding_before_save", "credential_save", "binding_before_publish", "account_publish", "readiness",
] as const;
export type CodexConnectionDiagnosticReason = typeof CODEX_CONNECTION_DIAGNOSTIC_REASONS[number];

export type CodexOAuthDiagnostic =
  | { stage: "provider_denied" }
  | { stage: "credential_connection"; reason: CodexConnectionDiagnosticReason }
  | { stage: "local_binding"; checkpoint: "callback" | "before_exchange" | "after_exchange" | "after_verification" }
  | { stage: "token_exchange"; reason: "http_rejected" | "invalid_response" | "invalid_token_shape" | "transport"; status?: number }
  | { stage: "account_verification"; reason: "jwks_http_rejected" | "jwks_unavailable" | "invalid_signed_claims" | "account_mismatch"; status?: number }
  | { stage: "account_verification"; reason: "invalid_signed_claims"; tokenKind: CodexJwtKind; rule: CodexJwtDiagnosticRule };

export type CodexOAuthDiagnosticMessage = Readonly<{
  type: "codex-oauth-diagnostic";
  diagnostic: CodexOAuthDiagnostic;
}>;

/** Runtime validation for the utility-host message boundary. Rebuild the value
 * from allowlisted primitives so unknown fields can never reach logs. */
export function parseCodexOAuthDiagnostic(value: unknown): CodexOAuthDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string")) return null;
  const hasExactKeys = (required: string[], optional: string[] = []): boolean => {
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.prototype.hasOwnProperty.call(input, key))
      && keys.every(key => allowed.has(key as string));
  };
  const status = (): number | undefined | null => {
    if (!Object.prototype.hasOwnProperty.call(input, "status")) return undefined;
    return typeof input.status === "number" ? safeHttpStatus(input.status) ?? null : null;
  };

  if (input.stage === "provider_denied")
    return hasExactKeys(["stage"]) ? { stage: "provider_denied" } : null;
  if (input.stage === "credential_connection") {
    if (!hasExactKeys(["stage", "reason"])) return null;
    const reason = CODEX_CONNECTION_DIAGNOSTIC_REASONS.find(reason => reason === input.reason);
    return reason ? { stage: "credential_connection", reason } : null;
  }
  if (input.stage === "local_binding") {
    if (!hasExactKeys(["stage", "checkpoint"])) return null;
    if (input.checkpoint !== "callback" && input.checkpoint !== "before_exchange"
      && input.checkpoint !== "after_exchange" && input.checkpoint !== "after_verification") return null;
    return { stage: "local_binding", checkpoint: input.checkpoint };
  }
  if (input.stage === "token_exchange" || input.stage === "account_verification") {
    if (input.stage === "account_verification" && input.reason === "invalid_signed_claims"
      && (Object.prototype.hasOwnProperty.call(input, "rule") || Object.prototype.hasOwnProperty.call(input, "tokenKind"))) {
      if (!hasExactKeys(["stage", "reason", "tokenKind", "rule"])) return null;
      if (input.tokenKind !== "access" && input.tokenKind !== "identity") return null;
      const rule = CODEX_JWT_DIAGNOSTIC_RULES.find(rule => rule === input.rule);
      if (!rule) return null;
      return { stage: "account_verification", reason: "invalid_signed_claims", tokenKind: input.tokenKind, rule };
    }
    if (!hasExactKeys(["stage", "reason"], ["status"])) return null;
    const safeStatus = status();
    if (safeStatus === null) return null;
    if (input.stage === "token_exchange") {
      if (input.reason !== "http_rejected" && input.reason !== "invalid_response"
        && input.reason !== "invalid_token_shape" && input.reason !== "transport") return null;
      return { stage: "token_exchange", reason: input.reason,
        ...(safeStatus === undefined ? {} : { status: safeStatus }) };
    }
    if (input.reason !== "jwks_http_rejected" && input.reason !== "jwks_unavailable"
      && input.reason !== "invalid_signed_claims" && input.reason !== "account_mismatch") return null;
    return { stage: "account_verification", reason: input.reason,
      ...(safeStatus === undefined ? {} : { status: safeStatus }) };
  }
  return null;
}

/** Safe, allowlisted stage metadata. Never include provider bodies, URLs, or credential values. */
export class CodexOAuthDiagnosticError extends Error {
  constructor(readonly diagnostic: CodexOAuthDiagnostic) {
    super("CODEX_OAUTH_UNAVAILABLE");
    this.name = "CodexOAuthDiagnosticError";
  }
}

export function safeHttpStatus(status: number): number | undefined {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}
