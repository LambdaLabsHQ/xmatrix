import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { packageExtension, shippedManifest } from "../scripts/package.mjs";

function files(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? files(path.join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}

// The extension ships the Web's workspace app built from apps/web. This is the
// one place that build runs outside a hand-made package: a Web change that
// brings Next's server runtime into the shell, or a route into the page that
// needs the Web's server, fails here instead of at the next store upload.
test("the package is an extension Chrome loads, with the app built into it", async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-extension-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const built = await packageExtension({ out, release: "9.8.7-beta.1" });
  const shipped = files(out);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "9.8.7");
  assert.equal(manifest.key, undefined);
  assert.deepEqual(manifest.externally_connectable?.matches, ["https://xmatrix.sh/*", "https://beta.xmatrix.sh/*"]);
  const unpacked = shippedManifest(JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8")),
    { release: "9.8.7-beta.1", unpacked: true });
  assert.ok(unpacked.externally_connectable?.matches.includes("http://localhost/*"));
  for (const named of [manifest.side_panel.default_path, manifest.background.service_worker, ...Object.values(manifest.icons)]) {
    assert.ok(shipped.includes(named), `the manifest names ${named}`);
  }

  // The panel frames this page; everything it loads is in the package.
  const page = fs.readFileSync(path.join(out, "app/index.html"), "utf8");
  for (const [, file] of page.matchAll(/(?:src|href)="([^"]+)"/gu)) assert.ok(shipped.includes(`app/${file}`), `the page loads ${file}`);
  // An extension page may run no inline script, and Chrome refuses a package with a `_` name in it.
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/u);
  assert.deepEqual(shipped.filter((file) => file.split("/").some((part) => part.startsWith("_"))), []);

  // The app is the release it was built for, and its live connection's worker is beside it.
  const scripts = shipped.filter((file) => /^app\/[^/]+\.js$/u.test(file)).map((file) => fs.readFileSync(path.join(out, file), "utf8"));
  assert.ok(scripts.some((script) => script.includes("9.8.7-beta.1")));
  assert.ok(shipped.includes("app/human-socket.worker.js"));
  assert.ok(built.app.routes > 100, "the Web's proxy routes answer in the page");
  // The styles name fonts and the wood by the Web's public paths, which the package carries at its root.
  const styles = fs.readFileSync(path.join(out, "app/app.css"), "utf8");
  for (const [, file] of styles.matchAll(/url\(["']?\/([^"')]+)["']?\)/gu)) assert.ok(shipped.includes(file), `the styles load /${file}`);
  // The side panel settles width breakpoints at desktop width (so it never renders mobile chrome or sheets)
  // while preserving viewport-height units (dvh) so the panel fills Chrome's side panel height.
  assert.doesNotMatch(styles, /@media\s*\(\s*max-width\s*:\s*767px\s*\)/u);
  assert.match(styles, /\b100dvh\b/u);
  // The side panel starts on pure white so it meets Chrome's native white side-panel bar with no border or seam.
  assert.match(page, /background:\s*#ffffff/u);
  // The on-page selection ask box must override globals.css's :root:not(.dark) .xmatrix-app .app-composer
  // (position: absolute !important) with an ID selector so the composer stays in normal flow and never collapses.
  const askPage = fs.readFileSync(path.join(out, "app/ask.html"), "utf8");
  assert.match(askPage, /<html\s+id="xmatrix-ask-box"/u);
  assert.match(askPage, /#xmatrix-ask-box\s+\.xmatrix-app\s+\.app-composer\s*\{[^}]*position:\s*relative\s*!important/su);

  // Chrome Manifest V3 forbids remotely hosted code (Blue Argon): extension pages keep self-only script/frame CSP
  // and no shipped JS or HTML artifact may reference Google's remote Picker loaders or load remote scripts/code.
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  assert.match(csp, /\bscript-src 'self'/u);
  assert.match(csp, /\bframe-src 'self'(?:;|$)/u);
  assert.doesNotMatch(csp, /docs\.google\.com|apis\.google\.com/u);

  const remoteCodePatterns = [
    ["Google Picker API URL", /https?:\/\/apis\.google\.com\/js\//u],
    ["Google Identity Services script URL", /https?:\/\/accounts\.google\.com\/gsi\/client/u],
    ["gapi.load call", /\bgapi\.load\s*\(/u],
    ["document.createElement(\"script\")", /\bdocument\.createElement\s*\(\s*["'`]script["'`]\s*\)/u],
    ["remote script .src assignment", /\.src\s*=\s*["'`]https?:[^"'`]*(?:\.m?js\b|\/gsi\/|apis\.google\.com)/iu],
    ["remote HTML <script src>", /<script[^>]+src\s*=\s*["'`]https?:/iu],
    ["remote dynamic import()", /\bimport\s*\(\s*["'`]https?:/u],
    ["remote importScripts()", /\bimportScripts\s*\(\s*["'`]https?:/u],
    ["eval() call", /\beval\s*\(/u],
    ["new Function() call", /\bnew\s+Function\s*\(/u],
  ];
  for (const file of shipped.filter((name) => /\.(?:js|mjs|html)$/u.test(name))) {
    const content = fs.readFileSync(path.join(out, file), "utf8");
    for (const [label, pattern] of remoteCodePatterns) {
      assert.doesNotMatch(content, pattern, `${file} must not contain ${label}`);
    }
  }
});

// The question box a page frames is only as wide as the box: its stylesheet is the App's as a desktop window applies it.
test("the question box's stylesheet settles width queries and viewport units at a desktop window", async () => {
  const { desktopStylesheet, widthCondition } = await import("../scripts/build-app.mjs");
  assert.equal(widthCondition("(width>=48rem)"), true);
  assert.equal(widthCondition("(max-width:767px)"), false);
  assert.equal(widthCondition("(hover:hover)"), null);
  assert.equal(desktopStylesheet("@media(width>=48rem){.a{x:1}}@media(max-width:767px){.b{x:2}}"
    + "@media(hover:hover)and (min-width:640px){.c{x:3}}@media(prefers-reduced-motion:reduce){.d{x:4}}"),
  ".a{x:1}@media(hover:hover){.c{x:3}}@media(prefers-reduced-motion:reduce){.d{x:4}}");
  assert.equal(desktopStylesheet(".f{max-height:min(9rem,34dvh)}"), ".f{max-height:min(9rem,272px)}");
  assert.equal(
    desktopStylesheet("@media(width>=48rem){.a{height:100dvh}}@media(max-width:767px){.b{height:50dvh}}", 1280, 800, { viewportUnits: false }),
    ".a{height:100dvh}",
  );
});
