import { randomUUID } from "node:crypto";
import type { LocalAgentService } from "../agents/service";
import { LocalProviderCallPort, type LocalProviderAdapter, type ProviderAdapterRequest } from "../providers/call-port";
import { localFixtureReadiness } from "../providers/web-local-fixture";
import { PROVIDER_CALL_VERSION, ProviderChunkSchema, type ProviderChunk, type ProviderReadinessCode } from "../shared/provider-call-contracts";
import { LOCAL_CONTRACT_VERSION, LocalIdSchema } from "../shared/local-contracts";
import type { z } from "zod";
import { DirectSessionService, type DirectExecutionBinding } from "./service";

/** A4F is an in-process contract fixture. No native entrypoint creates this class.
 * The A3 port is constructed here with a finite, injected chunk script; it
 * cannot select the Web/Python adapter, credentials, network or Tool executor. */
export interface DirectTurnFixture {
  readonly chunks: readonly ProviderChunk[];
  readonly beforePull?: (index: number, request: ProviderAdapterRequest) => void | Promise<void>;
}
export interface DirectTurnLimits {
  readonly timeoutMs: number;
  readonly maxChunks: number;
  readonly maxBytes: number;
  readonly maxOutputBytes: number;
}
const ceilings: DirectTurnLimits = { timeoutMs: 30000, maxChunks: 256, maxBytes: 65536, maxOutputBytes: 32768 };
// Process-local replay fence shared by every service object for the same host
// incarnation. It is deliberately not a durable ProviderCall ledger: after
// restart D3B's persisted runtime owner/epoch rejects the stranded attempt.
const usedAttempts = new Set<string>();
const MAX_UNCERTAIN_ATTEMPTS = 1024;

export type DirectFixtureTurnOutcome =
  | { kind: "final"; text: string; parsed: unknown }
  | { kind: "incomplete" | "empty" | "protocol_error" | "cancelled" | "unknown"; code: string };

