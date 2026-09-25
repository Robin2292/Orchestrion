import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeAttachments, recentUniquePaths } from "./attachments";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local attachment descriptions", () => {
  it("selects recent unique paths by their last occurrence", () => {
    expect(recentUniquePaths(["/a.png", "/b.png", "/c.png", "/a.png"], 2)).toEqual(["/c.png", "/a.png"]);
  });

  it("classifies files and folders and creates renderer-safe image previews", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-attachments-"));
    temporaryDirectories.push(root);
    const imagePath = join(root, "reference.png");
    const filePath = join(root, "brief.pdf");
    const folderPath = join(root, "materials");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(filePath, "brief");
    await mkdir(folderPath);

    const result = await describeAttachments([imagePath, filePath, folderPath, imagePath, "relative.txt"]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ path: imagePath, name: "reference.png", kind: "image", mimeType: "image/png", size: 8 });
    expect(result[0].previewUrl).toMatch(/^data:image\/png;base64,/);
    expect(result[1]).toMatchObject({ path: filePath, name: "brief.pdf", kind: "file", previewUrl: null });
    expect(result[2]).toMatchObject({ path: folderPath, name: "materials", kind: "folder", size: null, previewUrl: null });
  });

  it("ignores missing and unsupported filesystem objects instead of breaking the whole drop", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-attachments-"));
    temporaryDirectories.push(root);
    const validPath = join(root, "notes.txt");
    await writeFile(validPath, "notes");

    await expect(describeAttachments([join(root, "missing.png"), validPath])).resolves.toMatchObject([{ path: validPath, kind: "file" }]);
  });

  it("keeps oversized images attachable without copying them into renderer preview memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrion-attachments-"));
    temporaryDirectories.push(root);
    const imagePath = join(root, "large.png");
    await writeFile(imagePath, Buffer.alloc(4 * 1024 * 1024 + 1));

    await expect(describeAttachments([imagePath])).resolves.toMatchObject([{
      path: imagePath,
      kind: "image",
      previewUrl: null,
    }]);
  });
});
