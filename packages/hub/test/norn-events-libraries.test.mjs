import assert from "node:assert/strict";
import test from "node:test";
import {
  checkNornProgram,
  diffNornProgramUpgrade,
  eventsStream,
  nornDelivery,
  nornLibBlocks,
  nornProgramProblems,
  nornStartLedger,
  nornStep,
  pageSpaceLibraries,
  pinNornProgram,
  previewNornEdit,
  verifyNornLedgerMigration,
} from "../src/norn-host.ts";
import { extractGmailEventData, nornConnectorEventSpecs } from "../src/norn-libraries.ts";
import { emptyLedger, evaluate, settle } from "../src/vendor/norn/runtime/ledger.ts";
import { text } from "../src/vendor/norn/runtime/value.ts";

function makeProgram(source, options = {}) {
  const state = {
    spaceId: "space",
    channelId: "channel",
    programId: "prog-1",
    source,
    nowMs: 1_000,
    stopReason: null,
    ledger: nornStartLedger(1_000),
    requests: [],
  };
  return {
    state,
    step(act, occurred, opts = options) {
      state.nowMs += 1_000;
      const res = nornStep(act, occurred, opts)(structuredClone(state));
      if (res.write) {
        state.ledger = res.write.ledger;
        state.requests = res.write.requests.map(request => ({
          ...request,
          deliveryMessageId: `norn:${request.requestRef}:${request.epoch}`,
          delivered: true,
          abandoned: false,
        }));
      }
      return res;
    },
  };
}

test("feedback-pro end-to-end: Gmail.receivedAt filters inside authorized scope, exposes only mailRef (zero PII), and deduplicates redeliveries", () => {
  const source = `
    open Std
    Gmail.receivedAt("feedback@xmatrix.sh", ~subjectContains="Pro invitation")
      ->forEach(~key="feedback-pro", ~each=Queue, ref =>
        run(@claude, "Triage this Pro feedback reply using @gmail:read:" ++ ref.messageId, ~about=ref, ~by=4h)->wait)
  `;
  const checked = checkNornProgram(source);
  assert.ok(!("refusal" in checked), "refusal" in checked ? checked.refusal : "");

  const prog = makeProgram(source);
  const init = prog.step();
  assert.equal(init.write.requests.length, 0);
  const mailStreams = init.write.waits.filter(eventsStream("gmail", "message.received", "gmail:feedback@xmatrix.sh"));
  assert.equal(mailStreams.length, 1);

  // 1. Irrelevant email -> 0 Agent dispatches.
  const irrelevantData = extractGmailEventData(
    "msg-irrelevant-1",
    "personal@example.com",
    "From: promo@shop.example\nTo: personal@example.com\nSubject: Weekly sale\n\nBuy now",
  );
  const p1 = prog.step(undefined, {
    id: "gmail-1",
    streams: mailStreams,
    what: "A new Gmail message is available",
    cloudEvent: {
      app: "gmail",
      kind: "message.received",
      source: "gmail:personal@example.com",
      id: "job1:msg-irrelevant-1",
      data: {
        type: "record",
        fields: {
          messageId: text(irrelevantData.messageId),
          to: { type: "list", values: irrelevantData.to.map(text) },
          subject: text(irrelevantData.subject),
          from: text(irrelevantData.from),
        },
      },
    },
  });
  assert.equal(p1.write.requests.length, 0);

  // 2. Matching email -> 1 Agent dispatch, and delivery body carries ZERO email address or subject!
  const matchingData = extractGmailEventData(
    "msg-secret-42",
    "feedback@xmatrix.sh",
    "From: vip-customer@private-corp.io\nTo: feedback@xmatrix.sh\nSubject: Re: Pro invitation - confidential pricing\n\nBody",
  );
  const matchingEvent = {
    id: "gmail-2",
    streams: mailStreams,
    what: "A new Gmail message is available",
    cloudEvent: {
      app: "gmail",
      kind: "message.received",
      source: "gmail:feedback@xmatrix.sh",
      id: "job1:msg-secret-42",
      data: {
        type: "record",
        fields: {
          messageId: text(matchingData.messageId),
          to: { type: "list", values: matchingData.to.map(text) },
          subject: text(matchingData.subject),
          from: text(matchingData.from),
        },
      },
    },
  };
  const p2 = prog.step(undefined, matchingEvent);
  assert.equal(p2.write.requests.length, 1);
  const reqId = p2.write.requests[0].requestId;
  const req = prog.state.ledger.requests[reqId];
  const delivery = nornDelivery(req, p2.write.requests[0].requestRef);
  assert.ok(delivery.body.includes("msg-secret-42"), "delivery must include stable messageId reference");
  assert.ok(!delivery.body.includes("vip-customer@private-corp.io"), "sender email must NEVER appear in public Channel delivery");
  assert.ok(!delivery.body.includes("feedback@xmatrix.sh"), "recipient email must NEVER appear in public Channel delivery");
  assert.ok(!delivery.body.includes("confidential pricing"), "email subject must NEVER appear in public Channel delivery");

  // 3. Redelivered event with the same (source, id) -> deduplicated, 0 additional dispatches!
  const pDup = prog.step(undefined, matchingEvent);
  assert.equal(pDup.write, null);
  assert.equal(Object.keys(prog.state.ledger.requests).length, 1);
});

