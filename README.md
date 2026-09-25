# Orchestrion Desktop

Orchestrion is an open source macOS desktop client for local Codex sessions and governed work. It also contains an early Direct Agent text path with local context and call accounting. This repository contains the desktop application only. The Orchestrion backend and web application are maintained separately.

## Requirements

- macOS arm64
- Node.js 22.23.3 and pnpm 10.33.0
- Codex CLI installed and signed in (`codex login`)

## Develop

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Run `pnpm typecheck`, `pnpm test`, `pnpm test:signing`, and `pnpm build` to check the desktop source. The files under `src/web-compat` are the small schema and hook modules needed by the desktop client, copied from the private web codebase for this standalone repository.

## Package on macOS

`pnpm dist` creates a local unsigned macOS arm64 DMG and ZIP. An unsigned package is only for development. The credential adapter runs in `Orchestrion Helper.app` and requires a Developer ID provisioning profile for the exact `com.orchestrion.desktop.helper` bundle ID. Keep that profile outside the repository. Use `pnpm dist:local-keychain:check` and `pnpm dist:local-keychain` to verify a signed local app and its Keychain access without publishing it.

`pnpm dist:signed:check` checks the Developer ID Application identity, exact Helper profile, and notarization Keychain profile on the build Mac. `pnpm dist:signed` embeds the Helper profile, signs and notarizes the App and DMG, refreshes `latest-mac.yml` after DMG stapling, and checks the packaged Keychain adapter and Gatekeeper. It does not create a GitHub Release. Use a fresh `dist-signed/` directory for each build.

The packaged app carries `build/app-update.yml`, pointing to the public `Robin2292/Orchestrion` release feed. The release verifier checks that this embedded feed matches `package.json` before an artifact can be published. Keep both files in sync if the release repository changes.

The signing certificate and private key must be installed in macOS Keychain. A `notarytool` app-specific-password profile can be stored there and selected using `APPLE_KEYCHAIN_PROFILE`; the password stays in Keychain. Do not commit credentials or place passwords in command arguments.

```sh
export ORCHESTRION_MAC_SIGN_IDENTITY='Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)'
export APPLE_KEYCHAIN_PROFILE=OrchestrionNotary
export ORCHESTRION_MAC_HELPER_PROFILE='/absolute/path/outside/repository/helper.provisionprofile'
pnpm dist:local-keychain:check
pnpm dist:signed:check
pnpm dist:signed
```

The app must pass signature, notarization, Gatekeeper, installer, anonymous feed, and old-version-to-new-version update checks before a public Release. A successful local signed build proves only the local artifact checks. No public Release is available yet.

## License

Apache-2.0. See [LICENSE](LICENSE). This repository's license covers its own source; dependencies retain their respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for copied brand icon attribution.
