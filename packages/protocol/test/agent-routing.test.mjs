import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentRoutingDeclaration, parsePresentedRoutingDecision, routingDecisionCopy, routingQuotaObservation,
  cursorQuotaBucketForModel, ROUTING_QUOTA_MAX_AGE_MS, machineResourceObservation, hostObservedRequirements, routingModelCatalogObservation } from '../dist/agent-routing.js';

const now = Date.parse('2026-09-19T20:00:00Z');
const routingDeclaration = { schemaVersion: 1, enabled: true, models: ['model-a'], description: '',
  availability: 'unattended', maxConcurrent: 2, capabilities: [] };

test('canonical model aliases stay inside the explicitly registered model set', () => {
  const declaration = routingDeclaration;
  assert.equal(parseAgentRoutingDeclaration({ ...declaration, modelAliases: { 'model-a': 'provider/model-a' } }).modelAliases['model-a'], 'provider/model-a');
  assert.throws(() => parseAgentRoutingDeclaration({ ...declaration, modelAliases: { 'unregistered': 'another-model' } }));
});

test('declarations cannot smuggle credentials or live observations', () => {
  const declaration = routingDeclaration;
  assert.deepEqual(parseAgentRoutingDeclaration({ ...declaration, online: true }), parseAgentRoutingDeclaration(declaration));
  assert.deepEqual(parseAgentRoutingDeclaration({ ...declaration, apiKey: 'not-a-real-key' }), parseAgentRoutingDeclaration(declaration));
  assert.throws(() => parseAgentRoutingDeclaration({ ...declaration, models: ['model-a', 'model-a'] }));
});

test('a persisted provider quota reading survives an idle environment up to the bounded maximum age', () => {
  const observedAt = '2026-09-19T19:55:00Z';
  const usage = { quotaSource: 'provider_api', quotaObservedAt: observedAt,
    quotaUsages: [{ percent: 25, reset_at: '2026-09-19T21:00:00Z' }, { percent: 40, reset_at: '2026-09-20T00:00:00Z' }] };
  const quota = routingQuotaObservation(usage, now);
  assert.equal(quota.value, 60);
  assert.equal(quota.observedAt, new Date(observedAt).toISOString());
  // Five minutes old and no Instance is connected: still readable, not unknown.
  // A distant window reset does not extend it past the maximum age.
  assert.equal(quota.expiresAt, new Date(now - 5 * 60_000 + ROUTING_QUOTA_MAX_AGE_MS).toISOString());
  assert.equal(quota.source, 'provider');
});

test('the provider verdict on the account outranks its windows', () => {
  const observedAt = '2026-09-19T19:55:00Z';
  const week = { quotaSource: 'provider_api', quotaObservedAt: observedAt,
    quotaUsages: [{ percent: 100, reset_at: '2026-09-25T00:00:00Z' }] };
  // Used up and nothing more said: a hold until the reset.
  assert.equal(routingQuotaObservation(week, now).value, 0);
  assert.equal(routingQuotaObservation(week, now).expiresAt, new Date('2026-09-25T00:00:00Z').toISOString());
  // Still served on credits: eligible, after any window headroom, and read again soon.
  const served = routingQuotaObservation({ ...week, quotaAccount: { allowed: true, credits: { balance: 12 } } }, now);
  assert.equal(served.value, 1);
  assert.equal(served.expiresAt, new Date(Date.parse(observedAt) + ROUTING_QUOTA_MAX_AGE_MS).toISOString());
  // Refused: no headroom whatever the windows say.
  assert.equal(routingQuotaObservation({ ...week, quotaUsages: [{ percent: 20 }], quotaAccount: { allowed: false } }, now).value, 0);
});

test('an earlier window reset shortens a persisted reading below the maximum age', () => {
  const usage = { quotaSource: 'provider_api', quotaObservedAt: '2026-09-19T19:55:00Z',
    quotaUsages: [{ percent: 25, reset_at: '2026-09-19T20:02:00Z' }, { percent: 0, reset_at: '2026-09-20T00:00:00Z' }] };
  assert.equal(routingQuotaObservation(usage, now).expiresAt, new Date('2026-09-19T20:02:00Z').toISOString());
});

test('a persisted reading older than the bounded maximum age is unknown, never zero', () => {
  const observedAt = new Date(now - ROUTING_QUOTA_MAX_AGE_MS - 1).toISOString();
  const usage = { quotaSource: 'provider_api', quotaObservedAt: observedAt, quotaUsages: [{ percent: 10 }] };
  assert.equal(routingQuotaObservation(usage, now), undefined);
});

