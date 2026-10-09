#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XCODE_DEVELOPER_DIR="${XCODE_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ "${XMATRIX_IOS_CLEAN_ENV:-0}" != "1" ]]; then
  exec /usr/bin/env -i \
    HOME="${HOME:-}" \
    USER="${USER:-}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    XMATRIX_IOS_CLEAN_ENV=1 \
    XCODE_DEVELOPER_DIR="$XCODE_DEVELOPER_DIR" \
    IOS_DEVELOPMENT_TEAM="${IOS_DEVELOPMENT_TEAM:-}" \
    IOS_CONFIGURATION="${IOS_CONFIGURATION:-}" \
    IOS_MARKETING_VERSION="${IOS_MARKETING_VERSION:-}" \
    IOS_BUILD_NUMBER="${IOS_BUILD_NUMBER:-}" \
    IOS_ARCHIVE_PATH="${IOS_ARCHIVE_PATH:-}" \
    IOS_EXPORT_PATH="${IOS_EXPORT_PATH:-}" \
    IOS_USE_ASC_XCODE_AUTH="${IOS_USE_ASC_XCODE_AUTH:-}" \
    SKIP_TESTFLIGHT_UPLOAD="${SKIP_TESTFLIGHT_UPLOAD:-}" \
    ASC_API_KEY_ID="${ASC_API_KEY_ID:-}" \
    ASC_API_ISSUER_ID="${ASC_API_ISSUER_ID:-}" \
    ASC_P8_PATH="${ASC_P8_PATH:-}" \
    PATH="$XCODE_DEVELOPER_DIR/usr/bin:$XCODE_DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    bash "$0"
fi

TEAM_ID="${IOS_DEVELOPMENT_TEAM:-}"
CONFIGURATION="${IOS_CONFIGURATION:-Release}"
ROOT_PACKAGE_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT_DIR/version.json" | head -n 1)"
MARKETING_VERSION="${IOS_MARKETING_VERSION:-$ROOT_PACKAGE_VERSION}"
BUILD_NUMBER="${IOS_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
ARCHIVE_PATH="${IOS_ARCHIVE_PATH:-$ROOT_DIR/build/ios/xMatrix.xcarchive}"
EXPORT_PATH="${IOS_EXPORT_PATH:-$ROOT_DIR/build/ios/export}"
EXPORT_OPTIONS="$ROOT_DIR/apps/ios/ExportOptions.plist"
PROJECT_PATH="$ROOT_DIR/apps/ios/xMatrix.xcodeproj"
SCHEME="xMatrix"
IPA_PATH="$EXPORT_PATH/xMatrix.ipa"

export DEVELOPER_DIR="$XCODE_DEVELOPER_DIR"
export PATH="$DEVELOPER_DIR/usr/bin:$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ -z "$ROOT_PACKAGE_VERSION" ]]; then
  echo "Could not resolve version.json version." >&2
  exit 2
fi

if [[ "$MARKETING_VERSION" != "$ROOT_PACKAGE_VERSION" ]]; then
  echo "IOS_MARKETING_VERSION ($MARKETING_VERSION) must match version.json version ($ROOT_PACKAGE_VERSION)." >&2
  exit 2
fi

if [[ -z "$TEAM_ID" ]]; then
  echo "IOS_DEVELOPMENT_TEAM is required, for example: IOS_DEVELOPMENT_TEAM=ABCDE12345 PNPM ios:testflight" >&2
  exit 2
fi

run_xcodebuild() {
  if [[ "${IOS_USE_ASC_XCODE_AUTH:-0}" == "1" && -n "${ASC_API_KEY_ID:-}" && -n "${ASC_API_ISSUER_ID:-}" && -n "${ASC_P8_PATH:-}" ]]; then
    xcodebuild "$@" \
      -authenticationKeyPath "$ASC_P8_PATH" \
      -authenticationKeyID "$ASC_API_KEY_ID" \
      -authenticationKeyIssuerID "$ASC_API_ISSUER_ID"
  else
    xcodebuild "$@"
  fi
}

mkdir -p "$(dirname "$ARCHIVE_PATH")" "$EXPORT_PATH"

run_xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  MARKETING_VERSION="$MARKETING_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  -allowProvisioningUpdates \
  archive

run_xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath "$EXPORT_PATH" \
  -allowProvisioningUpdates

if [[ "${SKIP_TESTFLIGHT_UPLOAD:-0}" == "1" ]]; then
  echo "IPA exported at $IPA_PATH"
  exit 0
fi

if [[ -z "${ASC_API_KEY_ID:-}" || -z "${ASC_API_ISSUER_ID:-}" || -z "${ASC_P8_PATH:-}" ]]; then
  echo "ASC_API_KEY_ID, ASC_API_ISSUER_ID, and ASC_P8_PATH are required to upload to TestFlight." >&2
  echo "IPA exported at $IPA_PATH" >&2
  exit 2
fi

# Keep the key in the job's protected temporary directory. Never persist it
# into the runner user's long-lived credential directories.
export API_PRIVATE_KEYS_DIR="$(dirname "$ASC_P8_PATH")"

xcrun altool \
  --upload-app \
  --type ios \
  -f "$IPA_PATH" \
  --apiKey "$ASC_API_KEY_ID" \
  --apiIssuer "$ASC_API_ISSUER_ID"
