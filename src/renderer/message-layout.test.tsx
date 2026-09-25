import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "./App";
import type { ConversationMessage } from "../shared/contracts";

const baseMessage: ConversationMessage = {
  id: "message-1",
  sessionId: "session-1",
  role: "user",
  text: "Keep this response aligned with the workspace.",
  phase: "final_answer",
  createdAt: "2026-09-13T07:05:00.000Z",
};

describe("message layout", () => {
  it("places the user content before its avatar for right-aligned presentation", () => {
    const markup = renderToStaticMarkup(<MessageBubble message={baseMessage} previewUrls={{}} />);

    expect(markup).toContain('class="message message-user"');
    expect(markup).toContain('data-message-role="user"');
    expect(markup.indexOf('class="message-content"')).toBeLessThan(markup.indexOf('class="message-avatar user-avatar"'));
  });

  it("keeps assistant avatar before content and preserves streaming markup", () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        message={{ ...baseMessage, id: "message-2", role: "assistant", text: "A longer streamed reply", streaming: true }}
        previewUrls={{}}
      />,
    );

    expect(markup).toContain('class="message message-assistant"');
    expect(markup).toContain('data-message-role="assistant"');
    expect(markup.indexOf('class="message-avatar assistant-avatar"')).toBeLessThan(markup.indexOf('class="message-content"'));
    expect(markup).toContain('class="stream-caret"');
    expect(markup).not.toContain('class="phase-label"');
    expect(markup).not.toContain('aria-label="Copy final response"');
  });

  it("removes phase badges and places copy beneath completed final assistant responses", () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        message={{ ...baseMessage, id: "message-3", role: "assistant", text: "The work is complete.", streaming: false }}
        previewUrls={{}}
      />,
    );

    expect(markup).not.toContain('class="phase-label"');
    expect(markup.indexOf('class="message-text"')).toBeLessThan(markup.indexOf('class="message-final-actions"'));
    expect(markup).toContain('aria-label="Copy final response"');
  });
});
