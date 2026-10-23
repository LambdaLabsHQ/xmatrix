# xMatrix Desktop

The desktop app is an Electron shell for the xMatrix Web of its own channel, with native macOS and Windows integration. The app's version names the channel: a beta `X.Y.Z-beta.N` loads `https://beta.xmatrix.sh/app` and a stable `X.Y.Z` loads `https://xmatrix.sh/app`. Only that exact https origin may navigate the window in place and call the bridge; the stable Web is also trusted under `www.xmatrix.sh`. `XMATRIX_DESKTOP_DEV_URL` or `XMATRIX_DESKTOP_WEB_URL` changes the page a development build opens, but never what it trusts. Links that request a new window open in the operating system's default browser instead of replacing the app inside the Electron shell.

## Release

Production Release runs the `Desktop Release` workflow for the channel the release's version names: a beta `X.Y.Z-beta.N` publishes to dev, a stable `X.Y.Z` to stable. The macOS build machine signs the Apple Silicon (`arm64`) DMG, ZIP, blockmaps, and `latest-mac.yml`; the Windows build machine builds the x64 NSIS installer, its blockmap, and `latest.yml`. Intel macOS is not a supported release target. Each build machine uploads its own files straight into the immutable R2 release `releases/desktop-v<version>/` (one part per platform and run attempt), and `client-publish.yml` then seals the release manifest and points `channels/desktop/dev.json` (beta) or `stable.json` (stable) at it without transferring any artifact again; channels never move back to an older release. Each build machine first checks the app it packaged runs as exactly the release version (`scripts/desktop-app-version.mjs`), and the installed app follows the feed its own version names: a beta updates from dev, a stable from stable. macOS release builds are Developer ID signed with a secure timestamp, notarized by Apple and stapled before they are packaged; a build Apple does not accept is not published. Notarization uses the App Store Connect API key (`ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_P8_BASE64`).

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