test('quota readings require a provider source, a valid observation time and a usable window', () => {
  assert.equal(routingQuotaObservation(undefined, now), undefined);
  assert.equal(routingQuotaObservation({ quotaSource: 'session', quotaObservedAt: '2026-09-19T19:59:00Z',
    quotaUsages: [{ percent: 10 }] }, now), undefined);
  assert.equal(routingQuotaObservation({ quotaSource: 'provider_api', quotaObservedAt: '2026-09-19T20:00:30Z',
    quotaUsages: [{ percent: 10 }] }, now), undefined);
  assert.equal(routingQuotaObservation({ quotaSource: 'provider_api', quotaObservedAt: '2026-09-19T19:59:00Z',
    quotaUsages: [{ percent: 120 }, { percent: 'unknown' }] }, now), undefined);
});

test('a reset short window cannot erase an exhausted weekly window', () => {
  const usage = { quotaSource: 'provider_api', quotaObservedAt: new Date(now - 5 * 60_000).toISOString(),
    quotaUsages: [{ percent: 10, resetAt: new Date(now - 1).toISOString() },
      { percent: 100, resetAt: new Date(now + 24 * 60 * 60_000).toISOString() }] };
  assert.equal(routingQuotaObservation(usage, now).value, 0);
  assert.equal(routingQuotaObservation(usage, now).expiresAt, usage.quotaUsages[1].resetAt);
});

test('Cursor API bucket exhaustion does not zero routing headroom while Auto remains', () => {
  // Cursor GetCurrentPeriodUsage returns 1mo/Auto/API. Auto/Composer spend Auto;
  // third-party models spend API. Without a model, headroom is the better pool.
  const observedAt = '2026-09-19T19:55:00Z';
  const usage = { quotaSource: 'provider_api', quotaObservedAt: observedAt, quotaUsages: [
    { label: '1mo', percent: 26, resetAt: '2026-10-13T09:32:23Z' },
    { label: 'Auto', percent: 26, resetAt: '2026-10-13T09:32:23Z' },
    { label: 'API', percent: 100, resetAt: '2026-10-13T09:32:23Z' },
  ] };
  const quota = routingQuotaObservation(usage, now);
  assert.equal(quota.value, 74);
  assert.equal(quota.expiresAt, new Date(Date.parse(observedAt) + ROUTING_QUOTA_MAX_AGE_MS).toISOString());
  assert.equal(routingQuotaObservation(usage, now, { windowLabels: ['Auto'] }).value, 74);
  assert.equal(routingQuotaObservation(usage, now, { windowLabels: ['API'] }).value, 0);
  assert.equal(cursorQuotaBucketForModel('default'), 'Auto');
  assert.equal(cursorQuotaBucketForModel('composer-2.5'), 'Auto');
  assert.equal(cursorQuotaBucketForModel('claude-4-sonnet'), 'API');
});

test('exhaustion without a reset expires, implausibly distant resets are bounded, and fresh recovery replaces it', () => {
  const observedAt = new Date(now - 60 * 60_000).toISOString();
  const usage = { quotaSource: 'provider_api', quotaObservedAt: observedAt, quotaUsages: [{ percent: 100 }] };
  assert.equal(routingQuotaObservation(usage, now), undefined);
  usage.quotaUsages[0].resetAt = '2099-01-01T00:00:00Z';
  assert.equal(Date.parse(routingQuotaObservation(usage, now).expiresAt), Date.parse(observedAt) + 31 * 24 * 60 * 60_000);
  usage.quotaObservedAt = new Date(now).toISOString();
  usage.quotaUsages[0].percent = 20;
  assert.equal(routingQuotaObservation(usage, now).value, 80);
});

test('machine resource observations preserve numerical facts, stay current until replaced and reject future or private fields', () => {
  const sample = { observedAt: new Date(now - 1000).toISOString(), cpuLogicalCount: 8, cpuUsagePercent: 99,
    memoryTotalBytes: 16000, memoryAvailableBytes: 0 };
  assert.deepEqual(machineResourceObservation({ ...sample, privateAccount: 'secret' }, now), sample);
  // The daemon reports on change; Authority binds the observation to its live connection.
  const quiet = { ...sample, observedAt: new Date(now - 3_600_000).toISOString() };
  assert.deepEqual(machineResourceObservation(quiet, now), quiet);
  assert.equal(machineResourceObservation({ ...sample, observedAt: new Date(now + 1).toISOString() }, now), undefined);
  const invalid = machineResourceObservation({ ...sample, cpuUsagePercent: NaN, memoryAvailableBytes: 17000 }, now);
  assert.equal(invalid.cpuUsagePercent, undefined);
  assert.equal(invalid.memoryAvailableBytes, undefined);
});

test('machine load observations keep load average, swap and disk only when they are coherent', () => {
  const sample = { observedAt: new Date(now - 1000).toISOString(), loadAverage: [1.5, 0.75, 0],
    swapTotalBytes: 4000, swapFreeBytes: 4000, diskTotalBytes: 500, diskAvailableBytes: 20 };
  assert.deepEqual(machineResourceObservation(sample, now), sample);
  const invalid = machineResourceObservation({ ...sample, loadAverage: [1, -1, 0], swapFreeBytes: 4001,
    diskAvailableBytes: 501, cpuLogicalCount: 4 }, now);
  assert.deepEqual(invalid, { observedAt: sample.observedAt, cpuLogicalCount: 4, swapTotalBytes: 4000, diskTotalBytes: 500 });
  for (const loadAverage of [[1, 2], [1, 2, 3, 4], [1, Infinity, 0], '1 2 3']) {
    assert.equal(machineResourceObservation({ ...sample, loadAverage }, now).loadAverage, undefined);
  }
});


