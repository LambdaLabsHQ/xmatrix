import assert from "node:assert/strict";
import test from "node:test";
import {
  checkNornProgram,
  eventsStream,
  nornStartLedger,
  nornStep,
} from "../src/norn-host.ts";
import { emptyLedger, evaluate } from "../src/vendor/norn/runtime/ledger.ts";
import { text } from "../src/vendor/norn/runtime/value.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;

test("P1 #1 cross-version regression: existing v1 ledger with open Std + map keeps waiting request open across Hub upgrade", () => {
  const source = `open Std
every(1d)->map(t => t)->forEach(_ => ask(@alice, "Daily check")->wait)`;

  // Simulate snapshot created by pre-#1961 Hub (v1 ledger + NORN_STD_LEGACY_V1 node numbering).
  const preUpgrade = checkNornProgram(source, { legacyStd: true });
  assert.ok(!("refusal" in preUpgrade));
  const v1Ledger = emptyLedger(0, { identityScheme: 1 });
  evaluate(preUpgrade.code, v1Ledger, 0);
  const openedAtDay1 = evaluate(preUpgrade.code, v1Ledger, DAY).opened;
  assert.equal(openedAtDay1.length, 1);
  const originalReq = openedAtDay1[0];

  // Now run the CURRENT Hub `nornStep()` against the unedited v1 snapshot:
  // the open request MUST stay open (NOT Cancelled) under its exact original ID and epoch!
  const state = {
    spaceId: "space",
    channelId: "channel",
    programId: "prog-v1",
    source,
    nowMs: DAY + 1000,
    stopReason: null,
    ledger: structuredClone(v1Ledger),
    requests: [{
      requestId: originalReq.id,
      requestRef: "rlegacy1234",
      epoch: originalReq.epoch,
      holder: originalReq.holder,
      settled: false,
      delegated: false,
      deliveryMessageId: "norn:rlegacy1234:0",
      delivered: true,
      abandoned: false,
    }],
  };
  const step1 = nornStep()(structuredClone(state));
  assert.equal(step1.result.status, "running");
  assert.equal(step1.write.ledger.requests[originalReq.id].reply, null, "existing v1 request must NOT be cancelled on upgrade");
  assert.equal(step1.write.requests.length, 1);
  assert.equal(step1.write.requests[0].requestId, originalReq.id);
  assert.equal(step1.write.requests[0].epoch, originalReq.epoch);

  // Answering the original request under its original ID & epoch settles it cleanly.
  state.ledger = step1.write.ledger;
  state.nowMs = DAY + 2000;
  const step2 = nornStep({ requestId: originalReq.id, epoch: originalReq.epoch, reply: { typed: "All clear" } })(structuredClone(state));
  assert.equal(step2.result.refusal, undefined);
  assert.equal(step2.write.ledger.requests[originalReq.id].reply?.tag, "Answered");
});

test("P1 #5: Hub excludes internal @spawn handle from external deliveries while delivering real child requests", () => {
  const source = `
    let bg = spawn(~key="worker", () => ask(@alice, "Approve deploy")->wait)
    bg->wait
  `;
  const state = {
    spaceId: "space",
    channelId: "channel",
    programId: "prog-spawn",
    source,
    nowMs: 1_000,
    stopReason: null,
    ledger: nornStartLedger(1_000),
    requests: [],
  };
  const step1 = nornStep()(structuredClone(state));
  assert.equal(step1.result.status, "running");
  // ONLY @alice's request is indexed for external delivery — @spawn is NEVER listed!
  assert.equal(step1.write.requests.length, 1);
  assert.equal(step1.write.requests[0].holder, "@alice");
  assert.equal(step1.write.requests.some(r => r.holder === "@spawn"), false);

  // Answering @alice's child request completes both the spawned task and the program.
  state.ledger = step1.write.ledger;
  state.requests = step1.write.requests.map(r => ({ ...r, deliveryMessageId: `norn:${r.requestRef}:${r.epoch}`, delivered: true, abandoned: false }));
  state.nowMs = 2_000;
  const step2 = nornStep({ requestId: step1.write.requests[0].requestId, epoch: 0, reply: { typed: "Ship it" } })(structuredClone(state));
  assert.equal(step2.result.status, "completed");
});

