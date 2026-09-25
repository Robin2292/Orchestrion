import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalKeychainInputs } from "./build-local-keychain.mjs";

const identity = "Developer ID Application: Example (EXAMPLE123)";
const profile = {
  TeamIdentifier: ["EXAMPLE123"],
  Platform: ["OSX"],
  ProvisionsAllDevices: true,
  ExpirationDate: "2030-01-01T00:00:00Z",
  Entitlements: {
    "com.apple.developer.team-identifier": "EXAMPLE123",
    "com.apple.application-identifier": "EXAMPLE123.com.orchestrion.desktop.helper",
  },
};

test("only the exact provisioned utility helper identity is accepted", () => {
  const inputs = { identity, identities: [identity], profile, now: new Date("2026-09-25") };
  assert.equal(validateLocalKeychainInputs(inputs), "EXAMPLE123");
  assert.equal(validateLocalKeychainInputs({ ...inputs, profile: {
    ...profile, Entitlements: {
      "com.apple.developer.team-identifier": "EXAMPLE123",
      "application-identifier": "EXAMPLE123.com.orchestrion.desktop.helper",
    },
  } }), "EXAMPLE123");
  assert.throws(() => validateLocalKeychainInputs({ ...inputs, identities: [] }), /valid installed/);
  assert.throws(() => validateLocalKeychainInputs({ ...inputs, profile: {
    ...profile, Entitlements: { ...profile.Entitlements,
      "com.apple.application-identifier": "EXAMPLE123.com.orchestrion.desktop" },
  } }), /exact Orchestrion utility helper/);
  assert.throws(() => validateLocalKeychainInputs({ ...inputs, profile: {
    ...profile, Platform: ["iOS"],
  } }), /macOS Developer ID/);
  assert.throws(() => validateLocalKeychainInputs({ ...inputs, profile: {
    ...profile, ProvisionsAllDevices: false,
  } }), /macOS Developer ID/);
  assert.throws(() => validateLocalKeychainInputs({ ...inputs, now: new Date("2031-01-01") }), /expired/);
});
