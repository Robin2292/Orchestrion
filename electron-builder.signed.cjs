const { build } = require("./package.json");

const identity = process.env.ORCHESTRION_MAC_SIGN_IDENTITY;
if (!identity || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity)) {
  throw new Error("Signed macOS builds require ORCHESTRION_MAC_SIGN_IDENTITY naming a Developer ID Application certificate.");
}

module.exports = {
  ...build,
  forceCodeSigning: true,
  directories: { ...build.directories, output: "dist-signed" },
  mac: {
    ...build.mac,
    // electron-builder selects the Developer ID type itself and rejects its prefix.
    identity: identity.slice("Developer ID Application: ".length),
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    notarize: true,
  },
};
