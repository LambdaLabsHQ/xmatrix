import test from "node:test";
import assert from "node:assert/strict";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  normalizeSignupSourceHost,
  normalizeSignupSourceRef,
  parseSignupSource,
  signupSourceOfVisit,
  withSignupSource,
} = await loadTypescriptModule(new URL("../src/signup-source.ts", import.meta.url));

test("an outside referrer is kept as its domain only, without www", () => {
  assert.deepEqual(signupSourceOfVisit("https://xmatrix.page/zh", "https://www.v2ex.com/t/123?p=2"),
    { host: "v2ex.com", ref: null });
  assert.deepEqual(signupSourceOfVisit("https://xmatrix.sh/?ref=X", "https://t.co/abc"), { host: "t.co", ref: "x" });
});

test("our own hop carries the first source, and our own pages are never one", () => {
  // xmatrix.page sent the person on to xmatrix.sh with the source it saw.
  assert.deepEqual(signupSourceOfVisit("https://xmatrix.sh/login?xm_src=x.com&ref=x", "https://xmatrix.page/"),
    { host: "x.com", ref: "x" });
  assert.deepEqual(signupSourceOfVisit("https://xmatrix.sh/login", "https://xmatrix.page/"),
    { host: "direct", ref: null });
  assert.deepEqual(signupSourceOfVisit("https://beta.xmatrix.sh/app", "https://xmatrix-hub.xmatrix.sh/api/auth/callback"),
    { host: "direct", ref: null });
  assert.deepEqual(signupSourceOfVisit("http://localhost:3000/", "http://localhost:3000/login"),
    { host: "direct", ref: null });
  assert.deepEqual(signupSourceOfVisit("https://xmatrix.sh/", ""), { host: "direct", ref: null });
});

test("only short, plain values are accepted", () => {
  assert.equal(normalizeSignupSourceHost("WWW.Google.com"), "google.com");
  assert.equal(normalizeSignupSourceHost("evil.com/path"), null);
  assert.equal(normalizeSignupSourceHost("a".repeat(70) + ".com"), null);
  assert.equal(normalizeSignupSourceHost("direct"), "direct");
  assert.equal(normalizeSignupSourceRef("x"), "x");
  assert.equal(normalizeSignupSourceRef("launch_2026-11"), "launch_2026-11");
  assert.equal(normalizeSignupSourceRef("bad ref"), null);
  assert.equal(normalizeSignupSourceRef("x".repeat(33)), null);
  assert.deepEqual(parseSignupSource({ host: "x.com", ref: "x" }), { host: "x.com", ref: "x" });
  assert.deepEqual(parseSignupSource({ host: "x.com", ref: "no good" }), { host: "x.com", ref: null });
  assert.equal(parseSignupSource({ host: "https://x.com/path" }), null);
  assert.equal(parseSignupSource(null), null);
});

test("a hop adds the source to the next URL", () => {
  assert.equal(withSignupSource("https://xmatrix.sh/login?next=%2Fapp", { host: "x.com", ref: "x" }),
    "https://xmatrix.sh/login?next=%2Fapp&xm_src=x.com&ref=x");
  assert.equal(withSignupSource("https://xmatrix.sh/app?new_account=1", { host: "direct", ref: null }),
    "https://xmatrix.sh/app?new_account=1&xm_src=direct");
});
