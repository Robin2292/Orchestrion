// Runs the exact packaged utility helper as Node, without opening the app or
// touching its profile. Only a fresh random account and random marker are used.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { join, resolve } = require("node:path");

const app = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !app.endsWith(".app")) throw new Error("Expected a packaged app path");

const helper = join(app, "Contents/Frameworks/Orchestrion Helper.app/Contents/MacOS/Orchestrion Helper");
if (process.argv[3] !== "--child") {
  const result = spawnSync(helper, [__filename, app, "--child"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 20000,
  });
  const line = result.stdout?.trim();
  const allowed = new Set([
    "SYNTHETIC_KEYCHAIN_PASS", "SYNTHETIC_KEYCHAIN_DENIED:KEYCHAIN_MISSING_ENTITLEMENT",
    "SYNTHETIC_KEYCHAIN_DENIED:KEYCHAIN_INTERACTION_DENIED",
    "SYNTHETIC_KEYCHAIN_DENIED:KEYCHAIN_AUTH_DENIED",
    "SYNTHETIC_KEYCHAIN_DENIED:KEYCHAIN_OPERATION_DENIED",
    "SYNTHETIC_KEYCHAIN_DENIED:PROBE_FAILED",
    "SYNTHETIC_KEYCHAIN_DENIED:CLEANUP_UNCONFIRMED",
  ]);
  process.stdout.write(`${allowed.has(line) ? line : "SYNTHETIC_KEYCHAIN_DENIED:PROBE_PROCESS_FAILED"}\n`);
  if (result.status !== 0 || line !== "SYNTHETIC_KEYCHAIN_PASS") process.exitCode = 1;
} else {
  const native = require(join(app, "Contents/Resources/app.asar.unpacked/out/main/native/keychain.node"));
  const account = randomBytes(32).toString("hex");
  const first = randomBytes(32), second = randomBytes(32);
  let attempted = false;
  let failure;
  try {
    assert.equal(native.read(account), null);
    attempted = true;
    native.compareExchange(account, null, first);
    const firstRead = native.read(account);
    assert.ok(Buffer.isBuffer(firstRead) && firstRead.length === first.length && timingSafeEqual(firstRead, first));
    native.compareExchange(account, first, second);
    const secondRead = native.read(account);
    assert.ok(Buffer.isBuffer(secondRead) && secondRead.length === second.length && timingSafeEqual(secondRead, second));
    native.remove(account, second);
    assert.equal(native.read(account), null);
  } catch (error) {
    const allowlisted = new Set([
      "KEYCHAIN_MISSING_ENTITLEMENT", "KEYCHAIN_INTERACTION_DENIED",
      "KEYCHAIN_AUTH_DENIED", "KEYCHAIN_OPERATION_DENIED",
    ]);
    failure = allowlisted.has(error?.code) ? error.code : "PROBE_FAILED";
  } finally {
    if (attempted) {
      try {
        const current = native.read(account);
        if (current !== null) {
          const matchesFirst = current.length === first.length && timingSafeEqual(current, first);
          const matchesSecond = current.length === second.length && timingSafeEqual(current, second);
          if (!matchesFirst && !matchesSecond) throw new Error("Unexpected probe value");
          native.remove(account, matchesFirst ? first : second);
        }
        if (native.read(account) !== null) throw new Error("Probe cleanup incomplete");
      } catch { failure = "CLEANUP_UNCONFIRMED"; }
    }
    first.fill(0); second.fill(0);
  }
  if (!failure) process.stdout.write("SYNTHETIC_KEYCHAIN_PASS\n");
  else {
    process.stdout.write(`SYNTHETIC_KEYCHAIN_DENIED:${failure}\n`);
    process.exitCode = 1;
  }
}
