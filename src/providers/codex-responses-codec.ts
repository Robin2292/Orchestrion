/** Host-only, pure Responses conversion. Callers must supply complete canonical
 * facts; DirectPackedContext's preview/tool ID projection is not sufficient. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CanonicalMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: readonly CanonicalToolCall[]; responseItems?: readonly JsonValue[] }
  | { role: "tool"; callId: string; itemId: string; content: string };
export interface CanonicalToolCall {
  callId: string;
  itemId: string;
  name: string;
  arguments: { [key: string]: JsonValue };
}
export interface ResponsesInput { instructions: string | null; input: JsonValue[] }

export class ResponsesCodecError extends Error {
  constructor() { super("CODEX_RESPONSES_CODEC_INVALID"); }
}
function fail(): never { throw new ResponsesCodecError(); }
const LIMIT = { messages: 256, outputItems: 512, toolCalls: 64, responseItems: 256,
  bytes: 256 * 1024, stringBytes: 64 * 1024, nodes: 8192, arrayItems: 512, objectKeys: 128, depth: 32 } as const;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
};
const string = (value: unknown): string => typeof value === "string" ? value : fail();
const identifier = (value: unknown): string => {
  const id = string(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail();
  return id;
};
/** Count before copying or JSON.parse. Every property must be a JSON value;
 * hidden/symbol/accessor fields cannot disappear from provider facts. */
function bounded(value: unknown, budget = { bytes: 0, nodes: 0 }, depth = 0): void {
  if (depth > LIMIT.depth || ++budget.nodes > LIMIT.nodes) fail();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value === "string") {
    const size = Buffer.byteLength(value);
    budget.bytes += size;
    if (size > LIMIT.stringBytes || budget.bytes > LIMIT.bytes) fail();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > LIMIT.arrayItems) fail();
    if (Reflect.ownKeys(value).length !== value.length + 1) fail(); // indices plus length only
    for (let i = 0; i < value.length; i++) {
      if (!own(value, String(i))) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !own(descriptor, "value")) fail();
      bounded(descriptor.value, budget, depth + 1);
    }
    return;
  }
  if (!record(value)) fail();
  const properties = Reflect.ownKeys(value);
  if (properties.length > LIMIT.objectKeys) fail();
  for (const key of properties) {
    if (typeof key !== "string") fail();
    bounded(key, budget, depth + 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !own(descriptor, "value")) fail();
    bounded(descriptor.value, budget, depth + 1);
  }
}
const json = (value: unknown, depth = 0): JsonValue => {
  if (depth > LIMIT.depth) fail();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (record(value)) {
    const copy: { [key: string]: JsonValue } = Object.create(null);
    for (const [key, item] of Object.entries(value)) copy[key] = json(item, depth + 1);
    return copy;
  }
  return fail();
};
const jsonObject = (value: unknown): { [key: string]: JsonValue } => {
  bounded(value);
  const parsed = json(value);
  return record(parsed) ? parsed as { [key: string]: JsonValue } : fail();
};
const argumentsObject = (value: unknown) => {
  if (typeof value !== "string") fail();
  try { return jsonObject(JSON.parse(value)); } catch { return fail(); }
};
const same = (a: JsonValue, b: JsonValue): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (record(a) && record(b)) {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(key => own(b, key) && same(a[key] as JsonValue, b[key] as JsonValue));
  }
  return false;
};

function parseCall(raw: unknown): CanonicalToolCall {
  if (!record(raw)) fail();
  keys(raw, ["callId", "itemId", "name", "arguments"]);
  const itemId = identifier(raw.itemId);
  if (!itemId.startsWith("fc_")) fail();
  const name = string(raw.name);
  if (!name) fail();
  return { callId: identifier(raw.callId), itemId, name, arguments: jsonObject(raw.arguments) };
}

