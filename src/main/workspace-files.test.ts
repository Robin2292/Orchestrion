import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TEXT_FILE_LIMIT } from "../shared/contracts";
import { listProjectDirectory, nodeWorkspaceFileSystem, readProjectFile, saveProjectTextFile } from "./workspace-files";

const temporaryPaths: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `orchestrion-${label}-`));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace directory listing", () => {
  it("lists dotfiles and directories deterministically without reading contents", async () => {
    const root = await temporaryDirectory("workspace-files");
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".env"), "SECRET=not-returned");
    await writeFile(join(root, "readme.md"), "hello");

    await expect(listProjectDirectory(root, "")).resolves.toEqual({
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory", symbolicLink: false, accessible: true },
        { name: ".env", path: ".env", kind: "file", symbolicLink: false, accessible: true },
        { name: "readme.md", path: "readme.md", kind: "file", symbolicLink: false, accessible: true },
      ],
      truncated: false,
    });
    expect(JSON.stringify(await listProjectDirectory(root, ""))).not.toContain("SECRET");
  });

  it("bounds each response and reports truncation", async () => {
    const root = await temporaryDirectory("workspace-limit");
    await Promise.all(["a", "b", "c"].map((name) => writeFile(join(root, name), name)));
    const listing = await listProjectDirectory(root, "", { entryLimit: 2 });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(listing.truncated).toBe(true);
  });

  it("rejects traversal, absolute paths, missing paths, and files as directories", async () => {
    const root = await temporaryDirectory("workspace-reject");
    await writeFile(join(root, "file.txt"), "hello");

    await expect(listProjectDirectory(root, "../outside")).rejects.toThrow("escapes the project root");
    await expect(listProjectDirectory(root, "/tmp")).rejects.toThrow("must be relative");
    await expect(listProjectDirectory(root, "C:\\outside")).rejects.toThrow("must be relative");
    await expect(listProjectDirectory(root, "missing")).rejects.toThrow("does not exist");
    await expect(listProjectDirectory(root, "file.txt")).rejects.toThrow("not a directory");
  });

  it("allows contained links while rejecting directory and file symlink escapes", async () => {
    const root = await temporaryDirectory("workspace-links");
    const outside = await temporaryDirectory("workspace-outside");
    await mkdir(join(root, "inside"));
    await writeFile(join(root, "inside", "safe.txt"), "safe");
    await mkdir(join(outside, "private"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(root, "inside"), join(root, "inside-link"));

    const listing = await listProjectDirectory(root, "");
    expect(listing.entries.find((entry) => entry.name === "inside-link")).toMatchObject({ kind: "directory", symbolicLink: true, accessible: true });
    await expect(listProjectDirectory(root, "inside-link")).resolves.toMatchObject({ path: "inside-link" });

    await symlink(join(outside, "private"), join(root, "outside-directory"));
    await symlink(join(outside, "secret.txt"), join(root, "outside-file"));
    await expect(listProjectDirectory(root, "")).rejects.toThrow("entry resolves outside the project root");
    await expect(listProjectDirectory(root, "outside-directory")).rejects.toThrow("outside the project root");
    await expect(listProjectDirectory(root, "outside-file")).rejects.toThrow("outside the project root");
  });

  it("rejects a listing when the target directory is replaced during enumeration", async () => {
    const root = await temporaryDirectory("workspace-target-race");
    const outside = await temporaryDirectory("workspace-target-race-outside");
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "safe.txt"), "safe");
    await writeFile(join(outside, "secret.txt"), "secret");
    let replacementPerformed = false;
    const fileSystem = {
      ...nodeWorkspaceFileSystem,
      async readDirectory(path: string) {
        await rename(path, `${path}-original`);
        await symlink(outside, path);
        replacementPerformed = true;
        return nodeWorkspaceFileSystem.readDirectory(path);
      },
    };

    await expect(listProjectDirectory(root, "target", { fileSystem })).rejects.toThrow("changed while it was being read");
    expect(replacementPerformed).toBe(true);
  });

  it("revalidates ordinary children and rejects one replaced with an escaping link", async () => {
    const root = await temporaryDirectory("workspace-child-race");
    const outside = await temporaryDirectory("workspace-child-race-outside");
    const child = join(root, "safe.txt");
    await writeFile(child, "safe");
    await writeFile(join(outside, "secret.txt"), "secret");
    const fileSystem = {
      ...nodeWorkspaceFileSystem,
      async readDirectory(path: string) {
        const entries = await nodeWorkspaceFileSystem.readDirectory(path);
        await rename(child, join(root, "safe-original.txt"));
        await symlink(join(outside, "secret.txt"), child);
        return entries;
      },
    };

    await expect(listProjectDirectory(root, "", { fileSystem })).rejects.toThrow("entry resolves outside the project root");
  });
});

