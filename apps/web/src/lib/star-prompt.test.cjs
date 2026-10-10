const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  FIRST_ASK_AFTER_ANSWERS,
  QUIET_AFTER_PUT_OFF_MS,
  afterAgentAnswer,
  afterOpeningRepository,
  afterPutOff,
  readStarPromptRecord,
  writeStarPromptRecord,
} = require("./star-prompt.ts");

function memoryStorage(initial) {
  let value = initial ?? null;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
}

function answer(record, times, now) {
  let ask = false;
  for (let index = 0; index < times; index += 1) ({ record, ask } = afterAgentAnswer(record, now));
  return { record, ask };
}

test("the first ask waits for the product to have answered a few times", () => {
  const fresh = readStarPromptRecord(memoryStorage());
  assert.equal(answer(fresh, FIRST_ASK_AFTER_ANSWERS - 1, 0).ask, false);
  assert.equal(answer(fresh, FIRST_ASK_AFTER_ANSWERS, 0).ask, true);
});

test("putting an ask off doubles the answers it waits for and keeps three days quiet", () => {
  const now = 1_000_000;
  const asked = answer(readStarPromptRecord(memoryStorage()), FIRST_ASK_AFTER_ANSWERS, now).record;
  const putOff = afterPutOff(asked, now);

  // Enough answers, but still inside the quiet days.
  const early = answer(putOff, FIRST_ASK_AFTER_ANSWERS * 2, now + QUIET_AFTER_PUT_OFF_MS - 1);
  assert.equal(early.ask, false);
  // The quiet days are over: the answer that arrives next asks.
  assert.equal(afterAgentAnswer(early.record, now + QUIET_AFTER_PUT_OFF_MS).ask, true);

  // Past the quiet days, but not yet twice as many answers.
  assert.equal(answer(putOff, FIRST_ASK_AFTER_ANSWERS * 2 - 1, now + QUIET_AFTER_PUT_OFF_MS).ask, false);
  // A second put-off doubles again.
  assert.equal(afterPutOff(putOff, now).askAfter, FIRST_ASK_AFTER_ANSWERS * 4);
});

test("opening the repository ends the asking for good, across reloads", () => {
  const storage = memoryStorage();
  writeStarPromptRecord(storage, afterOpeningRepository(readStarPromptRecord(storage)));
  assert.equal(answer(readStarPromptRecord(storage), 1_000, Number.MAX_SAFE_INTEGER).ask, false);
});

test("a record this module did not write counts as never asked", () => {
  for (const stored of ["not json", "null", "[]", '{"answers":-1,"askAfter":5}', '{"answers":2,"askAfter":0}']) {
    assert.deepEqual(readStarPromptRecord(memoryStorage(stored)), { answers: 0, askAfter: FIRST_ASK_AFTER_ANSWERS });
  }
  assert.deepEqual(readStarPromptRecord({ getItem() { throw new Error("storage is blocked"); }, setItem() {} }),
    { answers: 0, askAfter: FIRST_ASK_AFTER_ANSWERS });
});
