import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSupportedNodeVersion } from "./require-node-22.mjs";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const signedOutput = join(desktop, "dist-signed");
const app = join(signedOutput, "mac-arm64", "Orchestrion.app");

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
  await command("pnpm", ["exec", "electron-vite", "build"]);
  await command("pnpm", ["exec", "electron-builder", "--config", "electron-builder.signed.cjs", "--mac", "--arm64", "--publish", "never"]);
  await command("codesign", ["--verify", "--deep", "--strict", app]);
  const signature = await command("codesign", ["--display", "--verbose=4", app], { capture: true });
  if (!signature.split("\n").includes(`Authority=${identity}`)) {
    throw new Error("Built app is not signed by the requested Developer ID Application identity.");
  }
  await command("xcrun", ["stapler", "validate", app]);
  process.stdout.write("Signed macOS build passed local signature and stapled-ticket checks; no artifacts were uploaded.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
