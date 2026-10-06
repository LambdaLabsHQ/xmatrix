const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const source = readFileSync(require.resolve("./google-doc-picker.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const events = [];
  const timers = new Map();
  let tokenConfig, pickerCallback;
  class View { setMimeTypes(value) { events.push(["mime", value]); return this; } }
  class Builder {
    setDeveloperKey(value) { events.push(["key", value]); return this; }
    setAppId(value) { events.push(["app", value]); return this; }
    setOAuthToken(value) { events.push(["token", value]); return this; }
    setOrigin(value) { events.push(["origin", value]); return this; }
    addView() { return this; }
    setCallback(value) { pickerCallback = value; return this; }
    build() { return { setVisible: () => events.push(["visible"]), dispose: () => events.push(["dispose"]) }; }
  }
  const sdk = { accounts: { oauth2: { initTokenClient: config => {
    tokenConfig = config; return { requestAccessToken: value => events.push(["request", value]) };
  } } }, picker: { View, PickerBuilder: Builder, ViewId: { DOCS: "docs" }, Action: { PICKED: "picked", CANCEL: "cancel" } } };
  const window = { setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id) };
  const exports = {};
  runInNewContext(code, { exports, window, document: {}, Error });
  const callbacks = { origin: "https://xmatrix.sh", onSelect: id => events.push(["selected", id]),
    onCancel: () => events.push(["cancelled"]), onError: message => events.push(["error", message]) };
  return { events, timers, functions: exports, sdk, callbacks, token: value => tokenConfig.callback(value),
    tokenError: () => tokenConfig.error_callback(), picker: value => pickerCallback(value), config: () => tokenConfig };
}
const publicConfig = { clientId: "public-client", apiKey: "public-picker-key", appId: "218762573462" };
const scope = "https://www.googleapis.com/auth/drive.file";
const grant = { access_token: "fixture-browser-selection-token", token_type: "Bearer", scope, expires_in: 3600 };

test("Picker obtains a separate per-file browser grant without incremental scope union or sending a Space token", () => {
  const f = fixture(); f.functions.openGoogleDocPicker(f.sdk, publicConfig, f.callbacks);
  assert.equal(f.config().include_granted_scopes, false);
  assert.equal(f.config().scope, scope);
  assert.equal(f.config().client_id, publicConfig.clientId);
  f.token(grant);
  assert.ok(f.events.some(event => event[0] === "token" && event[1] === grant.access_token));
  assert.ok(f.events.some(event => event[0] === "mime" && event[1] === "application/vnd.google-apps.document,application/vnd.google-apps.spreadsheet"));
  f.picker({ action: "picked", docs: [{ id: "fixture_document_1234", url: "https://evil.test" }] });
  assert.equal(f.events.filter(event => event[0] === "selected").length, 1);
  assert.equal(f.events.find(event => event[0] === "selected")[1], "fixture_document_1234");
  assert.equal(f.events.filter(event => event[0] === "dispose").length, 1);
  assert.equal(f.timers.size, 0);
  f.picker({ action: "picked", docs: [{ id: "another_document_1234" }] });
  assert.equal(f.events.filter(event => event[0] === "selected").length, 1);
});

test("cancel, timeout, unmount and late OAuth callbacks cannot select a file or retain an open Picker", () => {
  for (const mode of ["cancel", "timeout", "unmount", "late-grant"]) {
    const f = fixture(); const close = f.functions.openGoogleDocPicker(f.sdk, publicConfig, f.callbacks);
    if (mode === "late-grant") { close(); f.token(grant); }
    else {
      f.token(grant);
      if (mode === "cancel") f.picker({ action: "cancel" });
      else if (mode === "timeout") [...f.timers.values()][0]();
      else close();
      f.picker({ action: "picked", docs: [{ id: "fixture_document_1234" }] });
    }
    assert.equal(f.events.filter(event => event[0] === "selected").length, 0, mode);
    assert.equal(f.timers.size, 0, mode);
    assert.equal(f.events.filter(event => event[0] === "dispose").length, mode === "late-grant" ? 0 : 1, mode);
  }
});

test("broader scopes, malformed token responses and OAuth failures never open a Picker or expose provider errors", () => {
  for (const change of [{ scope: `${scope} https://www.googleapis.com/auth/drive` }, { token_type: "other" },
    { access_token: undefined }, { expires_in: 0 }, { error: "private-provider-error" }]) {
    const f = fixture(); f.functions.openGoogleDocPicker(f.sdk, publicConfig, f.callbacks);
    f.token({ ...grant, ...change });
    assert.equal(f.events.filter(event => event[0] === "visible").length, 0);
    assert.equal(f.events.filter(event => event[0] === "error").length, 1);
    assert.doesNotMatch(JSON.stringify(f.events), /private-provider-error/);
    assert.equal(f.timers.size, 0);
  }
  const f = fixture(); f.functions.openGoogleDocPicker(f.sdk, publicConfig, f.callbacks); f.tokenError();
  assert.equal(f.timers.size, 0);
});

test("an invalid picked address fails before server confirmation", () => {
  const f = fixture(); f.functions.openGoogleDocPicker(f.sdk, publicConfig, f.callbacks); f.token(grant);
  f.picker({ action: "picked", docs: [{ id: "../file?scope=all" }] });
  assert.equal(f.events.filter(event => event[0] === "selected").length, 0);
  assert.equal(f.events.filter(event => event[0] === "dispose").length, 1);
});
