import { describe, expect, it } from "vitest";
import { contextWindowUsageFromNotification, formatTokenCount, presentContextWindowUsage } from "./context-window";

describe("context window telemetry contract", () => {
  it("uses last usage as the current context signal and never the cumulative thread total", () => {
    expect(contextWindowUsageFromNotification({
      threadId: "thread-1",
      turnId: "turn-7",
      tokenUsage: {
        total: { totalTokens: 51_200_000 },
        last: { totalTokens: 140_000 },
        modelContextWindow: 1_000_000,
      },
    })).toEqual({ turnId: "turn-7", usedTokens: 140_000, contextWindowTokens: 1_000_000 });
  });

  it("keeps absent, null, unsafe, and invalid values unavailable instead of inventing numbers", () => {
    expect(contextWindowUsageFromNotification({ turnId: "turn-1", tokenUsage: { last: {}, modelContextWindow: null } }))
      .toEqual({ turnId: "turn-1", usedTokens: null, contextWindowTokens: null });
    expect(contextWindowUsageFromNotification({ turnId: "turn-2", tokenUsage: { last: { totalTokens: -1 }, modelContextWindow: 0 } }))
      .toEqual({ turnId: "turn-2", usedTokens: null, contextWindowTokens: null });
    expect(contextWindowUsageFromNotification({ turnId: "turn-3", tokenUsage: { last: { totalTokens: Number.MAX_VALUE }, modelContextWindow: Infinity } }))
      .toEqual({ turnId: "turn-3", usedTokens: null, contextWindowTokens: null });
    expect(contextWindowUsageFromNotification({ tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 } })).toBeNull();
  });

  it("clamps only the visual meter while reporting overflow honestly", () => {
    expect(presentContextWindowUsage({ turnId: "turn-1", usedTokens: 125_000, contextWindowTokens: 100_000 }))
      .toMatchObject({ available: true, percentageLabel: "125%", percentage: 125, visualPercentage: 100, tone: "overflow" });
  });

  it("does not calculate a percentage without both reported values", () => {
    expect(presentContextWindowUsage({ turnId: "turn-1", usedTokens: 42_000, contextWindowTokens: null }))
      .toEqual({
        available: false,
        usedLabel: "42k",
        totalLabel: "Unavailable",
        percentageLabel: "Unavailable",
        percentage: null,
        visualPercentage: 0,
        tone: "unavailable",
      });
  });

  it("formats compact token counts without implying extra precision", () => {
    expect(formatTokenCount(140_000)).toBe("140k");
    expect(formatTokenCount(12_400)).toBe("12.4k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
  });
});
