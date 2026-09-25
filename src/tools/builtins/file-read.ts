import { exactPath } from "../../shared/policy/p0-canonical";
import type { LocalContext } from "../../shared/local-contracts";
import type { ToolDefinition } from "../../shared/tool-registry-contracts";
import type { ToolPlannerInput } from "../../shared/tool-invocation-contracts";
import {
  FILE_READ_DESCRIPTION, FILE_READ_PARAMETERS, FileReadArgumentsSchema, GOVERNED_FILE_READ_CONNECTION, GOVERNED_FILE_READ_CONNECTOR,
  GOVERNED_FILE_READ_IMPLEMENTATION, GOVERNED_FILE_READ_MAX_PATH_LENGTH, GOVERNED_FILE_READ_REVIEW, GOVERNED_FILE_READ_TOOL,
  GOVERNED_LOGICAL_WORKSPACE_ROOT, GOVERNED_TOOL_REASONS,
} from "../../shared/governed-tool-contracts";
import type { ToolImplementation } from "../registry";

/** Reviewed built-in `file.read`. The planner is pure and deterministic: it maps
 * a workspace-relative path onto exactly one logical read claim under /workspace
 * and refuses traversal, absolute paths and secret-bearing locations. It never
 * touches the filesystem; the adapter runs only through the admission service
 * with an opaque WorkspaceAuthority (src/main/workspace-authority.ts). */

const SENSITIVE_NAMES = new Set([".env", ".netrc", ".pgpass", ".pgpass_backup", ".npmrc", ".pypirc", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".git",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa.pub", "id_dsa.pub", "id_ecdsa.pub", "id_ed25519.pub",
  "credentials", "credentials.json", ".git-credentials", ".htpasswd", ".boto", ".s3cfg"]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der", ".jks", ".keystore", ".ppk", ".asc", ".gpg", ".kdbx"]);
/** PEM / OpenSSH / PGP private-key armour. Matched anywhere in the decoded text
 * (the governed read is bounded to 256 KiB) so a key saved under an innocuous
 * name such as `deploy_key` is still refused. Public keys and certificates are
 * covered by the name/extension rules, not by content. */
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
/** Narrow, high-confidence credential shapes (review revision 6). Each has a
 * fixed vendor prefix or structural signature that ordinary prose, code, URLs
 * and base64 blobs do not produce; breadth is deliberately traded for a low
 * false-positive rate. Not a secret scanner: no entropy or keyword heuristics. */
const SECRET_MARKERS: readonly RegExp[] = [
  PRIVATE_KEY_MARKER,
  /\bAKIA[0-9A-Z]{16}\b/,                                            // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,                                   // GitHub classic / OAuth / app tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,                                // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,                                    // GitLab PAT
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{16,}\b/, // JWS: JSON header . JSON payload . signature
  // scheme://user:password@ or scheme://:password@ connection URI. The password
  // may itself contain ':' (review revision 8) but neither segment may cross
  // '?' or '#' (review revision 9): userinfo ends at the authority, so a query
  // or fragment carrying ':' and an e-mail address is not a credential.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:?#@/]*:[^\s?#@/]+@/i,
];
/** Review revision 7: base64-wrapped secrets. Standard-alphabet runs at least
 * this long are decoded (bounded to the first BASE64_RESCAN_LIMIT candidates
 * per read) and the decoded text is checked against the same SECRET_MARKERS,
 * so `TLS_PRIVATE_KEY_B64=<base64 PEM>` is refused like the PEM itself. This
 * raises the bar for one common wrapping only; hex, base64url, rot13, line-
 * wrapped base64, compression and double encoding are not decoded — a known v1
 * limitation consistent with "not a secret scanner" above. */
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{40,}={0,2}/g;
const BASE64_RESCAN_LIMIT = 64;
function matchesSecretMarker(text: string): boolean { return SECRET_MARKERS.some((marker) => marker.test(text)); }
function base64DecodedSecret(text: string): boolean {
  let scanned = 0;
  for (const match of text.matchAll(BASE64_CANDIDATE)) {
    if (++scanned > BASE64_RESCAN_LIMIT) return false;
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[0], "base64")); } catch { continue; }
    if (matchesSecretMarker(decoded)) return true;
  }
  return false;
}
/** Deny until an explicit secret-reference contract exists (ORCLOCAL-77 security
 * note). Evaluated on every segment of both the requested and realpath-resolved
 * relative path, so a symlinked or renamed secret cannot slip through. */
