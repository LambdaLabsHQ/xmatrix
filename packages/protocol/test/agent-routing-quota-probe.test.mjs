import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeRoutingQuotaRefusal, currentRoutingQuotaWindows, mergeRoutingQuotaWindows,
  parseRoutingQuotaProbeRequest, parseRoutingQuotaProbeResponse, routingQuotaPace,
  routingQuotaProbeObservations, routingQuotaRecord } from '../dist/agent-routing-quota-probe.js';

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

test('a probe checking a refusal may ask for a fresh read, and only as true', () => {
  assert.deepEqual(parseRoutingQuotaProbeRequest({ ...request, fresh: true }), { ...request, fresh: true });
  assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, fresh: false }));
  assert.deepEqual(parseRoutingQuotaProbeResponse(response(observed), { ...request, fresh: true }, now), response(observed));
});

test('unavailable is explicit and cannot carry an invented balance', () => {
  const unavailable = { ...target, status: 'unavailable', reason: 'timeout' };
  assert.deepEqual(parse(response(unavailable)).results, [unavailable]);
  assert.throws(() => parse(response({ ...unavailable, quotaUsages: [{ percent: 0 }] })));
});

test('a missing grant is its own reason only for a Hub that asked about grants', () => {
  const notGranted = { ...target, status: 'unavailable', reason: 'not_granted' };
  const asking = { ...request, accessGrants: true };
  assert.deepEqual(parseRoutingQuotaProbeRequest(asking), asking);
  assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, accessGrants: false }));
  assert.deepEqual(parseRoutingQuotaProbeResponse(response(notGranted), asking, now), response(notGranted));
  assert.throws(() => parse(response(notGranted)));
  assert.deepEqual(routingQuotaProbeObservations(response(notGranted), asking, now), []);
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

test('quota probe clamps small forward clock skew and still rejects far-future observations', () => {
  const slightFuture = { ...observed, quotaObservedAt: new Date(now + 46).toISOString(),
    quotaUsages: [{ percent: 100, resetAt: '1790423712' }] };
  const clamped = parse(response(slightFuture));
  assert.equal(clamped.results[0].quotaObservedAt, new Date(now).toISOString());
  const [fact] = routingQuotaProbeObservations(response(slightFuture), request, now);
  assert.equal(fact.record.observedAt, new Date(now).toISOString());

  const atLimit = { ...observed, quotaObservedAt: new Date(now + 5_000).toISOString() };
  assert.equal(parse(response(atLimit)).results[0].quotaObservedAt, new Date(now).toISOString());

  const pastLimit = { ...observed, quotaObservedAt: new Date(now + 5_001).toISOString() };
  assert.throws(() => parse(response(pastLimit)));
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
  assert.equal(fact.record.account.value, 0);
  assert.equal(fact.record.account.source, 'provider');
  assert.equal(Date.parse(fact.record.observedAt), Date.parse(observed.quotaObservedAt));
  assert.equal(Date.parse(fact.record.account.expiresAt), 1790423712 * 1000);
  // A probe that did not ask for scoped windows reads a partial reading.
  assert.equal(fact.record.scoped, undefined);
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
  assert.equal(routingQuotaProbeObservations(response(result), request, now)[0].record.account.value, 0);
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
  assert.deepEqual(fact.record.windows, [
    { label: '1w', usedPercent: 12, resetAt: new Date(1790423712 * 1000).toISOString() },
    { usedPercent: 5 },
  ]);
  assert.equal(fact.record.account.value, 88, 'routing still reads the tightest current window');
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
  assert.deepEqual(reading.record.quotaAccount, account);
  assert.equal(reading.record.account.value, 1, 'a used-up window the provider still serves is not a hold');
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
  // Scoped windows constrain single models, not the account's pace.
  assert.equal(pace(90, [{ label: '1mo', usedPercent: 50, resetAt: at(360) },
    { label: '1w', usedPercent: 100, resetAt: at(24), scope: 'Fable' }]), 1);
  // The provider's verdict: refused is none, served on credits past a full window is its small share.
  assert.equal(pace(0, [{ label: '5h', usedPercent: 10, resetAt: at(1) }]), 0);
  assert.equal(pace(1, [{ label: '1w', usedPercent: 100, resetAt: at(24) }]), 0.01);
  // A window whose reset has passed no longer counts.
  assert.equal(pace(60, [{ label: '5h', usedPercent: 100, resetAt: at(-1) }, { label: '1w', usedPercent: 40, resetAt: at(84) }]), 1.2);
});

