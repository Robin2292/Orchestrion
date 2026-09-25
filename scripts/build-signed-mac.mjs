import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { signProvisionedApp } from "./build-local-keychain.mjs";
import { assertSupportedNodeVersion } from "./require-node-22.mjs";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const signedOutput = join(desktop, "dist-signed");
const app = join(signedOutput, "mac-arm64", "Orchestrion.app");

async function sha512(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

export async function refreshDmgMetadata(metadataPath, dmgPath) {
  const lines = (await readFile(metadataPath, "utf8")).trimEnd().split(/\r?\n/);
  const index = lines.indexOf(`  - url: ${basename(dmgPath)}`);
  if (index < 0 || !/^    sha512: \S+$/.test(lines[index + 1] ?? "") ||
      !/^    size: \d+$/.test(lines[index + 2] ?? "")) {
    throw new Error("Update metadata does not contain the expected DMG asset.");
  }
  lines[index + 1] = `    sha512: ${await sha512(dmgPath)}`;
  lines[index + 2] = `    size: ${(await stat(dmgPath)).size}`;
  await writeFile(metadataPath, `${lines.join("\n")}\n`);
}

export function validateSignedBuildEnvironment({ env, identities, platform, arch, nodeVersion }) {
  assertSupportedNodeVersion(nodeVersion);
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("Signed desktop builds require an arm64 macOS host.");
  }
  const identity = env.ORCHESTRION_MAC_SIGN_IDENTITY;
  if (!identity || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity)) {
    throw new Error("Set ORCHESTRION_MAC_SIGN_IDENTITY to a Developer ID Application certificate name.");
  }
  if (!identities.includes(identity)) {
    throw new Error("The requested Developer ID Application certificate is not a valid keychain signing identity.");
  }

  const credentialGroups = [
    { required: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"] },
    { required: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] },
    { required: ["APPLE_KEYCHAIN_PROFILE"], optional: ["APPLE_KEYCHAIN"] },
  ];
  const selected = credentialGroups.filter(group =>
    [...group.required, ...(group.optional ?? [])].some(key => Boolean(env[key])));
  if (selected.length !== 1 || selected[0].required.some(key => !env[key])) {
    throw new Error("Provide exactly one complete electron-builder v26 notarization credential set (API key, Apple ID, or keychain profile).");
  }
  return identity;
}

async function command(executable, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: desktop,
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
    }
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`${executable} failed with exit code ${code}`)));
  });
}

async function notarize(path, profile, { staple = true } = {}) {
  const args = ["notarytool", "submit", path, "--keychain-profile", profile,
    "--wait", "--output-format", "json"];
  if (process.env.APPLE_KEYCHAIN) args.push("--keychain", process.env.APPLE_KEYCHAIN);
  const response = JSON.parse(await command("xcrun", args, { capture: true }));
  if (response.status !== "Accepted") throw new Error(`Apple notarization returned ${response.status ?? "no status"}.`);
  if (staple) {
    await command("xcrun", ["stapler", "staple", path]);
    await command("xcrun", ["stapler", "validate", path]);
  }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
    throw new Error("Usage: node scripts/build-signed-mac.mjs [--check]");
  }
  const rawIdentities = await command("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
  const identities = [...rawIdentities.matchAll(/"(Developer ID Application: [^"]+)"/g)].map(match => match[1]);
  const identity = validateSignedBuildEnvironment({
    env: process.env,
    identities,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
  });
  if (!process.env.APPLE_KEYCHAIN_PROFILE) {
    throw new Error("A stored APPLE_KEYCHAIN_PROFILE is required to notarize both the app and DMG without exposing a password in process arguments.");
  }
  await command("node", ["scripts/build-local-keychain.mjs", "--check"]);
  for (const path of ["build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist"]) {
    await access(join(desktop, path));
  }
  const config = require("../electron-builder.signed.cjs");
  if (config.mac.identity !== identity.slice("Developer ID Application: ".length) ||
      config.forceCodeSigning !== true || config.mac.notarize !== true ||
      config.mac.hardenedRuntime !== true || config.directories.output !== "dist-signed") {
    throw new Error("Signed electron-builder configuration failed its invariant check.");
  }
  if (process.argv[2] === "--check") {
    process.stdout.write("Signed macOS configuration and local prerequisites are ready; no build or upload was attempted.\n");
    return;
  }

  try {
    await access(signedOutput);
    throw new Error("dist-signed already exists; remove or archive it before a fresh signed build.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packageJson = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  const version = packageJson.version;
  const dmg = join(signedOutput, `Orchestrion-${version}-arm64.dmg`);
  const metadata = join(signedOutput, "latest-mac.yml");
  const team = /\(([A-Z0-9]{10})\)$/.exec(identity)[1];
  const temporary = await mkdtemp(join(tmpdir(), "orchestrion-notarize-"));
  try {
    await command("pnpm", ["exec", "electron-vite", "build"]);
    await command("pnpm", ["exec", "electron-builder", "--config", "electron-builder.signed.cjs",
      "--mac", "--arm64", "--dir", "--publish", "never", "--config.mac.notarize=false"]);
    signProvisionedApp({ app, profilePath: process.env.ORCHESTRION_MAC_HELPER_PROFILE,
      identity, team, timestamp: true });
    const appArchive = join(temporary, "Orchestrion-app.zip");
    await command("ditto", ["-c", "-k", "--keepParent", app, appArchive]);
    await notarize(appArchive, process.env.APPLE_KEYCHAIN_PROFILE, { staple: false });
    await command("xcrun", ["stapler", "staple", app]);
    await command("xcrun", ["stapler", "validate", app]);
    await command("pnpm", ["exec", "electron-builder", "--config", "electron-builder.signed.cjs",
      "--prepackaged", app, "--mac", "dmg", "zip", "--publish", "never"]);
    await command("codesign", ["--force", "--sign", identity, "--timestamp",
      "--identifier", "com.orchestrion.desktop.dmg", dmg]);
    await command("codesign", ["--verify", "--strict", dmg]);
    await notarize(dmg, process.env.APPLE_KEYCHAIN_PROFILE);
    await refreshDmgMetadata(metadata, dmg);
    await rm(`${dmg}.blockmap`, { force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await command("codesign", ["--verify", "--deep", "--strict", app]);
  const signature = await command("codesign", ["--display", "--verbose=4", app], { capture: true });
  if (!signature.split("\n").includes(`Authority=${identity}`)) {
    throw new Error("Built app is not signed by the requested Developer ID Application identity.");
  }
  await command("xcrun", ["stapler", "validate", app]);
  await command("xcrun", ["stapler", "validate", dmg]);
  await command("node", ["scripts/verify-packaged-app.mjs", app]);
  await command("node", ["scripts/packaged-keychain-smoke.cjs", app]);
  await command("node", ["scripts/packaged-launch-smoke.mjs", app, "--check-updater"]);
  await command("spctl", ["--assess", "--type", "execute", app]);
  await command("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
  process.stdout.write("Signed app and DMG passed signature and stapled-ticket checks. Both were submitted to Apple; nothing was published to GitHub.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