export function sensitivePathReason(segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i].toLowerCase();
    // Every name starting with ".env" (.env, .envrc, .env.local, .env_backup, .environment).
    if (SENSITIVE_NAMES.has(name) || name.startsWith(".env")) return GOVERNED_TOOL_REASONS.sensitivePath;
    if (name === ".config" && segments[i + 1]?.toLowerCase() === "gh") return GOVERNED_TOOL_REASONS.sensitivePath;
    const dot = name.lastIndexOf(".");
    if (dot > 0 && SENSITIVE_EXTENSIONS.has(name.slice(dot))) return GOVERNED_TOOL_REASONS.sensitivePath;
  }
  return null;
}

/** Content-based denial, evaluated by the adapter after the bytes are in memory
 * and before anything is returned. A name-based bypass (extensionless key,
 * renamed credential file) cannot defeat it. Narrow signature check only, on
 * the literal text and on one bounded base64-decoded pass over it. */
export function sensitiveContentReason(text: string): string | null {
  return matchesSecretMarker(text) || base64DecodedSecret(text) ? GOVERNED_TOOL_REASONS.sensitivePath : null;
}

export type NormalizedFileReadPath = { ok: true; relative: string; segments: string[]; logical: string } | { ok: false; code: string };
/** Lexical only. `./a/b` becomes `a/b`; anything absolute, escaping, empty,
 * NUL-bearing, backslashed or outside the P0 exact-path repertoire is refused. */
export function normalizeFileReadPath(raw: unknown): NormalizedFileReadPath {
  if (typeof raw !== "string" || !raw.length || raw.length > GOVERNED_FILE_READ_MAX_PATH_LENGTH) return { ok: false, code: GOVERNED_TOOL_REASONS.pathInvalid };
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) return { ok: false, code: GOVERNED_TOOL_REASONS.pathInvalid };
  const parts = raw.split("/");
  while (parts.length && parts[0] === ".") parts.shift();
  if (!parts.length || parts.some((part) => part === "" || part === "." || part === "..")) return { ok: false, code: GOVERNED_TOOL_REASONS.pathInvalid };
  const relative = parts.join("/"), logical = `${GOVERNED_LOGICAL_WORKSPACE_ROOT}/${relative}`;
  if (!exactPath(logical)) return { ok: false, code: GOVERNED_TOOL_REASONS.pathInvalid };
  const sensitive = sensitivePathReason(parts);
  if (sensitive) return { ok: false, code: sensitive };
  return { ok: true, relative, segments: parts, logical };
}

export function fileReadPlanner(input: ToolPlannerInput) {
  const parsed = FileReadArgumentsSchema.safeParse(input.arguments);
  if (!parsed.success) throw new Error(GOVERNED_TOOL_REASONS.argumentsInvalid);
  const path = normalizeFileReadPath(parsed.data.path);
  if (!path.ok) throw new Error(path.code);
  return { arguments: { path: path.relative }, claims: [{ type: "workspace_path" as const, value: path.logical, mode: "read" as const }] };
}

export function fileReadDefinition(context: LocalContext, sourceId: string): ToolDefinition {
  return {
    context: structuredClone(context), sourceId, connectorId: GOVERNED_FILE_READ_CONNECTOR, connectionId: GOVERNED_FILE_READ_CONNECTION,
    name: GOVERNED_FILE_READ_TOOL, description: FILE_READ_DESCRIPTION, parameters: structuredClone(FILE_READ_PARAMETERS), outputSchema: null,
    implementationId: GOVERNED_FILE_READ_IMPLEMENTATION.id, implementationVersion: GOVERNED_FILE_READ_IMPLEMENTATION.version, policyMode: "external",
  };
}

/** Composition seam for the trusted host. `adapter` is whatever bounded reader
 * the host binds; the registry retains it privately and only the admission
 * service's execute path can reach it. */
export function fileReadImplementation(context: LocalContext, sourceId: string, adapter: ToolImplementation["adapter"]): ToolImplementation {
  const definition = fileReadDefinition(context, sourceId);
  return { describe: () => structuredClone(definition), planner: fileReadPlanner, adapter, planningReview: { ...GOVERNED_FILE_READ_REVIEW } };
}
