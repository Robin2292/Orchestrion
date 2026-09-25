import { describe, expect, it, vi } from "vitest";
import { CodexResponsesText } from "./codex-responses-text";

const request = { token: "SYNTHETIC_TOKEN", accountId: "synthetic-account", model: "gpt-6-luna",
  messages: [{ role: "system" as const, content: "Answer briefly." },
    { role: "user" as const, content: "First" }, { role: "assistant" as const, content: "Earlier" },
    { role: "user" as const, content: "Again" }] };
const usage = { input_tokens: 42, output_tokens: 3 };
const sse = (events: unknown[], contentType = "application/json") => new Response(
  events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""),
  { status: 200, headers: { "content-type": contentType } });

describe("host Codex Responses text transport", () => {
  it("preserves canonical turns and accepts bounded completed SSE despite MIME", async () => {
    const send = vi.fn(async () => sse([
      { type: "response.output_text.delta", delta: "Yes" },
      { type: "response.completed", response: { status: "completed", output: [], usage } },
    ]));
    await expect(new CodexResponsesText(send as typeof fetch).complete(request,
      new AbortController().signal)).resolves.toEqual({ text: "Yes",
      usage: { inputTokens: 42, outputTokens: 3 } });
    const [url, options] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({ Authorization: "Bearer SYNTHETIC_TOKEN",
      "chatgpt-account-id": "synthetic-account" });
    const body = JSON.parse(String(options.body));
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).toMatchObject({ model: "gpt-6-luna", store: false,
      instructions: "Answer briefly.", input: [
        { role: "user", content: [{ type: "input_text", text: "First" }] },
        { role: "assistant", content: [{ type: "output_text", text: "Earlier" }] },
        { role: "user", content: [{ type: "input_text", text: "Again" }] },
      ] });
  });

  it("requires terminal usage and rejects tools, incomplete output and provider bodies", async () => {
    const missingUsage = new CodexResponsesText(vi.fn(async () => sse([
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ])) as typeof fetch);
    await expect(missingUsage.complete(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR" });
    const tool = new CodexResponsesText(vi.fn(async () => sse([
      { type: "response.output_item.added", item: { type: "function_call" } },
    ])) as typeof fetch);
    await expect(tool.complete(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", stage: "tool_output" });
    const unsupported = new CodexResponsesText(vi.fn(async () => sse([
      { type: "response.completed", response: { status: "completed", usage,
        output: [{ type: "computer_call" },
          { type: "message", content: [{ type: "output_text", text: "unsafe" }] }] } },
    ])) as typeof fetch);
    await expect(unsupported.complete(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", stage: "tool_output" });
    const partial = new CodexResponsesText(vi.fn(async () => sse([
      { type: "response.output_text.delta", delta: "partial" },
    ])) as typeof fetch);
    await expect(partial.complete(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_INCOMPLETE" });
    const denied = new CodexResponsesText(vi.fn(async () => new Response("SYNTHETIC_SECRET", { status: 401 })) as typeof fetch);
    await expect(denied.complete(request, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_AUTH_EXPIRED" });
  });

  it("refuses unsupported models before network and accepts final text without deltas", async () => {
    const send = vi.fn(async () => sse([{ type: "response.completed", response: { status: "completed", usage,
      output: [{ type: "message", content: [{ type: "output_text", text: "Final" }] }] } }]));
    const transport = new CodexResponsesText(send as typeof fetch);
    await expect(transport.complete({ ...request, model: "gpt-5.4" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_NOT_READY" });
    expect(send).not.toHaveBeenCalled();
    await expect(transport.complete(request, new AbortController().signal))
      .resolves.toMatchObject({ text: "Final" });
  });
});
