# xMatrix Desktop

The desktop app is an Electron shell for `https://xmatrix.sh/app` with native macOS and Windows integration. Links that request a new window open in the operating system's default browser instead of replacing the app inside the Electron shell.

## Release

Production Release runs the `Desktop Release` workflow for the stable channel. The macOS build machine signs the Apple Silicon (`arm64`) DMG, ZIP, blockmaps, and `latest-mac.yml`; the Windows build machine builds the x64 NSIS installer, its blockmap, and `latest.yml`. Intel macOS is not a supported release target. Each build machine uploads its own files straight into the immutable R2 release `releases/desktop-v<version>/` (one part per platform and run attempt), and `client-publish.yml` then seals the release manifest and points `channels/desktop/dev.json` at it without transferring any artifact again. Once that build is confirmed from the dev downloads, the `Release Promote` workflow points `channels/desktop/stable.json` at the same sealed release; channels never move back to an older release. Release builds are signed when the relevant signing secrets are configured, but macOS notarization and code-signing timestamps are kept out of the blocking release path because Apple service delays can stall self-hosted runners.

The app update feed is configured as:

```text
https://xmatrix.sh/api/desktop/releases/stable
```

The web app serves those files from the sealed release the stable channel names, so a partial upload cannot take over the update feed. `https://xmatrix.sh/api/desktop/releases/dev/<asset>` serves the release waiting on dev. Public download aliases include `latest-arm64.dmg`, `latest-arm64.zip`, and `latest-x64.exe`.

## Signing

macOS releases must be Developer ID signed for direct distribution outside the Mac App Store. The release workflow fails closed when `MACOS_CSC_LINK` is absent and verifies the built app and packaged updater ZIP against the full established Developer ID requirement: bundle ID `net.madebyrobot.xmatrix`, Apple Developer ID certificate chain, and Team ID `VWN9V9V56Z`. This identity continuity is part of the Squirrel.Mac update contract: changing it strands installed clients and therefore requires an explicit compatibility and migration plan before the guardrail is changed. Windows installers can ship unsigned while the code-signing certificate is pending; users may see a SmartScreen unknown-publisher warning until `WINDOWS_CSC_LINK` is configured. Configure these repository secrets for signed release builds:

```text
MACOS_CSC_LINK
MACOS_CSC_KEY_PASSWORD
WINDOWS_CSC_LINK
WINDOWS_CSC_KEY_PASSWORD
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

Use the `MadeByRobot, LLC` Apple Developer team; set `APPLE_ID` to the Apple ID that signs for it. `APPLE_TEAM_ID` must be the Apple Developer team ID for `MadeByRobot, LLC`.

`MACOS_CSC_LINK` should be a Developer ID Application certificate, not a Mac App Store distribution certificate. It can be a base64-encoded `.p12` certificate or a URL supported by electron-builder.

`WINDOWS_CSC_LINK` should be a Windows code-signing certificate supported by electron-builder. It can be a base64-encoded certificate or a URL supported by electron-builder.
