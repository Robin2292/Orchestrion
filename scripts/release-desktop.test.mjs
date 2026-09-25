import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { expectedArtifacts, parseArgs, preflight, verifyArtifacts, verifyDistributionPrerequisites } from "./release-desktop.mjs";

const pkg = {
  version: "1.2.3",
  build: {
    productName: "Orchestrion", artifactName: "${productName}-${version}-${arch}.${ext}",
    directories: { output: "dist" }, mac: { target: ["dmg", "zip"] },
    publish: { provider: "github", owner: "Example", repo: "Orchestrion" },
  },
};
const runtime = { node: "22.23.3", platform: "darwin", arch: "arm64" };
const folders = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("desktop release rehearsal gates", () => {
  it("requires a stable version, rejects publish flags and derives deterministic assets", () => {
    assert.deepEqual(parseArgs(["--version", "1.2.3", "--dry-run"]), { version: "1.2.3", dryRun: true, checkDistributionPrerequisites: false });
    assert.throws(() => parseArgs(["--version", "1.2.3", "--publish"]), /Unsupported argument/);
    assert.throws(() => parseArgs(["--version", "1.2.3-beta.1"]), /stable semver/);
    assert.throws(() => parseArgs(["--version", "01.2.3"]), /stable semver/);
    assert.throws(() => parseArgs(["--version", "1.2.3", "--dry-run", "--check-distribution-prerequisites"]), /built artifact/);
    assert.throws(() => parseArgs(["--version", "1.2.3", "--check-publish-ready"]), /Unsupported argument/);
    assert.throws(() => expectedArtifacts(pkg, "1.2.4"), /must match/);
    assert.match(expectedArtifacts(pkg, "1.2.3").zip, /Orchestrion-1\.2\.3-arm64\.zip$/);
    assert.match(expectedArtifacts(pkg, "1.2.3", "dist-signed").zip, /dist-signed\/Orchestrion-1\.2\.3-arm64\.zip$/);
  });

  it("fails closed on wrong runtime, dirty checkout, or existing local tag", () => {
    const clean = (file, args) => args[0] === "status" ? "" : "";
    assert.equal(preflight(pkg, { version: "1.2.3" }, clean, runtime).tag, "desktop-v1.2.3");
    assert.throws(() => preflight(pkg, { version: "1.2.3" }, clean, { ...runtime, node: "26.0.0" }), /Node 22/);
    assert.throws(() => preflight(pkg, { version: "1.2.3" }, () => " M file", runtime), /clean/);
    assert.throws(() => preflight(pkg, { version: "1.2.3" }, (file, args) => args[0] === "tag" ? "desktop-v1.2.3" : "", runtime), /already exists/);
  });

  it("verifies both assets, top-level ZIP fields, package version, and native smoke", async () => {
    const folder = await mkdtemp(join(tmpdir(), "desktop-release-test-")); folders.push(folder);
    const app = join(folder, "Orchestrion.app"); await mkdir(app);
    const zip = join(folder, "Orchestrion-1.2.3-arm64.zip");
    const dmg = join(folder, "Orchestrion-1.2.3-arm64.dmg");
    const metadata = join(folder, "latest-mac.yml");
    await writeFile(zip, "zip bytes"); await writeFile(dmg, "dmg bytes");
    const zipDigest = createHash("sha512").update("zip bytes").digest("base64");
    const dmgDigest = createHash("sha512").update("dmg bytes").digest("base64");
    const validMetadata = `version: 1.2.3\nfiles:\n  - url: Orchestrion-1.2.3-arm64.zip\n    sha512: ${zipDigest}\n    size: 9\n  - url: Orchestrion-1.2.3-arm64.dmg\n    sha512: ${dmgDigest}\n    size: 9\npath: Orchestrion-1.2.3-arm64.zip\nsha512: ${zipDigest}\nreleaseDate: '2026-09-24T00:00:00.000Z'\n`;
    await writeFile(metadata, validMetadata);
    const expected = { app, zip, dmg, metadata, tag: "desktop-v1.2.3", repo: "Example/Orchestrion" };
    const calls = [];
    const run = (file, args) => { calls.push([file, ...args]); return file === "plutil" ? "1.2.3" : ""; };
    await verifyArtifacts(expected, run);
    assert.ok(calls.some(call => call[0] === "node" && call[1] === "scripts/verify-packaged-app.mjs" && call[2] === app));
    for (const [malformed, reason] of [
      [validMetadata.replace("Orchestrion-1.2.3-arm64.dmg", "other.dmg"), /asset name/],
      [validMetadata.replace(dmgDigest, "wronghash"), /checksum/],
      [validMetadata.replace("    size: 9\npath:", "    size: 10\npath:"), /size/],
      [validMetadata.replace("path: Orchestrion-1.2.3-arm64.zip", "path: other.zip"), /Top-level update path/],
      [validMetadata.replace(`\nsha512: ${zipDigest}\nreleaseDate:`, "\nsha512: wronghash\nreleaseDate:"), /Top-level update checksum/],
      [validMetadata.replace("releaseDate:", "extra: surprise\nreleaseDate:"), /release date/],
    ]) {
      await writeFile(metadata, malformed);
      await assert.rejects(() => verifyArtifacts(expected, run), reason);
    }
    await writeFile(metadata, validMetadata);
    await rm(dmg);
    await assert.rejects(() => verifyArtifacts(expected, run), /ENOENT/);
  });

  it("reports only checked distribution prerequisites, not anonymous feed access", () => {
    const expected = { app: "/tmp/Orchestrion.app", dmg: "/tmp/Orchestrion.dmg", repo: "Example/Orchestrion" };
    const calls = [];
    const run = (file, args) => {
      calls.push([file, ...args]);
      if (file === "codesign" && args[0] === "-dv") return "Authority=Developer ID Application: Example\nTeamIdentifier=ABC123";
      if (file === "gh") return "PUBLIC";
      return "";
    };
    assert.deepEqual(verifyDistributionPrerequisites(expected, run), {
      developerIdSignatureVerified: true, appStapleValidated: true, dmgStapleValidated: true,
      gatekeeperAccepted: true, repositoryVisibility: "PUBLIC",
    });
    assert.equal(calls.filter(call => call[0] === "xcrun").length, 2);
    assert.ok(calls.some(call => call[0] === "spctl" && call.includes("open") && call.includes(expected.dmg)));
    assert.ok(calls.some(call => call[0] === "node" && call[1] === "scripts/packaged-keychain-smoke.cjs"));
    assert.throws(() => verifyDistributionPrerequisites(expected, (file, args) => file === "codesign" && args[0] === "-dv" ? "Authority=Ad Hoc" : "PUBLIC"), /Developer ID/);
    assert.throws(() => verifyDistributionPrerequisites(expected, (file, args) => file === "gh" ? "PRIVATE" : run(file, args)), /must be PUBLIC/);
  });
});
