import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { routingQuotaVerdict } from '../dist/agent-routing.js';

const now = Date.parse('2026-11-18T20:00:00Z');
const observedAt = '2026-11-18T19:55:00Z';
const reading = (fields) => ({ quotaSource: 'provider_api', quotaObservedAt: observedAt, ...fields });
const fable = { quotaScopes: ['Fable'] };

test('a used-up window is used up until its reset; headroom is open; no reading is unknown', () => {
  const week = reading({ quotaUsages: [{ percent: 100, reset_at: '2026-11-20T00:00:00Z' }] });
  assert.deepEqual(routingQuotaVerdict(week, now),
    { state: 'usedUp', observedAt: new Date(observedAt).toISOString(), until: '2026-11-20T00:00:00.000Z' });
  assert.equal(routingQuotaVerdict(reading({ quotaUsages: [{ percent: 40 }] }), now).state, 'open');
  assert.deepEqual(routingQuotaVerdict(undefined, now), { state: 'unknown' });
  assert.equal(routingQuotaVerdict({ ...week, quotaSource: 'local_estimate' }, now).state, 'unknown',
    'a local estimate is never a provider reading');
  assert.equal(routingQuotaVerdict(week, Date.parse('2026-11-20T00:00:01Z')).state, 'unknown', 'past its reset it says nothing');
});

test('a scoped window decides only the models it constrains', () => {
  const usage = reading({ quotaUsages: [{ percent: 30 }],
    scopedQuotaUsages: [{ percent: 100, scope: 'Fable', reset_at: '2026-11-19T00:00:00Z' }] });
  assert.equal(routingQuotaVerdict(usage, now).state, 'open', 'the account has headroom');
  assert.equal(routingQuotaVerdict(usage, now, { model: { quotaScopes: ['Opus'] } }).state, 'open');
  assert.equal(routingQuotaVerdict(usage, now, { model: fable }).state, 'usedUp');
  assert.equal(routingQuotaVerdict({ ...usage, quotaAccount: { allowed: true } }, now, { model: fable }).state, 'usedUp',
    'served on another model does not lift a model its own limit');
  assert.equal(routingQuotaVerdict({ ...usage, quotaAccount: { allowed: false } }, now).state, 'usedUp',
    'a refused account is used up whatever its windows say');
});

// "Is it used up" is answered once, in protocol. Outside it a reading's
// headroom number is read only where it is shown as a percentage.
test('no package outside protocol decides used up from a headroom number', () => {
  const root = new URL('../../../', import.meta.url);
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const path = new URL(name, dir);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : files(new URL(`${name}/`, dir));
    return /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : [];
  });
  const shown = new Set(['packages/db/src/agent-registration-quota-probe.ts']);
  const offenders = [];
  for (const dir of ['packages/db/src/', 'packages/hub/src/', 'apps/web/src/']) {
    for (const path of files(new URL(dir, root))) {
      const relative = path.pathname.slice(root.pathname.length);
      const source = readFileSync(path, 'utf8');
      if (!shown.has(relative) && /routingQuotaObservation\(/u.test(source)) offenders.push(`${relative}: routingQuotaObservation`);
      if (/remainingPercent\s*(?:<=?|>=?|===)\s*0\b/u.test(source)) offenders.push(`${relative}: remainingPercent compared to 0`);
    }
  }
  assert.deepEqual(offenders, [], 'ask routingQuotaVerdict (or registrationQuotaVerdict) instead');
});

test('a billing hold is used up until its own expiry, and a named summon ignores it', () => {
  const until = '2027-06-01T00:00:00.000Z';
  const stale = '2026-10-01T00:00:00Z';
  const usage = reading({ quotaObservedAt: stale, quotaUsages: [], billingHolds: { accountUntil: until } });
  const held = routingQuotaVerdict(usage, now);
  assert.equal(held.state, 'usedUp');
  assert.equal(held.until, until, 'a payment hold is not capped at a quota window\'s max age');
  assert.equal(routingQuotaVerdict(usage, now, { summon: 'named' }).state, 'unknown',
    'a named summon reads the provider windows alone');
  const open = reading({ quotaUsages: [{ percent: 20, reset_at: '2026-11-20T00:00:00Z' }],
    billingHolds: { scopes: [{ scope: 'API', until }] } });
  assert.equal(routingQuotaVerdict(open, now).state, 'open', 'a scope hold does not use the account up');
  assert.equal(routingQuotaVerdict(open, now, { model: { quotaScopes: ['Auto'] } }).state, 'open');
  assert.equal(routingQuotaVerdict(open, now, { model: { quotaScopes: ['API'] } }).state, 'usedUp');
  assert.equal(routingQuotaVerdict(open, now, { model: { quotaScopes: ['API'] }, summon: 'named' }).state, 'open');
  const measured = reading({ scopedQuotaUsages: [{ percent: 100, scope: 'API', reset_at: '2026-11-19T00:00:00Z' }] });
  assert.equal(routingQuotaVerdict(measured, now, { model: { quotaScopes: ['API'] }, summon: 'named' }).state, 'usedUp',
    'a provider window still refuses a named summon');
});

test('launch choice does not keep a second billing-hold policy', () => {
  const source = readFileSync(new URL('../../hub/src/registration-launch-choice.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('liftBillingHold'), false);
  assert.equal(source.includes('billingHeldScope'), false);
  assert.equal(source.includes('billingRefusalScopes'), false);
  const probe = readFileSync(new URL('../../db/src/agent-registration-quota-probe.ts', import.meta.url), 'utf8');
  assert.equal(probe.includes('billingRefusal: true'), false, 'a billing hold is not stored as a quota window');
  assert.equal(probe.includes("interval '31 days'"), false, '31-day exhausted hold is owned by protocol, never SQL');
  assert.equal(probe.includes('KEPT_REMAINING'), false, 'remaining headroom is owned by protocol, never SQL');
  assert.equal(probe.includes('QUOTA_RESET_MATCH_MS'), false, 'reset matching tolerance is owned by protocol');
  const rustLimit = readFileSync(new URL('../../cli-rs/crates/runtime/src/runtime_usage_limit.rs', import.meta.url), 'utf8');
  assert.equal(rustLimit.includes('quota_scope_by_reset'), false, 'refusal scope attribution is owned by protocol/Hub, not Rust');
  assert.equal(rustLimit.includes('RESET_MATCH_TOLERANCE'), false, 'reset matching tolerance is not duplicated in Rust');
});