test('a prepaid balance is a reading without a window, only on a probe that asked for it', () => {
  const account = { allowed: true, credits: { balance: 12.34, currency: 'CNY' } };
  const { quotaUsages: _windows, ...windowless } = observed;
  const balance = { ...windowless, quotaObservedAt: '2026-09-21T19:55:00Z', quotaAccount: account };
  const asked = { ...request, quotaAccount: true, accountBalance: true };
  assert.deepEqual(parseRoutingQuotaProbeRequest(asked), asked);
  assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, accountBalance: true }), 'a balance is an account fact');
  assert.throws(() => parseRoutingQuotaProbeResponse(response(balance), { ...request, quotaAccount: true }, now),
    'a probe that did not ask rejects a currency');
  assert.deepEqual(parseRoutingQuotaProbeResponse(response(balance), asked, now).results[0].quotaAccount, account);
  const [reading] = routingQuotaProbeObservations(response(balance), asked, now);
  assert.deepEqual([reading.record.account.value, reading.record.windows, reading.record.quotaAccount], [100, [], account]);
  const spent = { ...balance, quotaAccount: { allowed: false, credits: { balance: 0, currency: 'CNY' } } };
  assert.equal(routingQuotaProbeObservations(response(spent), asked, now)[0].record.account.value, 0);
  for (const quotaAccount of [undefined, { allowed: true }, { credits: { balance: 5 } },
    { credits: { balance: 5, currency: 'yuan' } }]) {
    assert.throws(() => parseRoutingQuotaProbeResponse(response({ ...balance, quotaAccount }), asked, now));
  }
  assert.throws(() => parseRoutingQuotaProbeResponse(response({ ...balance, quotaUsages: [] }), asked, now));
});

test('scoped windows travel only on a probe that asked, each naming its scope, possibly alone', () => {
  const asked = { ...request, windowLabels: true, scopedQuotaUsages: true };
  assert.deepEqual(parseRoutingQuotaProbeRequest(asked), asked);
  assert.throws(() => parseRoutingQuotaProbeRequest({ ...request, scopedQuotaUsages: false }));
  const fable = { percent: 100, resetAt: '2026-09-23T18:00:00Z', label: '1w', scope: 'Fable' };
  const complete = { ...observed, quotaObservedAt: '2026-09-21T19:55:00Z',
    quotaUsages: [{ percent: 55, resetAt: '2026-09-23T18:00:00Z', label: '1w' }], scopedQuotaUsages: [fable] };
  assert.throws(() => parse(response(complete)), 'a probe that did not ask rejects scoped windows');
  assert.deepEqual(parseRoutingQuotaProbeResponse(response(complete), asked, now), response(complete));
  for (const scope of [undefined, '', ' Fable', 'x'.repeat(65)]) {
    assert.throws(() => parseRoutingQuotaProbeResponse(response({ ...complete,
      scopedQuotaUsages: [{ ...fable, scope }] }), asked, now));
  }
  const [fact] = routingQuotaProbeObservations(response(complete), asked, now);
  assert.equal(fact.record.account.value, 45, 'the account reads its own windows');
  assert.deepEqual(fact.record.scoped, { windows: [{ label: '1w', usedPercent: 100,
    resetAt: '2026-09-23T18:00:00.000Z', scope: 'Fable' }], expiresAt: '2026-09-23T18:00:00.000Z' });
  // A complete reading that states no scoped window still says so.
  const [none] = routingQuotaProbeObservations(response({ ...complete, scopedQuotaUsages: [] }), asked, now);
  assert.deepEqual(none.record.scoped, { windows: [] });
  // Cursor with Auto and API pools has no account window at all.
  const { quotaUsages: _windows, ...pools } = complete;
  const auto = { ...pools, scopedQuotaUsages: [{ percent: 26, resetAt: '2026-10-13T09:32:23Z', label: '1mo', scope: 'Auto' }] };
  const [cursor] = routingQuotaProbeObservations(response(auto), asked, now);
  assert.equal(cursor.record.account, undefined);
  assert.deepEqual(cursor.record.windows, []);
  assert.equal(cursor.record.scoped.windows[0].scope, 'Auto');
  assert.throws(() => parseRoutingQuotaProbeResponse(response({ ...pools, scopedQuotaUsages: [] }), asked, now),
    'a reading of nothing is no reading');
});

test('a Cursor reading in the pre-scope wire reads its pools as scoped windows; the field marks the new wire', async () => {
  const { fromPreScopeCursorWire } = await import('../dist/agent-routing-quota-probe.js');
  const { routingQuotaObservation } = await import('../dist/agent-routing.js');
  const reset = '2026-10-13T09:32:23Z';
  const old = { quotaSource: 'provider_api', quotaObservedAt: '2026-09-21T19:55:00Z', quotaUsages: [
    { label: '1mo', window: 'cursor', percent: 60, resetAt: reset },
    { label: 'Auto', window: 'cursor', percent: 26, resetAt: reset },
    { label: 'API', window: 'cursor', percent: 100, resetAt: reset }] };
  const read = fromPreScopeCursorWire(old, 'cursor');
  assert.deepEqual(read.quotaUsages, [], 'the cycle total gated nothing beside the pools');
  assert.deepEqual(read.scopedQuotaUsages.map(window => [window.scope, window.percent]), [['Auto', 26], ['API', 100]]);
  assert.equal(routingQuotaObservation(read, now, { model: { quotaScopes: ['Auto'] } }).value, 74,
    'a used-up API pool does not stop Auto');
  // A reading that carries the field is the new wire, and other harnesses are never read so.
  const current = { ...old, scopedQuotaUsages: [] };
  assert.equal(fromPreScopeCursorWire(current, 'cursor'), current);
  assert.equal(fromPreScopeCursorWire(old, 'claude'), old);
  // A probe of an old Cursor daemon is read the same way.
  const cursorTarget = { targetId: 'registration:cursor', configurationDigest: 'c'.repeat(64) };
  const asked = { requestId: 'probe:1', connectionEpoch: 7, targets: [cursorTarget], windowLabels: true,
    scopedQuotaUsages: true };
  const [fact] = routingQuotaProbeObservations({ requestId: 'probe:1', connectionEpoch: 7, results: [{ ...cursorTarget,
    status: 'observed', quotaSource: 'provider_api', quotaObservedAt: old.quotaObservedAt,
    quotaUsages: old.quotaUsages.map(({ window: _window, ...window }) => window) }] }, asked, now);
  assert.equal(fact.record.account, undefined);
  assert.deepEqual(fact.record.scoped.windows.map(window => window.scope), ['Auto', 'API']);
});

