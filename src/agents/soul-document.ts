import { createHash } from "node:crypto";
import { AGENT_SOUL_MAX_BYTES, AgentSoulSnapshotSchema, type AgentSoulSnapshot } from "../shared/agent-soul-contracts";
import { StorageError } from "../storage/sqlite/foundation";

export function normalizeAgentSoul(value: string): AgentSoulSnapshot {
  if (typeof value !== "string" || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    throw new StorageError("SOUL_INVALID_CONTENT");
  const content = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").normalize("NFC");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > AGENT_SOUL_MAX_BYTES) throw new StorageError("SOUL_TOO_LARGE");
  return AgentSoulSnapshotSchema.parse({
    content,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

export function verifyAgentSoul(snapshot: AgentSoulSnapshot, effectivePrompt: string | null): AgentSoulSnapshot {
  const normalized = normalizeAgentSoul(snapshot.content);
  if (snapshot.content !== normalized.content || snapshot.hash !== normalized.hash
    || effectivePrompt !== snapshot.content) throw new StorageError("SOUL_INVALID_CONTENT");
  return snapshot;
}
