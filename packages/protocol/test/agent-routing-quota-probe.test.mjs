import assert from 'node:assert/strict';
import test from 'node:test';
import { currentRoutingQuotaWindows, parseRoutingQuotaProbeRequest, parseRoutingQuotaProbeResponse,
  routingQuotaPace, routingQuotaProbeObservations } from '../dist/agent-routing-quota-probe.js';

const now = Date.parse('2026-09-21T20:00:00Z');
const target = { targetId: 'registration:a', configurationDigest: 'a'.repeat(64) };
const request = { requestId: 'probe:1', connectionEpoch: 7, targets: [target] };
const observed = { ...target, status: 'observed', quotaSource: 'provider_api',
  quotaObservedAt: '2026-09-21T16:00:00Z', quotaUsages: [{ percent: 100, resetAt: '1790423712' }] };
const response = result => ({ requestId: request.requestId, connectionEpoch: 7, results: [result] });
const parse = value => parseRoutingQuotaProbeResponse(value, request, now);

test('quota probe preserves original provider time without making stale observations fresh', () => {
  assert.deepEqual(parseRoutingQuotaProbeRequest(request), request);
  assert.deepEqual(parse(response(observed)), response(observed));
});

test('unavailable is explicit and cannot carry an invented balance', () => {
  const unavailable = { ...target, status: 'unavailable', reason: 'timeout' };
  assert.deepEqual(parse(response(unavailable)).results, [unavailable]);
  assert.throws(() => parse(response({ ...unavailable, quotaUsages: [{ percent: 0 }] })));
});

test('quota probe fences another request, epoch, profile and configuration', () => {
  for (const patch of [{ requestId: 'other' }, { connectionEpoch: 6 }]) {
    assert.throws(() => parse({ ...response(observed), ...patch }));
  }
  for (const patch of [{ targetId: 'registration:b' }, { configurationDigest: 'b'.repeat(64) }]) {
    assert.throws(() => parse(response({ ...observed, ...patch })));
  }
});

test('quota probe rejects partial, duplicate and oversized target sets', () => {
  assert.throws(() => parse({ ...response(observed), results: [] }));
  for (const targets of [[], [target, target], Array.from({ length: 33 }, (_, i) => ({ ...target, targetId: `p:${i}` }))]) {
    assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, targets }));
  }
  const two = { ...request, targets: [target, { ...target, targetId: 'registration:b' }] };
  assert.throws(() => parseRoutingQuotaProbeResponse({ ...response(observed), results: [observed, observed] }, two, now));
});

test('quota probe rejects non-provider, future, malformed and out-of-range observations', () => {
  for (const patch of [{ quotaSource: 'session' }, { quotaObservedAt: 'bad' },
    { quotaObservedAt: '2026-09-22T00:00:00Z' }, { quotaUsages: [] },
    ...[-1, 101, NaN, Infinity, '100'].map(percent => ({ quotaUsages: [{ percent }] }))]) {
    assert.throws(() => parse(response({ ...observed, ...patch })));
  }
});

test('quota probe rejects extra credential/account fields at every boundary', () => {
  assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, ownerUserId: 'other' }));
  assert.throws(() => parse({ ...response(observed), token: 'not-a-real-token' }));
  assert.throws(() => parse(response({ ...observed, accountId: 'private-account' })));
  assert.throws(() => parse(response({ ...observed, quotaUsages: [{ percent: 40, email: 'private' }] })));
});

test('provider probe maps exhaustion to the existing routing observation policy', () => {
  const [fact] = routingQuotaProbeObservations(response(observed), request, now);
  assert.equal(fact.targetId, target.targetId);
  assert.equal(fact.configurationDigest, target.configurationDigest);
  assert.equal(fact.observation.value, 0);
  assert.equal(fact.observation.source, 'provider');
  assert.equal(Date.parse(fact.observation.observedAt), Date.parse(observed.quotaObservedAt));
  assert.equal(Date.parse(fact.observation.expiresAt), 1790423712 * 1000);
});

test('unavailable or expired probe facts produce no update, never an invented balance', () => {
  for (const result of [{ ...target, status: 'unavailable', reason: 'provider_unavailable' },
    { ...observed, quotaUsages: [{ percent: 12 }] },
    { ...observed, quotaUsages: [{ percent: 100, resetAt: '1' }] }]) {
    assert.deepEqual(routingQuotaProbeObservations(response(result), request, now), []);
  }
});

test('a reset short window cannot clear a still-exhausted long window', () => {
  const result = { ...observed, quotaUsages: [
    { percent: 100, resetAt: '1' }, { percent: 100, resetAt: '1790423712' }] };
  assert.equal(routingQuotaProbeObservations(response(result), request, now)[0].observation.value, 0);
});

