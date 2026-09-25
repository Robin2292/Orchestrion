/** Pure, trusted-host Responses event decoder. No transport, Tool admission or
 * durable accounting is implied by these provider facts. */
import type { JsonValue } from "./codex-responses-codec";

export type ResponsesStreamFact =
  | { type: "text_delta"; text: string }
  | { type: "tool_proposal"; outputIndex: number; itemId: string; callId: string; name: string; arguments: { [key: string]: JsonValue } }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  | { type: "terminal"; outcome: "end_turn" | "tool_use" | "incomplete" | "cancelled"; responseId: string | null; incompleteReason: string | null }
  | { type: "error"; code: "provider_failed" | "provider_error" };

export class ResponsesStreamError extends Error {
  constructor(readonly code: "protocol" | "limit" | "incomplete") { super(`CODEX_RESPONSES_STREAM_${code.toUpperCase()}`); }
}
function fail(code: ResponsesStreamError["code"] = "protocol"): never { throw new ResponsesStreamError(code); }
const LIMIT = { events: 256, bytes: 256 * 1024, stringBytes: 64 * 1024, calls: 64,
  nodes: 8192, depth: 32, arrayItems: 512, objectKeys: 128 } as const;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function validJson(value: unknown, budget = { nodes: 0 }, depth = 0): void {
  if (depth > LIMIT.depth || ++budget.nodes > LIMIT.nodes) fail("limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value === "string") { if (Buffer.byteLength(value) > LIMIT.stringBytes) fail("limit"); return; }
  if (Array.isArray(value)) {
    if (value.length > LIMIT.arrayItems || Reflect.ownKeys(value).length !== value.length + 1) fail("limit");
    for (let i = 0; i < value.length; i++) {
      const property = Object.getOwnPropertyDescriptor(value, String(i));
      if (!property?.enumerable || !own(property, "value")) fail();
      validJson(property.value, budget, depth + 1);
    }
    return;
  }
  if (!record(value)) fail();
  const properties = Reflect.ownKeys(value);
  if (properties.length > LIMIT.objectKeys) fail("limit");
  for (const key of properties) {
    if (typeof key !== "string") fail();
    validJson(key, budget, depth + 1);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !own(property, "value")) fail();
    validJson(property.value, budget, depth + 1);
  }
}
const id = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fail();
const nonempty = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : fail();
const index = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail();
const tokens = (value: unknown): number => value === undefined ? 0 : Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail();
function argumentsObject(raw: unknown): { [key: string]: JsonValue } {
  if (typeof raw !== "string") fail();
  if (Buffer.byteLength(raw) > LIMIT.stringBytes) fail("limit");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(); }
  validJson(value);
  return record(value) ? value as { [key: string]: JsonValue } : fail();
}
interface Call { outputIndex: number; itemId: string; callId: string; name: string; fragments: string; done?: { [key: string]: JsonValue } }
function callItem(item: unknown, outputIndex: number): Call {
  if (!record(item) || item.type !== "function_call") fail();
  const itemId = id(item.id), callId = id(item.call_id), name = nonempty(item.name);
  if (!itemId.startsWith("fc_")) fail();
  return { outputIndex, itemId, callId, name, fragments: "" };
}
function sameCall(a: Call, b: Call): boolean {
  return a.outputIndex === b.outputIndex && a.itemId === b.itemId && a.callId === b.callId && a.name === b.name;
}
const detail = (value: unknown): Record<string, unknown> => value === undefined ? {} : record(value) ? value : fail();
function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (record(a) && record(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && sameJson(a[key] as JsonValue, b[key] as JsonValue));
  }
  return false;
}

/** Decodes one finite response. A Tool proposal is returned only after a
 * completed terminal item proves its exact call/item pair and full arguments. */
