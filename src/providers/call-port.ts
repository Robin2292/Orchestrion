import type { LocalAgentService } from "../agents/service";
import { agentCommandBytes } from "../agents/service";
import type { LocalAgentVersion } from "../shared/agent-contracts";
import type { RuntimeOwnerSchema } from "../shared/local-contracts";
import type { z } from "zod";
import { ProviderCallRequestSchema, ProviderChunkSchema, ProviderReadinessCodeSchema, type ProviderCallEvent, type ProviderReadinessCode } from "../shared/provider-call-contracts";

export interface ProviderAdapterRequest { model: string; messages: { role: "system" | "user"; content: string }[]; maxTokens: number }
/** Host-only transport seam, not a registry. The concrete Web adapter below
 * reuses Python ProviderRegistry. No credential, dispatch, SQL or renderer port. */
export interface LocalProviderAdapter {
  readonly source: "web_provider_adapter";
  readiness(version: LocalAgentVersion): ProviderReadinessCode | null;
  stream(request: ProviderAdapterRequest, signal: AbortSignal): AsyncIterable<unknown>;
}
const refusal = (code: unknown): ProviderCallEvent => {
  const parsed = ProviderReadinessCodeSchema.safeParse(code);
  return { type: "not_ready", code: parsed.success ? parsed.data : "PROVIDER_UNAVAILABLE", retryable: false };
};
export class ProviderPortError extends Error {
  constructor(readonly code: ProviderReadinessCode) { super(code); }
}
const budgets = { timeoutMs: 30000, maxChunks: 256, maxBytes: 65536 };

/** One active call per host-scoped port. This is ephemeral provider I/O, never
 * F6 durable work or N-series billing. A2/runtime must own scheduling/recovery.
 * Pulling the next event acknowledges the last one: no prefetch/unbounded queue.
 * No Tool call is dispatched or admitted here; T2 remains the only admission. */