test('model catalogs retain real effort options and exclude private or invented fields', () => {
  const observedAt = new Date(now - 1000).toISOString();
  const result = routingModelCatalogObservation([{ model: 'actual-model', description: 'Coding', secret: 'never-send',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Detailed' }, { reasoningEffort: 'high' }] },
    { model: 'hidden-model', hidden: true }], observedAt, now);
  assert.deepEqual(result.value, [{ model: 'actual-model', description: 'Coding', efforts: [{ value: 'high', description: 'Detailed' }] }]);
  assert.equal(result.observedAt, observedAt);
  assert.doesNotMatch(JSON.stringify(result), /never-send/);
  for (const time of [undefined, 'invalid', new Date(now + 1).toISOString(), new Date(now - 86400000).toISOString()]) {
    assert.equal(routingModelCatalogObservation([{ model: 'actual-model' }], time, now), undefined);
  }
});

test('shared presentation preserves failed-decision observations and bounds private input', () => {
  const rows = Array.from({ length: 30 }, () => ({
    harness: 'codex', machineId: 'machine', activeRuns: 3,
    selected: false, quotaObservation: { status: 'stale', source: 'provider', observedAt: new Date(now - 1000).toISOString() },
    machineResources: { observedAt: new Date(now - 1000).toISOString(), cpuLogicalCount: 8 },
    privateToken: 'never-present',
  }));
  const parsed = parsePresentedRoutingDecision({ source: 'jev-unavailable', evaluatedAt: new Date(now).toISOString(), candidateCount: 30, rows });
  assert.equal(parsed.source, 'jev-unavailable');
  assert.equal(parsed.rows.length, 30);
  assert.equal(parsed.rows[29].quotaObservation.status, 'stale');
  assert.equal(parsed.rows[29].machineResources.cpuLogicalCount, 8);
  assert.equal(JSON.stringify(parsed).includes('never-present'), false);
  assert.doesNotMatch(routingDecisionCopy(parsed).rule, /ranks|highest|capacity/);
});

test('a bound Machine is kept by name and a broken one does not hide the decision', () => {
  const bound = parsePresentedRoutingDecision({ source: 'jev', rows: [],
    machine: { id: 'machine:abc', name: 'Workstation' } });
  assert.deepEqual(bound.machine, { id: 'machine:abc', name: 'Workstation' });
  const nameless = parsePresentedRoutingDecision({ source: 'jev', rows: [], machine: { id: 'machine:abc' } });
  assert.deepEqual(nameless.machine, { id: 'machine:abc' });
  const dropped = parsePresentedRoutingDecision({ source: 'jev', rows: [], machine: { name: 'Workstation' } });
  assert.equal(dropped.machine, undefined);
  assert.equal(dropped.source, 'jev');
});

test('a failed selection always renders its cause', () => {
  assert.match(routingDecisionCopy({ source: 'jev-unavailable', rows: [], failureCode: 'timeout' }).verdict,
    /Cause \(timeout\): xMatrix did not answer/);
  assert.match(routingDecisionCopy({ source: 'jev-unavailable', rows: [] }).verdict, /Cause: not recorded/);
  assert.equal(parsePresentedRoutingDecision({ source: 'jev-unavailable', failureCode: 'jev_auth_failed' }).failureCode, 'jev_auth_failed');
  assert.equal(parsePresentedRoutingDecision({ source: 'jev-unavailable', failureCode: 'x\ny' }).failureCode, undefined);
});

test('host capabilities are kept as verified ids; only provable ones gate a launch', () => {
  const now = Date.parse('2026-10-01T20:00:00.000Z');
  const observedAt = '2026-10-01T19:59:00.000Z';
  assert.deepEqual(machineResourceObservation({ observedAt, hostCapabilities: ['github', 'github'] }, now),
    { observedAt, hostCapabilities: ['github'] });
  assert.equal(machineResourceObservation({ observedAt, hostCapabilities: ['GitHub token'] }, now), undefined,
    'free text is never evidence');
  assert.deepEqual(hostObservedRequirements(['node', 'github', 'github']), ['github']);
  assert.deepEqual(hostObservedRequirements(['browser']), []);
});

test('a laptop is the only form factor a machine reports', () => {
  const now = Date.parse('2026-10-05T09:00:00.000Z');
  const observedAt = '2026-10-05T08:59:00.000Z';
  assert.deepEqual(machineResourceObservation({ observedAt, formFactor: 'laptop' }, now), { observedAt, formFactor: 'laptop' });
  assert.equal(machineResourceObservation({ observedAt, formFactor: 'desktop' }, now), undefined);
});