test("P1 #5 + contract gaps: within(2h) stays anchored, manifest form records eventErrors, and accepting returns rejection reason", () => {
  // 1. within(2h) stays anchored across Hub passes.
  const withinState = {
    spaceId: "space", channelId: "channel", programId: "prog-within",
    source: `within(2h, () => ask(@alice, "Quick check")->wait)`,
    nowMs: 10_000, stopReason: null, ledger: nornStartLedger(10_000), requests: [],
  };
  const w1 = nornStep()(structuredClone(withinState));
  const reqId = w1.write.requests[0].requestId;
  assert.equal(w1.write.ledger.requests[reqId].by, 10_000 + 2 * HOUR);
  withinState.ledger = w1.write.ledger;
  withinState.requests = w1.write.requests.map(r => ({ ...r, deliveryMessageId: `norn:${r.requestRef}:0`, delivered: true, abandoned: false }));
  withinState.nowMs = 10_000 + HOUR;
  const w2 = nornStep()(structuredClone(withinState));
  assert.equal(w2.write.ledger.requests[reqId].by, 10_000 + 2 * HOUR);

  // 2. Malformed CloudEvent payload fails runtime manifest form validation and records visible eventErrors.
  const ghState = {
    spaceId: "space", channelId: "channel", programId: "prog-gh",
    source: `GitHub.issueOpened("acme/app")->forEach(~key="i", ~each=Queue, issue => ask(@alice, issue.title)->wait)`,
    nowMs: 1_000, stopReason: null, ledger: nornStartLedger(1_000), requests: [],
  };
  const ghInit = nornStep()(structuredClone(ghState));
  const ghStreams = ghInit.write.waits.filter(eventsStream("github", "issues.opened", "acme/app"));
  ghState.ledger = ghInit.write.ledger;
  ghState.nowMs = 2_000;
  const ghBad = nornStep(undefined, {
    id: "bad-gh-1",
    streams: ghStreams,
    what: "bad",
    cloudEvent: {
      app: "github",
      kind: "issues.opened",
      source: "acme/app",
      id: "gh-bad-1",
      // `number` is declared `int`, passing `string` must fail validation and record `eventErrors`!
      data: { type: "record", fields: { number: text("NaN"), title: text("Oops"), author: text("a"), url: text("u") } },
    },
  })(structuredClone(ghState));
  assert.equal(ghBad.write.requests.length, 0);
  assert.equal(ghBad.write.ledger.eventErrors?.length, 1);

  // 3. `accepting` validator refusal is surfaced directly in `result.refusal` and request stays open for retry.
  const accState = {
    spaceId: "space", channelId: "channel", programId: "prog-acc",
    source: `ask(@alice, "Enter code")->accepting(s => if s == "bad" { Error("Code cannot be bad") } else { Ok(s) })->wait`,
    nowMs: 1_000, stopReason: null, ledger: nornStartLedger(1_000), requests: [],
  };
  const a1 = nornStep()(structuredClone(accState));
  const accReq = a1.write.requests[0];
  accState.ledger = a1.write.ledger;
  accState.requests = [{ ...accReq, deliveryMessageId: `norn:${accReq.requestRef}:0`, delivered: true, abandoned: false }];
  accState.nowMs = 2_000;
  const aReject = nornStep({ requestId: accReq.requestId, epoch: 0, reply: { typed: "bad" } })(structuredClone(accState));
  assert.equal(aReject.result.refusal, "Code cannot be bad");
  assert.equal(aReject.write.ledger.requests[accReq.requestId].reply, null);

  accState.ledger = aReject.write.ledger;
  accState.nowMs = 3_000;
  const aOk = nornStep({ requestId: accReq.requestId, epoch: 0, reply: { typed: "good" } })(structuredClone(accState));
  assert.equal(aOk.result.refusal, undefined);
  assert.equal(aOk.result.status, "completed");
});

test("P1 #2: pageProgramPreview redacts raw ledger data and runs real forward-advancing replay steps on v1 ledgers", async () => {
  const source = `let first = ask(@alice, "Secret question")->wait\nignore(first)\nask(@bob, "Follow-up")->wait`;
  const checked = checkNornProgram(source, { legacyStd: true });
  assert.ok(!("refusal" in checked));
  const v1Ledger = emptyLedger(0, { identityScheme: 1 });
  evaluate(checked.code, v1Ledger, 0);

  const load = await compileCommonJsSourceModule(new URL("../src/norn-page-programs.ts", import.meta.url));
  const hostMod = await import("../src/norn-host.ts");
  const valueMod = await import("../src/vendor/norn/runtime/value.ts");
  const { pageProgramPreview } = load(name => ({
    "@xmatrix/db": {
      PostgresNornProgramRepository: class {},
      PostgresPageRepository: class {},
      readDeletedConversations: async () => new Set(),
      readNornProgram: async () => undefined,
      readNornRequest: async () => undefined,
      readPageNornPrograms: async () => [{
        name: "main",
        channelId: "ch-1",
        state: "running",
        source,
        ledger: structuredClone(v1Ledger),
      }],
    },
    "./agent-launch-coordinator-wake": { wakeAgentLaunchCoordinator: async () => {} },
    "./page-restriction": { effectivelyRestricted: async () => false },
    "./deterministic-id": { deterministicConversationId: async () => "id" },
    "./norn-branches": { ensureAndWakeNornBranches: async () => {} },
    "./norn-facts": { seedPageFactsForProgram: async () => {}, revalidatePageFactHolds: async () => [] },
    "./norn-host": hostMod,
    "./norn-plan": { nornFlow: () => [] },
    "./postgres-authority-fleet": { createPostgresAuthorityDatabase: () => ({}) },
    "./postgres-message-authority": { postgresMessageRoute: async () => ({}) },
    "./product-message-append": { dispatchProductMessageAppend: async () => new Response() },
    "./system-conversation": { openConversation: async () => {} },
    "./vendor/norn/runtime/value": valueMod,
  })[name]);

  const pageBody = `\`\`\`norn 1 run main\n${source}\n\`\`\``;
  const [item] = await pageProgramPreview({}, { spaceId: "s", pageId: "p", currentBody: pageBody });
  const serialized = JSON.stringify(item);
  // Raw ledger & private text MUST NOT leak in preview response!
  assert.equal("ledger" in item.migration, false);
  assert.ok(!serialized.includes("Secret question"), "preview response must not leak raw request text");
  assert.ok(!serialized.includes("occurrences"), "preview response must not expose raw ledger occurrences");
  // Real forward-advancing replay actually ran and verified dispatching "Follow-up" on BOTH ledgers!
  assert.equal(item.migration.ok, true);
  assert.equal(item.migration.verified, true);
  assert.ok(item.migration.stepsExecuted >= 3);
  assert.equal(item.migration.legacyDispatchedCount, 1);
  assert.equal(item.migration.migratedDispatchedCount, 1);
});
