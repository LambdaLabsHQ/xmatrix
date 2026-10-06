#!/usr/bin/env node
import process from "node:process";
import { androidVersion } from "./android-common.mjs";

process.env.RELEASE_TAG = `android-v${androidVersion}`;
process.env.RELEASE_TITLE = `Android v${androidVersion}`;
process.env.RELEASE_NOTES = `Android release v${androidVersion}. APK download: https://xmatrix.sh/api/android/releases/stable/latest.apk`;
process.env.RELEASE_PRERELEASE = "false";
process.env.RELEASE_FORCE_TAG = "false";

await import("./publish-github-release.mjs");
