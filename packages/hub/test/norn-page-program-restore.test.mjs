import assert from "node:assert/strict";
import test from "node:test";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const SOURCE = `after(2027-01-25T09:00:00Z)->wait\nsay(@Daniel, "check")`;
const BODY = `# Page\n\n\`\`\`norn run check\n${SOURCE}\n\`\`\`\n`;
const REMOVED = "Removed from its page";

async function sync(program) {
  const calls = [];
  const load = await compileCommonJsSourceModule(new URL("../src/norn-page-programs.ts", import.meta.url));
  const hostMod = await import("../src/norn-host.ts");
  const valueMod = await import("../src/vendor/norn/runtime/value.ts");
  const { syncPagePrograms } = load(name => ({
    "@xmatrix/db": {
      NORN_REMOVED_FROM_PAGE: REMOVED,
      PostgresNornProgramRepository: class {
        async start(input) { calls.push(["start", input.programId]); }
        async restore(input) { calls.push(["restore", input.programId]); return true; }
        async revise(input) { calls.push(["revise", input.programId]); }
        async remove(input) { calls.push(["remove", input.programId]); }
      },
      PostgresPageRepository: class {
        async read() { return { page: { title: "Page", body: BODY } }; }
        async link() {}
      },
      readDeletedConversations: async () => new Set(),
      readNornProgram: async () => undefined,
      readNornRequest: async () => undefined,
      readPageNornPrograms: async () => program ? [program] : [],
    },
    "./agent-launch-coordinator-wake": { wakeAgentLaunchCoordinator: async () => {} },
    "./page-restriction": { effectivelyRestricted: async () => false },
    "./deterministic-id": { deterministicConversationId: async (...parts) => parts.join(":") },
    "./norn-host": hostMod,
    "./norn-plan": { nornFlow: () => [] },
    "./postgres-authority-fleet": { createPostgresAuthorityDatabase: () => ({}) },
    "./postgres-message-authority": { postgresMessageRoute: async () => ({}) },
    "./product-message-append": { dispatchProductMessageAppend: async () => new Response(null, { status: 200 }) },
    "./system-conversation": { openConversation: async () => {} },
    "./vendor/norn/runtime/value": valueMod,
  })[name]);
  await syncPagePrograms({}, { spaceId: "s", pageId: "p", userId: "u" });
  return calls;
}

const program = (over) => ({ name: "check", programId: "norn-page:run-1", channelId: "ch", source: SOURCE, runs: 1,
  state: "running", stopReason: null, ledger: { ended: null }, ...over });

test("an unchanged running block is left alone", async () => {
  assert.deepEqual(await sync(program({})), []);
});

test("a block restored unchanged before its removal ended the program calls the removal off", async () => {
  assert.deepEqual(await sync(program({ stopReason: REMOVED })), [["restore", "norn-page:run-1"]]);
});

test("a block restored unchanged after its removal ended the program runs it again", async () => {
  const calls = await sync(program({ state: "failed", ledger: { ended: { at: 1, status: "failed", result: null, error: REMOVED } } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "start");
  assert.match(calls[0][1], /:2$/);
});

test("an unchanged block whose program ended on its own does not run again", async () => {
  assert.deepEqual(await sync(program({ state: "completed", ledger: { ended: { at: 1, status: "completed", result: null, error: null } } })), []);
});
