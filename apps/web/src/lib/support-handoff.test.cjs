const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  emptySupportHandoffDraft, isSupportableFailureNotice, supportHandoffCardOf, supportHandoffRequestOf,
} = require("./support-handoff.ts");

test("a support handoff starts with nothing ticked and sends nothing until the person agrees", () => {
  const draft = emptySupportHandoffDraft();
  assert.deepEqual(draft.parts, { messages: false, diagnostics: false, logs: false });
  assert.equal(draft.consent, false);
  const written = { ...draft, line: "The agent never starts" };
  assert.equal(supportHandoffRequestOf(written), undefined, "no agreement, nothing to send");
  assert.deepEqual(supportHandoffRequestOf({ ...written, consent: true }),
    { line: "The agent never starts", parts: [], consent: true }, "agreeing alone sends only the line");
  assert.equal(supportHandoffRequestOf({ ...draft, consent: true }), undefined, "the line is required");
  assert.deepEqual(supportHandoffRequestOf({ ...written, consent: true,
    parts: { ...draft.parts, messages: true } }).parts, ["messages"], "only what is ticked is included");
  assert.equal(supportHandoffRequestOf({ ...written, consent: true, parts: { ...draft.parts, logs: true } }), undefined,
    "logs are sent only after the person previewed them");
});

test("failure notices xMatrix writes offer the handoff; other messages do not", () => {
  assert.equal(isSupportableFailureNotice({ source: "machine_run_failure" }), true);
  assert.equal(isSupportableFailureNotice({ source: "turn_stalled" }), true);
  assert.equal(isSupportableFailureNotice({ xmatrixTurnRetry: { attempt: 2 } }), true);
  assert.equal(isSupportableFailureNotice({ source: "billing_notice" }), false);
  assert.equal(isSupportableFailureNotice(undefined), false);
});

test("a handoff card names its grant, or is not one", () => {
  assert.equal(supportHandoffCardOf({ supportHandoff: { grantId: "csr_1" } }), null);
  assert.deepEqual(supportHandoffCardOf({ supportHandoff: { grantId: "csr_1", spaceId: "space-1",
    parts: ["messages", "everything"] } }).parts, ["messages"]);
});