test("GitHub built-in library (issueOpened, ciFailed, prMerged) runs through Events CloudEvents 1.0.2", () => {
  const source = `
    GitHub.ciFailed("acme/app")
      ->forEach(~key="ci", ~each=Queue, failure =>
        run(@codex, "Investigate " ++ failure.workflow ++ " on " ++ failure.branch, ~by=2h)->wait)
  `;
  const prog = makeProgram(source);
  const init = prog.step();
  const streams = init.write.waits.filter(eventsStream("github", "workflow_run.completed", "acme/app"));
  assert.equal(streams.length, 1);

  // Non-default branch failure is filtered out by GitHub.ciFailed -> 0 dispatches.
  const pFeature = prog.step(undefined, {
    id: "gh-1",
    streams,
    what: "Workflow failed",
    cloudEvent: {
      app: "github",
      kind: "workflow_run.completed",
      source: "acme/app",
      id: "github:run:10:1",
      data: {
        type: "record",
        fields: {
          workflow: text("CI"),
          conclusion: text("failure"),
          branch: text("feature/x"),
          defaultBranch: text("main"),
          url: text("https://github.com/acme/app/actions/runs/10"),
        },
      },
    },
  });
  assert.equal(pFeature.write.requests.length, 0);

  // Default branch failure dispatches @codex once.
  const pMain = prog.step(undefined, {
    id: "gh-2",
    streams,
    what: "Workflow failed",
    cloudEvent: {
      app: "github",
      kind: "workflow_run.completed",
      source: "acme/app",
      id: "github:run:11:1",
      data: {
        type: "record",
        fields: {
          workflow: text("CI"),
          conclusion: text("failure"),
          branch: text("main"),
          defaultBranch: text("main"),
          url: text("https://github.com/acme/app/actions/runs/11"),
        },
      },
    },
  });
  assert.equal(pMain.write.requests.length, 1);
  assert.equal(prog.state.ledger.requests[pMain.write.requests[0].requestId].text, "Investigate CI on main");
});

