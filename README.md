# Orchestrion Desktop

Orchestrion is an open source macOS desktop client for local Codex sessions and governed work. This repository contains the desktop application only. The Orchestrion backend and web application are maintained separately.

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

`pnpm dist` creates a local unsigned macOS arm64 DMG and ZIP. An unsigned package is only for development. `pnpm dist:signed:check` checks a Developer ID Application identity and Apple notarization credentials on the build Mac. `pnpm dist:signed` creates signed artifacts and submits the app for notarization; it does not create a GitHub Release.

The signing certificate and private key must be installed in macOS Keychain. A `notarytool` app-specific-password profile can be stored there and selected using `APPLE_KEYCHAIN_PROFILE`; the password stays in Keychain. Do not commit credentials or place passwords in command arguments.

```sh
export ORCHESTRION_MAC_SIGN_IDENTITY='Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)'
export APPLE_KEYCHAIN_PROFILE=OrchestrionNotary
pnpm dist:signed:check
pnpm dist:signed
```

The app must pass signature, notarization, Gatekeeper, installer, and old-version-to-new-version update checks before a public Release. The DMG still needs its own stapled notarization ticket. No public Release is available yet.

## License

Apache-2.0. See [LICENSE](LICENSE). This repository's license covers its own source; dependencies retain their respective licenses.
