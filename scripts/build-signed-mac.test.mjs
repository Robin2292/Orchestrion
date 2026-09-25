import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshDmgMetadata, validateSignedBuildEnvironment } from "./build-signed-mac.mjs";

const identity = "Developer ID Application: Example Company (ABCDE12345)";
const ready = {
  env: {
    ORCHESTRION_MAC_SIGN_IDENTITY: identity,
    APPLE_KEYCHAIN: "/private/example.keychain-db",
    APPLE_KEYCHAIN_PROFILE: "example-profile",
  },
  identities: [identity],
  platform: "darwin",
  arch: "arm64",
  nodeVersion: "22.23.3",
};

test("signed build requires an installed Developer ID identity and one complete notarization credential set", () => {
  assert.equal(validateSignedBuildEnvironment(ready), identity);
  const profileOnly = { ...ready.env, APPLE_KEYCHAIN_PROFILE: "default-profile" };
  delete profileOnly.APPLE_KEYCHAIN;
  assert.equal(validateSignedBuildEnvironment({ ...ready, env: profileOnly }), identity);
  const apiKey = {
    ORCHESTRION_MAC_SIGN_IDENTITY: identity,
    APPLE_API_KEY: "/private/example.p8",
    APPLE_API_KEY_ID: "EXAMPLE123",
    APPLE_API_ISSUER: "example-issuer",
  };
  assert.equal(validateSignedBuildEnvironment({ ...ready, env: apiKey }), identity);
  const appleId = {
    ORCHESTRION_MAC_SIGN_IDENTITY: identity,
    APPLE_ID: "example@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "example-password",
    APPLE_TEAM_ID: "ABCDE12345",
  };
  assert.equal(validateSignedBuildEnvironment({ ...ready, env: appleId }), identity);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, identities: [] }), /valid keychain signing identity/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ...ready.env, ORCHESTRION_MAC_SIGN_IDENTITY: "-" } }), /Developer ID Application/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ...ready.env, APPLE_KEYCHAIN_PROFILE: "" } }), /exactly one complete/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ORCHESTRION_MAC_SIGN_IDENTITY: identity } }), /exactly one complete/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ...apiKey, APPLE_API_KEY_ID: "" } }), /exactly one complete/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ...appleId, APPLE_TEAM_ID: "" } }), /exactly one complete/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ...apiKey, APPLE_KEYCHAIN_PROFILE: "example-profile" } }), /exactly one complete/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, env: { ...ready.env, APPLE_ID: "example@example.com" } }), /exactly one complete/);
  assert.throws(() => validateSignedBuildEnvironment({ ...ready, arch: "x64" }), /arm64 macOS/);
});

test("signed config preserves unsigned development config and forbids unsigned signing fallback", () => {
  const require = createRequire(import.meta.url);
  const unsigned = require("../package.json").build;
  const previous = process.env.ORCHESTRION_MAC_SIGN_IDENTITY;
  try {
    process.env.ORCHESTRION_MAC_SIGN_IDENTITY = identity;
    const signed = require("../electron-builder.signed.cjs");
    assert.equal(unsigned.mac.identity, null);
    assert.equal(unsigned.directories.output, "dist");
    assert.equal(signed.mac.identity, "Example Company (ABCDE12345)");
    assert.equal(signed.forceCodeSigning, true);
    assert.equal(signed.mac.hardenedRuntime, true);
    assert.equal(signed.mac.notarize, true);
    assert.equal(signed.directories.output, "dist-signed");
    assert.deepEqual(signed.mac.target, ["dmg", "zip"]);
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRION_MAC_SIGN_IDENTITY;
    else process.env.ORCHESTRION_MAC_SIGN_IDENTITY = previous;
  }
});

test("DMG signing and stapling refresh only its update digest and size", async () => {
  const folder = await mkdtemp(join(tmpdir(), "orchestrion-dmg-metadata-"));
  try {
    const dmg = join(folder, "Orchestrion-0.1.0-arm64.dmg");
    const metadata = join(folder, "latest-mac.yml");
    await writeFile(dmg, "signed and stapled DMG bytes");
    await writeFile(metadata, "version: 0.1.0\nfiles:\n  - url: Orchestrion-0.1.0-arm64.zip\n    sha512: zip-digest\n    size: 10\n  - url: Orchestrion-0.1.0-arm64.dmg\n    sha512: stale-digest\n    size: 9\npath: Orchestrion-0.1.0-arm64.zip\nsha512: zip-digest\nreleaseDate: '2026-09-25T00:00:00.000Z'\n");
    await refreshDmgMetadata(metadata, dmg);
    const result = await readFile(metadata, "utf8");
    const digest = createHash("sha512").update("signed and stapled DMG bytes").digest("base64");
    assert.ok(result.includes(`  - url: Orchestrion-0.1.0-arm64.dmg\n    sha512: ${digest}\n    size: ${Buffer.byteLength("signed and stapled DMG bytes")}`));
    assert.match(result, /  - url: Orchestrion-0\.1\.0-arm64\.zip\n    sha512: zip-digest\n    size: 10/);
    assert.match(result, /path: Orchestrion-0\.1\.0-arm64\.zip\nsha512: zip-digest/);
    await writeFile(metadata, "version: 0.1.0\nfiles:\n");
    await assert.rejects(() => refreshDmgMetadata(metadata, dmg), /expected DMG asset/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
