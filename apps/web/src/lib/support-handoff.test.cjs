const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  emptySupportHandoffDraft, isSupportableFailureNotice, supportHandoffCardOf, supportHandoffRequestOf, supportLogMachines,
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
  assert.deepEqual(supportHandoffRequestOf({ ...written, consent: true, parts: { ...draft.parts, logs: true },
    logExcerpt: "== logs/daemon.err ==\nreconnected" }),
  { line: "The agent never starts", parts: ["logs"], consent: true, logExcerpt: "== logs/daemon.err ==\nreconnected" },
  "the previewed excerpt goes with the logs part");
  assert.deepEqual(supportHandoffRequestOf({ ...written, consent: true, logExcerpt: "kept from an earlier tick" }),
    { line: "The agent never starts", parts: [], consent: true }, "an unticked box sends no excerpt");
});

test("logs are previewed from one of the person's online machines, one entry per machine", () => {
  const daemon = { status: "online", name: "daemon", machineId: "machine-1", hostname: "laptop.local" };
  assert.deepEqual(supportLogMachines([
    { ...daemon, machineName: "Work laptop" },
    { ...daemon, id: "second daemon of the same machine" },
    { ...daemon, machineId: "machine-2", status: "offline" },
    { ...daemon, machineId: undefined },
    { ...daemon, machineId: "machine-3" },
  ]), [{ machineId: "machine-1", label: "Work laptop" }, { machineId: "machine-3", label: "laptop.local" }]);
  assert.deepEqual(supportLogMachines([{ ...daemon, status: "offline" }]), [], "nothing online, nothing to read");
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
