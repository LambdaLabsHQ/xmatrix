# Android Deployment

This repository includes a native Android WebView shell under `apps/android` and can run release builds from either a Linux or Windows self-hosted GitHub Actions runner. The public stable APK URL is:

```text
https://xmatrix.sh/api/android/releases/stable/latest.apk
```

## Runner Requirements

Install these on the runner host:

- GitHub Actions runner with labels such as `self-hosted, local-linux-x64` or `self-hosted, local-windows-x64`.
- JDK 21 or newer. Android CI and releases validate and reuse this runner JDK; they fall back to `actions/setup-java` only when it is unavailable.
- Android SDK command line tools, Android SDK Platform 36, build tools, and platform tools. The workflow can install these with `node scripts/android-env.mjs --install` when they are not already present.
- Node 22, or allow the workflow to install it through `actions/setup-node`.
- PNPM dependencies for the workspace. The workflow runs `pnpm install --frozen-lockfile` before building the packaged web bundle.

The workflow is `.github/workflows/android-deploy.yml`. Stable publication is a reusable workflow called only by the immutable-tag Production Release train; it has no `main` push or standalone manual publication trigger.
If `ANDROID_HOME` is not set, the workflow runs `scripts/android-env.mjs` to find SDK Platform 36 in common Windows and Linux install locations.
The installer retries and resumes interrupted command-line-tools downloads so a transient runner connection does not discard the partial transfer.

## Repository Secrets

Configure these secrets before uploading to Google Play:

- `ANDROID_KEYSTORE_BASE64`: base64 encoded release keystore.
- `ANDROID_KEYSTORE_PASSWORD`: release keystore password.
- `ANDROID_KEY_ALIAS`: release key alias.
- `ANDROID_KEY_PASSWORD`: release key password.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`: base64 encoded Google Play service account JSON.

The service account should have access to the target Play Console app.

## Repository Variables

Optional variables:

- `ANDROID_PROJECT_DIR`: defaults to `apps/android`.
- `ANDROID_BUILD_TASK`: defaults to `:app:bundleRelease`.
- `ANDROID_DEPLOY_TASK`: defaults to `:app:publishReleaseBundle`.
- `ANDROID_PLAY_TRACK`: defaults to `internal`.
- `ANDROID_DEPLOY_ON_PRODUCTION`: set to `true` in the production GitHub Environment to upload the tagged release to Play internal; otherwise the train still publishes the immutable GitHub Release without a Play upload.
- `ANDROID_GRADLE_ARGS`: extra Gradle arguments.
- `ANDROID_ADDITIONAL_TEST_TASKS`: optional extra Gradle validation tasks. The required `:app:testDebugUnitTest` and `:app:lintDebug` tasks always run and cannot be replaced.

Android release version names are always the root `version.json` version. `ANDROID_VERSION_NAME` may only be set to that same value; mismatches fail before Gradle runs.

## Release Flow

For every manually promoted production tag, the Production Release train:

1. Run `:app:testDebugUnitTest` and `:app:lintDebug` before creating any publishable artifact.
2. Build `:app:assembleRelease` and `:app:bundleRelease`.
3. Stage `xMatrix-Android-<version>.apk`, `xMatrix-Android-<version>.aab`, and `checksums.txt`.
4. Publish or update the `android-v<version>` GitHub Release, replacing same-name release assets for that version.
5. Make the APK available through `https://xmatrix.sh/api/android/releases/stable/latest.apk`.

The Android WebView loads the live `https://xmatrix.sh/app` experience by default, matching iOS behavior so web feature changes can reach users after the website is deployed. Release APKs still include a packaged web bundle generated from `apps/web` before the Gradle release build runs, but it is only used as a fallback if the main xMatrix page fails to load. Live API requests continue to use the production xMatrix services. Next.js static files are stored under `assets/xmatrix-web/next/static` in the APK because Android packaging filters asset directories that start with `_`; the WebView asset handler maps `/_next/static/...` requests back to that stored path when fallback mode is active.

The Android native bridge is registered before application JavaScript runs. AndroidX WebKit exposes it only to the trusted xMatrix origins, and native calls are accepted only from the main frame. Devices with an Android System WebView too old for the document-start message bridge show an update-required screen instead of falling back to a broader JavaScript interface.

`main` runs change-selected Android validation. Test Release runs the heavier
Android candidate check only for a version freeze (apart from the closed
one-time `0.16.4` bootstrap); ordinary same-version main pushes do not rebuild
Android. Neither path publishes a stable APK/AAB or uploads to Play.
Development testing should use local builds or the candidate evidence from a
candidate Test Release.

Android release binaries are retained only as GitHub Release assets. The workflow does not upload Actions artifacts.

The website exposes a release manifest at `https://xmatrix.sh/api/android/releases/latest`.

## Gradle Contract

The shared script passes these Gradle properties:

- `xmatrixVersionName` and `versionName`, set to the root `version.json` version.
- `xmatrixVersionCode` and `versionCode`, defaulting to the GitHub run number.
- `track`, defaulting to `internal`.
- Android injected signing properties when keystore secrets are present.
- `play.serviceAccountCredentials` and `GOOGLE_APPLICATION_CREDENTIALS` when the Play service account secret is present.

Play upload uses Gradle Play Publisher's `:app:publishReleaseBundle` task by default. The app targets Android 16 / API 36, matching the current Android SDK release line for new app builds.

Set `SKIP_ANDROID_WEB_BUNDLE=1` only for local native-shell debugging. Release builds should keep the packaged web bundle enabled.

## Local Dry Run

Build locally without Play upload:

```sh
SKIP_ANDROID_DEPLOY=1 node scripts/android-deploy.mjs
```

Upload locally with explicit files:

```sh
ANDROID_KEYSTORE_FILE=/secure/xmatrix-release.jks \
ANDROID_KEYSTORE_PASSWORD=... \
ANDROID_KEY_ALIAS=... \
ANDROID_KEY_PASSWORD=... \
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/secure/google-play.json \
ANDROID_DEPLOY_TASK=:app:publishReleaseBundle \
node scripts/android-deploy.mjs
```
