import { describe, expect, it } from "vitest";
import { IPC, selectedAttachmentPaths, type OrchestrionDesktopApi } from "./contracts";

describe("local attachment selection contract", () => {
  it("exposes a dedicated renderer-safe IPC method", () => {
    const method: keyof OrchestrionDesktopApi = "chooseAttachments";
    const dropMethod: keyof OrchestrionDesktopApi = "resolveDroppedAttachments";
    const previewMethod: keyof OrchestrionDesktopApi = "loadAttachmentPreviews";

    expect(method).toBe("chooseAttachments");
    expect(dropMethod).toBe("resolveDroppedAttachments");
    expect(previewMethod).toBe("loadAttachmentPreviews");
    expect(IPC.chooseAttachments).toBe("orchestrion:choose-attachments");
    expect(IPC.describeDroppedAttachments).toBe("orchestrion:describe-dropped-attachments");
    expect(IPC.loadAttachmentPreviews).toBe("orchestrion:load-attachment-previews");
  });

  it("returns no paths when the user cancels", () => {
    expect(selectedAttachmentPaths({
      canceled: true,
      filePaths: ["/tmp/not-selected.txt"],
    })).toEqual([]);
  });

  it("returns every explicitly selected local path without reading file contents", () => {
    const filePaths = ["/tmp/brief.pdf", "/tmp/data.csv"];

    expect(selectedAttachmentPaths({ canceled: false, filePaths })).toEqual(filePaths);
  });
});
