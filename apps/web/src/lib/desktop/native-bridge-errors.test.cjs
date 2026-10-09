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
