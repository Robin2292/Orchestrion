/** A bounded, host-only Codex Responses transport for a single text Agent turn. */
import type { CodexTextFailure, CodexProtocolStage } from "./codex-text-diagnostics";
export type { CodexTextFailure, CodexProtocolStage } from "./codex-text-diagnostics";

export class CodexTextError extends Error {
  constructor(readonly code: CodexTextFailure, readonly stage?: CodexProtocolStage) { super(code); }
}

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_EVENTS = 512;
const MODELS = new Set(["gpt-6-luna"]);
// The subscription endpoint rejects max_output_tokens. Reserve the model's
// published maximum before dispatch instead (OpenAI GPT-6 Luna model card).
export const CODEX_TEXT_MAX_OUTPUT_TOKENS = 128_000;
export const codexTextModelReady = (model: string): boolean => MODELS.has(model);
export type CodexTextResult = { text: string; usage: { inputTokens: number; outputTokens: number } };
export type CodexTextMessage = { role: "system" | "user" | "assistant"; content: string };
type Request = { token: string; accountId: string; model: string; messages: readonly CodexTextMessage[] };

function statusCode(status: number): CodexTextFailure {
  if (status === 401 || status === 403) return "PROVIDER_AUTH_EXPIRED";
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  if (status === 402) return "PROVIDER_QUOTA";
  if (status === 400) return "PROVIDER_BAD_REQUEST";
  return "PROVIDER_UNAVAILABLE";
}

export class CodexResponsesText {
  constructor(private readonly send: typeof fetch = fetch) {}

  async complete(input: Request, signal: AbortSignal): Promise<CodexTextResult> {
    if (!codexTextModelReady(input.model)) throw new CodexTextError("MODEL_NOT_READY");
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.accountId) || !input.token)
      throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
    if (!input.messages.length || input.messages.length > 256 || input.messages.at(-1)?.role !== "user"
        || input.messages.some(m => !m.content || Buffer.byteLength(m.content) > MAX_TEXT_BYTES))
      throw new CodexTextError("PROVIDER_BAD_REQUEST");
    const instructions = input.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const turns = input.messages.filter(m => m.role !== "system").map(m => ({ role: m.role,
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] }));
    const body = JSON.stringify({ model: input.model, store: false, stream: true,
      instructions: instructions || "You are a helpful assistant.", input: turns,
      text: { verbosity: "low" } });
    let response: Response;
    try {
      response = await this.send(ENDPOINT, { method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${input.token}`, "chatgpt-account-id": input.accountId,
          "Content-Type": "application/json", Accept: "text/event-stream",
          "OpenAI-Beta": "responses=experimental", originator: "orchestrion" }, body });
    } catch { throw new CodexTextError(signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK"); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined);
      throw new CodexTextError(statusCode(response.status)); }
    if (response.redirected) throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "redirect");
    if (!response.body) throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "body_missing");
    // The subscription endpoint may stream SSE without an SSE content type.
    // Trust only bounded, parsed events and an explicit completed text result.
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "", output = "", bytes = 0, events = 0, done = false;
    let usage: CodexTextResult["usage"] | null = null;
    const event = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]" || !payload) return;
      let value: unknown;
      try { value = JSON.parse(payload); } catch { throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_json"); }
      if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string")
        throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
      const item = value as Record<string, unknown>;
      if (done) throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
      if (item.type === "response.output_text.delta") {
        if (typeof item.delta !== "string") throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
        output += item.delta;
        if (Buffer.byteLength(output) > MAX_TEXT_BYTES) throw new CodexTextError("PROVIDER_STREAM_LIMIT");
      } else if (item.type === "response.output_item.added" || item.type === "response.output_item.done") {
        const outputItem = item.item;
        if (!outputItem || typeof outputItem !== "object" || !("type" in outputItem)
            || typeof outputItem.type !== "string")
          throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
        if (outputItem.type !== "message" && outputItem.type !== "reasoning")
          throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "tool_output");
      }
      else if (item.type === "response.completed" || item.type === "response.done") {
        const response = item.response;
        if (response && typeof response === "object") {
          const detail = response as Record<string, unknown>;
          if (detail.status !== "completed")
            throw new CodexTextError("PROVIDER_INCOMPLETE");
          if (Array.isArray(detail.output)) {
            let final = "";
            for (const entry of detail.output) {
              if (!entry || typeof entry !== "object" || !("type" in entry))
                throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
              if (entry.type === "reasoning") continue;
              if (entry.type !== "message")
                throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "tool_output");
              if (!("content" in entry) || !Array.isArray(entry.content))
                throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
              for (const part of entry.content) {
                if (part && typeof part === "object" && "type" in part && part.type === "output_text") {
                  if (!("text" in part) || typeof part.text !== "string")
                    throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
                  final += part.text;
                }
              }
            }
            if (final && output && final !== output)
              throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
            output = final || output;
          }
          const raw = detail.usage;
          if (!raw || typeof raw !== "object" || !("input_tokens" in raw) || !("output_tokens" in raw)
              || !Number.isSafeInteger(raw.input_tokens) || !Number.isSafeInteger(raw.output_tokens)
              || (raw.input_tokens as number) < 1 || (raw.output_tokens as number) < 0)
            throw new CodexTextError("PROVIDER_PROTOCOL_ERROR", "event_shape");
          usage = { inputTokens: raw.input_tokens as number, outputTokens: raw.output_tokens as number };
        }
        done = true;
      }
      else if (item.type === "response.failed" || item.type === "response.incomplete"
          || item.type === "response.cancelled" || item.type === "error")
        throw new CodexTextError("PROVIDER_INCOMPLETE");
    };
    try {
      while (true) {
        if (signal.aborted) throw new CodexTextError("PROVIDER_TIMEOUT");
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new CodexTextError("PROVIDER_STREAM_LIMIT");
        pending += decoder.decode(next.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary).replace(/\r$/, "");
          pending = pending.slice(boundary + 1);
          if (++events > MAX_EVENTS) throw new CodexTextError("PROVIDER_STREAM_LIMIT");
          event(line);
        }
      }
      if (pending.trim()) event(pending.trim());
      if (!done || !output.trim() || !usage) throw new CodexTextError("PROVIDER_INCOMPLETE");
      return { text: output, usage };
    } catch (error) {
      if (error instanceof CodexTextError) throw error;
      throw new CodexTextError(signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_PROTOCOL_ERROR",
        signal.aborted ? undefined : "stream_decode");
    } finally { await reader.cancel().catch(() => undefined); }
  }
}
