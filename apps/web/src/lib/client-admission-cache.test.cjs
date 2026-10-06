const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("../components/dashboard/compile-ts-modules.cjs");
const compiled = compileTsModules(__dirname, ["client-admission-cache"]);
const { ClientAdmissionCache } = compiled.exports;
test.after(compiled.dispose);

test("anonymous and authenticated query clients share in-flight and accepted admission", async () => {
  const cache = new ClientAdmissionCache();
  let finish, calls = 0;
  const check = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const anonymous = cache.read("hub/version/protocol/platform", check);
  const authenticated = cache.read("hub/version/protocol/platform", check);
  assert.equal(anonymous, authenticated);
  await Promise.resolve();
  finish(true);
  assert.equal(await authenticated, true);
  assert.equal(await cache.read("hub/version/protocol/platform", check), true);
  assert.equal(calls, 1);
});

test("failed checks retry, identity changes recheck, and socket recovery invalidates acceptance", async () => {
  const cache = new ClientAdmissionCache();
  await assert.rejects(cache.read("first", async () => { throw new Error("offline"); }));
  assert.equal(await cache.read("first", async () => "retry"), "retry");
  assert.equal(await cache.read("changed", async () => "new"), "new");
  cache.clear();
  assert.equal(await cache.read("changed", async () => "rechecked"), "rechecked");
});
