// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../shared/contracts";
import { MessageBubble } from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write(_data: string, callback?: () => void) { callback?.(); }
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("MessageBubble final response actions", () => {
  it("copies the completed assistant response and confirms the action", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const message: ConversationMessage = {
      id: "final-1",
      sessionId: "session-1",
      role: "assistant",
      text: "Ready for review.",
      phase: "final_answer",
      createdAt: "2026-09-18T10:00:00.000Z",
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<MessageBubble message={message} previewUrls={{}} />));

    const copy = container.querySelector<HTMLButtonElement>('[aria-label="Copy final response"]')!;
    await act(async () => { copy.click(); await Promise.resolve(); });

    expect(writeText).toHaveBeenCalledExactlyOnceWith("Ready for review.");
    expect(container.querySelector('[aria-label="Copied final response"]')?.textContent).toBe("Copied");
  });
});
