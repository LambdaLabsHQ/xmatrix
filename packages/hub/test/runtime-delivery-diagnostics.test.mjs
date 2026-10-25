import assert from "node:assert/strict";
import test from "node:test";
import { reportError, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { RelayRuntimeLive } from "../src/relay-runtime.ts";
import { deliverToAudience, runtimeJsonRequest, RUNTIME_CHANNEL_AGENT_PRESENCE_URL } from "../src/runtime-transport/runtime-principal-delivery.ts";
import { captureErrorReports } from "./support/error-reports.mjs";
import { recordingRuntimeNamespace } from "./support/runtime-namespace.mjs";

// HUB-9Y: the original platform error has no stack. The actual sent report
// must distinguish concurrent ingress and the failed hop, without identities.
test("stackless delivery reports retain invocation-local hop evidence and never replay partial fanout", async (t) => {
  const envelopes = captureErrorReports(t);
  const calls = [];
  let releaseMessage;
  const messageStarted = Promise.withResolvers();
  const messageBlocked = new Promise(resolve => { releaseMessage = resolve; });
  const failures = [];
  const env = {
    RELAY_RUNTIME: recordingRuntimeNamespace(calls, async (cell, request) => {
      const { reason } = await request.json();
      if (reason === "update") {
        messageStarted.resolve();
        await messageBlocked;
      }
      const error = new Error("Subrequest depth limit exceeded.");
      error.stack = undefined;
      failures.push(error);
      throw error;
    }),
  };
  // The source cell served its own sockets; only the other viewer's cell is fetched.
  const publish = reason => deliverToAudience({
    env, label: "Agent presence", reason, audience: { humans: ["private-source", "private-target"] },
    self: { cellName: "user-private-source", fetch: async () => { throw new Error("served locally already"); } },
    skipSelf: true,
    request: () => runtimeJsonRequest(RUNTIME_CHANNEL_AGENT_PRESENCE_URL, { reason, private: "private-body" }),
  });
  const runtime = Object.create(RelayRuntimeLive.prototype);
  runtime.productAdapter = {
    owns: () => true,
    webSocketMessage: () => publish("update"),
    webSocketClose: () => publish("disconnect"),
  };
  // Keep the message delivery blocked while the close fails in another context.
  const message = runtime.webSocketMessage({}, "private-frame");
  const observed = message.catch(error => error);
  await messageStarted.promise;
  const closed = await runtime.webSocketClose({}, 1000, "private-reason").catch(error => error);
  releaseMessage();
  const updated = await observed;
  for (const [error, entry, reason] of [[closed, "socket_close", "disconnect"], [updated, "socket_message", "update"]]) {
    assert.equal(error.cause.errors.length, 1);
    assert.ok(failures.includes(error.cause.errors[0]), "the original platform exception stays in the cause chain");
    assert.match(error.cause.message, new RegExp(`ingress=${entry} delivery=presence route=principal source=owner target=owner reason=${reason} phase=fetch attempts=1`));
  }
  // Send one failure: Sentry intentionally deduplicates identical originating
  // platform errors; context isolation above is independent of that policy.
  reportError(closed);
  await sendErrorReports();
  const events = envelopes.flatMap(body => body.split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  })).filter(value => value?.exception);
  assert.equal(events.length, 1);
  assert.ok(events[0].exception.values.some(value => value.value.includes("ingress=socket_close")));
  assert.doesNotMatch(envelopes.join("\n"), /private-(?:source|target|body|frame|reason)|channel-private/);
  assert.deepEqual(calls.map(call => call.cell).sort(), ["user-private-target", "user-private-target"]);
});
