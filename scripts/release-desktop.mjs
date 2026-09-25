import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSupportedNodeVersion } from "./require-node-22.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = desktop;

export function parseArgs(args) {
  const options = { dryRun: false, checkDistributionPrerequisites: false, version: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--check-distribution-prerequisites") options.checkDistributionPrerequisites = true;
    else if (arg === "--version" && !options.version) options.version = args[++index];
    else throw new Error(`Unsupported argument: ${arg}. This script never uploads or creates a tag.`);
  }
  assert.ok(options.version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.version), "Pass --version X.Y.Z (stable semver only)");
  assert.ok(!(options.dryRun && options.checkDistributionPrerequisites), "Distribution prerequisite checks require a built artifact");
  return options;
}

export function expectedArtifacts(pkg, version, output = "dist") {
  assert.equal(pkg.version, version, "--version must match package.json version");
  assert.equal(pkg.build?.productName, "Orchestrion");
  assert.equal(pkg.build?.artifactName, "${productName}-${version}-${arch}.${ext}");
  assert.equal(pkg.build?.directories?.output, "dist");
  assert.ok(output === "dist" || output === "dist-signed", "Unexpected artifact output directory");
  assert.deepEqual(pkg.build?.mac?.target, ["dmg", "zip"]);
  assert.equal(pkg.build?.publish?.provider, "github");
  assert.ok(/^[A-Za-z0-9-]+$/.test(pkg.build.publish.owner));
  assert.ok(/^[A-Za-z0-9_.-]+$/.test(pkg.build.publish.repo));
  return {
    tag: `desktop-v${version}`,
    app: join(desktop, output, "mac-arm64/Orchestrion.app"),
    dmg: join(desktop, output, `Orchestrion-${version}-arm64.dmg`),
    zip: join(desktop, output, `Orchestrion-${version}-arm64.zip`),
    metadata: join(desktop, output, "latest-mac.yml"),
    repo: `${pkg.build.publish.owner}/${pkg.build.publish.repo}`,
  };
}

function command(file, args, cwd = desktop) {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${file} failed (exit ${result.status ?? "unknown"})`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function preflight(pkg, options, run = command, runtime = { node: process.versions.node, platform: process.platform, arch: process.arch }) {
  assertSupportedNodeVersion(runtime.node);
  assert.equal(runtime.platform, "darwin", "macOS is required for this release rehearsal");
  assert.equal(runtime.arch, "arm64", "arm64 is the only supported desktop release architecture");
  const expected = expectedArtifacts(pkg, options.version);
  assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repository), "", "Git checkout must be clean");
  assert.equal(run("git", ["tag", "--list", expected.tag], repository), "", `${expected.tag} already exists locally`);
  return expected;
}

async function regularNonempty(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && info.size > 0, `${path} must be a nonempty regular file`);
  return info;
}

async function sha512(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

export async function verifyArtifacts(expected, run = command) {
  const zipInfo = await regularNonempty(expected.zip);
  const dmgInfo = await regularNonempty(expected.dmg);
  await regularNonempty(expected.metadata);
  assert.ok((await lstat(expected.app)).isDirectory(), "Packaged .app is missing");
  const appVersion = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(expected.app, "Contents/Info.plist")]);
  assert.equal(appVersion, expected.tag.slice("desktop-v".length), "Packaged app version differs from release version");
  const lines = (await readFile(expected.metadata, "utf8")).trimEnd().split(/\r?\n/);
  let line = 0;
  assert.equal(lines[line++], `version: ${appVersion}`, "Update metadata version differs from packaged app");
  assert.equal(lines[line++], "files:", "Update metadata files section is missing");
  const assets = [
    { path: expected.zip, info: zipInfo, digest: await sha512(expected.zip) },
    { path: expected.dmg, info: dmgInfo, digest: await sha512(expected.dmg) },
  ];
  for (const asset of assets) {
    assert.equal(lines[line++], `  - url: ${basename(asset.path)}`, `Update metadata asset name differs from ${basename(asset.path)}`);
    assert.equal(lines[line++], `    sha512: ${asset.digest}`, `Update metadata checksum differs from ${basename(asset.path)}`);
    assert.equal(lines[line++], `    size: ${asset.info.size}`, `Update metadata size differs from ${basename(asset.path)}`);
  }
  assert.equal(lines[line++], `path: ${basename(expected.zip)}`, "Top-level update path must name the verified ZIP");
  assert.equal(lines[line++], `sha512: ${assets[0].digest}`, "Top-level update checksum must match the verified ZIP");
  assert.match(lines[line++] ?? "", /^releaseDate: '[^']+'$/, "Update metadata release date is missing");
  assert.equal(line, lines.length, "Update metadata has unexpected extra entries");
  run("node", ["scripts/verify-packaged-app.mjs", expected.app]);
}

export function verifyDistributionPrerequisites(expected, run = command) {
  const signature = run("codesign", ["-dv", "--verbose=4", expected.app]);
  assert.match(signature, /Authority=Developer ID Application:/, "Developer ID signature evidence is required");
  assert.match(signature, /TeamIdentifier=[A-Z0-9]+/, "Signing team evidence is required");
  run("codesign", ["--verify", "--deep", "--strict", expected.app]);
  run("xcrun", ["stapler", "validate", expected.app]);
  run("xcrun", ["stapler", "validate", expected.dmg]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", expected.app]);
  const visibility = run("gh", ["repo", "view", expected.repo, "--json", "visibility", "--jq", ".visibility"]);
  assert.equal(visibility.toUpperCase(), "PUBLIC", "Configured GitHub repository must be PUBLIC; anonymous Release asset access needs separate verification");
  return { developerIdSignatureVerified: true, appStapleValidated: true, dmgStapleValidated: true, gatekeeperAccepted: true, repositoryVisibility: "PUBLIC" };
}

export async function rehearse(options, run = command) {
  const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  const expected = preflight(pkg, options, run);
  const assets = [expected.dmg, expected.zip, expected.metadata];
  if (options.dryRun) return { result: "DRY_RUN_ONLY", tag: expected.tag, assets, publish: false };
  if (options.checkDistributionPrerequisites) {
    const signed = expectedArtifacts(pkg, options.version, "dist-signed");
    await verifyArtifacts(signed, run);
    const prerequisites = verifyDistributionPrerequisites(signed, run);
    return { result: "EXISTING_SIGNED_ARTIFACTS_CHECKED", tag: signed.tag,
      assets: [signed.dmg, signed.zip, signed.metadata], publish: false, prerequisites };
  }
  for (const path of assets) await rm(path, { force: true });
  run("pnpm", ["run", "rebuild:native"]);
  run("pnpm", ["exec", "electron-vite", "build"]);
  run("pnpm", ["exec", "electron-builder", "--mac", "--arm64", "--publish", "never"]);
  await verifyArtifacts(expected, run);
  return { result: "LOCAL_REHEARSAL_ONLY", tag: expected.tag, assets, publish: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await rehearse(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(`Desktop release rehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
