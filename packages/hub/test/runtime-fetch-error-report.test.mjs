import assert from "node:assert/strict";
import test from "node:test";
import { startErrorReporting } from "@xmatrix/protocol/error-reporting";
import { RelayRuntimeLive } from "../src/relay-runtime.ts";

test("Runtime reports the receiving exception before RPC obscures it and preserves its rejection", async (t) => {
  const envelopes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    envelopes.push(String(init.body));
    return new Response(null, { status: 200 });
  });
  startErrorReporting({ dsn: "https://public@errors.example.test/1", release: "test", component: "hub" });
  const original = new Error("receiving socket failed");
  const pending = [];
  let attempts = 0;
  const runtime = Object.create(RelayRuntimeLive.prototype);
  Object.assign(runtime, {
    ctx: { waitUntil: (task) => pending.push(task) },
    productAdapter: {
      deliverChannelAgentPresence() { attempts += 1; throw original; },
    },
  });
  const request = () => new Request("https://relay-runtime/internal/product/channel-agent-presence?private-query", {
    method: "POST",
    body: JSON.stringify({ channelId: "private-channel", reason: "update", card: { id: "private-agent" },
      recipients: [{ userId: "private-user", digest: false, card: true, channel: false, immediate: [] }] }),
  });
  await assert.rejects(runtime.fetch(request()), (error) => error === original);
  assert.equal(attempts, 1, "a partial broadcast must never be replayed");
  await Promise.all(pending);
  const events = envelopes.flatMap(envelope => envelope.split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line)).filter(value => value.exception));
  assert.equal(events.length, 1);
  assert.equal(events[0].tags.operation, "RelayRuntime.fetch");
  assert.equal(events[0].exception.values.at(-1).value, original.message);
  assert.ok(events[0].exception.values.at(-1).stacktrace.frames.length > 0);
  assert.doesNotMatch(envelopes.join("\n"), /private-(?:query|channel|agent|user)/u);

  const response = await runtime.fetch(new Request(request().url, { method: "POST", body: "{}" }));
  assert.equal(response.status, 400, "ordinary validation responses remain responses");
  assert.equal(attempts, 1);
  assert.equal(envelopes.length, 1);

  runtime.ctx.waitUntil = () => { throw new Error("report scheduling failed"); };
  await assert.rejects(runtime.fetch(request()), (error) => error === original);
  assert.equal(attempts, 2, "reporting failure must preserve the original delivery rejection");
});
