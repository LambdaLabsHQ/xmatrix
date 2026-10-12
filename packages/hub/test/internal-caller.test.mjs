import assert from "node:assert/strict";
import test from "node:test";
import { asInternalCaller, internalCallerOf } from "../src/internal-caller.ts";

const member = { id: "member", email: "member@example.test", name: "Member" };
const header = "x-xmatrix-internal-caller";

test("only a request the Hub builds inside asInternalCaller names its caller, and only while it runs", async () => {
  assert.equal(internalCallerOf(new Request("https://hub.test/x", { headers: { [header]: "guess.guess" } })), undefined,
    "a header from outside names nobody");
  let issued;
  await asInternalCaller(member, async (headers) => {
    issued = headers[header];
    assert.equal(internalCallerOf(new Request("https://hub.test/x", { headers })), member);
    const [, key] = issued.split(".");
    assert.equal(internalCallerOf(new Request("https://hub.test/x", { headers: { [header]: `guess.${key}` } })), undefined,
      "the key alone is not enough");
  });
  assert.equal(internalCallerOf(new Request("https://hub.test/x", { headers: { [header]: issued } })), undefined,
    "a finished call's header names nobody");
});
