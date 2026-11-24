#!/usr/bin/env node
// Builds the extension into a directory Chrome can load: its own pages and
// service worker as they are, the app built from apps/web beside them
// (build-app.mjs), and the release's version stamped into the manifest.
//
//   package.mjs                      the Chrome Web Store upload, in dist/chrome-extension
//   package.mjs --unpacked           a build to "Load unpacked", in dist/chrome-extension-unpacked
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

import { buildApp } from "./build-app.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const shipped = ["manifest.json", "assets", "icons", "src"];
/** The Web, which fetches an account's Google picture for the app (apps/web identity-avatar.tsx). */
const WEB_ORIGIN = "https://xmatrix.sh";

/**
 * Chrome allows only up to four dot-separated integers in `version`, so a beta
 * `4.7.3-beta.2` ships as version `4.7.3` with the full name in `version_name`.
 */
export function chromeVersion(release) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(release);
  if (!match) throw new Error(`Not a release version: ${release}`);
  return { version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, versionName: release };
}

/**
 * What the extension's own pages may load, the app in the side panel among
 * them: the Web's policy for the app (apps/web next.config.ts) without the
 * Web. Scripts, styles and fonts come from the package only. The Hub is the
 * one server they talk to, and a picture in a message comes from the package,
 * the Hub or the Web (an account's Google picture, fetched by the Web), never
 * from the address a message names.
 */
export function extensionPagesPolicy(hubOrigin) {
  const hub = new URL(hubOrigin);
  const socket = `${hub.protocol === "http:" ? "ws" : "wss"}://${hub.host}`;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // The Docs picker runs in Google's own frame.
    "frame-src 'self' https://docs.google.com",
    `img-src 'self' data: blob: ${hub.origin} ${WEB_ORIGIN}`,
    // Direct Internet audio and video previews load only after a reader clicks Preview.
    `media-src 'self' blob: https: ${hub.origin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${hub.origin} ${socket}`,
    "worker-src 'self'",
  ].join("; ");
}

/**
 * The manifest a build ships. The store upload drops the key: it pins an
 * unpacked build to the store item's ID, and the store refuses an upload
 * carrying it. `hubUrl` points a build at another Hub (a local stack), for
 * the service worker and the app alike.
 */
export function shippedManifest(manifest, { release, unpacked = false, hubUrl }) {
  const { version, versionName } = chromeVersion(release);
  const { key, externally_connectable: connectable, ...rest } = manifest;
  const hubOrigin = new URL(hubUrl ?? manifest.host_permissions[0]).origin;
  const externallyConnectable = connectable
    ? {
      ...connectable,
      matches: unpacked
        ? [...connectable.matches, "http://localhost/*", "http://127.0.0.1/*"]
        : connectable.matches,
    }
    : undefined;
  return {
    ...rest,
    version,
    version_name: versionName,
    ...(unpacked ? { key } : {}),
    ...(externallyConnectable ? { externally_connectable: externallyConnectable } : {}),
    host_permissions: [`${hubOrigin}/*`],
    content_security_policy: { extension_pages: extensionPagesPolicy(hubOrigin) },
  };
}

/**
 * The script the side panel injects into a tab an Agent reads (sidepanel.js readTab): Playwright's accessibility
 * snapshot, vendored under snapshot/playwright, behind `globalThis.__xmatrixPageSnapshot`.
 */
export async function buildPageSnapshot(outfile, { minify = true } = {}) {
  const vendored = path.join(root, "snapshot", "playwright");
  await esbuild.build({ entryPoints: [path.join(root, "snapshot", "page-snapshot.ts")], outfile, bundle: true,
    format: "iife", target: "chrome116", minify, logLevel: "warning",
    banner: { js: "/*! Includes Playwright's accessibility snapshot, Copyright (c) Microsoft Corporation, "
      + "Apache License 2.0: page-snapshot.LICENSE.txt */" } });
  // The Apache License asks that its text and Playwright's NOTICE go with the code.
  fs.writeFileSync(outfile.replace(/\.js$/u, ".LICENSE.txt"),
    `${fs.readFileSync(path.join(vendored, "NOTICE"), "utf8").trim()}\n\n${fs.readFileSync(path.join(vendored, "LICENSE"), "utf8")}`);
}

export async function packageExtension({ out, release, unpacked = false, hubUrl, minify = true } = {}) {
  const target = out ?? path.join(repo, "dist", unpacked ? "chrome-extension-unpacked" : "chrome-extension");
  const resolved = release ?? JSON.parse(fs.readFileSync(path.join(repo, "version.json"), "utf8")).version;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of shipped) {
    fs.cpSync(path.join(root, entry), path.join(target, entry), { recursive: true });
  }
  const manifest = shippedManifest(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")),
    { release: resolved, unpacked, hubUrl });
  fs.writeFileSync(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await buildPageSnapshot(path.join(target, "src", "page-snapshot.js"), { minify });
  const app = await buildApp({ extensionRoot: target, release: resolved, hubUrl, minify });
  return { out: target, version: manifest.version, versionName: manifest.version_name, app };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  // --release overrides version.json, for a store upload that must exceed the last one.
  const out = arg("--out");
  const built = await packageExtension({
    ...(out ? { out: path.resolve(out) } : {}),
    ...(arg("--release") ? { release: arg("--release") } : {}),
    ...(arg("--hub") ? { hubUrl: arg("--hub") } : {}),
    unpacked: process.argv.includes("--unpacked"),
    minify: !process.argv.includes("--no-minify"),
  });
  console.log(`Packaged the xMatrix Chrome extension ${built.versionName} in ${built.out}: `
    + `${(built.app.bytes / 1024 / 1024).toFixed(1)} MB of app scripts, ${built.app.routes} proxy routes in the page`);
}
