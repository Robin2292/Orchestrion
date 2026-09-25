import { describe, expect, it } from "vitest";
import { decodeCodexResponsesEvents as decode, ResponsesStreamError } from "./codex-responses-stream";

const call = (index: number, suffix: string, name = "read") => ({ type: "function_call", id: `fc_${suffix}`,
  call_id: `call_${suffix}`, name, arguments: '{"path":"src"}' });
const terminal = (output: unknown[] = [], status = "completed") => ({ type: `response.${status}`, response: {
  id: "resp_1", status, usage: { input_tokens: 100, output_tokens: 40,
    input_tokens_details: { cached_tokens: 25, cache_write_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 8 } }, output,
} });
const proposal = (facts: ReturnType<typeof decode>) => facts.filter(fact => fact.type === "tool_proposal");

describe("pure Codex Responses event decoder", () => {
  it("preserves Web text deltas, cache accounting and end-turn outcome", () => {
    expect(decode([
      { type: "response.output_text.delta", delta: "GROUP A — FACTUAL\n" },
      { type: "response.output_text.delta", delta: "GROUP B — NARRATIVE" }, terminal(),
    ])).toEqual([
      { type: "text_delta", text: "GROUP A — FACTUAL\n" },
      { type: "text_delta", text: "GROUP B — NARRATIVE" },
      { type: "usage", inputTokens: 100, outputTokens: 40, cachedTokens: 25,
        cacheWriteTokens: 10, reasoningTokens: 8 },
      { type: "terminal", outcome: "end_turn", responseId: "resp_1", incompleteReason: null },
    ]);
  });

  it("recovers a complete Web terminal-only call without treating a fragment as authority", () => {
    const facts = decode([{ type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: "fc_terminal", call_id: "call_terminal", name: "lookup" } },
      terminal([{ type: "function_call", id: "fc_terminal", call_id: "call_terminal", name: "lookup",
        arguments: '{"id":"42"}' }])]);
    expect(proposal(facts)).toEqual([{ type: "tool_proposal", outputIndex: 0, itemId: "fc_terminal",
      callId: "call_terminal", name: "lookup", arguments: { id: "42" } }]);
    expect(facts.at(-1)).toMatchObject({ type: "terminal", outcome: "tool_use" });
  });

  it("routes interleaved parallel fragments by Web output_index and preserves proposal order", () => {
    const a = call(2, "a"), b = call(4, "b");
    const added = (item: typeof a, output_index: number) => ({ type: "response.output_item.added", output_index,
      item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name } });
    const facts = decode([added(a, 2), added(b, 4),
      { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":"' },
      { type: "response.function_call_arguments.delta", output_index: 4, delta: '{"path":"src"}' },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: 'src"}' },
      terminal([{ type: "reasoning", id: "rs_1", summary: [] }, { ...a, output_index: 2 }, { ...b, output_index: 4 }])]);
    expect(proposal(facts)).toEqual([
      { type: "tool_proposal", outputIndex: 2, itemId: "fc_a", callId: "call_a", name: "read", arguments: { path: "src" } },
      { type: "tool_proposal", outputIndex: 4, itemId: "fc_b", callId: "call_b", name: "read", arguments: { path: "src" } },
    ]);
  });

  it("uses completed item snapshots when Web omits terminal output", () => {
    const item = call(0, "a");
    expect(proposal(decode([{ type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name } },
      { type: "response.output_item.done", output_index: 0, item },
      { ...terminal(), response: { ...terminal().response, output: [] } }])))
      .toMatchObject([{ itemId: "fc_a", callId: "call_a", arguments: { path: "src" } }]);
  });

  it("keeps failed, cancelled and incomplete outcomes distinct", () => {
    expect(decode([{ type: "error", error: { message: "private detail" } }]))
      .toEqual([{ type: "error", code: "provider_error" }]);
    expect(decode([{ type: "response.failed", response: { error: { message: "private detail" } } }]))
      .toEqual([{ type: "error", code: "provider_failed" }]);
    expect(decode([terminal([], "cancelled")]).at(-1)).toMatchObject({ type: "terminal", outcome: "cancelled" });
    expect(decode([{ type: "response.incomplete", response: { status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" } } }]).at(-1))
      .toMatchObject({ type: "terminal", outcome: "incomplete", incompleteReason: "max_output_tokens" });
  });

  it("preserves cancelled and incomplete outcomes for partial Tool arguments without proposals", () => {
    const partial = { type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "lookup" } };
    const delta = { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"id":' };
    for (const status of ["cancelled", "incomplete"] as const) {
      const facts = decode([partial, delta, { type: `response.${status}`, response: {
        id: "resp_partial", status, usage: { input_tokens: 3, output_tokens: 1 },
        output: [{ ...partial.item, arguments: '{"id":' }],
      } }]);
      expect(proposal(facts)).toEqual([]);
      expect(facts).toEqual([
        { type: "usage", inputTokens: 3, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        { type: "terminal", outcome: status, responseId: "resp_partial", incompleteReason: null },
      ]);
    }
    expect(() => decode([partial, delta, terminal([{ ...partial.item, arguments: '{"id":' }])]))
      .toThrow("CODEX_RESPONSES_STREAM_PROTOCOL");
  });

  it("rejects malformed, duplicate, mismatched and incomplete Tool pairs", () => {
    const item = call(0, "a");
    const added = { type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name } };
    const bad = [
      [added, terminal([{ ...item, call_id: "call_wrong" }])],
      [added, terminal()],
      [terminal([item, item])],
      [terminal([{ ...item, output_index: 2 }, { ...call(0, "b"), output_index: 1 }])],
      [terminal([{ ...item, arguments: "{" }])],
      [terminal([{ ...item, arguments: "[]" }])],
      [added, { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"other"}' }, terminal([item])],
      [{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }, terminal()],
      [terminal([{ ...item, id: "wrong" }])],
      [{ type: "response.output_item.done", output_index: 0, item }, terminal([{ ...item, call_id: "call_wrong" }])],
      [terminal(), { type: "response.output_text.delta", delta: "late" }],
      [{ type: "response.output_text.delta", delta: "partial" }],
      [{ type: "response.unknown", response: {} }, terminal()],
      [{ type: "response.completed", response: { status: "mystery" } }],
    ];
    for (const events of bad) expect(() => decode(events)).toThrow(ResponsesStreamError);
  });

  it("enforces event and byte limits before accepting provider facts", () => {
    expect(() => decode(Array.from({ length: 257 }, () => ({ type: "response.output_text.delta", delta: "x" }))))
      .toThrow("CODEX_RESPONSES_STREAM_LIMIT");
    expect(() => decode([{ type: "response.output_text.delta", delta: "x".repeat(65537) }, terminal()]))
      .toThrow("CODEX_RESPONSES_STREAM_LIMIT");
    expect(() => decode([...Array.from({ length: 6 }, () => ({ type: "response.output_text.delta",
      delta: "x".repeat(48 * 1024) })), terminal()]))
      .toThrow("CODEX_RESPONSES_STREAM_LIMIT");
  });
});
