import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectBundle } from "../spikes/f0/inspect-bundle.mjs";

const app = resolve(process.argv[2] ?? "dist/mac-arm64/Orchestrion.app");
const resources = join(app, "Contents/Resources");
const native = "out/main/native";
const unpacked = join(resources, "app.asar.unpacked", native);
const asarPath = join(resources, "app.asar");
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve("electron-builder/package.json"))("@electron/asar");

for (const name of ["keychain.node", "node-pty/prebuilds/darwin-arm64/pty.node", "node-pty/prebuilds/darwin-arm64/spawn-helper"]) {
  const relative = join(native, name);
  assert.equal(asar.statFile(asarPath, relative).unpacked, true, `${relative} must be outside ASAR`);
  const packaged = join(unpacked, name);
  assert.ok((await stat(packaged)).isFile(), `${relative} is missing`);
  const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
  assert.equal(await digest(packaged), await digest(join("out", "main", "native", name)));
}
const helper = await stat(join(unpacked, "node-pty/prebuilds/darwin-arm64/spawn-helper"));
assert.equal(helper.mode & 0o777, 0o755, "spawn-helper must be 0755");
const bytes = await inspectBundle(app);
assert.ok(bytes < 1024 * 1024 * 1024, "F0 bundle size budget exceeded");
const executable = join(app, "Contents/MacOS/Orchestrion");
execFileSync(executable, [resolve("scripts/packaged-native-smoke.cjs"), app], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
  timeout: 20000,
});
console.log(JSON.stringify({ result: "PACKAGED_APP_NATIVE_PASS", bytes, symlinksContained: true }));
