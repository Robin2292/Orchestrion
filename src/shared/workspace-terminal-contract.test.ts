import { describe, expect, it } from "vitest";
import {
  IPC,
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_MAX_COLUMNS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLUMNS,
  TERMINAL_MIN_ROWS,
  type CreateTerminalInput,
  type OrchestrionDesktopApi,
  type TerminalEvent,
} from "./contracts";

describe("workspace terminal contract", () => {
  it("exposes a session-scoped bridge without accepting a cwd or shell", () => {
    const methods: Array<keyof OrchestrionDesktopApi> = [
      "createTerminal",
      "sendTerminalInput",
      "acknowledgeTerminalOutput",
      "resizeTerminal",
      "closeTerminal",
      "closeSessionTerminals",
      "onTerminalEvent",
    ];
    const input: CreateTerminalInput = { sessionId: "session-1", columns: 80, rows: 24 };
    const output: TerminalEvent = { type: "output", terminalId: "terminal-1", sessionId: "session-1", sequence: 1, data: "ready" };

    expect(methods).toHaveLength(7);
    expect(input).not.toHaveProperty("cwd");
    expect(input).not.toHaveProperty("shell");
    expect(output.sessionId).toBe("session-1");
    expect(IPC.createTerminal).toBe("orchestrion:create-terminal");
    expect(IPC.terminalEvent).toBe("orchestrion:terminal-event");
    expect(IPC.acknowledgeTerminalOutput).toBe("orchestrion:acknowledge-terminal-output");
    expect(IPC.closeSessionTerminals).toBe("orchestrion:close-session-terminals");
  });

  it("publishes explicit dimensions, input, and buffering bounds", () => {
    expect([TERMINAL_MIN_COLUMNS, TERMINAL_MAX_COLUMNS]).toEqual([2, 500]);
    expect([TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS]).toEqual([1, 300]);
    expect(TERMINAL_MAX_INPUT_BYTES).toBe(32 * 1024);
    expect(TERMINAL_MAX_BUFFERED_OUTPUT_BYTES).toBe(256 * 1024);
  });
});