export function decodeCodexResponsesEvents(rawEvents: unknown): ResponsesStreamFact[] {
  if (!Array.isArray(rawEvents) || rawEvents.length > LIMIT.events) fail("limit");
  const facts: ResponsesStreamFact[] = [], added = new Map<number, Call>(), done = new Map<number, Call>();
  const ids = new Set<string>(), callIds = new Set<string>();
  let bytes = 0, active: number | undefined, terminal = false;
  for (const raw of rawEvents) {
    if (terminal) fail();
    validJson(raw);
    bytes += Buffer.byteLength(JSON.stringify(raw));
    if (bytes > LIMIT.bytes) fail("limit");
    if (!record(raw) || typeof raw.type !== "string") fail();
    switch (raw.type) {
      case "response.output_text.delta":
        if (typeof raw.delta !== "string") fail();
        if (raw.delta) facts.push({ type: "text_delta", text: raw.delta });
        break;
      case "response.output_item.added": {
        if (!record(raw.item)) fail();
        if (raw.item.type !== "function_call") break;
        const position = raw.output_index === undefined ? added.size : index(raw.output_index);
        const call = callItem(raw.item, position);
        if (added.size >= LIMIT.calls || added.has(position) || ids.has(call.itemId) || callIds.has(call.callId)) fail();
        ids.add(call.itemId); callIds.add(call.callId); added.set(position, call); active = position;
        break;
      }
      case "response.function_call_arguments.start": {
        const position = raw.output_index === undefined ? active : index(raw.output_index);
        if (position === undefined || !added.has(position)) fail();
        active = position; break;
      }
      case "response.function_call_arguments.delta": {
        const position = raw.output_index === undefined ? active : index(raw.output_index);
        if (position === undefined || !added.has(position) || typeof raw.delta !== "string") fail();
        const call = added.get(position)!;
        call.fragments += raw.delta;
        if (Buffer.byteLength(call.fragments) > LIMIT.stringBytes) fail("limit");
        active = position; break;
      }
      case "response.output_item.done": {
        const position = index(raw.output_index);
        if (!record(raw.item)) fail();
        if (raw.item.type !== "function_call") break;
        const call = callItem(raw.item, position);
        if (done.has(position) || added.has(position) && !sameCall(added.get(position)!, call)) fail();
        call.done = argumentsObject(raw.item.arguments);
        done.set(position, call); break;
      }
      case "response.completed":
      case "response.done":
      case "response.incomplete":
      case "response.cancelled": {
        if (!record(raw.response)) fail();
        const response = raw.response;
        const status = response.status ?? (raw.type === "response.done" ? undefined : raw.type.slice("response.".length));
        if (status !== "completed" && status !== "incomplete" && status !== "cancelled") fail();
        if (raw.type !== "response.done" && status !== raw.type.slice("response.".length)) fail();
        const responseId = response.id === undefined ? null : id(response.id);
        const usage = detail(response.usage), input = detail(usage.input_tokens_details), output = detail(usage.output_tokens_details);
        const rawOutput = response.output;
        if (rawOutput !== undefined && !Array.isArray(rawOutput)) fail();
        const incomplete = detail(response.incomplete_details);
        const incompleteReason = incomplete.reason === undefined ? null : nonempty(incomplete.reason);
        const usageFact: ResponsesStreamFact = { type: "usage", inputTokens: tokens(usage.input_tokens),
          outputTokens: tokens(usage.output_tokens), cachedTokens: tokens(input.cached_tokens),
          cacheWriteTokens: tokens(input.cache_write_tokens), reasoningTokens: tokens(output.reasoning_tokens) };
        // A cancelled or incomplete response can end mid-argument. It has no
        // executable Tool proposal, even if its terminal snapshot is partial.
        if (status !== "completed") {
          facts.push(usageFact, { type: "terminal", outcome: status, responseId, incompleteReason });
          terminal = true; break;
        }
        if (incompleteReason !== null) fail();
        const snapshots = rawOutput?.length ? rawOutput : [...done.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
          type: "function_call", id: call.itemId, call_id: call.callId, name: call.name,
          arguments: JSON.stringify(call.done), output_index: call.outputIndex,
        }));
        if (snapshots.length > LIMIT.arrayItems) fail("limit");
        const proposals: Extract<ResponsesStreamFact, { type: "tool_proposal" }>[] = [];
        const seenItems = new Set<string>(), seenCalls = new Set<string>(), seenPositions = new Set<number>();
        let previousPosition = -1;
        for (let i = 0; i < snapshots.length; i++) {
          const item = snapshots[i];
          if (!record(item)) fail();
          if (item.type === "reasoning" || item.type === "message") continue;
          if (item.type !== "function_call") fail();
          const position = item.output_index === undefined ? i : index(item.output_index);
          if (position <= previousPosition) fail();
          previousPosition = position;
          const call = callItem(item, position);
          if (seenPositions.has(position) || seenItems.has(call.itemId) || seenCalls.has(call.callId)) fail();
          seenPositions.add(position); seenItems.add(call.itemId); seenCalls.add(call.callId);
          const started = added.get(position), completed = done.get(position);
          if (started && !sameCall(started, call) || completed && !sameCall(completed, call)) fail();
          const args = argumentsObject(item.arguments);
          if (started?.fragments && !sameJson(argumentsObject(started.fragments), args)) fail();
          if (completed?.done && !sameJson(completed.done, args)) fail();
          proposals.push({ type: "tool_proposal", outputIndex: position, itemId: call.itemId,
            callId: call.callId, name: call.name, arguments: args });
        }
        if (proposals.length > LIMIT.calls || [...added.keys()].some(position => !seenPositions.has(position))
          || [...done.keys()].some(position => !seenPositions.has(position))) fail();
        facts.push(...proposals, usageFact, { type: "terminal", outcome: proposals.length ? "tool_use" : "end_turn",
          responseId, incompleteReason: null });
        terminal = true; break;
      }
      case "response.failed":
      case "error":
        facts.push({ type: "error", code: raw.type === "error" ? "provider_error" : "provider_failed" });
        terminal = true; break;
      default: fail();
    }
  }
  if (!terminal) fail("incomplete");
  return facts;
}
