import { execFileSync, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedExecutionAuthority } from "./execution-authority";
import { HostProcessExecutor, ProcessTreeSupervisor, ProcessWorkspaceAuthority, gitArgv, gitEnvironment } from "./host-process-executor";
import { normalizeGitInvocation, normalizeGitPath, normalizeGitRevision } from "../tools/builtins/git-readonly";
import { GOVERNED_GIT_DIFF_TOOL, GOVERNED_GIT_LOG_TOOL, GOVERNED_GIT_STATUS_TOOL } from "../shared/governed-tool-contracts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "orclocal-ep1c-git-")); roots.push(root);
  execFileSync("/usr/bin/git", ["init", "-q", root]);
  execFileSync("/usr/bin/git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("/usr/bin/git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  for (const [name, value] of [["*.txt", "literal\n"], ["sibling.txt", "sibling\n"], ["!secret", "bang\n"], ["[ab].ts", "bracket\n"]]) writeFileSync(join(root, name), value);
  execFileSync("/usr/bin/git", ["-C", root, "add", "--", "*.txt", "sibling.txt", "!secret", "[ab].ts"]);
  execFileSync("/usr/bin/git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}
function authority(root: string, lexical = root): ProcessWorkspaceAuthority {
  const value = statSync(root), canonical = realpathSync(root);
  return ProcessWorkspaceAuthority.fromExecutionAuthority({
    placement: { placement: "local_trusted", workspace: { kind: "local_folder", path: lexical } },
    workspace: { kind: "local_folder", canonical_path: canonical, dev: value.dev, ino: value.ino }, project: { path: lexical, canonicalPath: canonical },
  } as ResolvedExecutionAuthority);
}
function invocation(tool: typeof GOVERNED_GIT_STATUS_TOOL | typeof GOVERNED_GIT_DIFF_TOOL | typeof GOVERNED_GIT_LOG_TOOL, args: unknown) {
  const value = normalizeGitInvocation(tool, args); if (!value.ok) throw new Error(value.code); return value;
}

describe("EP1-C exact readonly Git process", () => {
  it("lowers only closed logical requests to exact hardened argv and a credential-free environment", () => {
    expect(gitArgv(invocation(GOVERNED_GIT_STATUS_TOOL, {}))).toEqual(expect.arrayContaining(["--literal-pathspecs", "--no-optional-locks", "status", "--ignore-submodules=all"]));
    expect(gitArgv(invocation(GOVERNED_GIT_DIFF_TOOL, { path: "src/a.ts", cached: true }))).toEqual(expect.arrayContaining(["diff", "--no-ext-diff", "--no-textconv", "--cached", "--", "src/a.ts"]));
    expect(gitArgv(invocation(GOVERNED_GIT_LOG_TOOL, { max_count: 7, format: "oneline" }))).toEqual(expect.arrayContaining(["log", "--max-count=7", "--no-show-signature", "HEAD"]));
    const environment = gitEnvironment("/workspace", "/tmp/git-view", "/workspace/.git/objects");
    expect(Object.keys(environment).some((key) => /TOKEN|KEY|PROXY|SSH_AUTH_SOCK|GIT_CONFIG_COUNT/.test(key))).toBe(false);
    expect(environment).toMatchObject({
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
      GIT_DIR: "/tmp/git-view", GIT_COMMON_DIR: "/tmp/git-view", GIT_INDEX_FILE: "/tmp/git-view/index",
      GIT_WORK_TREE: "/workspace", GIT_OBJECT_DIRECTORY: "/workspace/.git/objects",
    });
    expect(normalizeGitInvocation(GOVERNED_GIT_STATUS_TOOL, { argv: ["status"] }).ok).toBe(false);
    expect(normalizeGitInvocation(GOVERNED_GIT_DIFF_TOOL, { path: "a", revision: "-c" }).ok).toBe(false);
    expect(normalizeGitInvocation(GOVERNED_GIT_DIFF_TOOL, { path: "a", revision: "HEAD..main" }).ok).toBe(false);
    expect(normalizeGitInvocation(GOVERNED_GIT_DIFF_TOOL, { path: "a", revision: "HEAD", cached: true }).ok).toBe(false);
    expect(normalizeGitInvocation(GOVERNED_GIT_LOG_TOOL, { max_count: 51 }).ok).toBe(false);
    expect(normalizeGitRevision("main")).toBe("main"); expect(normalizeGitRevision("--git-dir=x")).toBeNull();
    expect(normalizeGitPath("../outside").ok).toBe(false); expect(normalizeGitPath(".env.local").ok).toBe(false);
  });

  it("treats a policy-representable special name as one literal file", async () => {
    const root = repo(); writeFileSync(join(root, "!secret"), "changed bang\n");
    const result = await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "!secret" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("changed bang"); expect(result.text).not.toContain("sibling\n");
      expect(result.evidence).toMatchObject({ placement: "local_trusted", isolation: "none", exit_code: 0, timed_out: false, cancelled: false });
    }
  });

  it("preserves validated core.filemode=false for executable-bit-only changes", async () => {
    const root = repo(), target = join(root, "sibling.txt");
    execFileSync("/usr/bin/git", ["-C", root, "config", "core.filemode", "false"]);
    chmodSync(target, 0o755);
    const nativeStatus = execFileSync("/usr/bin/git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
    const nativeDiff = execFileSync("/usr/bin/git", ["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--", "sibling.txt"], { encoding: "utf8" });
    expect(nativeStatus).toBe(""); expect(nativeDiff).toBe("");
    const executor = new HostProcessExecutor();
    const governedStatus = await executor.execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    const governedDiff = await executor.execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" }));
    expect(governedStatus.ok && governedStatus.text).not.toContain("sibling.txt");
    expect(governedDiff).toMatchObject({ ok: true, text: nativeDiff });
  });

  it.each(["*.txt", "[ab].ts", "private/*.txt"])("refuses the unrepresentable path %s instead of widening its policy claim", (name) => {
    expect(normalizeGitPath(name)).toMatchObject({ ok: false, code: "GIT_PATH_INVALID" });
    expect(normalizeGitInvocation(GOVERNED_GIT_DIFF_TOOL, { path: name })).toMatchObject({ ok: false, code: "GIT_PATH_INVALID" });
  });

  it("returns bounded status/log and refuses sensitive diff paths and content", async () => {
    const root = repo(), executor = new HostProcessExecutor();
    writeFileSync(join(root, "ordinary.txt"), "change\n");
    const status = await executor.execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(status.ok && status.text).toContain("ordinary.txt");
    const log = await executor.execute(authority(root), invocation(GOVERNED_GIT_LOG_TOOL, { max_count: 1, format: "oneline" }));
    expect(log.ok && log.text).toContain("initial");
    expect(normalizeGitInvocation(GOVERNED_GIT_DIFF_TOOL, { path: ".env.local" })).toMatchObject({ ok: false, code: "GIT_SENSITIVE_OUTPUT" });
    writeFileSync(join(root, ".env.local"), "TOKEN=not-returned\n");
    expect(await executor.execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}))).toMatchObject({ ok: false, code: "GIT_SENSITIVE_OUTPUT" });
    rmSync(join(root, ".env.local"));
    const secrets = [
      "postgres://user:password@localhost/db\n",
      "-----BEGIN PRIVATE KEY-----\nrenamed\n-----END PRIVATE KEY-----\n",
      `TLS_KEY=${Buffer.from("-----BEGIN PRIVATE KEY-----\nwrapped\n-----END PRIVATE KEY-----").toString("base64")}\n`,
    ];
    for (const value of secrets) {
      writeFileSync(join(root, "sibling.txt"), value);
      const secret = await executor.execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" }));
      expect(secret).toMatchObject({ ok: false, code: "GIT_SENSITIVE_OUTPUT", evidence: { placement: "local_trusted", isolation: "none" } });
    }
  });

  it("snapshots bounded repository excludes without copying repository attributes", async () => {
    const root = repo();
    writeFileSync(join(root, ".git", "info", "exclude"), "ignored-untracked.log\n");
    writeFileSync(join(root, "ignored-untracked.log"), "ignored\n");
    writeFileSync(join(root, "visible-untracked.log"), "visible\n");
    const native = execFileSync("/usr/bin/git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
    expect(native).toContain("visible-untracked.log"); expect(native).not.toContain("ignored-untracked.log");
    const governed = await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(governed.ok && governed.text).toContain("visible-untracked.log");
    expect(governed.ok && governed.text).not.toContain("ignored-untracked.log");
  });

  it.each(["core.fsmonitor", "core.hooksPath", "diff.bad.external", "diff.bad.textconv", "filter.bad.clean", "filter.bad.process", "core.alternateRefsCommand"])
  ("fails closed before spawn for repository helper config %s", async (key) => {
    const root = repo(), marker = join(root, "helper-fired"), command = join(root, "helper");
    writeFileSync(command, `#!/bin/sh\nprintf fired > '${marker}'\n`); chmodSync(command, 0o700);
    if (key.startsWith("diff.")) writeFileSync(join(root, ".gitattributes"), "*.txt diff=bad\n");
    if (key.startsWith("filter.")) writeFileSync(join(root, ".gitattributes"), "*.txt filter=bad\n");
    execFileSync("/usr/bin/git", ["-C", root, "config", key, command]);
    const result = await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(result).toMatchObject({ ok: false, code: "GIT_REPOSITORY_REFUSED" });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses deprecated helper-bearing section syntax before spawn", async () => {
    const root = repo(), marker = join(root, "deprecated-helper-fired"), helper = join(root, "deprecated-helper");
    writeFileSync(helper, `#!/bin/sh\nprintf fired > '${marker}'\ncat\n`); chmodSync(helper, 0o700);
    writeFileSync(join(root, ".gitattributes"), "sibling.txt filter=review\n");
    writeFileSync(join(root, ".git", "config"), `${readFileSync(join(root, ".git", "config"), "utf8")}\n[filter.review]\nclean = ${helper}\n`);
    writeFileSync(join(root, "sibling.txt"), "changed\n");
    expect(await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" })))
      .toMatchObject({ ok: false, code: "GIT_REPOSITORY_REFUSED" });
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    [GOVERNED_GIT_STATUS_TOOL, {}],
    [GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" }],
    [GOVERNED_GIT_LOG_TOOL, { max_count: 1, format: "oneline" }],
  ] as const)("isolates %s from config and attribute mutation at the spawn boundary", async (tool, args) => {
    const root = repo(), marker = join(root, "boundary-helper-fired"), helper = join(root, "boundary-helper");
    writeFileSync(helper, `#!/bin/sh\nprintf fired > '${marker}'\ncat\n`); chmodSync(helper, 0o700);
    writeFileSync(join(root, "sibling.txt"), "changed at boundary\n");
    writeFileSync(join(root, ".git", "info", "attributes"), "sibling.txt filter=review\n");
    const original = readFileSync(join(root, ".git", "config"), "utf8");
    let spawned = 0, isolatedGitDir = "", isolatedAttributesPresent = false;
    const boundarySpawn = ((file: string, argv: readonly string[], options: SpawnOptions) => {
      spawned += 1; isolatedGitDir = String(options?.env?.GIT_DIR ?? "");
      isolatedAttributesPresent = existsSync(join(isolatedGitDir, "info", "attributes"));
      writeFileSync(join(root, ".git", "config"), `${original}\n[core]\nrepositoryformatversion = 999\n[filter \"review\"]\nclean = ${helper}\n`);
      writeFileSync(join(root, ".gitattributes"), "sibling.txt filter=review\n");
      return nodeSpawn(file, argv, options);
    }) as typeof nodeSpawn;
    const outcome = await new HostProcessExecutor({ spawn: boundarySpawn }).execute(authority(root), invocation(tool, args));
    expect(outcome.ok).toBe(true);
    expect(spawned).toBe(1); expect(isolatedGitDir).not.toBe(join(root, ".git")); expect(isolatedAttributesPresent).toBe(false);
    expect(existsSync(marker)).toBe(false); expect(existsSync(isolatedGitDir)).toBe(false);
  });

  it("refuses inline core.worktree and ordinary commondir indirection before Git can read outside the workspace", async () => {
    const root = repo(), outside = repo(), executor = new HostProcessExecutor();
    writeFileSync(join(outside, "sibling.txt"), "OUTSIDE_WORKSPACE_CONTENT\n");
    writeFileSync(join(root, ".git", "config"), `${readFileSync(join(root, ".git", "config"), "utf8")}\n[core] worktree = ${outside}\n`);
    expect(await executor.execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" })))
      .toMatchObject({ ok: false, code: "GIT_REPOSITORY_REFUSED" });
    writeFileSync(join(root, ".git", "config"), readFileSync(join(outside, ".git", "config"), "utf8"));
    writeFileSync(join(root, ".git", "commondir"), join(outside, ".git"));
    expect(await executor.execute(authority(root), invocation(GOVERNED_GIT_LOG_TOOL, { max_count: 1, format: "oneline" })))
      .toMatchObject({ ok: false, code: "GIT_REPOSITORY_REFUSED" });
  });

  it("requires diff paths to identify one tracked regular index entry", async () => {
    const root = repo(), executor = new HostProcessExecutor();
    mkdirSync(join(root, "deleted")); writeFileSync(join(root, "deleted", ".env"), "OUTSIDE_WORKSPACE_CONTENT\n");
    execFileSync("/usr/bin/git", ["-C", root, "add", "--", "deleted/.env"]);
    execFileSync("/usr/bin/git", ["-C", root, "commit", "-qm", "tracked deleted tree"]);
    rmSync(join(root, "deleted"), { recursive: true });
    expect(await executor.execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "deleted" })))
      .toMatchObject({ ok: false, code: "GIT_PATH_INVALID" });
    rmSync(join(root, "sibling.txt"));
    const oneFile = await executor.execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" }));
    expect(oneFile.ok && oneFile.text).toContain("--- a/sibling.txt");
    expect(oneFile.ok && oneFile.text).not.toContain("OUTSIDE_WORKSPACE_CONTENT");
  });

  it("allows one exact tracked deletion when its parent directory is also absent", async () => {
    const root = repo(), parent = join(root, "src");
    mkdirSync(parent); writeFileSync(join(parent, "a.txt"), "tracked deletion\n");
    execFileSync("/usr/bin/git", ["-C", root, "add", "--", "src/a.txt"]);
    execFileSync("/usr/bin/git", ["-C", root, "commit", "-qm", "tracked nested file"]);
    rmSync(parent, { recursive: true });
    const native = execFileSync("/usr/bin/git", ["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--", "src/a.txt"], { encoding: "utf8" });
    const governed = await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "src/a.txt" }));
    expect(governed).toMatchObject({ ok: true, text: native });
    expect(governed.ok && governed.text).toContain("diff --git a/src/a.txt b/src/a.txt");
    expect(governed.ok && governed.text).not.toContain("sibling.txt");
  });

  it("parses file markers only before the first hunk", async () => {
    const root = repo();
    writeFileSync(join(root, "sibling.txt"), "-- ordinary old content\n");
    execFileSync("/usr/bin/git", ["-C", root, "add", "--", "sibling.txt"]);
    execFileSync("/usr/bin/git", ["-C", root, "commit", "-qm", "hunk marker fixture"]);
    writeFileSync(join(root, "sibling.txt"), "++ ordinary new content\n");
    const outcome = await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("--- ordinary old content");
      expect(outcome.text).toContain("+++ ordinary new content");
    }
  });

  it.each([".npmrc", ".aws/config", ".envdir/config", "ordinary.crt"])("applies shared sensitive-path rules to status path %s", async (name) => {
    const root = repo(), target = join(root, ...name.split("/"));
    mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, "not returned\n");
    expect(await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {})))
      .toMatchObject({ ok: false, code: "GIT_SENSITIVE_OUTPUT" });
  });

  it("refuses linked-worktree metadata, alternates, symlinked exact paths and root drift", async () => {
    const root = repo();
    mkdirSync(join(root, ".git", "objects", "info"), { recursive: true }); writeFileSync(join(root, ".git", "objects", "info", "alternates"), "/tmp/objects\n");
    expect(await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}))).toMatchObject({ ok: false, code: "GIT_REPOSITORY_REFUSED" });
    rmSync(join(root, ".git", "objects", "info", "alternates"));
    const link = join(root, "linked.txt"); requireSymlink(join(root, "sibling.txt"), link);
    expect(await new HostProcessExecutor().execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "linked.txt" }))).toMatchObject({ ok: false, code: "GIT_PATH_INVALID" });
    const old = authority(root), moved = `${root}-moved`; roots.push(moved); execFileSync("/bin/mv", [root, moved]); mkdirSync(root);
    expect(await new HostProcessExecutor().execute(old, invocation(GOVERNED_GIT_STATUS_TOOL, {}))).toMatchObject({ ok: false, code: "GIT_WORKSPACE_DRIFT" });
    const linkRoot = `${root}-link`; roots.push(linkRoot); execFileSync("/bin/ln", ["-s", moved, linkRoot]);
    expect(await new HostProcessExecutor().execute(authority(moved, linkRoot), invocation(GOVERNED_GIT_STATUS_TOOL, {}))).toMatchObject({ ok: false, code: "GIT_WORKSPACE_DRIFT" });
  });

  it("stops a bounded metadata/ref snapshot cooperatively when aborted", async () => {
    const root = repo(), controller = new AbortController(), refs = `${join(realpathSync(root), ".git", "refs")}/`;
    let reachedReferenceFile = false, isolatedGitDir = "", spawned = 0;
    const countedSpawn = ((file: string, argv: readonly string[], options: SpawnOptions) => {
      spawned += 1; return nodeSpawn(file, argv, options);
    }) as typeof nodeSpawn;
    const executor = new HostProcessExecutor({
      spawn: countedSpawn,
      snapshotCheckpoint: (source) => {
        if (source.startsWith(join(tmpdir(), "orchestrion-git-readonly-"))) isolatedGitDir = source;
        if (!reachedReferenceFile && source.startsWith(refs) && existsSync(source) && lstatSync(source).isFile()) {
          reachedReferenceFile = true; controller.abort();
        }
      },
    });
    const outcome = await executor.execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}), controller.signal);
    expect(reachedReferenceFile).toBe(true); expect(spawned).toBe(0);
    expect(outcome).toMatchObject({ ok: false, code: "TOOL_CALL_CANCELLED" });
    expect(isolatedGitDir).not.toBe(""); expect(existsSync(isolatedGitDir)).toBe(false);
  });

  it.each(["index", "info/exclude"])("refuses FIFO metadata %s without waiting for a writer", async (relative) => {
    const root = repo(), target = join(root, ".git", ...relative.split("/"));
    rmSync(target); execFileSync("/usr/bin/mkfifo", [target]);
    const signal = AbortSignal.timeout(1_000);
    let isolatedGitDir = "", spawned = 0;
    const countedSpawn = ((file: string, argv: readonly string[], options: SpawnOptions) => {
      spawned += 1; return nodeSpawn(file, argv, options);
    }) as typeof nodeSpawn;
    const started = Date.now();
    const outcome = await new HostProcessExecutor({
      spawn: countedSpawn, timeoutMs: 1_000,
      snapshotCheckpoint: (source) => {
        if (source.startsWith(join(tmpdir(), "orchestrion-git-readonly-"))) isolatedGitDir = source;
      },
    }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}), signal);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome).toMatchObject({ ok: false, code: "GIT_REPOSITORY_REFUSED" });
    expect(spawned).toBe(0); expect(isolatedGitDir).not.toBe(""); expect(existsSync(isolatedGitDir)).toBe(false);
  });

  it("TERM then KILL owns the process group and keeps the pid tracked through close", async () => {
    const root = repo(), script = join(root, "fake-git");
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nprintf ready > kill-ready\nwhile :; do sleep 1; done\n"); chmodSync(script, 0o700);
    const tracked: boolean[] = [], killed: NodeJS.Signals[] = [];
    const supervisor = new ProcessTreeSupervisor({ termGraceMs: 20, track: (_pid, active) => tracked.push(active), kill: (pid, signal) => {
      killed.push(signal); process.kill(-pid, signal);
    } });
    const controller = new AbortController();
    const running = new HostProcessExecutor({ gitExecutable: script, supervisor, timeoutMs: 1000 }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}), controller.signal);
    for (let i = 0; i < 400 && !existsSync(join(root, "kill-ready")); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(existsSync(join(root, "kill-ready"))).toBe(true); controller.abort();
    const outcome = await running;
    expect(outcome).toMatchObject({ ok: false, code: "TOOL_CALL_CANCELLED", evidence: { cancelled: true } });
    expect(killed.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]); expect(tracked).toEqual([true, false]);
  });

  it("reaps an inherited-pipe descendant after the direct child exits", async () => {
    const root = repo(), script = join(root, "fake-git");
    writeFileSync(script, "#!/bin/sh\n( trap '' TERM; printf ready > descendant-ready; while :; do sleep 1; done ) &\nchild=$!\nwhile [ ! -f descendant-ready ]; do :; done\nprintf '%s' \"$child\" > descendant-pid\nexit 0\n"); chmodSync(script, 0o700);
    const tracked: boolean[] = [], killed: NodeJS.Signals[] = [];
    const supervisor = new ProcessTreeSupervisor({ termGraceMs: 20, track: (_pid, active) => tracked.push(active), kill: (pid, signal) => {
      killed.push(signal); process.kill(-pid, signal);
    } });
    const outcome = await new HostProcessExecutor({ gitExecutable: script, supervisor }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(outcome).toMatchObject({ ok: true, evidence: { exit_code: 0 } });
    expect(killed.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]); expect(tracked).toEqual([true, false]);
    const descendant = Number(readFileSync(join(root, "descendant-pid"), "utf8"));
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  it("does not settle or untrack while a TERM-ignoring redirected descendant remains alive", async () => {
    const root = repo(), script = join(root, "fake-git");
    writeFileSync(script, "#!/bin/sh\n( exec >/dev/null 2>&1; trap '' TERM; printf ready > redirected-ready; while :; do sleep 1; done ) &\nchild=$!\nwhile [ ! -f redirected-ready ]; do :; done\nprintf '%s' \"$child\" > redirected-pid\nexit 0\n"); chmodSync(script, 0o700);
    const tracked: boolean[] = [], killed: NodeJS.Signals[] = [];
    const supervisor = new ProcessTreeSupervisor({ termGraceMs: 20, track: (_pid, active) => tracked.push(active), kill: (pid, signal) => {
      killed.push(signal); process.kill(-pid, signal);
    } });
    const outcome = await new HostProcessExecutor({ gitExecutable: script, supervisor }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(outcome).toMatchObject({ ok: true, evidence: { exit_code: 0 } });
    expect(killed.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]); expect(tracked).toEqual([true, false]);
    const descendant = Number(readFileSync(join(root, "redirected-pid"), "utf8"));
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  it("owns its timeout and output bound through process close", async () => {
    const root = repo(), script = join(root, "fake-git");
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nprintf ready > timeout-ready\nwhile :; do sleep 1; done\n"); chmodSync(script, 0o700);
    const timeout = await new HostProcessExecutor({ gitExecutable: script, timeoutMs: 20 }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(timeout).toMatchObject({ ok: false, code: "TOOL_CALL_TIMED_OUT", evidence: { timed_out: true, cancelled: false } });
    writeFileSync(script, "#!/bin/sh\ni=0\nwhile [ $i -lt 100 ]; do printf 1234567890; i=$((i+1)); done\n");
    const bounded = await new HostProcessExecutor({ gitExecutable: script, maxOutputBytes: 64 }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {}));
    expect(bounded).toMatchObject({ ok: false, code: "GIT_OUTPUT_TOO_LARGE", evidence: { truncated: true } });
    expect(bounded.evidence?.stdout_bytes).toBeGreaterThan(64);
  });

  it("fails closed for non-zero exit and non-UTF8 output", async () => {
    const root = repo(), script = join(root, "fake-git");
    writeFileSync(script, "#!/bin/sh\nexit 7\n"); chmodSync(script, 0o700);
    expect(await new HostProcessExecutor({ gitExecutable: script }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {})))
      .toMatchObject({ ok: false, code: "GIT_PROCESS_FAILED", evidence: { exit_code: 7 } });
    writeFileSync(script, "#!/bin/sh\nprintf '\\377'\n");
    expect(await new HostProcessExecutor({ gitExecutable: script }).execute(authority(root), invocation(GOVERNED_GIT_STATUS_TOOL, {})))
      .toMatchObject({ ok: false, code: "GIT_OUTPUT_NOT_UTF8", evidence: { exit_code: 0 } });
  });

  it("refuses a diff process that returns more than the admitted exact file", async () => {
    const root = repo(), script = join(root, "fake-git");
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' 'diff --git a/sibling.txt b/sibling.txt' 'diff --git a/other.txt b/other.txt'\n"); chmodSync(script, 0o700);
    expect(await new HostProcessExecutor({ gitExecutable: script }).execute(authority(root), invocation(GOVERNED_GIT_DIFF_TOOL, { path: "sibling.txt" })))
      .toMatchObject({ ok: false, code: "GIT_PATH_INVALID", evidence: { exit_code: 0 } });
  });
});

function requireSymlink(target: string, path: string): void {
  // Avoid importing a second fs surface solely for this one assertion.
  execFileSync("/bin/ln", ["-s", target, path]); expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("sibling\n");
}
