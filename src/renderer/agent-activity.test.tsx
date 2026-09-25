// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../shared/contracts";
import { ActivityCard, ConversationTimeline, ThinkingRow, shouldFollowLiveOutput } from "./App";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write(_data: string, callback?: () => void) { callback?.(); }
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createdAt = "2026-09-18T07:00:00.000Z";
const message = (partial: Partial<ConversationMessage> & Pick<ConversationMessage, "id">): ConversationMessage => ({
  sessionId: "session-1",
  turnId: "turn-1",
  role: "system",
  text: "",
  phase: null,
  createdAt,
  ...partial,
});

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("agent activity timeline", () => {
  it("collapses completed work into one capsule while keeping the final answer visible", () => {
    const messages = [
      message({ id: "reason", activity: { kind: "reasoning", label: "Reasoning summary", status: "completed", result: "Public summary" } }),
      message({ id: "tool", activity: { kind: "tool", label: "repo / search", status: "completed", arguments: "query", result: "result" } }),
      message({ id: "final", role: "assistant", phase: "final_answer", text: "The work is complete.", createdAt: "2026-09-18T07:01:08.000Z" }),
    ];
    const markup = renderToStaticMarkup(<ConversationTimeline messages={messages} previewUrls={{}} />);

    expect(markup).toContain("Worked for 1m 8s");
    expect(markup).toContain("The work is complete.");
    expect(markup).not.toContain("Public summary");
    expect(markup).not.toContain("activity-detail-viewport");
  });

  it("expands one tool independently into a fixed scrolling detail viewport", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const tool = message({ id: "tool", activity: { kind: "tool", label: "filesystem / read", status: "completed", arguments: "{\n  \"path\": \"README.md\"\n}", result: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") } });
    await act(async () => root?.render(<ActivityCard message={tool} />));

    const toggle = container.querySelector<HTMLButtonElement>(".activity-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".activity-detail-viewport")?.textContent).toContain("line 30");
  });

  it("keeps consecutive tool calls as separate inspectable items", () => {
    const markup = renderToStaticMarkup(<ConversationTimeline messages={[
      message({ id: "tool-a", activity: { kind: "tool", label: "repo / search", status: "completed", result: "first" } }),
      message({ id: "tool-b", activity: { kind: "tool", label: "shell / run", status: "running", arguments: "pnpm test" } }),
    ]} previewUrls={{}} />);
    expect(markup.match(/class="activity-card activity-tool"/g)).toHaveLength(2);
    expect(markup).not.toContain("activity-burst");
  });

  it("renders the final answer as GitHub-flavored markdown instead of raw syntax", () => {
    const markup = renderToStaticMarkup(<ConversationTimeline messages={[
      message({ id: "final", role: "assistant", phase: "final_answer", text: "## Result\n\n**Ready**\n\n| Item | State |\n| --- | --- |\n| UI | Done |" }),
    ]} previewUrls={{}} />);
    expect(markup).toContain("<h2>Result</h2>");
    expect(markup).toContain("<strong>Ready</strong>");
    expect(markup).toContain("<table>");
    expect(markup).not.toContain("## Result");
  });

  it("copies a tool result from its compact header control", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<ActivityCard message={message({ id: "tool-copy", activity: { kind: "tool", label: "filesystem / read", status: "completed", result: "copy me" } })} />));
    await act(async () => container.querySelector<HTMLButtonElement>(".activity-toggle")!.click());
    const copy = container.querySelector<HTMLButtonElement>(".activity-result-copy")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy result");
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(copy.textContent).toContain("Copied");
  });

  it("only follows live output while the reader remains near the bottom", () => {
    expect(shouldFollowLiveOutput({ scrollTop: 700, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
    expect(shouldFollowLiveOutput({ scrollTop: 620, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
    expect(shouldFollowLiveOutput({ scrollTop: 630, clientHeight: 300, scrollHeight: 1000 }, 80)).toBe(true);
  });

  it("renders distinct sub-agent, compaction, and custom thinking visuals", () => {
    const subagent = renderToStaticMarkup(<ActivityCard message={message({ id: "sub", activity: { kind: "subagent", label: "Started a sub-agent", status: "running" } })} />);
    const compaction = renderToStaticMarkup(<ActivityCard message={message({ id: "compact", activity: { kind: "compaction", label: "Compacted context", status: "running" } })} />);
    const thinking = renderToStaticMarkup(<ThinkingRow />);
    expect(subagent).toContain('data-activity-kind="subagent"');
    expect(compaction).toContain("memory-fold running");
    expect(thinking).toContain("thinking-mark");
    expect(thinking).toContain("Agent is thinking");
  });
});
