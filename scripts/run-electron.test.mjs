import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchElectron, resolveElectronExecutable } from "./run-electron.mjs";

async function fakeElectronPackage({ version = "38.8.6", packagedPath = "Electron", executable = "file" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "orchestrion-electron-launcher-"));
  const packageDirectory = join(root, "electron");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ version }));
  if (packagedPath !== null) await writeFile(join(packageDirectory, "path.txt"), `${packagedPath}\n`);
  if (executable === "file") {
    await writeFile(join(packageDirectory, "dist", "Electron"), "binary", { mode: 0o700 });
  } else if (executable === "directory") {
    await mkdir(join(packageDirectory, "dist", "Electron"));
  }
  return {
    root,
    packageDirectory,
    require: { resolve: () => join(packageDirectory, "package.json") },
  };
}

describe("run-electron", () => {
  it("trims and validates the installed pinned executable", async () => {
    const fixture = await fakeElectronPackage();
    await expect(resolveElectronExecutable(fixture.require)).resolves.toBe(
      await realpath(join(fixture.packageDirectory, "dist", "Electron")),
    );
  });

  it("rejects version drift and malicious absolute or escaping metadata", async () => {
    const wrongVersion = await fakeElectronPackage({ version: "38.8.7" });
    await expect(resolveElectronExecutable(wrongVersion.require)).rejects.toThrow("Expected Electron 38.8.6");

    const absolutePath = await fakeElectronPackage({ packagedPath: "/tmp/electron" });
    await expect(resolveElectronExecutable(absolutePath.require)).rejects.toThrow("Electron package path is invalid");

    const escapingPath = await fakeElectronPackage({ packagedPath: "../outside" });
    await expect(resolveElectronExecutable(escapingPath.require)).rejects.toThrow("escapes its package distribution");
  });

  it("rejects symlink escape, missing metadata, missing executable, and a non-file executable", async () => {
    const escaping = await fakeElectronPackage({ executable: "missing" });
    const outside = join(escaping.root, "outside-electron");
    await writeFile(outside, "binary", { mode: 0o700 });
    await symlink(outside, join(escaping.packageDirectory, "dist", "Electron"));
    await expect(resolveElectronExecutable(escaping.require)).rejects.toThrow("resolves outside its package distribution");

    const missingMetadata = await fakeElectronPackage({ packagedPath: null });
    await expect(resolveElectronExecutable(missingMetadata.require)).rejects.toThrow(
      'Run "pnpm install --frozen-lockfile" with lifecycle scripts enabled',
    );

    const missingExecutable = await fakeElectronPackage({ executable: "missing" });
    await expect(resolveElectronExecutable(missingExecutable.require)).rejects.toThrow("Electron 38.8.6 is incomplete");

    const nonFile = await fakeElectronPackage({ executable: "directory" });
    await expect(resolveElectronExecutable(nonFile.require)).rejects.toThrow("Electron 38.8.6 is incomplete");

    await expect(
      resolveElectronExecutable({
        resolve: () => {
          throw Object.assign(new Error("missing package"), { code: "MODULE_NOT_FOUND" });
        },
      }),
    ).rejects.toThrow('Run "pnpm install --frozen-lockfile" with lifecycle scripts enabled');
  });

  it("spawns the exact executable and argv without a shell and returns success", async () => {
    const child = new EventEmitter();
    const env = { PATH: "/bin" };
    const spawnChild = vi.fn(() => child);
    const resultPromise = launchElectron({
      executable: "/verified/electron",
      args: ["smoke.mjs", "--flag"],
      env,
      spawnChild,
    });
    child.emit("exit", 0, null);

    await expect(resultPromise).resolves.toEqual({ code: 0, signal: null });
    expect(spawnChild).toHaveBeenCalledWith("/verified/electron", ["smoke.mjs", "--flag"], {
      stdio: "inherit",
      env,
      shell: false,
    });
  });

  it("propagates asynchronous and synchronous spawn failures", async () => {
    const child = new EventEmitter();
    const asynchronous = launchElectron({ executable: "/verified/electron", args: [], spawnChild: () => child });
    child.emit("error", new Error("async spawn failure"));
    await expect(asynchronous).rejects.toThrow("async spawn failure");

    await expect(
      launchElectron({
        executable: "/verified/electron",
        args: [],
        spawnChild: () => {
          throw new Error("sync spawn failure");
        },
      }),
    ).rejects.toThrow("sync spawn failure");
  });

  it("preserves a nonzero child exit", async () => {
    const child = new EventEmitter();
    const resultPromise = launchElectron({ executable: "/verified/electron", args: [], spawnChild: () => child });
    child.emit("exit", 7, null);
    await expect(resultPromise).resolves.toEqual({ code: 7, signal: null });
  });
});
