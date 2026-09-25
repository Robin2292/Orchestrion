import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSupportedNodeVersion } from "./require-node-22.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const repository = desktop;
const helperId = "com.orchestrion.desktop.helper";

export function validateLocalKeychainInputs({ identity, identities, profile, now = new Date() }) {
  const match = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity ?? "");
  if (!match || !identities.includes(identity)) throw new Error("A valid installed Developer ID Application identity is required.");
  const team = match[1];
  const entitlements = profile?.Entitlements ?? {};
  if (!Array.isArray(profile?.TeamIdentifier) || !profile.TeamIdentifier.includes(team)
      || entitlements["com.apple.developer.team-identifier"] !== team
      || (entitlements["com.apple.application-identifier"] ?? entitlements["application-identifier"]) !== `${team}.${helperId}`) {
    throw new Error("The macOS profile must authorize the exact Orchestrion utility helper App ID and signing team.");
  }
  if (!Array.isArray(profile?.Platform) || !profile.Platform.some(platform => ["OSX", "macOS", "MacOS"].includes(platform))
      || profile.ProvisionsAllDevices !== true || Array.isArray(profile.ProvisionedDevices)
      || entitlements["com.apple.security.get-task-allow"] === true) {
    throw new Error("A macOS Developer ID distribution profile is required.");
  }
  if (!profile.ExpirationDate || !Number.isFinite(Date.parse(profile.ExpirationDate))
      || Date.parse(profile.ExpirationDate) <= now.getTime()) throw new Error("The helper provisioning profile is expired.");
  return team;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: desktop, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} preflight failed.`);
  return result.stdout;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktop, env: process.env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed.`);
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function main() {
  assertSupportedNodeVersion();
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Requires arm64 macOS.");
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
    throw new Error("Usage: node scripts/build-local-keychain.mjs [--check]");
  }
  const identity = process.env.ORCHESTRION_MAC_SIGN_IDENTITY;
  const profilePath = process.env.ORCHESTRION_MAC_HELPER_PROFILE;
  if (!profilePath || !isAbsolute(profilePath) || !existsSync(profilePath)) {
    throw new Error("Set ORCHESTRION_MAC_HELPER_PROFILE to an existing absolute path outside the repository.");
  }
  if (realpathSync(profilePath).startsWith(`${repository}/`)) {
    throw new Error("Keep the provisioning profile outside the source repository.");
  }
  const identitiesText = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = [...identitiesText.matchAll(/"(Developer ID Application: [^"]+)"/g)].map(match => match[1]);
  const profileXml = capture("security", ["cms", "-D", "-i", profilePath]);
  // Profiles contain certificate bytes that plutil cannot represent as JSON.
  // Emit only allowlisted, non-secret metadata for validation.
  const profile = JSON.parse(capture("python3", ["-c", `
import json, plistlib, sys
p = plistlib.loads(sys.stdin.buffer.read())
e = p.get("Entitlements", {})
expiry = p.get("ExpirationDate")
print(json.dumps({
  "TeamIdentifier": p.get("TeamIdentifier"),
  "Platform": p.get("Platform"),
  "ExpirationDate": expiry.isoformat() + ("Z" if expiry.tzinfo is None else "") if expiry else None,
  "ProvisionsAllDevices": p.get("ProvisionsAllDevices"),
  "ProvisionedDevices": p.get("ProvisionedDevices"),
  "Entitlements": {k: e.get(k) for k in (
    "com.apple.developer.team-identifier", "com.apple.application-identifier", "application-identifier",
    "com.apple.security.get-task-allow")}
}))
`], { input: profileXml }));
  const team = validateLocalKeychainInputs({ identity, identities, profile });
  if (process.argv[2] === "--check") {
    process.stdout.write("Local Keychain signing prerequisites are ready; no package was built.\n");
    return;
  }

  const output = resolve(process.env.ORCHESTRION_MAC_LOCAL_OUTPUT ?? join(tmpdir(), `orchestrion-local-keychain-${process.pid}`));
  if (existsSync(output)) throw new Error("Local package output already exists; choose a fresh path.");
  run("pnpm", ["exec", "electron-vite", "build"]);
  run("pnpm", ["exec", "electron-builder", "--config", "electron-builder.signed.cjs",
    "--mac", "--arm64", "--dir", "--publish", "never", "--config.mac.notarize=false",
    `--config.directories.output=${output}`]);

  const app = join(output, "mac-arm64", "Orchestrion.app");
  const helper = join(app, "Contents/Frameworks/Orchestrion Helper.app");
  const helperBundleId = capture("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleIdentifier", join(helper, "Contents/Info.plist")]).trim();
  if (helperBundleId !== helperId) throw new Error("Packaged utility helper bundle ID changed.");
  copyFileSync(profilePath, join(helper, "Contents/embedded.provisionprofile"));
  const temporary = mkdtempSync(join(tmpdir(), "orchestrion-keychain-sign-"));
  try {
    const entitlements = join(temporary, "helper-entitlements.plist");
    writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${xmlEscape(`${team}.${helperId}`)}</string>
<key>com.apple.developer.team-identifier</key><string>${xmlEscape(team)}</string>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>\n`);
    run("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp=none",
      "--entitlements", entitlements, helper]);
    run("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp=none",
      "--entitlements", "build/entitlements.mac.plist", app]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  run("codesign", ["--verify", "--deep", "--strict", app]);
  run("node", ["scripts/packaged-keychain-smoke.cjs", app]);
  process.stdout.write(`LOCAL_KEYCHAIN_PACKAGE_PASS ${app}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Local Keychain package failed."}\n`);
    process.exitCode = 1;
  });
}