test('attributeRoutingQuotaRefusal resolves raw reset times and tie-breaks in one place (#1725)', () => {
  const refusalNow = Date.parse('2026-11-15T12:00:00Z');
  const makeRecord = (session, week, scoped) => routingQuotaRecord({
    quotaSource: 'provider_api',
    quotaObservedAt: '2026-11-15T12:00:00Z',
    quotaUsages: [
      { label: '5h', percent: session, resetAt: '2026-11-15T23:00:00.312Z' },
      { label: '1w', percent: week, resetAt: '2026-11-19T17:59:59.768Z' },
    ],
    scopedQuotaUsages: scoped,
  }, refusalNow);

  const fable = (percent) => [{ label: '1w', percent, resetAt: '2026-11-19T17:59:59.769Z', scope: 'Fable' }];
  // Model week used up beside an open account week resetting at the same second -> Fable.
  const modelWeek = attributeRoutingQuotaRefusal(makeRecord(0, 55, fable(100)), Date.parse('2026-11-19T18:00:00Z'), refusalNow);
  assert.equal(modelWeek?.usedUp, 'scope');
  assert.equal(modelWeek?.scope, 'Fable');

  // Both account and Fable week used up -> account wins (stops every model).
  const bothWeeks = attributeRoutingQuotaRefusal(makeRecord(0, 100, fable(100)), Date.parse('2026-11-19T18:00:00Z'), refusalNow);
  assert.equal(bothWeeks?.usedUp, 'account');

  // Sole window resetting within 2s is marked used up even if rounded to 99%.
  const soleWindow = attributeRoutingQuotaRefusal(makeRecord(99, 55, fable(100)), Date.parse('2026-11-15T23:00:01Z'), refusalNow);
  assert.equal(soleWindow?.usedUp, 'account');
  assert.equal(soleWindow?.record.windows.find(w => w.label === '5h')?.usedPercent, 100);

  // Beyond 2s tolerance -> unresolved.
  assert.equal(attributeRoutingQuotaRefusal(makeRecord(100, 55, fable(100)), Date.parse('2026-11-15T23:00:03Z'), refusalNow), undefined);

  // Two candidates sharing a reset with neither at 100% -> ambiguous (unresolved).
  assert.equal(attributeRoutingQuotaRefusal(makeRecord(0, 99, fable(99)), Date.parse('2026-11-19T18:00:00Z'), refusalNow), undefined);

  // Two distinct used-up scopes sharing a reset with an open account -> ambiguous (unresolved).
  const twoUsedUpScopes = makeRecord(0, 55, [
    { label: '1w', percent: 100, resetAt: '2026-11-19T17:59:59.769Z', scope: 'Fable' },
    { label: '1w', percent: 100, resetAt: '2026-11-19T17:59:59.769Z', scope: 'Sonnet' },
  ]);
  assert.equal(attributeRoutingQuotaRefusal(twoUsedUpScopes, Date.parse('2026-11-19T18:00:00Z'), refusalNow), undefined);

  // Legacy daemon explicit scope narrows the match and marks the matched window used up.
  const explicit = attributeRoutingQuotaRefusal(makeRecord(0, 55, fable(97)), Date.parse('2026-11-19T18:00:00Z'), refusalNow, 'Fable');
  assert.equal(explicit?.usedUp, 'scope');
  assert.equal(explicit?.scope, 'Fable');
  assert.equal(explicit?.record.scoped?.windows[0]?.usedPercent, 100);
});

test('mergeRoutingQuotaWindows preserves higher usedPercent within 2s reset match and resets on new window', () => {
  const stored = [
    { label: '1w', usedPercent: 100, resetAt: '2026-11-19T18:00:00.000Z', scope: 'Fable' },
  ];
  const lagging = [
    { label: '1w', usedPercent: 98, resetAt: '2026-11-19T17:59:58.500Z', scope: 'Fable' },
  ];
  assert.equal(mergeRoutingQuotaWindows(lagging, stored)[0]?.usedPercent, 100);
  const nextWeek = [
    { label: '1w', usedPercent: 5, resetAt: '2026-11-26T18:00:00.000Z', scope: 'Fable' },
  ];
  assert.equal(mergeRoutingQuotaWindows(nextWeek, stored)[0]?.usedPercent, 5);
});