export class DirectFixtureTurnCoordinator {
  private readonly port: LocalProviderCallPort;
  private readonly limits: DirectTurnLimits;
  constructor(private readonly direct: DirectSessionService, agents: LocalAgentService,
    fixture: DirectTurnFixture, limits: DirectTurnLimits = ceilings) {
    for (const key of Object.keys(ceilings) as (keyof DirectTurnLimits)[])
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ceilings[key])
        throw new Error("INVALID_PAYLOAD");
    if (limits.maxOutputBytes > limits.maxBytes || fixture.chunks.length > limits.maxChunks)
      throw new Error("INVALID_PAYLOAD");
    // Validate the entire script before a turn can start. A scripted Tool event
    // is still allowed here only to prove A3's fail-closed Tool rejection.
    const chunks = fixture.chunks.map(chunk => ProviderChunkSchema.parse(structuredClone(chunk)));
    const adapter: LocalProviderAdapter = {
      source: "web_provider_adapter", readiness: localFixtureReadiness,
      stream: async function* (request, signal) {
        for (const [index, chunk] of chunks.entries()) {
          if (signal.aborted) return;
          await fixture.beforePull?.(index, request);
          if (signal.aborted) return;
          yield chunk;
        }
      },
    };
    this.limits = { ...limits };
    this.port = new LocalProviderCallPort(agents, adapter,
      () => direct.authority().runtime_owner, () => true,
      { timeoutMs: limits.timeoutMs, maxChunks: limits.maxChunks, maxBytes: limits.maxBytes });
  }

  /** Exactly one simulated user→assistant dispatch per attempt. The only
   * persisted transition is D3B's existing attempt outcome, after a validated
   * final. All uncertain results leave the attempt running for trusted recovery. */
  async run(raw: { sessionId: string; attemptId: string; binding: DirectExecutionBinding;
    text: string; signal: AbortSignal; outputSchema: z.ZodType<unknown> }): Promise<DirectFixtureTurnOutcome> {
    const sessionId = LocalIdSchema.parse(raw.sessionId), attemptId = LocalIdSchema.parse(raw.attemptId);
    if (typeof raw.text !== "string" || !raw.text.trim() || Buffer.byteLength(raw.text) > this.limits.maxBytes)
      return { kind: "protocol_error", code: "INVALID_PAYLOAD" };
    const authority = this.direct.authority();
    const key = JSON.stringify([authority.runtime_owner.instance_id, authority.runtime_owner.epoch,
      authority.context.org_id, authority.context.project_id, sessionId, attemptId]);
    if (usedAttempts.has(key)) return { kind: "unknown", code: "DIRECT_TURN_ALREADY_DISPATCHED" };
    if (usedAttempts.size >= MAX_UNCERTAIN_ATTEMPTS) return { kind: "unknown", code: "DIRECT_TURN_LIMIT" };
    // Check before claiming the attempt and before any scripted provider pull.
    const pin = this.direct.assertDispatch(sessionId, attemptId, raw.binding);
    const session = this.direct.get(sessionId);
    if (!session || session.agent_id === null) return { kind: "unknown", code: "DIRECT_SESSION_UNAVAILABLE" };
    usedAttempts.add(key);
    if (raw.signal.aborted) return { kind: "cancelled", code: "PROVIDER_CANCELLED" };
    const request = { schemaVersion: PROVIDER_CALL_VERSION, context: authority.context,
      runtimeOwner: authority.runtime_owner, source: "web_provider_adapter" as const,
      agent: { agentId: session.agent_id, versionId: pin.agentVersionId },
      text: raw.text, mode: "text" as const };
    let text = "", chunks = 0, coverage = false;
    try {
      // assertDispatch is repeated immediately before the single simulated send.
      this.direct.assertDispatch(sessionId, attemptId, raw.binding);
      for await (const event of this.port.call(request, raw.signal)) {
        if (raw.signal.aborted) return { kind: "cancelled", code: "PROVIDER_CANCELLED" };
        // A revoke or placement change during a stream must stop projection
        // before its next chunk can be observed by this coordinator.
        this.direct.assertDispatch(sessionId, attemptId, raw.binding);
        if (++chunks > this.limits.maxChunks + 2) return { kind: "unknown", code: "PROVIDER_STREAM_LIMIT" };
        if (event.type === "coverage") {
          if (coverage || event.coverage.admittedTools.length || event.coverage.accounting !== "not_durable_provider_accounting")
            return { kind: "protocol_error", code: "PROVIDER_PROTOCOL_ERROR" };
          coverage = true; continue;
        }
        // A3 reports readiness refusal before emitting coverage or touching
        // the fixture stream. It is a typed preflight result, not a protocol fault.
        if (event.type === "not_ready") return classifyFault(event.code, raw.signal);
        if (!coverage) return { kind: "protocol_error", code: "PROVIDER_PROTOCOL_ERROR" };
        if (event.type === "text") {
          text += event.text;
          if (Buffer.byteLength(text) > this.limits.maxOutputBytes)
            return { kind: "incomplete", code: "PROVIDER_STREAM_LIMIT" };
          continue;
        }
        if (!text.trim()) return { kind: "empty", code: "PROVIDER_EMPTY" };
        const parsed = raw.outputSchema.safeParse(text);
        if (!parsed.success) return { kind: "protocol_error", code: "OUTPUT_SCHEMA_INVALID" };
        // No fixture text is released until the exact authority is rechecked
        // and D3B records its terminal transition. No separate answer store.
        this.direct.assertDispatch(sessionId, attemptId, raw.binding);
        this.direct.outcome({ schema_version: LOCAL_CONTRACT_VERSION, request_id: randomUUID(),
          idempotency_key: randomUUID(), ...this.direct.authority() }, sessionId, attemptId, "completed");
        usedAttempts.delete(key); // D3B's terminal attempt now rejects every further dispatch.
        return { kind: "final", text, parsed: parsed.data };
      }
      return { kind: "incomplete", code: "PROVIDER_INCOMPLETE" };
    } catch {
      return { kind: "unknown", code: "DIRECT_TURN_UNKNOWN" };
    }
  }
}

function classifyFault(code: ProviderReadinessCode, signal: AbortSignal): DirectFixtureTurnOutcome {
  if (signal.aborted && code === "PROVIDER_CANCELLED") return { kind: "cancelled", code };
  if (code === "PROVIDER_INCOMPLETE" || code === "PROVIDER_STREAM_LIMIT") return { kind: "incomplete", code };
  if (code === "PROVIDER_PROTOCOL_ERROR" || code === "TOOL_MODE_NOT_READY")
    return { kind: "protocol_error", code };
  return { kind: "unknown", code };
}