describe("workspace file read and save", () => {
  it("returns editable UTF-8 text with a revision and bounded media data URLs", async () => {
    const root = await temporaryDirectory("workspace-read");
    await writeFile(join(root, "notes.md"), "# Hello\n");
    await writeFile(join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(readProjectFile(root, "notes.md")).resolves.toMatchObject({
      status: "ready",
      path: "notes.md",
      kind: "text",
      mimeType: "text/markdown",
      editable: true,
      content: { type: "text", text: "# Hello\n" },
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await expect(readProjectFile(root, "pixel.png")).resolves.toMatchObject({
      status: "ready",
      kind: "image",
      editable: false,
      content: { type: "data-url", dataUrl: "data:image/png;base64,iVBORw==" },
    });
  });

  it("returns typed unsupported and too-large fallbacks without reading unbounded content", async () => {
    const root = await temporaryDirectory("workspace-bounds");
    await writeFile(join(root, "archive.zip"), "not really a zip");
    await writeFile(join(root, "large.txt"), Buffer.alloc(WORKSPACE_TEXT_FILE_LIMIT + 1, 0x61));
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff, 0xfe]));

    await expect(readProjectFile(root, "archive.zip")).resolves.toMatchObject({ status: "unsupported", kind: "unsupported" });
    await expect(readProjectFile(root, "large.txt")).resolves.toMatchObject({
      status: "too-large",
      kind: "text",
      maxBytes: WORKSPACE_TEXT_FILE_LIMIT,
    });
    await expect(readProjectFile(root, "invalid.txt")).resolves.toMatchObject({
      status: "unsupported",
      kind: "unsupported",
      editable: false,
    });
  });

  it("atomically saves supported text, preserves mode, and refuses stale revisions", async () => {
    const root = await temporaryDirectory("workspace-save");
    const path = join(root, "script.sh");
    await writeFile(path, "echo old\n");
    await chmod(path, 0o766);
    const opened = await readProjectFile(root, "script.sh");
    if (opened.status !== "ready") throw new Error("fixture did not open");

    const saved = await saveProjectTextFile(root, "script.sh", "echo new\n", opened.revision);
    expect(await readFile(path, "utf8")).toBe("echo new\n");
    expect((await stat(path)).mode & 0o777).toBe(0o766);
    expect(saved).toMatchObject({ path: "script.sh", size: 9, revision: expect.stringMatching(/^sha256:/) });

    await writeFile(path, "external change\n");
    await expect(saveProjectTextFile(root, "script.sh", "overwrite\n", saved.revision)).rejects.toThrow("changed since it was opened");
    expect(await readFile(path, "utf8")).toBe("external change\n");
  });

  it("serializes same-path saves so only one caller can consume a revision", async () => {
    const root = await temporaryDirectory("workspace-save-lock");
    await writeFile(join(root, "state.json"), "{}\n");
    const opened = await readProjectFile(root, "state.json");
    if (opened.status !== "ready") throw new Error("fixture did not open");

    const results = await Promise.allSettled([
      saveProjectTextFile(root, "state.json", "{\"writer\":1}\n", opened.revision),
      saveProjectTextFile(root, "state.json", "{\"writer\":2}\n", opened.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects traversal, symlink escapes, symlink saves, and non-text saves", async () => {
    const root = await temporaryDirectory("workspace-file-reject");
    const outside = await temporaryDirectory("workspace-file-outside");
    await writeFile(join(root, "safe.txt"), "safe");
    await writeFile(join(root, "image.png"), "image");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    await symlink(join(root, "safe.txt"), join(root, "safe-link.txt"));
    const opened = await readProjectFile(root, "safe.txt");
    if (opened.status !== "ready") throw new Error("fixture did not open");

    await expect(readProjectFile(root, "../secret.txt")).rejects.toThrow("escapes the project root");
    await expect(readProjectFile(root, "escape.txt")).rejects.toThrow("outside the project root");
    await expect(saveProjectTextFile(root, "safe-link.txt", "new", opened.revision)).rejects.toThrow("do not follow symbolic links");
    await expect(saveProjectTextFile(root, "image.png", "new", opened.revision)).rejects.toThrow("Only supported text");
  });
});