test("Page Space libraries (norn 1 lib) support pub opaque type, content-hash pinning, and 3-way upgrade diff", () => {
  const pageBody = `# Review workflow

\`\`\`norn 1 lib Review
pub opaque type ticket = { id: string }
pub let make = (id: string): ticket => { id: id }
pub let idOf = (t: ticket): string => t.id
\`\`\`

\`\`\`norn 1 run triage
needs Review
let t = Review.make("T-100")
ask(@alice, "Handle " ++ Review.idOf(t), ~by=4h)->wait
\`\`\`
`;
  assert.deepEqual(nornLibBlocks(pageBody).map(b => [b.name, b.edition, b.problem]), [["Review", "1", undefined]]);
  assert.deepEqual(nornProgramProblems(pageBody), []);

  const libs = pageSpaceLibraries(pageBody);
  const runSource = `needs Review\nlet t = Review.make("T-100")\nask(@alice, "Handle " ++ Review.idOf(t), ~by=4h)->wait`;
  const prog = makeProgram(runSource, { libraries: libs });
  const first = prog.step();
  assert.equal(first.write.requests.length, 1);
  // Subsequent pass without passing `options.libraries` still works via `ledger.pinnedLibraries`!
  const second = prog.step(
    { requestId: first.write.requests[0].requestId, epoch: 0, reply: { typed: "Done" } },
    undefined,
    {},
  );
  assert.equal(second.result.status, "completed");

  // Content-hash pinning & 3-way upgrade diff detect library upgrade and require explicit adoption.
  const pin1 = pinNornProgram(runSource, libs);
  assert.ok(!("refusal" in pin1));
  assert.ok(pin1.libraries.Review);
  const upgradedLib = `pub opaque type ticket = { id: string }\npub let make = (id: string): ticket => { id: id }\npub let idOf = (t: ticket): string => "ITEM-" ++ t.id`;
  const diff = diffNornProgramUpgrade(
    { source: runSource, libraries: libs },
    { source: runSource, libraries: { Review: upgradedLib } },
  );
  assert.ok(!("refusal" in diff));
  assert.equal(diff.requiresExplicitAdoption, true);
  assert.equal(diff.interfaces.find(i => i.library === "Review")?.change, "NONE");
});

test("read-only previewNornEdit and verifyNornLedgerMigration preserve legacy request IDs and epochs", () => {
  const before = `open Std\nevery(1d)->forEach(~key="daily", _ => run(@auto, "Check", ~by=1h)->wait)`;
  const after = `open Std\nevery(12h)->forEach(~key="daily", _ => run(@auto, "Check", ~by=1h)->wait)`;

  const ledger = emptyLedger(0);
  const checkedBefore = checkNornProgram(before);
  assert.ok(!("refusal" in checkedBefore));
  evaluate(checkedBefore.code, ledger, 0);
  const p1 = evaluate(checkedBefore.code, ledger, 86_400_000);
  settle(ledger, p1.opened[0].id, "@auto", { tag: "Answered", value: { type: "record", fields: { text: text("ok") } } }, 86_400_000 + 1000);
  evaluate(checkedBefore.code, ledger, 86_400_000 + 1000);

  const preview = previewNornEdit(before, after, ledger, 86_400_000 + 2000);
  assert.ok(!("refusal" in preview));
  assert.equal(preview.opened.length, 0);
  assert.equal(preview.loops[0].status, "rescheduled");

  // Legacy v1 ledger migration verification (read-only, preserves original request ID and epoch).
  const legacySrc = `ask(@alice, "Approve release?", ~by=1d)->wait`;
  const v1 = emptyLedger(0, { identityScheme: 1 });
  const checkedLegacy = checkNornProgram(legacySrc);
  assert.ok(!("refusal" in checkedLegacy));
  const legacyOpen = evaluate(checkedLegacy.code, v1, 0).opened[0];
  const verified = verifyNornLedgerMigration(legacySrc, v1, 100, [
    { kind: "reply", requestId: legacyOpen.id, holder: "@alice", reply: { tag: "Answered", value: text("yes") }, at: 200 },
  ]);
  assert.ok(!("refusal" in verified));
  assert.equal(verified.migration.ok, true);
  assert.equal(verified.report?.ok, true);
  assert.equal(v1.identityScheme, 1, "verifyNornLedgerMigration must never mutate the input ledger");
});

test("connector event manifests declare typed Norn Events kinds and fields for connected apps", () => {
  const github = nornConnectorEventSpecs("github");
  const gmail = nornConnectorEventSpecs("gmail");
  assert.ok(github.some(e => e.kind === "issues.opened" && e.fields.some(f => f.name === "number")));
  assert.ok(github.some(e => e.kind === "workflow_run.completed" && e.fields.some(f => f.name === "conclusion")));
  assert.ok(gmail.some(e => e.kind === "message.received" && e.fields.some(f => f.name === "messageId")));
});