export class LocalProviderCallPort {
  #call: symbol | undefined;
  constructor(private readonly agents: LocalAgentService, private readonly adapter: LocalProviderAdapter,
    private readonly owner: () => z.infer<typeof RuntimeOwnerSchema>, private readonly active: () => boolean,
    private readonly limits = budgets) {
    for (const k of ["timeoutMs", "maxChunks", "maxBytes"] as const)
      if (!Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > budgets[k]) throw new Error("INVALID_PAYLOAD");
    this.limits = { ...limits };
  }
  /** Direct's host-only ledger may supply its already pinned request messages.
   * This is never accepted through ProviderCallRequestSchema or renderer IPC. */
  async *call(raw: unknown, signal: AbortSignal,
    trustedMessages?: readonly ProviderAdapterRequest["messages"][number][]): AsyncGenerator<ProviderCallEvent> {
    let request;
    try { agentCommandBytes(raw); request = ProviderCallRequestSchema.parse(raw); }
    catch { yield refusal("INVALID_PAYLOAD"); return; }
    if (this.#call) { yield refusal("PROVIDER_BUSY"); return; }
    const pin = agentCommandBytes(request.agent);
    const fence = () => {
      if (!this.active() || agentCommandBytes(request.context) !== agentCommandBytes(this.agents.context)) throw new ProviderPortError("CONTEXT_MISMATCH");
      if (agentCommandBytes(request.runtimeOwner) !== agentCommandBytes(this.owner())) throw new ProviderPortError("RUNTIME_OWNER_MISMATCH");
      if (request.source !== this.adapter.source) throw new ProviderPortError("SOURCE_NOT_READY");
      try { return this.agents.reference(JSON.parse(pin)); }
      catch { throw new ProviderPortError("AGENT_VERSION_NOT_READY"); }
    };
    let version;
    try { version = fence(); }
    catch (error) { yield refusal(error instanceof ProviderPortError ? error.code : "PROVIDER_UNAVAILABLE"); return; }
    if (request.mode !== "text") { yield refusal("TOOL_MODE_NOT_READY"); return; }
    let readiness;
    try { readiness = this.adapter.readiness(version); }
    catch { readiness = "PROVIDER_UNAVAILABLE" as const; }
    if (readiness !== null) { yield refusal(readiness); return; }
    const token = Symbol(); this.#call = token;
    const release = () => { if (this.#call === token) this.#call = undefined; };
    const controller = new AbortController();
    let aborted: ProviderReadinessCode = "PROVIDER_CANCELLED";
    const cancel = () => { controller.abort(); release(); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => { aborted = "PROVIDER_TIMEOUT"; cancel(); }, this.limits.timeoutMs);
    let iterator: AsyncIterator<unknown> | undefined;
    const check = () => { if (controller.signal.aborted) throw new ProviderPortError(aborted); fence(); };
    try {
      check();
      yield { type: "coverage", coverage: { source: "web_provider_adapter", toolExecution: "outside_governed_tool_execution",
        admittedTools: [], accounting: "not_durable_provider_accounting", evidence: "a3-local-http-fixture" } };
      check();
      let messages: ProviderAdapterRequest["messages"];
      if(trustedMessages) {
        if(trustedMessages.length<1||trustedMessages.length>2
          ||trustedMessages.at(-1)?.role!=="user"||trustedMessages.at(-1)?.content!==request.text
          ||trustedMessages.length===2&&trustedMessages[0]?.role!=="system"
          ||trustedMessages.some(m=>typeof m.content!=="string"||!m.content
            ||Object.keys(m).sort().join()!=="content,role"))
          throw new ProviderPortError("INVALID_PAYLOAD");
        messages=trustedMessages.map(m=>({role:m.role,content:m.content}));
      } else {
        messages=[];
        if (version.definition.systemPrompt) messages.push({ role: "system", content: version.definition.systemPrompt });
        messages.push({ role: "user", content: request.text });
      }
      if (Buffer.byteLength(JSON.stringify(messages)) > this.limits.maxBytes) throw new ProviderPortError("PROVIDER_STREAM_LIMIT");
      iterator = this.adapter.stream({ model: version.definition.modelId, messages,
        maxTokens: version.definition.maxTokens ?? 256 }, controller.signal)[Symbol.asyncIterator]();
      let chunks = 0, bytes = 0;
      while (true) {
        check();
        const next = await abortable(iterator.next(), controller.signal, () => new ProviderPortError(aborted));
        check();
        if (next.done) throw new ProviderPortError("PROVIDER_INCOMPLETE");
        const parsed = ProviderChunkSchema.safeParse(next.value);
        if (!parsed.success) throw new ProviderPortError("PROVIDER_PROTOCOL_ERROR");
        const chunk = parsed.data;
        bytes += Buffer.byteLength(JSON.stringify(chunk));
        if (++chunks > this.limits.maxChunks || bytes > this.limits.maxBytes) throw new ProviderPortError("PROVIDER_STREAM_LIMIT");
        if (chunk.type === "error") throw new ProviderPortError(chunk.code);
        if (chunk.type === "tool_call_start" || chunk.type === "tool_call_delta") throw new ProviderPortError("TOOL_MODE_NOT_READY");
        if (chunk.type === "done") {
          if (chunk.outcome !== "completed") throw new ProviderPortError(chunk.outcome === "tools" ? "TOOL_MODE_NOT_READY" : "PROVIDER_INCOMPLETE");
          cancel();
          yield { type: "completed" }; return;
        }
        yield { type: "text", text: chunk.text };
      }
    } catch (error) {
      cancel();
      yield refusal(error instanceof ProviderPortError ? error.code : "PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", cancel); cancel();
      // Adapters must abort their physical I/O. Never wait indefinitely for a
      // broken generator's return(), and never expose its rejection text.
      try { void Promise.resolve(iterator?.return?.()).catch(() => undefined); } catch { /* safe close */ }
    }
  }
}
export function abortable<T>(pending: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(error());
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
    if (signal.aborted) abort();
  });
}
