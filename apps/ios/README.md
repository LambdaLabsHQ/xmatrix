# xMatrix iOS

This is a native iOS shell for the existing xMatrix web app. Electron cannot run on iOS, so this target reuses the same `/app` web surface through `WKWebView` and injects a compatible `window.xmatrixDesktop` bridge.

## Open in Xcode

```sh
open apps/ios/xMatrix.xcodeproj
```

Select the `xMatrix` scheme, choose an iPhone simulator or device, then run.

## Web URL

The app loads `https://xmatrix.sh/app` by default. For local development, edit `XMatrixWebURL` in `xMatrix/Info.plist` to a reachable URL such as:

```xml
<string>http://localhost:3001/app</string>
```

When running on a physical device, use the Mac LAN IP instead of `localhost`.

## TestFlight

The release helper archives, exports, and uploads the app:

```sh
IOS_DEVELOPMENT_TEAM=YOUR_APPLE_TEAM_ID \
IOS_BUILD_NUMBER=2026050601 \
ASC_API_KEY_ID=YOUR_APP_STORE_CONNECT_KEY_ID \
ASC_API_ISSUER_ID=YOUR_APP_STORE_CONNECT_ISSUER_ID \
ASC_P8_PATH=/path/to/AuthKey_YOUR_KEY_ID.p8 \
PNPM ios:testflight
```

The TestFlight marketing version is the root `version.json` version. `IOS_MARKETING_VERSION` may only be set to that same value; mismatches fail before archiving.

Set `SKIP_TESTFLIGHT_UPLOAD=1` to stop after exporting the IPA.

## Bridge compatibility

The injected bridge mirrors the Electron preload API used by `apps/web/src/lib/desktop/bridge.ts`:

- `getContext`, `setBadge`, `notify`, and `openExternal` map to native iOS APIs.
- `checkCliInstalled` always returns `{ "installed": false }`.
- Desktop auto-update methods return a disabled status because iOS updates are handled by the App Store or TestFlight.
- `xmatrix://channel/:id` and `xmatrix://login?...` deep links are mapped to the same web routes as the Electron app.

## Native mobile tab dock

On iPhone the bottom tab dock is rendered by a native UIKit tab bar instead of the web surface. The dock has Pages, Channels, Agents, and More, in the web dock's order.

- The app targets iOS 26 and uses the system `UITabBar` without a custom appearance. It is hosted by a transparent controller with no content child, so the native dock never covers the `WKWebView`. iOS supplies the native selection treatment and accessibility adaptations; the app does not simulate those with gradients, materials, overlays, or shaders.
- The dock floats on the screen bottom, not on the home-indicator inset. Its side and bottom gap is the display corner radius minus the capsule's own corner radius (never under 12pt, and never so wide that the capsule is under 240pt), so the capsule shares a center with the device corners. The web layer receives that gap and the capsule's height above the home indicator.
- The app is one `WKWebView`. A tab tap calls `onMobileTabChange` listeners in that page, which switch to the tab's pane; the web shell keeps one mounted pane per dock tab, so switching tabs never loads, boots, or rebuilds a screen. Deep links load in the same page.
- `setMobileTabState({ visible, activeView })` reports the page's current view and whether the dock shows; the native bar highlights the tab that owns the view (Pages, Channels and Agents own themselves, every other view is in More). The web layer also sends `spaceId` and `userId`, which only older app builds that kept a page per tab use.
- The web-rendered `MobileTabDock` is hidden when the iOS shell is detected, so only the native capsule dock is visible.

## Native startup regression tests

Run `xcodebuild -project apps/ios/xMatrix.xcodeproj -scheme xMatrix -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test` from the repository root (or select another available iOS 26 simulator).

The `xMatrixTests` target exercises the production coordinator with real `WKWebView` instances whose top-level `load` calls are recorded instead of sent to the network. It verifies single-page startup, tab taps that switch panes without loading, deep links in the same page, foreground resume, and bridge state decoding. These are lifecycle tests, not end-to-end network latency benchmarks.
