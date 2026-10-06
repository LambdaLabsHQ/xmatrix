import assert from 'node:assert/strict';
import test from 'node:test';
import { drainDingTalkInbound } from '../dist/index.js';

/** Contract-only scoped sinks; no real native proof, Channel append or Automation occurs. */
function fixture() {
  const app = { suiteKey: 'suiteFixture',eventKeyDigest: 'a'.repeat(64) },calls = [],states = [],stored = new Set();
  const job = { appIdentity: 'dingtalk|suiteFixture|'+'a'.repeat(64),eventDigest: 'b'.repeat(64),connectionId: 'original:dingtalk',
    spaceId: 'original',scopeDigest: 'c'.repeat(64),parentGeneration: crypto.randomUUID(),inboundGeneration: crypto.randomUUID(),leaseId: crypto.randomUUID() };
  const state = { active: true,claim: true,failAutomation: false,revokedAfterAppend: false };
  const current = { installation: { spaceId: 'original',actorUserId: 'owner',members: ['MemberCase'] },scope: {},
    candidate: { text: 'private body' },sourceRef: 'dingtalk:inbound-'+'d'.repeat(64),eventId: 'e'.repeat(64) };
  const repository = { claim: async () => state.claim ? [job] : [],current: async () => state.active ? current : null,
    finish: async ({ outcome }) => { states.push(outcome); } };
  const effects = {
    verifyNative: async (_value,signal) => { assert.equal(signal.aborted,false);calls.push('native'); },
    append: async ({ event },fence) => { assert.equal(await fence.current(),true);calls.push(event);stored.add('channel:'+event.eventId);
      if (state.revokedAfterAppend) state.active=false; },
    automations: async ({ event },fence) => { assert.equal(await fence.current(),true);calls.push('automation');
      if (state.failAutomation) throw Error('private provider detail');stored.add('automation:'+event.eventId); }
  };
  return { app,job,state,calls,states,stored,repository,effects,run: extra => drainDingTalkInbound({ app,repository,effects,...extra }) };
}
test('DingTalk dormant drain resolves current source, verifies native authority and emits stable scoped effect plans',async () => {
  const f = fixture();await f.run();assert.deepEqual(f.states,['done']);assert.equal(f.stored.size,2);
  const event = f.calls.find(v => typeof v==='object');assert.equal(event.feature,'message.received');assert.equal(event.body,'private body');
  assert.doesNotMatch(JSON.stringify(event),/MemberCase|owner|native-token|original/);
  f.state.active=false;await f.run();assert.deepEqual(f.states,['done','obsolete']);assert.equal(f.calls.length,3);
});
test('DingTalk dormant drain retries partial effects with identical IDs and stops between append and Automation on retirement',async () => {
  const f = fixture();f.state.failAutomation=true;await f.run();assert.deepEqual(f.states,['retry']);assert.equal(f.stored.size,1);
  f.state.failAutomation=false;await f.run();assert.equal(f.stored.size,2);assert.deepEqual(f.states,['retry','done']);
  const ids = f.calls.filter(v => typeof v==='object').map(v => v.eventId);assert.equal(new Set(ids).size,1);
  const g = fixture();g.state.revokedAfterAppend=true;await g.run();assert.deepEqual(g.states,['obsolete']);
  assert.equal(g.calls.includes('automation'),false);
});
test('DingTalk dormant drain times out ignored native verification and suppresses every later effect',async () => {
  const f = fixture();let release,signal;
  f.effects.verifyNative=async (_value,s) => { signal=s;await new Promise(resolve => { release=resolve; }); };
  await f.run({ deadlineMs: 5 });assert.deepEqual(f.states,['retry']);assert.equal(signal.aborted,true);
  release();await new Promise(resolve => setImmediate(resolve));assert.equal(f.stored.size,0);assert.equal(f.calls.length,0);
  const controller = new AbortController();controller.abort();await f.run({ signal: controller.signal });assert.deepEqual(f.states,['retry']);
});
test('DingTalk dormant drain fails closed on native/current check errors and rejects oversized claim batches',async () => {
  const f = fixture();f.effects.verifyNative=async () => { throw Error('private error'); };await f.run();assert.deepEqual(f.states,['retry']);assert.equal(f.stored.size,0);
  const g = fixture();g.repository.current=async () => { throw Error('authority unavailable'); };await g.run();assert.deepEqual(g.states,['retry']);
  const h = fixture();h.repository.claim=async () => Array(9).fill(h.job);await assert.rejects(h.run(),/claim bound/);
  await assert.rejects(f.run({ deadlineMs: 20001 }),/deadline/);
});

test('DingTalk late current responses cannot reopen a timed-out effect fence',async () => {
  const f = fixture();const original = f.repository.current;let release,seen,checks=0,gate;
  const waiting = new Promise(resolve => { seen=resolve; });
  f.repository.current=async input => {
    if (++checks===3) { seen();await new Promise(resolve => { release=resolve; }); }
    return original(input);
  };
  f.effects.append=async (_input,fence) => { gate=fence; if (await fence.current()) f.stored.add('late'); };
  const running=f.run({ deadlineMs: 15 });await waiting;await running;
  assert.deepEqual(f.states,['retry']);assert.equal(gate.signal.aborted,true);
  release();await new Promise(resolve => setImmediate(resolve));assert.equal(f.stored.size,0);
  assert.equal(await gate.current(),false);
});

test('DingTalk late initial current and late effects remain cancelled after bounded drain returns',async () => {
  const f=fixture();const original=f.repository.current;let release;
  f.repository.current=async input => { await new Promise(resolve => { release=resolve; });return original(input); };
  await f.run({ deadlineMs: 5 });release();await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.states,['retry']);assert.equal(f.calls.length,0);
  const g=fixture();let later,signal;
  g.effects.append=async (_input,fence) => { signal=fence.signal;await new Promise(resolve => { later=resolve; });
    if (await fence.current()) g.stored.add('late-effect'); };
  await g.run({ deadlineMs: 5 });assert.equal(signal.aborted,true);later();
  await new Promise(resolve => setImmediate(resolve));assert.deepEqual(g.states,['retry']);
  assert.equal(g.stored.size,0);assert.equal(g.calls.includes('automation'),false);
});