function parseMessage(raw: unknown): CanonicalMessage {
  if (!record(raw)) fail();
  if (raw.role === "system" || raw.role === "user") {
    keys(raw, ["role", "content"]);
    const content = string(raw.content);
    if (!content) fail();
    return { role: raw.role, content };
  }
  if (raw.role === "assistant") {
    keys(raw, ["role", "content", "toolCalls"], ["responseItems"]);
    if (!Array.isArray(raw.toolCalls) || raw.toolCalls.length > LIMIT.toolCalls) fail();
    const parsed: CanonicalMessage = { role: "assistant", content: string(raw.content), toolCalls: raw.toolCalls.map(parseCall) };
    if (own(raw, "responseItems")) {
      if (!Array.isArray(raw.responseItems) || raw.responseItems.length > LIMIT.responseItems) fail();
      parsed.responseItems = raw.responseItems.map(item => jsonObject(item));
    }
    return parsed;
  }
  if (raw.role === "tool") {
    keys(raw, ["role", "callId", "itemId", "content"]);
    return { role: "tool", callId: identifier(raw.callId), itemId: identifier(raw.itemId), content: string(raw.content) };
  }
  return fail();
}

/** Validate the full provider snapshot before considering replay. Unknown output
 * kinds and partial known items are errors, even when canonical text changed. */
function replayMatches(items: readonly JsonValue[], message: Extract<CanonicalMessage, { role: "assistant" }>,
  emittedIds: Set<string>): boolean {
  let text = "";
  const calls: CanonicalToolCall[] = [];
  const outputIds = new Set<string>();
  for (const item of items) {
    if (!record(item)) fail();
    if (own(item, "id")) {
      const id = identifier(item.id);
      if (outputIds.has(id)) fail();
      outputIds.add(id);
    }
    if (item.type === "reasoning") {
      if (!own(item, "id") || !String(item.id).startsWith("rs_")
        || typeof item.encrypted_content !== "string" || !item.encrypted_content
        || !Array.isArray(item.summary) || own(item, "status") && item.status !== "completed") fail();
      for (const part of item.summary) {
        if (!record(part) || part.type !== "summary_text" || typeof part.text !== "string") fail();
      }
    } else if (item.type === "message") {
      if (item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) fail();
      for (const part of item.content) {
        if (!record(part) || part.type !== "output_text" || typeof part.text !== "string") fail();
        text += part.text;
      }
    } else if (item.type === "function_call") {
      if (own(item, "status") && item.status !== "completed") fail();
      calls.push(parseCall({ callId: item.call_id, itemId: item.id, name: item.name,
        arguments: argumentsObject(item.arguments) }));
    } else fail();
  }
  const matches = text === message.content && calls.length === message.toolCalls.length
    && calls.every((call, i) => {
      const expected = message.toolCalls[i];
      return call.callId === expected.callId && call.itemId === expected.itemId
        && call.name === expected.name && same(call.arguments, expected.arguments);
    });
  if (matches) {
    for (const id of outputIds) if (emittedIds.has(id)) fail();
    for (const id of outputIds) emittedIds.add(id);
  }
  return matches;
}

export function encodeCodexResponsesInput(rawMessages: unknown): ResponsesInput {
  if (!Array.isArray(rawMessages) || rawMessages.length > LIMIT.messages) fail();
  bounded(rawMessages);
  const messages = rawMessages.map(parseMessage);
  const instructions: string[] = [], input: JsonValue[] = [];
  const pending = new Map<string, string>(), used = new Set<string>(), emittedIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      if (pending.size) fail();
      instructions.push(message.content); continue;
    }
    if (message.role === "user") {
      if (pending.size) fail();
      input.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
      continue;
    }
    if (message.role === "assistant") {
      if (pending.size || !message.content && !message.toolCalls.length) fail();
      if (message.responseItems?.length && replayMatches(message.responseItems, message, emittedIds)) input.push(...message.responseItems);
      else {
        if (message.content) input.push({ type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: message.content }] });
        for (const call of message.toolCalls) {
          if (emittedIds.has(call.itemId)) fail();
          emittedIds.add(call.itemId);
          input.push({ type: "function_call", id: call.itemId,
            call_id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) });
        }
      }
      for (const call of message.toolCalls) {
        if (used.has(call.callId) || used.has(call.itemId) || pending.has(call.callId)) fail();
        used.add(call.callId); used.add(call.itemId); pending.set(call.callId, call.itemId);
      }
      if (input.length > LIMIT.outputItems) fail();
      continue;
    }
    if (pending.get(message.callId) !== message.itemId) fail();
    pending.delete(message.callId);
    input.push({ type: "function_call_output", call_id: message.callId, output: message.content });
    if (input.length > LIMIT.outputItems) fail();
  }
  if (pending.size) fail();
  return { instructions: instructions.length ? instructions.join("\n\n") : null, input };
}
