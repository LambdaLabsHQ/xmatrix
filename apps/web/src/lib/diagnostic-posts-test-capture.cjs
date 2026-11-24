/**
 * Runs a test in a page whose diagnostics choice is `diagnosticsEnabled` and
 * collects the JSON bodies it posts, so a test can assert what leaves.
 */
function capturedDiagnosticPosts(t, { diagnosticsEnabled = true } = {}) {
  const previousWindow = global.window;
  global.window = {
    localStorage: {
      getItem: (key) => (diagnosticsEnabled && key === "xmatrix:diagnostics-enabled" ? "true" : null),
    },
  };
  t.after(() => {
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
