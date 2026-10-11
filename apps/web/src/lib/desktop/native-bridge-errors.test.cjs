const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { describeError } = require("../user-facing-error.ts");

function bridge() {
  const native = fs.readFileSync(path.resolve(__dirname, "../../../../ios/xMatrix/NativeBridge.swift"), "utf8");
  const injection = /static let injectionScript = """\n([\s\S]*?)\n    """/.exec(native)[1];
  const messages = [];
  const window = { webkit: { messageHandlers: { xmatrixNative: { postMessage: message => messages.push(message) } } } };
  vm.runInNewContext(injection, { window, Error });
  return { window, messages };
}

test("native cancellation retains its type through the actual injection script and is not a defect", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const { window, messages } = bridge();
  const pending = window.xmatrixDesktop.applePurchases({ productIds: ["test-product"], restore: true });
  assert.equal(messages[0].method, "applePurchases");
  window.__xmatrixNativeResolve(messages[0].id, false, { name: "AbortError", message: "The operation was cancelled." });
  await assert.rejects(pending, error => {
    assert.equal(error.name, "AbortError");
    assert.equal(describeError(error, "Couldn't restore the purchase"), null);
    return true;
  });
  assert.equal(logged.length, 0);
});

test("ordinary native failures, including legacy cancellation text, still reach the defect boundary", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const { window, messages } = bridge();
  for (const message of ["Request Canceled", "Network connection lost"]) {
    const pending = window.xmatrixDesktop.applePurchases({ productIds: ["test-product"], restore: true });
    window.__xmatrixNativeResolve(messages.at(-1).id, false, message);
    await assert.rejects(pending, error => {
      assert.equal(error.name, "Error");
      assert.equal(error.message, message);
      assert.match(describeError(error, "Couldn't restore the purchase").message, /Something went wrong/);
      return true;
    });
  }
  assert.equal(logged.length, 2);
});

test("iOS purchase binding refusals keep an actionable reason without reporting a defect", async (t) => {
  t.mock.method(console, "error", () => {});
  const { window, messages } = bridge();
  const previousWindow = global.window;
  global.window = window;
  t.after(() => { global.window = previousWindow; });
  const reports = [];
  t.mock.method(global, "fetch", async (_url, init) => {
    reports.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  });
  for (const message of [
    "Your App Store subscription is bound to another Space. Rebinding is not supported.",
    "This App Store purchase history belongs to another Space. Restore it there; rebinding is not supported.",
  ]) {
    const pending = window.xmatrixDesktop.applePurchase({ productId: "test-product", appAccountToken: "test-token", productIds: ["test-product"] });
    window.__xmatrixNativeResolve(messages.at(-1).id, false, message);
    await assert.rejects(pending, error => {
      const shown = describeError(error, "Couldn't complete the purchase");
      assert.equal(shown.message, "Couldn't complete the purchase. Your App Store subscription belongs to another Space. Open the original Space to manage or restore it. Purchases cannot be moved between Spaces.");
      assert.equal(shown.retryable, false);
      return true;
    });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.length, 0);
});

test("native binding refusal compatibility is limited to exact iOS purchase messages", (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const previousWindow = global.window;
  global.window = { xmatrixDesktop: { client: "ios" } };
  t.after(() => { global.window = previousWindow; });
  t.mock.method(global, "fetch", async () => new Response(null, { status: 202 }));
  const refusal = new Error("Your App Store subscription is bound to another Space. Rebinding is not supported.");
  for (const [error, action, client] of [
    [refusal, "Couldn't restore the purchase", "ios"],
    [refusal, "Couldn't complete the purchase", "desktop"],
    [new Error(refusal.message + " unexpected"), "Couldn't complete the purchase", "ios"],
    [new Error("Apple purchase verification failed."), "Couldn't complete the purchase", "ios"],
  ]) {
    global.window.xmatrixDesktop.client = client;
    assert.match(describeError(error, action).message, /Something went wrong/);
  }
  assert.equal(logged.length, 4);
});
