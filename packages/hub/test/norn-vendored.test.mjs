import assert from "node:assert/strict";
import test from "node:test";
import { builtinInterface, checkSource, elaborate } from "../src/vendor/norn/frontend/check/index.ts";
import { parse } from "../src/vendor/norn/frontend/parser.ts";
import { compile } from "../src/vendor/norn/runtime/code.ts";
import { emptyLedger, evaluate, settle } from "../src/vendor/norn/runtime/ledger.ts";
import { text, variant } from "../src/vendor/norn/runtime/value.ts";

const source = `type verdict = Sound | Flawed(string)
let review = run(@codex, "Review the design")->wait
switch review { | Answered(Sound) => "sound" | Answered(Flawed(why)) => why | other => fail(other) }`;

test("the vendored Norn checks a typed request and settles it on a ledger", () => {
  assert.equal(parse(source).ok, true);
  const checked = checkSource(source, { host: builtinInterface(), std: null });
  assert.deepEqual(checked.diagnostics, []);
  const code = compile(elaborate(checked.program, checked.reports));
  const ledger = emptyLedger();

  const first = evaluate(code, ledger, 0);
  assert.equal(first.status, "waiting");
  assert.equal(first.opened.length, 1);
  const [request] = first.opened;
  assert.deepEqual([request.verb, request.holder, request.text], ["run", "@codex", "Review the design"]);
  assert.equal(request.form.text, "verdict");
  assert.deepEqual(request.form.definitions.verdict.constructors.map(constructor => constructor.name), ["Sound", "Flawed"]);

  const outside = { tag: "Answered", value: { type: "record", fields: { text: text("looks fine") } } };
  assert.equal(settle(ledger, request.id, "@codex", outside, 1), false);
  assert.equal(ledger.requests[request.id].reply, null);
  assert.deepEqual(ledger.evidence.map(({ request: id, holder, reply }) => ({ id, holder, reply })),
    [{ id: request.id, holder: "@codex", reply: outside }]);
  assert.match(ledger.evidence[0].reason, /^The report must be verdict: expected one of Sound, Flawed/u);
  assert.equal(evaluate(code, ledger, 1).status, "waiting");

  assert.equal(settle(ledger, request.id, "@codex", { tag: "Answered", value: variant("Flawed", text("no owner on failure")) }, 2), true);
  const last = evaluate(code, ledger, 2);
  assert.equal(last.status, "completed");
  assert.deepEqual(last.result, text("no owner on failure"));
});
