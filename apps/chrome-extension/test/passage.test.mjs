import assert from "node:assert/strict";
import test from "node:test";

import { pagePassage } from "../src/passage.js";
import { chromeVersion, extensionPagesPolicy, shippedManifest } from "../scripts/package.mjs";

test("a passage is bounded text from a web page with a known target", () => {
  assert.deepEqual(pagePassage({ text: " line\r\nnext ", title: "Issue\n  #12", url: "https://example.test/a", target: "new" }),
    { text: "line\nnext", label: "Issue #12", href: "https://example.test/a", target: "new" });
  assert.equal(pagePassage({ text: "x", title: "Settings", url: "chrome://settings", target: "new" }), null);
  assert.equal(pagePassage({ text: "x", title: "T", url: "javascript:alert(1)", target: "current" }), null);
  assert.equal(pagePassage({ text: "x", title: "T", url: "https://example.test", target: "all" }), null);
  assert.equal(pagePassage({ text: "y".repeat(30_000), title: "T", url: "https://example.test", target: "current" }).text.length, 20_000);
});

test("a beta release ships with a version Chrome accepts and its full name beside it", () => {
  assert.deepEqual(chromeVersion("4.7.3-beta.2"), { version: "4.7.3", versionName: "4.7.3-beta.2" });
  assert.deepEqual(chromeVersion("1.0.0"), { version: "1.0.0", versionName: "1.0.0" });
  assert.throws(() => chromeVersion("4.7"), /Not a release version/u);
});

// The store refuses an upload carrying the key; without it an unpacked build
// gets another ID, which the app does not take as its side panel.
test("the store upload drops the key an unpacked build keeps, and a build for another Hub may reach only that Hub", () => {
  const manifest = { name: "xMatrix", version: "1.0.0", key: "MIIB…", host_permissions: ["https://xmatrix-hub.xmatrix.sh/*"] };
  const store = shippedManifest(manifest, { release: "4.8.0-beta.1" });
  assert.deepEqual({ ...store, content_security_policy: undefined }, { name: "xMatrix", version: "4.8.0",
    version_name: "4.8.0-beta.1", host_permissions: ["https://xmatrix-hub.xmatrix.sh/*"], content_security_policy: undefined });
  assert.equal(shippedManifest(manifest, { release: "4.8.0", unpacked: true }).key, "MIIB…");
  assert.deepEqual(shippedManifest(manifest, { release: "4.8.0", hubUrl: "http://localhost:8787/api" }).host_permissions,
    ["http://localhost:8787/*"]);
});

// A message can name any address as a picture. The Web's policy keeps a reader's browser from asking it; the
// app in the panel must be held to the same, or opening a conversation tells a stranger's server who read it.
test("the extension's pages run only packaged scripts and ask only the Hub, and no picture's own address", () => {
  const directives = (hubOrigin) => new Map(extensionPagesPolicy(hubOrigin).split("; ").map((directive) => {
    const [name, ...sources] = directive.split(" ");
    return [name, sources];
  }));
  const policy = directives("https://xmatrix-hub.xmatrix.sh");
  assert.deepEqual(policy.get("script-src"), ["'self'"]);
  assert.deepEqual(policy.get("default-src"), ["'self'"]);
  assert.deepEqual(policy.get("connect-src"), ["'self'", "https://xmatrix-hub.xmatrix.sh", "wss://xmatrix-hub.xmatrix.sh"]);
  assert.deepEqual(policy.get("img-src"), ["'self'", "data:", "blob:", "https://xmatrix-hub.xmatrix.sh", "https://xmatrix.sh"]);
  assert.deepEqual(directives("http://localhost:8787").get("connect-src"), ["'self'", "http://localhost:8787", "ws://localhost:8787"]);
});

test("a quick question opens with the same quoted head the web app writes", async () => {
  const { discussionHead, discussionTitle } = await import("../src/passage.js");
  assert.equal(discussionHead("line one\n\nline two", { label: "Issue [12]", href: "https://a.example/x" }),
    "> line one\n>\n> line two\n\n— [Issue \\[12\\]](https://a.example/x)\n\n");
  assert.equal(discussionHead("q", { label: "", href: "https://a.example/a b" }), "> q\n\n— [source](<https://a.example/a b>)\n\n");
  assert.equal(discussionTitle(`  ${"w".repeat(80)} `), `“${"w".repeat(59)}…”`);
});
