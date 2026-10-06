import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

// Exercise the installed dependency, not a reimplementation of its URL logic.
const require = createRequire(import.meta.url);
const source = await readFile(join(dirname(require.resolve("wrangler")), "ProxyWorker.js"), "utf8");
const { ProxyWorker } = await import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=wrangler-ProxyWorker.js`).toString("base64")}`);

function fixture(t) {
  // Workerd's Headers has getAll(Set-Cookie); Node exposes getSetCookie.
  Object.defineProperty(Headers.prototype, "getAll", {
    configurable: true,
    value(name) {
      assert.equal(name.toLowerCase(), "set-cookie");
      return this.getSetCookie();
    },
  });
  t.after(() => { delete Headers.prototype.getAll; });
  const errors = [];
  const proxy = new ProxyWorker({}, {
    PROXY_CONTROLLER_AUTH_SECRET: "test-controller-secret",
    PROXY_CONTROLLER: {
      async fetch(_url, init) {
        errors.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      },
    },
  });
  proxy.proxyData = {
    userWorkerUrl: { protocol: "http:", hostname: "127.0.0.1", port: "12345" },
  };
  return { proxy, errors };
}

for (const method of ["POST", "GET", "HEAD"]) {
  test(`unchanged downstream ${method} preserves the original error on a non-root URL`, async (t) => {
    const { proxy, errors } = fixture(t);
    const failure = new Error("fixture downstream connection reset");
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw failure; });
    let outcome;
    proxy.fetch(new Request("http://localhost/api/channels?limit=20", { method }))
      .then((response) => { outcome = response; }, (error) => { outcome = error; });
    await setImmediate();
    assert.equal(outcome, failure, "must not misreport a restart or indefinitely queue a GET");
    assert.equal(errors[0]?.error.message, failure.message);
    assert.equal(proxy.requestRetryQueue.size, 0);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test("a genuinely changed downstream never replays a POST", async (t) => {
  const { proxy, errors } = fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    proxy.proxyData.userWorkerUrl.port = "12346";
    throw new Error("old downstream closed");
  });
  const response = await proxy.fetch(new Request("http://localhost/api/channels", { method: "POST" }));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /restarted mid-request/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(proxy.requestRetryQueue.size, 0);
  assert.equal(errors.length, 0);
});

test("a genuinely changed downstream still queues a GET until resumed", async (t) => {
  const { proxy, errors } = fixture(t);
  let first = true;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    if (first) {
      first = false;
      proxy.proxyData.userWorkerUrl.port = "12346";
      throw new Error("old downstream closed");
    }
    return new Response("new downstream");
  });
  const pending = proxy.fetch(new Request("http://localhost/api/channels?limit=20"));
  await setImmediate();
  assert.equal(proxy.requestRetryQueue.size, 1);
  assert.equal(fetch.mock.callCount(), 1);
  proxy.processQueue();
  assert.equal(await (await pending).text(), "new downstream");
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(errors.length, 0);
});
