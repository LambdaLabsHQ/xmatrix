const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRequire } = require("node:module");

const ts = require("typescript");

function loadModule(relativePath) {
  const filename = path.join(__dirname, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Not named `module`: Next's no-assign-module-variable rule fails the build.
  const loaded = { exports: {} };
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", output);
  fn(loaded.exports, createRequire(filename), loaded, filename, path.dirname(filename));
  return loaded.exports;
}

const { classifyProxyFailure, ProxySessionRefreshError } = loadModule("xmatrix-proxy-failure.ts");

test("a proxy timeout is not reported as an unavailable Hub", () => {
  const abort = new Error("The operation was aborted.");
  abort.name = "AbortError";
  const failure = classifyProxyFailure({ cause: abort, timedOut: true });
  assert.equal(failure.reason, "hub_timeout");
  assert.equal(failure.status, 504);
  assert.doesNotMatch(failure.error, /unavailable/i);
});

test("an aborted cause counts as a timeout even when the controller flag is missed", () => {
  const abort = new Error("aborted");
  abort.name = "TimeoutError";
  assert.equal(classifyProxyFailure({ cause: abort, timedOut: false }).reason, "hub_timeout");
});

test("a failed session refresh blames the session, not the Hub", () => {
  const failure = classifyProxyFailure({
    cause: new ProxySessionRefreshError(new Error("refresh rejected")),
    timedOut: false,
  });
  assert.equal(failure.reason, "session_refresh_failed");
  assert.match(failure.error, /session/i);
  assert.doesNotMatch(failure.error, /hub is unavailable/i);
});

test("a session refresh that times out still blames the session", () => {
  const failure = classifyProxyFailure({
    cause: new ProxySessionRefreshError(new Error("boom")),
    timedOut: true,
  });
  assert.equal(failure.reason, "session_refresh_failed");
});

test("only a genuine transport failure keeps the unavailable-Hub wording", () => {
  const failure = classifyProxyFailure({
    cause: new TypeError("Network connection lost."),
    timedOut: false,
  });
  assert.equal(failure.reason, "hub_unreachable");
  assert.equal(failure.status, 503);
  assert.equal(failure.error, "xMatrix hub is unavailable right now.");
});

test("every proxy catch classifies instead of hard-coding one message", () => {
  for (const relativePath of ["xmatrix-proxy.ts", "relay-v2/message-attachment-upload-proxy.ts"]) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8");
    assert.match(source, /classifyProxyFailure\(\{ cause, timedOut: controller\.signal\.aborted \}\)/, relativePath);
    assert.match(source, /logProxyFailure\(/, relativePath);
    assert.doesNotMatch(source, /"xMatrix hub is unavailable right now\."/, relativePath);
  }
});
