import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextWindowIndicator } from "./ContextWindowIndicator";

describe("ContextWindowIndicator", () => {
  it("renders reported usage and keeps breakdown explicitly unavailable", () => {
    const markup = renderToStaticMarkup(<ContextWindowIndicator
      usage={{ turnId: "turn-1", usedTokens: 140_000, contextWindowTokens: 1_000_000 }}
      open
      onOpenChange={() => undefined}
    />);

    expect(markup).toContain("Context window");
    expect(markup).toContain("140k / 1M (14%)");
    expect(markup).toContain("Context window breakdown coming soon");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-valuenow="14"');
    expect(markup).toContain('aria-controls="context-window-popover"');
    expect(markup).toContain('role="region"');
    expect(markup).not.toContain('role="dialog"');
  });

  it("renders an honest waiting state without a fake percentage", () => {
    const markup = renderToStaticMarkup(<ContextWindowIndicator usage={null} open onOpenChange={() => undefined} />);

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Waiting for context telemetry from the local Codex runtime.");
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).not.toContain("NaN");
  });
});
