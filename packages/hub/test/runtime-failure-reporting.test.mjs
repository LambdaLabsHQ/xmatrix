import assert from "node:assert/strict";
import test from "node:test";
import { sendErrorReports, startErrorReporting } from "@xmatrix/protocol/error-reporting";
import { RuntimeSocketState } from "../src/runtime-transport/ordered-socket-dispatch.ts";

test("unclassified socket failures retain bounded origin names in the Sentry envelope (XMATRIX-HUB-7H)", async () => {
  const envelopes = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    envelopes.push(String(init.body));
    return new Response("{}", { status: 200 });
  };
  try {
    startErrorReporting({ dsn: "https://key@o1.ingest.us.sentry.io/2", release: "test", component: "hub" });
    const error = new Error("token=PRIVATE_SENTINEL");
    error.stack = [
      "Error: token=PRIVATE_SENTINEL",
      "    at verifySignedMachineDaemonCredential (index.js:10:2)",
      "    at async verifyMachineDaemonCredential (index.js:20:2)",
      "    at async PostgresMachineDaemonPort.refresh (index.js:30:2)",
      "    at async MachineDaemonRuntimeTransport.refresh (index.js:40:2)",
      "    at ignoredFifthFrame (index.js:50:2)",
    ].join("\n");
    const replies = [];
    const sockets = new RuntimeSocketState("test", (_id, message, failure) => ({ message, failure }), () => {});
    await sockets.answerOperation({ send: (raw) => replies.push(JSON.parse(raw)) }, "refresh", "Request failed",
      async () => { throw error; });
    await sendErrorReports();
    const events = envelopes.flatMap((body) => body.split("\n").map((line) => JSON.parse(line)))
      .filter((item) => item.event_id && item.exception);
    assert.equal(events.length, 1);
    assert.match(events[0].exception.values[0].value,
      /origin=verifySignedMachineDaemonCredential,verifyMachineDaemonCredential,PostgresMachineDaemonPort.refresh,MachineDaemonRuntimeTransport.refresh/u);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|ignoredFifthFrame|\[Array\]/u);
    assert.equal(replies[0].failure.code, "runtime.session_failed");
    assert.equal(replies[0].failure.retryable, false);
    assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_SENTINEL|verifySigned/u);
  } finally {
    globalThis.fetch = fetch;
  }
});
