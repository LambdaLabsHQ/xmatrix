import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SummonDecisionClock,
} from "../src/summon-decision-clock.ts";
function fixture(maintain) {
  let stored, alarm = null;
  const storage = { async get() { return stored; }, async put(_key, value) { stored = value; },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } };
  return { clock: new SummonDecisionClock(storage, maintain, () => 1000), alarm: () => alarm };
}
test('clock is scoped, preserves earlier alarms and sleeps until authoritative due time', async () => {
  const f = fixture(async space => { assert.equal(space, 'space'); return 1_000_000; });
  await f.clock.arm('space');
  assert.equal(f.alarm(), 61000);
  await assert.rejects(f.clock.arm('other'));
  await f.clock.arm('space');
  assert.equal(f.alarm(), 61000);
  await f.clock.alarm();
  assert.equal(f.alarm(), 1_000_000);
  await f.clock.arm('space');
  assert.equal(f.alarm(), 61000);
});
test('failed maintenance keeps a recovery alarm, while an idle Space stops waking', async () => {
  const f = fixture(async () => { throw new Error('database unavailable'); });
  await f.clock.arm('space');
  await assert.rejects(f.clock.alarm());
  assert.equal(f.alarm(), 301000);
  const idle = fixture(async () => null);
  await idle.clock.arm('space'); await idle.clock.alarm();
  assert.equal(idle.alarm(), null);
});

test('a summon can arm during cleanup and its wake is not erased by an idle result', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = fixture(async () => { started(); await pending; return null; });
  await f.clock.arm('space');
  const cleanup = f.clock.alarm();
  await entered;
  await f.clock.arm('space');
  assert.equal(f.alarm(), 61000);
  finish(); await cleanup;
  assert.equal(f.alarm(), 61000);
});
