import { describe, expect, it } from "vitest";
import {
  activityFromItem,
  appendActivityOutput,
  safeDisplay,
} from "./activity-presentation";

describe("activity presentation", () => {
  it("projects only the public reasoning summary and drops private reasoning content", () => {
    const activity = activityFromItem({
      type: "reasoning",
      summary: [{ text: "I checked the contract and selected the bounded path." }],
      content: [{ text: "private chain of thought must never cross the bridge" }],
      status: "completed",
    }, true);

    expect(activity).toMatchObject({
      kind: "reasoning",
      status: "completed",
      result: "I checked the contract and selected the bounded path.",
    });
    expect(JSON.stringify(activity)).not.toContain("private chain of thought");
  });

  it("redacts sensitive arguments and bounds streamed output", () => {
    const activity = activityFromItem({
      type: "mcpToolCall",
      server: "deploy",
      tool: "inspect",
      arguments: { api_key: "should-not-render", nested: { token: "also-private" }, region: "local" },
      result: { authorization: "Bearer abcdefghijklmnop", ok: true },
      status: "completed",
    }, true)!;

    expect(activity.arguments).toContain('"api_key": "[redacted]"');
    expect(activity.arguments).toContain('"region": "local"');
    expect(activity.arguments).not.toContain("should-not-render");
    expect(activity.result).not.toContain("abcdefghijklmnop");

    const streamed = appendActivityOutput(activity, "x".repeat(30_000));
    expect(streamed.result?.length).toBeLessThan(25_000);
    expect(streamed.result).toContain("output truncated for display");
  });

  it("uses dedicated sub-agent and compaction projections", () => {
    expect(activityFromItem({ type: "collabToolCall", tool: "spawn_agent", newThreadId: "task-7", agentStatus: "running" }, false))
      .toMatchObject({ kind: "subagent", label: "Started a sub-agent", status: "running" });
    expect(activityFromItem({ type: "contextCompaction", status: "completed" }, true))
      .toMatchObject({ kind: "compaction", label: "Compacted context", status: "completed" });
    expect(safeDisplay("Authorization: Bearer very-secret-token")).not.toContain("very-secret-token");
  });
});
