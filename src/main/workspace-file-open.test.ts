import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProjectFile, type WorkspaceFileLaunchAdapter } from "./workspace-file-open";

const temporaryPaths: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `orchestrion-${label}-`));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function launcher() {
  const openSystem = vi.fn(async () => "");
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn(() => child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return { adapter: { openSystem, spawn } satisfies WorkspaceFileLaunchAdapter, openSystem, spawn };
}

describe("workspace file external open", () => {
  it("passes a validated canonical path as a literal argument without a shell", async () => {
    const root = await temporaryDirectory("workspace-open");
    const suspiciousName = "$(touch injected);notes.txt";
    await writeFile(join(root, suspiciousName), "safe");
    const fake = launcher();
    const canonicalRoot = await realpath(root);

    await openProjectFile(root, suspiciousName, "vscode", { launcher: fake.adapter, platform: "darwin" });
    expect(fake.spawn).toHaveBeenCalledWith("/usr/bin/open", ["-a", "Visual Studio Code", "--", join(canonicalRoot, suspiciousName)]);
  });

  it("supports system default and Cursor as reusable destinations", async () => {
    const root = await temporaryDirectory("workspace-open-destinations");
    await writeFile(join(root, "notes.txt"), "safe");
    const fake = launcher();
    const canonicalRoot = await realpath(root);

    await openProjectFile(root, "notes.txt", "system", { launcher: fake.adapter });
    await openProjectFile(root, "notes.txt", "cursor", { launcher: fake.adapter, platform: "linux" });
    expect(fake.openSystem).toHaveBeenCalledWith(join(canonicalRoot, "notes.txt"));
    expect(fake.spawn).toHaveBeenCalledWith("cursor", ["--", join(canonicalRoot, "notes.txt")]);
  });

  it("revocation during canonical resolution prevents the actual editor launch", async () => {
    const root = await temporaryDirectory("workspace-open-revocation");
    await writeFile(join(root, "notes.txt"), "safe");
    const fake = launcher(); let active = true;
    const pending = openProjectFile(root, "notes.txt", "cursor", {
      launcher: fake.adapter,
      assertActive: () => { if (!active) throw new Error("NOT_AUTHENTICATED"); },
    });
    active = false;
    await expect(pending).rejects.toThrow("NOT_AUTHENTICATED");
    expect(fake.spawn).not.toHaveBeenCalled(); expect(fake.openSystem).not.toHaveBeenCalled();
  });

  it("rejects traversal, escaping symlinks, and unknown destinations before launching", async () => {
    const root = await temporaryDirectory("workspace-open-reject");
    const outside = await temporaryDirectory("workspace-open-outside");
    await writeFile(join(root, "safe.txt"), "safe");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    const fake = launcher();

    await expect(openProjectFile(root, "../secret.txt", "system", { launcher: fake.adapter })).rejects.toThrow("escapes the project root");
    await expect(openProjectFile(root, "escape.txt", "system", { launcher: fake.adapter })).rejects.toThrow("outside the project root");
    await expect(openProjectFile(root, "safe.txt", "preview" as "system", { launcher: fake.adapter })).rejects.toThrow("Unsupported");
    expect(fake.openSystem).not.toHaveBeenCalled();
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
