import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "../shared/contracts";
import { appendAttachmentsToDraft, boundedAttachments, MAX_COMPOSER_ATTACHMENTS, previewMap, retainPreviewPayloadsForDraft } from "./attachment-state";

function attachment(index: number, previewUrl: string | null = null): ComposerAttachment {
  return {
    id: `attachment-${index}`,
    path: `/tmp/attachment-${index}.png`,
    name: `attachment-${index}.png`,
    kind: "image",
    mimeType: "image/png",
    size: 10,
    previewUrl,
  };
}

describe("desktop composer attachment state", () => {
  it("deduplicates across picker batches and caps the visible aggregate", () => {
    const firstBatch = Array.from({ length: 20 }, (_, index) => attachment(index));
    const secondBatch = Array.from({ length: 20 }, (_, index) => attachment(index + 15));

    const result = boundedAttachments(firstBatch, secondBatch);

    expect(result.overflow).toBe(true);
    expect(result.attachments).toHaveLength(MAX_COMPOSER_ATTACHMENTS);
    expect(new Set(result.attachments.map((item) => item.path)).size).toBe(MAX_COMPOSER_ATTACHMENTS);
    expect(result.attachments.at(-1)?.path).toBe("/tmp/attachment-31.png");
  });

  it("records an overflow notice from the latest functional draft state", () => {
    const firstBatch = Array.from({ length: 20 }, (_, index) => attachment(index));
    const secondBatch = Array.from({ length: 20 }, (_, index) => attachment(index + 20));
    const first = appendAttachmentsToDraft({ text: "", attachments: [] }, firstBatch);

    const second = appendAttachmentsToDraft(first, secondBatch);

    expect(second.attachments).toHaveLength(MAX_COMPOSER_ATTACHMENTS);
    expect(second.attachmentLimitExceeded).toBe(true);
  });

  it("drops preview payloads beyond the renderer cache budget without dropping attachments", () => {
    const result = boundedAttachments([], [attachment(1, "123456"), attachment(2, "abcdef")], 8);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].previewUrl).toBe("123456");
    expect(result.attachments[1].previewUrl).toBeNull();
    expect(previewMap(result.attachments)).toEqual({ "/tmp/attachment-1.png": "123456" });
  });

  it("retains preview payloads only for the active session draft", () => {
    const drafts = {
      active: { text: "active", attachments: [attachment(1, "active-preview")] },
      inactive: { text: "inactive", attachments: [attachment(2, "inactive-preview")] },
    };

    const result = retainPreviewPayloadsForDraft(drafts, "active");

    expect(result.active.attachments[0].previewUrl).toBe("active-preview");
    expect(result.inactive.attachments[0].previewUrl).toBeNull();
    expect(result.inactive.text).toBe("inactive");
  });
});