test('a named window is accepted only when the probe asked for names', () => {
  const named = { ...observed, quotaUsages: [{ percent: 40, resetAt: '1790423712', label: '5h' }] };
  assert.throws(() => parse(response(named)), 'a probe that did not ask rejects labels');
  const asked = { ...request, windowLabels: true };
  assert.deepEqual(parseRoutingQuotaProbeRequest(asked), asked);
  assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, windowLabels: false }));
  assert.deepEqual(parseRoutingQuotaProbeResponse(response(named), asked, now), response(named));
  // A daemon that predates labels still answers a probe that asks for them.
  assert.deepEqual(parseRoutingQuotaProbeResponse(response(observed), asked, now), response(observed));
  for (const label of ['', ' 5h', 'x'.repeat(25), 5]) {
    assert.throws(() => parseRoutingQuotaProbeResponse(response({ ...named,
      quotaUsages: [{ percent: 40, label }] }), asked, now));
  }
});

test('observations carry the windows that have not reset, for display', () => {
  const asked = { ...request, windowLabels: true };
  const result = { ...observed, quotaObservedAt: '2026-09-21T19:55:00Z', quotaUsages: [{ percent: 30, resetAt: '1', label: '5h' },
    { percent: 12, resetAt: '1790423712', label: '1w' }, { percent: 5 }] };
  const [fact] = routingQuotaProbeObservations(response(result), asked, now);
  assert.deepEqual(fact.windows, [
    { label: '1w', usedPercent: 12, resetAt: new Date(1790423712 * 1000).toISOString() },
    { usedPercent: 5 },
  ]);
  assert.equal(fact.observation.value, 88, 'routing still reads the tightest current window');
});

test('a stored or served reading keeps only valid windows that have not reset', () => {
  const later = new Date(now + 60_000).toISOString();
  assert.deepEqual(currentRoutingQuotaWindows([
    { label: '5h', usedPercent: 100, resetAt: new Date(now - 1).toISOString() },
    { label: '1w', usedPercent: 12, resetAt: later },
    { label: '', usedPercent: 5, resetAt: 'not a time' },
    { usedPercent: 101 }, { usedPercent: '4' }, null, 'x',
  ], now), [{ label: '1w', usedPercent: 12, resetAt: later }, { usedPercent: 5 }]);
  assert.deepEqual(currentRoutingQuotaWindows(undefined, now), []);
  assert.deepEqual(currentRoutingQuotaWindows({ usedPercent: 1 }, now), []);
});

test('the account verdict travels only on a probe that asked for it', () => {
  const account = { allowed: true, credits: { balance: 137.5 } };
  assert.throws(() => parse(response({ ...observed, quotaAccount: account })), 'a probe that did not ask rejects it');
  const asked = { ...request, quotaAccount: true };
  assert.deepEqual(parseRoutingQuotaProbeRequest(asked), asked);
  const parsed = parseRoutingQuotaProbeResponse(response({ ...observed, quotaAccount: account }), asked, now);
  assert.deepEqual(parsed.results[0].quotaAccount, account);
  assert.throws(() => parseRoutingQuotaProbeResponse(response({ ...observed, quotaAccount: { allowed: 'yes' } }), asked, now));
  const fresh = { ...observed, quotaObservedAt: '2026-09-21T19:55:00Z', quotaAccount: account };
  const [reading] = routingQuotaProbeObservations(response(fresh), asked, now);
  assert.deepEqual(reading.account, account);
  assert.equal(reading.observation.value, 1, 'a used-up window the provider still serves is not a hold');
});

test('quota pace is the remaining share over the share of the window still to run', () => {
  const at = hours => new Date(now + hours * 3_600_000).toISOString();
  const pace = (remainingPercent, windows) => Math.round(routingQuotaPace({ remainingPercent, windows }, now) * 1000) / 1000;
  // Half of a 5h window left with an hour to its reset is lost unless spent;
  // 80% of a week left with six days to go is a little behind the pace.
  assert.equal(pace(50, [{ label: '5h', usedPercent: 50, resetAt: at(1) }]), 2.5);
  assert.equal(pace(80, [{ label: '1w', usedPercent: 20, resetAt: at(6 * 24) }]), 0.933);
  // Every window caps spending: the tightest counts.
  assert.equal(pace(40, [{ label: '5h', usedPercent: 10, resetAt: at(1) },
    { label: '1w', usedPercent: 60, resetAt: at(84) }]), 0.8);
  // No length or no reset: the remaining share alone; no windows: the reading.
  assert.equal(pace(70, [{ usedPercent: 30, resetAt: at(1) }]), 0.7);
  assert.equal(pace(70, [{ label: '5h', usedPercent: 30 }]), 0.7);
  assert.equal(pace(70, []), 0.7);
  // Cursor's Auto and API pools take the 1mo cycle's length; the better pool counts.
  assert.equal(pace(90, [{ label: '1mo', usedPercent: 50, resetAt: at(360) },
    { label: 'Auto', usedPercent: 10, resetAt: at(360) }, { label: 'API', usedPercent: 100, resetAt: at(360) }]), 1.8);
  // The provider's verdict: refused is none, served on credits past a full window is its small share.
  assert.equal(pace(0, [{ label: '5h', usedPercent: 10, resetAt: at(1) }]), 0);
  assert.equal(pace(1, [{ label: '1w', usedPercent: 100, resetAt: at(24) }]), 0.01);
  // A window whose reset has passed no longer counts.
  assert.equal(pace(60, [{ label: '5h', usedPercent: 100, resetAt: at(-1) }, { label: '1w', usedPercent: 40, resetAt: at(84) }]), 1.2);
});
