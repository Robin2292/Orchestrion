import { describe, expect, it } from "vitest";
import { IPC } from "../../shared/contracts";
import { validateRequest } from "./requests";

describe("desktop model-setting request contracts", () => {
  it("accepts the live service tier on session start and settings updates", () => {
    expect(validateRequest(IPC.startSession, {
      agentId: "agent-1",
      text: "Start",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: "priority",
    })).toBe(true);
    expect(validateRequest(IPC.updateSessionSettings, {
      sessionId: "session-1",
      model: "gpt-5.6-sol",
      modelProvider: null,
      reasoningEffort: "medium",
      serviceTier: null,
    })).toBe(true);
  });

  it("keeps model-setting requests strict", () => {
    expect(validateRequest(IPC.updateSessionSettings, {
      sessionId: "session-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: "priority",
      contextWindow: 900_000,
    })).toBe(false);
  });
});
