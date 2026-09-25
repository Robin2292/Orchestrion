import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedExecutionAuthority } from "./execution-authority";
import { WorkspaceAuthority } from "./workspace-authority";
import { nodeWorkspaceFileSystem, snapshotProjectRoot } from "./workspace-files";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); });
function tree() {
  const root = mkdtempSync(join(tmpdir(), "orclocal-ep1b-authority-")); roots.push(root);
  const project = join(root, "project"), outside = join(root, "outside");
  mkdirSync(join(project, "src", "nested"), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(project, "README.md"), "# hello\n");
  writeFileSync(join(project, "src", "nested", "文件.ts"), "export const x = 1;\n");
  writeFileSync(join(project, ".env"), "SECRET=1\n");
  writeFileSync(join(project, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
  writeFileSync(join(project, "large.txt"), "x".repeat(300 * 1024));
  writeFileSync(join(outside, "leak.txt"), "outside\n");
  symlinkSync(join(project, ".env"), join(project, "innocent.txt"));
  symlinkSync(join(outside, "leak.txt"), join(project, "escape.txt"));
  symlinkSync(join(project, "src"), join(project, "srclink"), "dir");
  writeFileSync(join(project, "plain.txt"), "plain\n");
  symlinkSync(join(project, "plain.txt"), join(project, "src", "alias.txt"));
  // Review revision 5: secrets that no name or extension rule catches.
  writeFileSync(join(project, "deploy_key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(project, "src", "notes.txt"), "# scratch\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n");
  writeFileSync(join(project, "credentials"), "just a note\n");
  writeFileSync(join(project, ".git-credentials"), "just a note\n");
  writeFileSync(join(project, "src", "public_key"), "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n");
  // Review revision 6: credential forms under ordinary names.
  writeFileSync(join(project, "src", "database.yml"), "production:\n  url: postgres://app:s3cr3t@db.internal:5432/app\n");
  writeFileSync(join(project, "src", "token.ts"), "export const token = \"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\";\n");
  writeFileSync(join(project, "src", "client.ts"), "export const base = new URL(\"https://api.example.com:8443/v1\");\n");
  return { root, project, outside };
}
async function authorityFor(projectPath: string, identityPath = projectPath, placement = "local_trusted") {
  const live = await snapshotProjectRoot(identityPath);
  const resolved = {
    placement: { placement, workspace: { kind: "local_folder", path: projectPath } },
    workspace: { kind: "local_folder", canonical_path: live.canonicalPath, dev: live.dev, ino: live.ino },
    project: { id: "p", path: projectPath, canonicalPath: live.canonicalPath },
  } as unknown as ResolvedExecutionAuthority;
  return WorkspaceAuthority.fromExecutionAuthority(resolved);
}

describe("EP1-B WorkspaceAuthority", () => {
  it("reads UTF-8 text inside the bound folder and reports bytes and hash", async () => {
    const t = tree(), a = await authorityFor(t.project);
    const bytes = Buffer.from("# hello\n");
    expect(await a.read("README.md")).toEqual({ ok: true, relativePath: "README.md", text: "# hello\n", bytes: 8, hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
    expect(await a.read("./src/nested/文件.ts")).toMatchObject({ ok: true, relativePath: "src/nested/文件.ts", text: "export const x = 1;\n" });
    expect(a.identity).toEqual({ kind: "local_folder", canonical_path: realpathSync(t.project), dev: expect.any(Number), ino: expect.any(Number) });
  });
  it.each<[string, string]>([
    ["../outside/leak.txt", "FILE_READ_PATH_INVALID"], ["/etc/hosts", "FILE_READ_PATH_INVALID"], ["", "FILE_READ_PATH_INVALID"],
    [".env", "FILE_READ_SENSITIVE_PATH"], ["innocent.txt", "FILE_READ_SYMLINK_REFUSED"], ["escape.txt", "FILE_READ_PATH_INVALID"],
    ["srclink/nested/文件.ts", "FILE_READ_SYMLINK_REFUSED"], ["src/alias.txt", "FILE_READ_SYMLINK_REFUSED"],
    ["missing.md", "FILE_READ_NOT_FOUND"], ["src", "FILE_READ_NOT_A_FILE"], ["large.txt", "FILE_READ_TOO_LARGE"], ["binary.bin", "FILE_READ_NOT_UTF8"],
    ["deploy_key", "FILE_READ_SENSITIVE_PATH"], ["src/notes.txt", "FILE_READ_SENSITIVE_PATH"], ["credentials", "FILE_READ_SENSITIVE_PATH"], [".git-credentials", "FILE_READ_SENSITIVE_PATH"],
  ])("refuses %s with %s and exposes no path", async (path, code) => {
    const t = tree(), a = await authorityFor(t.project);
    const outcome = await a.read(path);
    expect(outcome).toEqual({ ok: false, code });
    expect(JSON.stringify(outcome)).not.toContain(t.root);
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE KEY");
  });
  it("refuses private-key content under a non-sensitive name and still allows plain text and public keys (review P1)", async () => {
    const t = tree(), a = await authorityFor(t.project);
    expect(await a.read("deploy_key")).toEqual({ ok: false, code: "FILE_READ_SENSITIVE_PATH" });
    expect(await a.read("credentials")).toEqual({ ok: false, code: "FILE_READ_SENSITIVE_PATH" });
    expect(await a.read("plain.txt")).toMatchObject({ ok: true, text: "plain\n" });
    expect(await a.read("src/public_key")).toMatchObject({ ok: true, relativePath: "src/public_key" });
  });
  it("refuses token- and password-bearing content under ordinary names and still allows credential-free URLs (review P1)", async () => {
    const t = tree(), a = await authorityFor(t.project);
    for (const path of ["src/database.yml", "src/token.ts"]) {
      const outcome = await a.read(path);
      expect(outcome).toEqual({ ok: false, code: "FILE_READ_SENSITIVE_PATH" });
      expect(JSON.stringify(outcome)).not.toMatch(/s3cr3t|ghp_/);
    }
    expect(await a.read("src/client.ts")).toMatchObject({ ok: true, relativePath: "src/client.ts" });
  });
  it("honours an explicit smaller byte bound", async () => {
    const t = tree(), a = await authorityFor(t.project);
    expect(await a.read("README.md", 4)).toEqual({ ok: false, code: "FILE_READ_TOO_LARGE" });
    expect(await a.read("README.md", 8)).toMatchObject({ ok: true });
  });
  it("refuses when the live root identity differs from the bound identity", async () => {
    const t = tree(), a = await authorityFor(t.project, t.outside);
    expect(await a.read("README.md")).toEqual({ ok: false, code: "FILE_READ_WORKSPACE_DRIFT" });
    const replaced = await authorityFor(t.project);
    rmSync(t.project, { recursive: true }); mkdirSync(t.project); writeFileSync(join(t.project, "README.md"), "new\n");
    expect(await replaced.read("README.md")).toEqual({ ok: false, code: "FILE_READ_WORKSPACE_DRIFT" });
  });
  it("does not block on a path swapped for a FIFO after the snapshot, and honours an abort signal (review P2)", async () => {
    const t = tree(), fifo = join(t.project, "swap.txt");
    writeFileSync(fifo, "before\n");
    const { execFileSync } = await import("node:child_process");
    rmSync(fifo); execFileSync("mkfifo", [fifo]);
    const native = nodeWorkspaceFileSystem;
    // The snapshot lies: it reports the FIFO as a regular file (the race window
    // between snapshot and open). open() must still return immediately.
    const lying = { lstat: native.lstat, realpath: native.realpath, readDirectory: native.readDirectory,
      stat: async (p: string) => { const s = await native.stat(p); return p.endsWith("swap.txt") ? Object.assign(s, { isFile: () => true, isFIFO: () => false }) : s; } };
    const live = await snapshotProjectRoot(t.project);
    const resolved = { placement: { placement: "local_trusted", workspace: { kind: "local_folder", path: t.project } },
      workspace: { kind: "local_folder", canonical_path: live.canonicalPath, dev: live.dev, ino: live.ino }, project: { id: "p", path: t.project, canonicalPath: live.canonicalPath } } as unknown as ResolvedExecutionAuthority;
    const a = WorkspaceAuthority.fromExecutionAuthority(resolved, lying);
    const started = Date.now();
    expect(await a.read("swap.txt")).toEqual({ ok: false, code: "FILE_READ_WORKSPACE_DRIFT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    const aborted = new AbortController(); aborted.abort();
    expect(await a.read("README.md", 1024, aborted.signal)).toEqual({ ok: false, code: "TOOL_CALL_CANCELLED" });
    const late = new AbortController();
    const lateFs = { ...lying, lstat: async (p: string) => { if (p.endsWith("README.md")) late.abort(); return native.lstat(p); } };
    const b = WorkspaceAuthority.fromExecutionAuthority(resolved, lateFs);
    expect(await b.read("README.md", 1024, late.signal)).toEqual({ ok: false, code: "TOOL_CALL_CANCELLED" });
  });
  it("is host-minted only and refuses non local_trusted authority", async () => {
    const t = tree();
    await expect(authorityFor(t.project, t.project, "local_isolated")).rejects.toThrow("EXECUTION_PLACEMENT_UNSUPPORTED");
    expect(() => Reflect.construct(WorkspaceAuthority as unknown as new (...args: unknown[]) => unknown, [Symbol("forged"), {}, t.project, {}])).toThrow("host-minted");
    const a = await authorityFor(t.project);
    expect(Object.keys(a)).toEqual([]);
    expect(JSON.stringify(a)).toBe("{}");
  });
});
