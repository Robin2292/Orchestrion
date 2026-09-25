const assert = require("node:assert/strict");
const { join } = require("node:path");

const app = process.argv[2];
assert.ok(app);
const native = join(app, "Contents/Resources/app.asar/out/main/native");
const keychain = require(join(native, "keychain.node"));
for (const method of ["read", "compareExchange", "remove"]) assert.equal(typeof keychain[method], "function");
// Invalid account is rejected before Security.framework receives an operation.
assert.throws(() => keychain.read("invalid"), /CREDENTIAL_UNAVAILABLE/);

const pty = require(join(native, "node-pty"));
const terminal = pty.spawn("/bin/echo", ["PACKAGED_PTY_OK"], {
  cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" },
});
let output = "";
terminal.onData(data => { output += data; });
terminal.onExit(({ exitCode }) => {
  assert.equal(exitCode, 0);
  assert.match(output, /PACKAGED_PTY_OK/);
  console.log("PACKAGED_KEYCHAIN_AND_PTY_PASS");
});
