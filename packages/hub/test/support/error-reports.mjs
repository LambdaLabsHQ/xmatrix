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

/** Decode the actual exception events delivered to the test's transport. */
export function exceptionEvents(envelopes) {
  return envelopes.flatMap(body => body.split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  })).filter(value => value?.event_id && value.exception);
}
