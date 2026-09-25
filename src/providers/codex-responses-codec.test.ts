import { describe, expect, it } from "vitest";
import { encodeCodexResponsesInput as encode } from "./codex-responses-codec";

const call = { callId: "call_1", itemId: "fc_1", name: "search", arguments: { q: "pi agent" } };
const tool = { role: "tool", callId: "call_1", itemId: "fc_1", content: "result" };
const opaque = { type: "reasoning", id: "rs_1", encrypted_content: "opaque-provider-ciphertext", summary: [] };
const responseCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: '{"q":"pi agent"}' };

describe("pure Codex Responses codec", () => {
  it("preserves Web's ordered instructions, text, exact paired calls and outputs", () => {
    expect(encode([
      { role: "system", content: "First" }, { role: "system", content: "Second" },
      { role: "user", content: "Find" },
      { role: "assistant", content: "Searching", toolCalls: [call] }, tool,
      { role: "assistant", content: "Found it", toolCalls: [] },
    ])).toEqual({ instructions: "First\n\nSecond", input: [
      { role: "user", content: [{ type: "input_text", text: "Find" }] },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Searching" }] },
      responseCall,
      { type: "function_call_output", call_id: "call_1", output: "result" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Found it" }] },
    ] });
  });

  it("replays the exact Web-style reasoning and call snapshot once", () => {
    const result = encode([{ role: "assistant", content: "", toolCalls: [call], responseItems: [opaque, responseCall] }, tool]);
    expect(result.input).toEqual([opaque, responseCall, { type: "function_call_output", call_id: "call_1", output: "result" }]);
    expect(result.input.filter(item => (item as { type?: string }).type === "function_call")).toHaveLength(1);
  });

  it("uses canonical fallback after text or paired call changes", () => {
    const oldText = { type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "original long text" }] };
    expect(encode([{ role: "assistant", content: "shortened by compactor", toolCalls: [], responseItems: [opaque, oldText] }]).input)
      .toEqual([{ type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "shortened by compactor" }] }]);
    const changed = { ...call, itemId: "fc_2" };
    expect(encode([{ role: "assistant", content: "", toolCalls: [changed], responseItems: [opaque, responseCall] },
      { ...tool, itemId: "fc_2" }]).input).toEqual([
      { type: "function_call", id: "fc_2", call_id: "call_1", name: "search", arguments: '{"q":"pi agent"}' },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ]);
    expect(encode([{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: { q: "new" } }],
      responseItems: [opaque, responseCall] }, tool]).input[0]).toEqual({
      type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: '{"q":"new"}',
    });
  });

  it("preserves parallel call order and enforces every exact result", () => {
    const second = { callId: "call_2", itemId: "fc_2", name: "read", arguments: { path: "a" } };
    const output = encode([{ role: "assistant", content: "", toolCalls: [call, second] },
      { role: "tool", callId: "call_2", itemId: "fc_2", content: "two" }, tool]).input;
    expect(output.map(item => (item as { type?: string }).type)).toEqual([
      "function_call", "function_call", "function_call_output", "function_call_output",
    ]);
    expect(() => encode([{ role: "assistant", content: "", toolCalls: [call, second] }, tool])).toThrow("CODEX_RESPONSES_CODEC_INVALID");
    expect(() => encode([{ role: "assistant", content: "", toolCalls: [call] },
      { ...tool, itemId: "fc_wrong" }])).toThrow("CODEX_RESPONSES_CODEC_INVALID");
  });

  it("fails closed on absent Tool facts, malformed arguments, unsupported content and incomplete snapshots", () => {
    const bad = [
      [{ role: "assistant", content: "", toolCalls: [{ callId: "call_1", itemId: "fc_1" }] }, tool],
      [{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: "{" }] }, tool],
      [{ role: "assistant", content: "", toolCalls: [call], responseItems: [{ type: "image", data: "x" }] }, tool],
      [{ role: "assistant", content: "", toolCalls: [call], responseItems: [{ ...responseCall, arguments: "{" }] }, tool],
      [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }],
      [{ role: "tool", callId: "call_1", itemId: "fc_1", content: "orphan" }],
      [{ role: "assistant", content: "", toolCalls: [] }],
      [{ role: "assistant", content: "", toolCalls: [call] }, tool, tool],
      [{ role: "assistant", content: "", toolCalls: [call] }, { role: "user", content: "interrupted" }, tool],
      [{ role: "assistant", content: "", toolCalls: [call] }, { role: "system", content: "late" }, tool],
      [{ role: "user", content: "", extra: "unsupported" }],
    ];
    for (const messages of bad) expect(() => encode(messages)).toThrow("CODEX_RESPONSES_CODEC_INVALID");
  });

  it("rejects malformed reasoning and duplicate provider output IDs before replay", () => {
    const assistant = (responseItems: unknown[]) => ({ role: "assistant", content: "", toolCalls: [call], responseItems });
    const bad = [
      [opaque, { ...opaque }, responseCall],
      [{ ...opaque, encrypted_content: null }, responseCall],
      [{ ...opaque, encrypted_content: "" }, responseCall],
      [{ ...opaque, summary: "text" }, responseCall],
      [{ ...opaque, summary: [{ type: "summary_text", text: 17 }] }, responseCall],
      [{ ...opaque, summary: [{ type: "unknown", text: "text" }] }, responseCall],
      [{ ...opaque, id: "fc_1" }, responseCall],
    ];
    for (const items of bad) expect(() => encode([assistant(items), tool])).toThrow("CODEX_RESPONSES_CODEC_INVALID");
    expect(() => encode([assistant([opaque, responseCall]), tool,
      { role: "assistant", content: "later", toolCalls: [], responseItems: [opaque,
        { type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "later" }] }] }])).toThrow("CODEX_RESPONSES_CODEC_INVALID");
    expect(encode([assistant([{ ...opaque, summary: [{ type: "summary_text", text: "brief" }] }, responseCall]), tool])
      .input[0]).toMatchObject({ id: "rs_1", summary: [{ type: "summary_text", text: "brief" }] });
  });

  it("bounds messages, items, bytes and nested arguments before conversion", () => {
    const assistant = (responseItems: unknown[]) => ({ role: "assistant", content: "revised", toolCalls: [], responseItems });
    const manyNodes = Object.fromEntries(Array.from({ length: 6 }, (_, group) =>
      [`group${group}`, Array.from({ length: 512 }, (_, i) => ({ n: i }))]));
    const bad = [
      [{ role: "user", content: "x".repeat(1024 * 1024) }],
      Array.from({ length: 5 }, () => ({ role: "user", content: "x".repeat(60 * 1024) })),
      Array.from({ length: 257 }, () => ({ role: "user", content: "u" })),
      [assistant(Array.from({ length: 257 }, () => opaque))],
      [{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: { big: "x".repeat(65537) } }] }, tool],
      [assistant([{ ...opaque, summary: Array.from({ length: 513 }, () => ({ type: "summary_text", text: "x" })) }])],
      [{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: { deep: Array.from({ length: 8193 }, () => 0) } }] }, tool],
      [{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: manyNodes }] }, tool],
      [{ role: "assistant", content: "", toolCalls: [call], responseItems: [opaque,
        { ...responseCall, arguments: JSON.stringify(manyNodes) }] }, tool],
    ];
    for (const messages of bad) expect(() => encode(messages)).toThrow("CODEX_RESPONSES_CODEC_INVALID");
    const extra = [1] as number[] & { hidden?: string };
    extra.hidden = "dropped";
    expect(() => encode([{ role: "assistant", content: "", toolCalls: [{ ...call, arguments: { extra } }] }, tool]))
      .toThrow("CODEX_RESPONSES_CODEC_INVALID");
  });
});
