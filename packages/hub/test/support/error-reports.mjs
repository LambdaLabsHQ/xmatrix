import { startErrorReporting } from "@xmatrix/protocol/error-reporting";

/** Capture real Sentry envelopes without sending them outside the test. */
export function captureErrorReports(t) {
  const envelopes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    envelopes.push(String(init.body));
    return new Response(null, { status: 200 });
  });
  startErrorReporting({ dsn: "https://public@errors.example.test/1", release: "test", component: "hub" });
  return envelopes;
}
