/**
 * Runs a test in a page whose account has explicitly opted in to diagnostics
 * (`diagnosticsEnabled`) or made no choice on a stable build, as the Hub would
 * answer it, and collects the JSON bodies it posts, so a test can assert what
 * leaves.
 */
function capturedDiagnosticPosts(t, { diagnosticsEnabled = true } = {}) {
  const { configureDiagnosticsConsent } = require("./diagnostics-preference.ts");
  const previousWindow = global.window;
  global.window = {};
  configureDiagnosticsConsent({
    read: async () => ({ accountRegime: "default-ok", requestRegime: "default-ok",
      choice: diagnosticsEnabled ? "opted-in" : null }),
    write: async () => {},
  }, { build: "stable", environment: { now: () => 1, storage: null, doNotTrack: null, globalPrivacyControl: false } });
  t.after(() => {
    configureDiagnosticsConsent(null, { environment: null });
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  const sent = [];
  t.mock.method(global, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  });
  return sent;
}

module.exports = { capturedDiagnosticPosts };
