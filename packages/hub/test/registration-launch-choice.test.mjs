import assert from 'node:assert/strict';
import test from 'node:test';
import {
  environmentHeadroom, jointRanking, registrationLaunchChooser,
} from "../src/registration-launch-choice.ts";
const candidates = ['first', 'last'].map(id => ({ key: { spaceId: 'space', ownerUserId: id, machineId: id, harness: 'codex' },
  description: id, models: ['small', 'large'], workspaceReferences: ['workspace-a', 'workspace-b'], workspaces: ['a', 'b'].map(letter => ({ reference: `workspace-${letter}`, machineId: id, canonicalCwd: `/projects/${letter}`, description: `Project ${letter}` })) }));
// Two harnesses, so Jev scores each one's fit.
const twoHarnesses = [candidates[0], { ...candidates[1], key: { ...candidates[1].key, harness: 'claude' } }];
test('network placement favours HTTPS reliability/tail latency and never confuses ICMP with proxy traffic', async () => {
  const now = Date.now();
  const observedAt = new Date(now - 1000).toISOString();
  const at = (candidate, latency, failures = 0, extra = {}) => ({ ...candidate, observations: {
    evaluatedAt: observedAt, quota: { remainingPercent: 100, assumed: true },
    machineResources: { observedAt, cpuUsagePercent: 10, network: {
      observedAt, target: 'cloudflare-speed', protocol: 'https', attempts: 10, failures,
      latencyP95Ms: latency, latencyMedianMs: latency, ...extra } } } });
  const slow = at(candidates[0], 200), fast = at(candidates[1], 20);
  assert.equal(jointRanking([slow, fast], () => 1 / 3, now)[0].candidate, fast);
  const lossy = at(candidates[1], 20, 10);
  assert.equal(jointRanking([lossy, slow], () => 1 / 3, now)[0].candidate, slow);
  const directLoss = at(candidates[0], 20, 0, { packetLoss: {
    protocol: 'icmp', target: '1.1.1.1', sent: 20, received: 1 } });
  assert.equal(jointRanking([directLoss, fast], () => 1 / 3, now)[0].candidate, directLoss);
  const stale = at(candidates[0], 1, 0, { observedAt: new Date(now - 3600_000).toISOString() });
  const staleRanking = jointRanking([stale, fast], () => 1 / 3, now);
  assert.equal(staleRanking[0].network, undefined);
  assert.equal(staleRanking[0].candidate, stale, 'missing network facts preserve candidate order');
  const result = await registrationLaunchChooser(answer)({ message: '@codex inspect', tags: {}, candidates: [slow, fast] });
  assert.equal(result.key.machineId, fast.key.machineId);
  assert.equal(result.parameterEvidence.placement.ranking[0].network.latencyP95Ms, 20);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
});
/** Choices default to the last option; a fit score defaults to "capable". */
function answer(input, options = {}) {
  return { answers: Object.fromEntries(Object.entries(input.questions).map(([key, question]) => {
    if (question.type === 'score') {
      const level = options[key] ?? 1;
      return [key, { score: level, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === level ? 1 : 0])) }];
    }
    const selected = options[key] ?? Object.keys(question.criteria).at(-1);
    return [key, { choice: selected, probabilities: Object.fromEntries(Object.keys(question.criteria).map(value => [value, value === selected ? 1 : 0])) }];
  })) };
}
test('one harness has no fit to score; the location and its one list of models are chosen in one call', async () => {
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex inspect', tags: {}, candidates });
  assert.deepEqual(result.key, candidates[0].key);
  assert.equal(result.model, 'large');
  assert.equal(result.workspaceReference, 'workspace-b');
  assert.equal(Object.hasOwn(result, "oneshot"), false);
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [['workspace', 'modelEffort']]);
  assert.deepEqual(result.parameterEvidence.choices.map(choice => choice.key), ['modelEffort', 'workspace']);
  const { digestCanonicalCloneCborV1 } = await import('@xmatrix/protocol');
  assert.equal(result.parameterEvidence.inputDigest, await digestCanonicalCloneCborV1(calls), "the evidence is what Jev read");
  assert.equal(result.parameterEvidence.rubricVersion, 'registration-parameters-v11');
  assert.equal(result.parameterEvidence.harness, undefined);
  assert.equal(result.parameterEvidence.fit, undefined);
  assert.deepEqual(result.parameterEvidence.placement.ranking.map(item => item.machineId), ['first', 'last']);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
});
test('environments of one harness offering different models: the model is chosen after them, for the one that runs it', async () => {
  const calls = [];
  const offers = [candidates[0], { ...candidates[1], models: ['large', 'huge'] }];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex inspect', tags: {}, candidates: offers });
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [['workspace'], ['modelEffort']]);
  assert.deepEqual(result.key, offers[0].key);
  assert.equal(result.model, 'large', "among the models the chosen environment offers");
});
test('Jev scores each harness on its own question and never sees load, quota or machines', async () => {
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input, { fit_1: 3 }); })({
    message: 'review this design', tags: {}, candidates: twoHarnesses.map(candidate => ({ ...candidate,
      observations: { evaluatedAt: 'now', outstandingMachineAllocations: 2, outstandingRegistrationAllocations: 1,
        quota: { remainingPercent: 40, assumed: false } } })) });
  assert.deepEqual(Object.keys(calls[0].questions), ['workspace', 'fit_0', 'fit_1']);
  const described = key => JSON.parse(calls[0].questions[key].instructions.slice(calls[0].questions[key].instructions.indexOf('{')));
  assert.deepEqual([described('fit_0'), described('fit_1')], [
    { harness: 'codex', descriptions: ['first'], models: ['small', 'large'] },
    { harness: 'claude', descriptions: ['last'], models: ['small', 'large'] }]);
  // The receipt can say whether the chosen Agent was judged from a description or from its name alone.
  assert.deepEqual(result.parameterEvidence.placement.ranking.map(item => item.described), [true, true]);
  const undescribed = await registrationLaunchChooser(async input => answer(input))({ message: 'review this design', tags: {},
    candidates: twoHarnesses.map(candidate => ({ ...candidate, description: '' })) });
  assert.deepEqual(undescribed.parameterEvidence.placement.ranking.map(item => item.described), [false, false]);
  assert.equal(calls[0].questions.fit_0.type, 'score');
  assert.equal(calls[0].questions.fit_0.criteria.length, 4);
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.questions), /observations|quota|Allocations|machineId/u);
  // No machine is measured, so fit alone separates them.
  assert.deepEqual(result.key, twoHarnesses[1].key);
  const { digestCanonicalCloneCborV1, parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(result.parameterEvidence.fit, { inputDigest: await digestCanonicalCloneCborV1([calls[0]]), scores: {
    codex: { score: 1, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } }, claude: { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } } });
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
});

test('harness and machine are chosen together: an idle capable harness beats a busy preferred one', async () => {
  // 2026-10-08: Jev's fit put claude first, and claude ran only on the busy machine
  // (load 5.7/8, 18% claude quota) while another machine sat idle with codex at 89%.
  const sample = (load, usage, available, quota) => ({ evaluatedAt: 'now', outstandingMachineAllocations: 0,
    outstandingRegistrationAllocations: 0, quota: { remainingPercent: quota, assumed: false },
    machineResources: { observedAt: 'now', cpuLogicalCount: 8, loadAverage: [load, 0, 0], cpuUsagePercent: usage,
      memoryTotalBytes: 100, memoryAvailableBytes: available } });
  const at = (harness, machineId, observations) => ({ ...candidates[0], models: [], key: { ...candidates[0].key, harness, machineId },
    workspaces: candidates[0].workspaces.map(workspace => ({ ...workspace, machineId })), observations });
  const fleet = [at('claude', 'busy', sample(5.7, 71, 60, 18)), at('codex', 'busy', sample(5.7, 71, 60, 90)),
    at('codex', 'idle', sample(0.02, 3, 86, 89))];
  const choose = fits => registrationLaunchChooser(async input => answer(input, fits))({ message: '@auto fix it', tags: {}, candidates: fleet });
  // Both capable: codex on the idle machine dominates every other environment.
  const even = await choose({});
  assert.deepEqual([even.key.harness, even.key.machineId], ['codex', 'idle']);
  assert.deepEqual(even.parameterEvidence.placement.ranking.map(item => [item.harness, item.machineId, item.frontier]),
    [['codex', 'idle', true], ['codex', 'busy', true], ['claude', 'busy', false]]);
  // A strong fit for claude still loses to its scarce headroom on the balanced profile.
  const preferred = await choose({ fit_0: 2 });
  assert.deepEqual([preferred.key.harness, preferred.key.machineId], ['codex', 'idle']);
  assert.equal(preferred.parameterEvidence.placement.ranking.find(item => item.harness === 'claude').frontier, true);
  // Unsuitable codex leaves claude, wherever it has room.
  const unsuitable = await choose({ fit_1: 0 });
  assert.deepEqual([unsuitable.key.harness, unsuitable.key.machineId], ['claude', 'busy']);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(even.parameterEvidence), even.parameterEvidence);
});

test('more harnesses than one call holds are scored in parallel calls', async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ ...candidates[0], models: [],
    key: { ...candidates[0].key, harness: `h${index}` } }));
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input, { fit_8: 3 }); })({
    message: '@auto', tags: { launch: 'force' }, candidates: many });
  assert.deepEqual(calls.map(call => Object.keys(call.questions).length), [8, 2]);
  assert.equal(result.key.harness, 'h8');
  assert.equal(Object.keys(result.parameterEvidence.fit.scores).length, 9);
});
test('explicit identity and model tags restrict the offered options', async () => {
  const result = await registrationLaunchChooser(async input => answer(input))({ message: '@codex model:small',
    tags: { machine: 'first', model: 'small' }, candidates });
  assert.deepEqual(result.key, candidates[0].key);
  assert.equal(result.model, 'small');
  assert.equal(Object.hasOwn(result, "oneshot"), false);
});
test('failed or invalid Jev decisions have no server choice fallback', async () => {
  await assert.rejects(registrationLaunchChooser(async () => { throw new Error('unavailable'); })({ message: '@codex', tags: {}, candidates }));
  await assert.rejects(registrationLaunchChooser(async input => answer(input, { modelEffort: 'invented' }))({ message: '@codex', tags: {}, candidates }));
});

test('registered workspace descriptions reach Jev and explicit pwd fixes its domain', async () => {
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex pwd:/projects/a', tags: { pwd: '/projects/a' }, candidates });
  const offered = Object.values(calls[0].questions.workspace.criteria).map(value => JSON.parse(value));
  assert.deepEqual(offered, [{ reference: 'workspace-a', canonicalCwd: '/projects/a', description: 'Project a' }]);
  assert.equal(result.workspaceReference, 'workspace-a');
});

test('observed effort pairs reach Jev and the chosen effort reaches the launch', async () => {
  const available = candidates.map(candidate => ({ ...candidate, supportsRequestedEffort: true,
    modelCatalog: [{ model: 'large', description: 'Reasoning model', efforts: [
      { value: 'low', description: 'Quick' }, { value: 'high', description: 'Thorough' }] }] }));
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex model:large effort:high', tags: { model: 'large', effort: 'high' }, candidates: available });
  assert.equal(result.model, 'large');
  assert.equal(result.effort, 'high');
  assert.equal(result.parameterEvidence.selections.effort, 'high');
  assert.deepEqual(Object.values(calls.at(-1).questions.modelEffort.criteria).map(value => JSON.parse(value)), [
    { model: 'large', description: 'Reasoning model', effort: 'high', effortDescription: 'Thorough' }]);
  await assert.rejects(registrationLaunchChooser(async input => answer(input))({
    message: '@codex effort:high', tags: { effort: 'high' }, candidates }),
  error => error.code === 'registration_effort_unavailable');
});

test('headroom is the scarcest of CPU, memory and provider quota; unknown is not idle', () => {
  const at = (machineResources, quota = { remainingPercent: 100, assumed: true }) => ({ ...candidates[0], observations: {
    evaluatedAt: 'now', outstandingMachineAllocations: 0, outstandingRegistrationAllocations: 0, quota, machineResources } });
  const sample = (load, usage, available) => ({ observedAt: 'now', cpuLogicalCount: 8, loadAverage: [load, 0, 0],
    cpuUsagePercent: usage, memoryTotalBytes: 100, memoryAvailableBytes: available });
  const room = candidate => Math.round(environmentHeadroom(candidate) * 1000) / 1000;
  // CPU counts the run queue per core and the busy time, whichever leaves less.
  assert.equal(room(at(sample(2, 10, 90))), 0.75);
  assert.equal(room(at(sample(0, 40, 90))), 0.6);
  assert.equal(room(at(sample(0, 0, 30))), 0.3);
  assert.equal(room(at(sample(0, 0, 90), { remainingPercent: 20, assumed: false })), 0.2);
  // An overloaded machine goes below zero; Windows reports no load average.
  assert.equal(room(at(sample(16, 50, 90))), -1);
  assert.equal(room(at({ observedAt: 'now', cpuUsagePercent: 50 })), 0.5);
  assert.equal(environmentHeadroom(at(undefined)), undefined);
  assert.equal(environmentHeadroom(candidates[0]), undefined);
});

test('quota counts by its pace: equally fit, the account whose quota resets soonest unspent runs it', () => {
  const now = Date.parse('2026-10-08T22:00:00Z');
  const at = hours => new Date(now + hours * 3_600_000).toISOString();
  const account = (harness, window) => ({ ...candidates[0], key: { ...candidates[0].key, harness },
    observations: { evaluatedAt: 'now', outstandingMachineAllocations: 0, outstandingRegistrationAllocations: 0,
      quota: { remainingPercent: 100 - window.usedPercent, assumed: false, windows: [window] },
      machineResources: { observedAt: 'now', cpuLogicalCount: 8, loadAverage: [2, 0, 0] } } });
  // 50% of a 5h window resetting within the hour beats 80% of a week with six days to go.
  const soon = account('claude', { label: '5h', usedPercent: 50, resetAt: at(1) });
  const later = account('codex', { label: '1w', usedPercent: 20, resetAt: at(144) });
  const ranked = jointRanking([later, soon], () => 1 / 3, now);
  assert.deepEqual(ranked.map(item => [item.candidate.key.harness, Math.round(item.quotaPace * 100) / 100]),
    [['claude', 2.5], ['codex', 0.93]]);
  // Spending ahead of its reset makes an account short of quota: 30% of a week
  // left with five days to go caps headroom at its pace.
  const ahead = account('codex', { label: '1w', usedPercent: 70, resetAt: at(120) });
  assert.equal(Math.round(environmentHeadroom(ahead, now) * 1000) / 1000, 0.42);
  // Fit still comes first: a strong fit on a slower account wins.
  assert.equal(jointRanking([soon, later], candidate => candidate.key.harness === 'codex' ? 2 / 3 : 1 / 3, now)[0]
    .candidate.key.harness, 'codex');
});

test('with equal fit the work runs where the most headroom is; then the fewest outstanding Runs; then candidate order', async () => {
  const machine = (id, load, allocations = 0) => ({ ...candidates[0], key: { ...candidates[0].key, machineId: id },
    observations: { evaluatedAt: 'now', outstandingMachineAllocations: allocations, outstandingRegistrationAllocations: 0,
      quota: { remainingPercent: 100, assumed: true },
      machineResources: { observedAt: 'now', cpuLogicalCount: 8, loadAverage: [load, 0, 0] } } });
  const unmeasured = { ...candidates[0], key: { ...candidates[0].key, machineId: 'unmeasured' } };
  const pick = (...list) => jointRanking(list, () => 1 / 3)[0].candidate.key.machineId;
  assert.equal(pick(unmeasured, machine('busy', 6), machine('idle', 1)), 'idle');
  assert.equal(pick(unmeasured, machine('busy', 6)), 'busy');
  assert.equal(pick(machine('queued', 1, 3), machine('idle', 1)), 'idle');
  assert.equal(pick(machine('idle', 1), machine('twin', 1)), 'idle');
  // Through the chooser: of the harness's environments, the idle one runs it.
  const busy = { ...candidates[0], observations: machine('first', 7).observations };
  const idle = { ...candidates[1], observations: machine('last', 1).observations };
  const chosen = await registrationLaunchChooser(async input => answer(input))({ message: '@codex', tags: {}, candidates: [busy, idle] });
  assert.deepEqual(chosen.key, candidates[1].key);
});

test('an environment whose measured quota is exhausted until its reset is never offered', async () => {
  // 2026-09-29: Jev chose a Claude at 0% (reset 18:19 UTC) over one at 10%, and the turn failed at once.
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const exhausted = { quota: { remainingPercent: 0, assumed: false, source: 'provider', expiresAt: later } };
  const remaining = { quota: { remainingPercent: 10, assumed: false, source: 'provider', expiresAt: later } };
  const result = await registrationLaunchChooser(async input => answer(input))({
    message: '@claude', tags: {}, candidates: [{ ...candidates[0], observations: exhausted }, { ...candidates[1], observations: remaining }] });
  assert.deepEqual(result.key, candidates[1].key);

  await assert.rejects(registrationLaunchChooser(async input => answer(input))({ message: '@claude', tags: {},
    candidates: candidates.map(candidate => ({ ...candidate, observations: exhausted })) }),
  error => error.code === 'registration_quota_exhausted');

  // A passed reset or an assumed default is not an exhaustion fact.
  const reset = { quota: { ...exhausted.quota, expiresAt: new Date(Date.now() - 1000).toISOString() } };
  const assumed = { quota: { remainingPercent: 0, assumed: true } };
  for (const observations of [reset, assumed]) {
    const kept = await registrationLaunchChooser(async input => answer(input))({ message: '@claude', tags: {},
      candidates: [{ ...candidates[0], observations }] });
    assert.deepEqual(kept.key, candidates[0].key);
  }
});
test('runtime model aliases preserve the declared model and its observed effort options', async () => {
  const result = await registrationLaunchChooser(async input => answer(input))({ message: '@codex effort:high', tags: { effort: 'high' },
    candidates: [{ ...candidates[0], models: ['alias'], modelAliases: { alias: 'provider/model' }, supportsRequestedEffort: true,
      modelCatalog: [{ model: 'provider/model', description: 'Observed', efforts: [{ value: 'high', description: 'Thorough' }] }] }] });
  assert.equal(result.model, 'alias');
  assert.equal(result.effort, 'high');
});

test('omitted launch options stay in Jev choices and an explicit repo restricts them', async () => {
  const candidate = { ...candidates[0], workspaceReferences: [...candidates[0].workspaceReferences, 'repo:owner/project'],
    workspaces: [...candidates[0].workspaces, { reference: 'repo:owner/project', repo: 'owner/project', machineId: 'first', description: 'API server' }] };
  const calls = [];
  await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex inspect', tags: {}, candidates: [candidate] });
  assert.equal(calls.length, 1);
  const offered = Object.values(calls[0].questions.workspace.criteria).map(value => JSON.parse(value));
  assert.deepEqual(offered.map(workspace => workspace.repo), ['owner/project']);
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [["workspace", "modelEffort"]]);
  assert.ok(Object.keys(calls.at(-1).questions.modelEffort.criteria).length > 1);
});

test('authorized repositories are workspace alternatives and explicit repo restricts Jev', async () => {
  const candidate = { ...candidates[0], workspaceReferences: [...candidates[0].workspaceReferences, 'repo:owner/project'],
    workspaces: [...candidates[0].workspaces, { reference: 'repo:owner/project', repo: 'owner/project', machineId: 'first', description: 'API server' }] };
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex repo:owner/project', tags: { repo: 'owner/project' }, candidates: [candidate] });
  assert.equal(Object.keys(calls[0].questions.workspace.criteria).length, 1);
  assert.equal(result.workspaceReference, 'repo:owner/project');
  assert.equal(result.parameterEvidence.selections.workspaceKind, 'repo');
});

test('a repository no candidate offers is refused before Jev is called', async () => {
  let calls = 0;
  await assert.rejects(registrationLaunchChooser(async () => { calls++; return { answers: {} }; })({
    message: '@auto repo:owner/missing', tags: { repo: 'owner/missing' }, candidates,
  }), error => error.code === 'invalid_registration_repository' && error.status === 409);
  assert.equal(calls, 0);
});

test('a host name selects that machine and a shared name selects none', async () => {
  const named = candidates.map(candidate => ({ ...candidate,
    machineName: candidate.key.machineId === 'first' ? 'build01' : 'other-host' }));
  const result = await registrationLaunchChooser(async input => answer(input))({
    message: '@auto machine:build01', tags: { machine: 'build01' }, candidates: named });
  assert.equal(result.key.machineId, 'first');
  const collided = named.map(candidate => ({ ...candidate, machineName: 'build01' }));
  await assert.rejects(registrationLaunchChooser(async () => assert.fail('Jev must not be called'))({
    message: '@auto machine:build01', tags: { machine: 'build01' }, candidates: collided,
  }), error => error.code === 'registration_machine_ambiguous');
});

test('a named machine whose daemon is offline is not reported as a missing environment', async () => {
  await assert.rejects(registrationLaunchChooser(async () => assert.fail('Jev must not be called'))({
    message: '@auto machine:Laptop', tags: { machine: 'Laptop' }, candidates,
    blocked: [{ machineId: 'laptop-id', machineName: 'Laptop', reason: 'daemon_offline' }],
  }), error => error.code === 'registration_daemon_offline' && error.status === 409);
  await assert.rejects(registrationLaunchChooser(async () => assert.fail('Jev must not be called'))({
    message: '@auto machine:Other', tags: { machine: 'Other' }, candidates,
    blocked: [{ machineId: 'laptop-id', machineName: 'Laptop', reason: 'daemon_offline' }],
  }), error => error.code === 'registration_machine_unavailable');
});

test('a machine whose harness is too old to talk to is refused naming it, without asking Jev', async () => {
  const tooOld = { program: 'Cursor CLI', version: '2025.09.12-4852336', minimumVersion: '2026.01.01', machineName: 'Laptop' };
  await assert.rejects(registrationLaunchChooser(async () => assert.fail('Jev must not be called'))({
    message: '@auto machine:Laptop', tags: { machine: 'Laptop' }, candidates,
    blocked: [{ machineId: 'laptop-id', machineName: 'Laptop', reason: 'harness_outdated', tooOld }],
  }), error => error.code === 'registration_harness_outdated' && error.status === 409 && error.tooOld === tooOld);
});

test('explicit machine, model and effort failures retain their exact phase', async () => {
  const cases = [
    [{ machine: 'missing' }, 'registration_machine_unavailable'],
    [{ model: 'missing' }, 'registration_model_unavailable'],
    [{ effort: 'high' }, 'registration_effort_unavailable'],
  ];
  for (const [tags, code] of cases) {
    await assert.rejects(registrationLaunchChooser(async () => assert.fail('Jev must not be called'))({
      message: '@auto', tags, candidates,
    }), error => error.code === code);
  }
});

test('Jev provider failure is observable at the environment and parameter decision', async () => {
  for (const failedCall of [1, 2]) {
    let calls = 0;
    await assert.rejects(registrationLaunchChooser(async input => {
      if (++calls === failedCall) throw Object.assign(new Error('private provider payload'), { code: 'jev_auth_failed' });
      return answer(input);
    })({ message: '@auto', tags: {}, candidates: twoHarnesses }), error => {
      assert.equal(error.code, `registration_${failedCall === 1 ? 'environment' : 'parameter'}_jev_auth_failed`);
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
    assert.equal(calls, failedCall);
  }
});

test('authorized channel context reaches both decisions while explicit current constraints remain fixed', async () => {
  const calls = [];
  const context = { hierarchy: [{ topic: 'Previously used project b' }], messages: [{ body: 'Use b' }] };
  const message = '@codex pwd:/projects/a model:small';
  const selected = await registrationLaunchChooser(async request => { calls.push(request); return answer(request); },
    async sequence => { assert.equal(sequence, 10); return context; })({
      message, sourceSequence: 10, tags: { pwd: '/projects/a', model: 'small' }, candidates: twoHarnesses });
  // The model the message names is the only one left, so only the harness's fit is asked.
  assert.equal(calls.length, 1);
  for (const call of calls) {
    assert.equal(call.state.message, message);
    assert.deepEqual(call.state.channelContext, context);
  }
  assert.equal(selected.workspaceReference, 'workspace-a');
  assert.equal(selected.model, 'small');
  assert.equal(selected.parameterEvidence.choices.find(choice => choice.key === 'modelEffort').only, true);
});

test('registration failures identify the actual phase without retaining provider or context text', async () => {
  const invocation = { message: '@auto inspect', sourceSequence: 10, tags: {}, candidates: twoHarnesses };
  for (const stage of ['context', 'environment', 'parameter']) {
    let calls = 0;
    await assert.rejects(registrationLaunchChooser(async input => {
      calls++;
      if (stage === 'environment' || calls === 2) throw new Error('private provider payload');
      return answer(input);
    }, async () => {
      if (stage === 'context') throw new Error('private channel text');
      return {};
    })(invocation), error => {
      assert.equal(error.code, stage === 'context' ? 'registration_context_unavailable'
        : `registration_${stage}_jev_evaluation_failed`);
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
    assert.equal(calls, { context: 0, environment: 1, parameter: 2 }[stage]);
  }
});

test('both registration decisions identify evidence storage failure', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    let records = 0, calls = 0;
    const evaluate = Object.assign(async input => { calls++; return answer(input); }, {
      recordDecision: async () => { if (++records === failAt) throw new Error('private storage error'); },
    });
    await assert.rejects(registrationLaunchChooser(evaluate)({ message: '@auto inspect', tags: {}, candidates: twoHarnesses }), error => {
      assert.equal(error.code, 'registration_evidence_unavailable');
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
    assert.equal(calls, Math.floor(failAt / 2));
  }
});

test('input that needs no repository may run in a private managed directory', async () => {
  const calls = [];
  const bare = candidates.map(candidate => ({ ...candidate, workspaces: [] }));
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: 'Organize this Space', tags: { }, candidates: bare, managedWorkspace: true });
  assert.equal(result.workspaceReference, undefined);
  assert.equal(Object.hasOwn(result, "oneshot"), false);
  assert.deepEqual(Object.values(calls[0].questions.workspace.criteria),
    [JSON.stringify({ description: 'Private managed directory with no repository' })]);
  assert.equal(result.parameterEvidence.selections.workspaceKind, 'managed');
  await assert.rejects(registrationLaunchChooser(async input => answer(input))({
    message: 'Organize this Space', tags: {}, candidates: bare }), /No registered workspace/u);
  await assert.rejects(registrationLaunchChooser(async input => answer(input))({
    message: 'Organize this Space', tags: { pwd: '/projects/a' }, candidates: bare, managedWorkspace: true }));
});

test('a conversation co-writing a page is offered only the private managed directory, ready at once', async () => {
  const calls = [];
  const withRepo = { ...candidates[0], workspaceReferences: [...candidates[0].workspaceReferences, 'repo:owner/project'],
    workspaces: [...candidates[0].workspaces, { reference: 'repo:owner/project', repo: 'owner/project', machineId: 'first', description: 'API server' }] };
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex launch:force co-write this page', tags: { launch: 'force' }, candidates: [withRepo],
    managedWorkspace: true, managedOnly: true });
  assert.deepEqual(Object.values(calls[0].questions.workspace.criteria),
    [JSON.stringify({ description: 'Private managed directory with no repository' })], "no repository, no registered directory");
  assert.equal(result.workspaceReference, undefined);
  assert.equal(result.parameterEvidence.selections.workspaceKind, 'managed');
  // A named repository or directory still wins: the conversation asked for it.
  calls.length = 0;
  const named = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex repo:owner/project', tags: { repo: 'owner/project' }, candidates: [withRepo], managedOnly: true });
  assert.equal(named.workspaceReference, 'repo:owner/project');
});

test('with nothing left to choose Jev is not called, and each choice is recorded as the only option it was', async () => {
  let calls = 0;
  const onlyOne = { ...candidates[0], models: [] };
  const result = await registrationLaunchChooser(async input => { calls++; return answer(input); })({
    message: '@codex launch:force co-write this page', tags: { launch: 'force' }, candidates: [onlyOne],
    managedWorkspace: true, managedOnly: true });
  assert.equal(calls, 0, "one harness, one directory, the runtime's own model: no question is left");
  assert.equal(result.workspaceReference, undefined);
  assert.equal(result.useRuntimeDefaultModel, true);
  assert.deepEqual(result.parameterEvidence.choices,
    [{ key: 'workspace', selected: 'workspace_0', probabilities: { workspace_0: 1 }, only: true }]);
  assert.equal(result.parameterEvidence.rubricVersion, 'registration-parameters-v11');
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
  // A choice beside it is still Jev's to make, and the one-option question goes with it as before.
  const asked = [];
  const withModels = await registrationLaunchChooser(async input => { asked.push(input); return answer(input); })({
    message: '@codex launch:force co-write this page', tags: { launch: 'force' }, candidates: [candidates[0]],
    managedWorkspace: true, managedOnly: true });
  assert.deepEqual(asked.map(call => Object.keys(call.questions)), [['workspace', 'modelEffort']]);
  assert.equal(withModels.parameterEvidence.choices.some(choice => choice.only), false);
});

const modelOptions = call => Object.values(call.questions.modelEffort.criteria).map(value => JSON.parse(value));

test('an empty model list skips model selection, even beside an observed catalog', async () => {
  for (const harness of ['cursor', 'codex', 'claude', 'kimi']) {
    const candidate = { ...candidates[0], key: { ...candidates[0].key, harness }, models: [], supportsRequestedEffort: true,
      modelCatalog: [{ model: 'gpt-5.4', description: 'Reported', efforts: [{ value: 'medium', description: 'Default' }] }] };
    const calls = [];
    const chosen = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
      message: `@${harness}`, tags: {}, candidates: [candidate] });
    assert.deepEqual(Object.keys(calls.at(-1).questions), ['workspace']);
    assert.equal(chosen.useRuntimeDefaultModel, true);
    assert.equal(chosen.model, '');
    assert.equal(chosen.effort, undefined);
    assert.equal(Object.hasOwn(chosen.parameterEvidence.selections, 'model'), false);
    assert.deepEqual(chosen.parameterEvidence.choices.map(choice => choice.key), ['workspace']);
    const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
    assert.deepEqual(parseLaunchParameterEvidence(chosen.parameterEvidence), chosen.parameterEvidence);
    // No model override is allowed, so any explicit model is unavailable, including one
    // spelled like the harness; so is an effort while the daemon cannot carry it to the default model.
    for (const tags of [{ model: harness }, { model: 'gpt-5.4' }, { effort: 'medium' }]) {
      await assert.rejects(registrationLaunchChooser(async input => answer(input))({
        message: `@${harness}`, tags, candidates: [candidate] }), error => error.code === (tags.effort
        ? 'registration_effort_unavailable' : 'registration_model_unavailable'));
    }
  }
});

test('a requested effort applies to the runtime default model without a model choice', async () => {
  const candidate = { ...candidates[0], models: [], supportsRequestedEffort: true, supportsDefaultModelEffort: true,
    parameterModel: 'gpt-5.4',
    modelCatalog: [{ model: 'gpt-5.4', description: 'Reported', efforts: [{ value: 'high', description: 'Thorough' }] }] };
  const calls = [];
  const choose = (tags, from = candidate) => registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: `@codex effort:${tags.effort}`, tags, candidates: [from] });
  const chosen = await choose({ effort: 'high' });
  assert.deepEqual(Object.keys(calls.at(-1).questions), ['workspace'], 'the effort is the author\'s, not a choice');
  assert.deepEqual([chosen.useRuntimeDefaultModel, chosen.model, chosen.effort], [true, '', 'high']);
  assert.deepEqual(chosen.parameterEvidence.selections.effort, 'high');
  assert.equal(Object.hasOwn(chosen.parameterEvidence.selections, 'model'), false);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(chosen.parameterEvidence), chosen.parameterEvidence);
  // Effort requires positive evidence for the current default model.
  await assert.rejects(choose({ effort: 'medium' }), error => error.code === 'registration_effort_unavailable');
  await assert.rejects(choose({ effort: 'medium' }, { ...candidate, modelCatalog: undefined }),
    error => error.code === 'registration_effort_unavailable');
  await assert.rejects(choose({ effort: 'high', model: 'gpt-5.4' }), error => error.code === 'registration_effort_unavailable');
});

test('effort routing excludes unproven controls before weighing fit or machine headroom', async () => {
  const supported = { ...candidates[0], models: [], supportsRequestedEffort: true, supportsDefaultModelEffort: true,
    parameterModel: 'reasoner', modelCatalog: [{ model: 'reasoner', description: '', efforts: [{ value: 'high', description: '' }] }] };
  const unsupported = { ...supported, key: { ...supported.key, harness: 'cursor' },
    observations: { machineResources: { cpuUsagePercent: 0 }, quota: { remainingPercent: 100, assumed: true } } };
  for (const missing of [
    { modelCatalog: [{ model: 'reasoner', description: '', efforts: [] }] },
    { modelCatalog: undefined },
    { parameterModel: undefined },
    { parameterModel: 'other-model' },
    { supportsDefaultModelEffort: false },
  ]) {
    const cursor = { ...unsupported, ...missing };
    const chosen = await registrationLaunchChooser(async input => answer(input))({
      message: '@auto effort:high', tags: { effort: 'high' }, candidates: [cursor, supported] });
    assert.deepEqual(chosen.key, supported.key);
    assert.equal(chosen.effort, 'high');
    await assert.rejects(registrationLaunchChooser(async () => { throw new Error('must not evaluate'); })({
      message: '@cursor effort:high', tags: { effort: 'high' }, candidates: [cursor] }),
    error => error.code === 'registration_effort_unavailable');
  }
  // Declaring model names does not prove that the provider can set effort either.
  await assert.rejects(registrationLaunchChooser(async () => { throw new Error('must not evaluate'); })({
    message: '@auto model:reasoner effort:high', tags: { model: 'reasoner', effort: 'high' },
    candidates: [{ ...unsupported, models: ['reasoner'], modelCatalog: undefined }] }),
  error => error.code === 'registration_effort_unavailable');
});

test('default-only harnesses read intent, location and fit in one call, then weigh machine load', async () => {
  const calls = [];
  const available = twoHarnesses.map(candidate => ({ ...candidate, models: [] }));
  available.push({ ...available[1], key: { ...available[1].key, ownerUserId: 'idle', machineId: 'idle' },
    workspaces: available[1].workspaces.map(workspace => ({ ...workspace, machineId: 'idle' })),
    observations: { outstandingMachineAllocations: 0, quota: { remainingPercent: 100, assumed: true },
      machineResources: { cpuUsagePercent: 5 } } });
  const chosen = await registrationLaunchChooser(async input => { calls.push(input); return answer(input, { intent: 'summon' }); })({
    message: '@auto inspect', tags: {}, candidates: available,
    summon: { text: '@auto', start: 0, end: 5, authorKind: 'human' } });
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [['intent', 'workspace', 'fit_0', 'fit_1']]);
  assert.equal(chosen.key.machineId, 'idle');
  assert.equal(chosen.useRuntimeDefaultModel, true);
  assert.equal(chosen.parameterEvidence.placement.ranking[0].machineId, 'idle');
});

test('declared models are a choice only for the environment that runs the work', async () => {
  const roomy = { evaluatedAt: 'now', outstandingMachineAllocations: 0, outstandingRegistrationAllocations: 0,
    quota: { remainingPercent: 100, assumed: true }, machineResources: { observedAt: 'now', cpuUsagePercent: 10 } };
  const calls = [];
  const chosen = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex', tags: {}, candidates: [{ ...candidates[0], models: [] }, { ...candidates[1], observations: roomy }] });
  assert.deepEqual(modelOptions(calls.at(-1)).map(option => option.model), ['small', 'large']);
  assert.equal(chosen.key.machineId, 'last');
  assert.equal(chosen.useRuntimeDefaultModel, undefined);
  // The default-only environment with more room runs its runtime default; nothing is asked.
  calls.length = 0;
  const defaults = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex', tags: {}, candidates: [{ ...candidates[0], models: [], observations: roomy }, candidates[1]] });
  assert.equal(defaults.key.machineId, 'first');
  assert.equal(defaults.useRuntimeDefaultModel, true);
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [['workspace']]);
});

test('an explicit model list offers the observed catalog intersected with it', async () => {
  const candidate = { ...candidates[0], models: ['gpt-5.4', 'gpt-5.5'], supportsRequestedEffort: true,
    modelCatalog: [
      { model: 'gpt-5.4', description: 'Reported', efforts: [{ value: 'medium', description: 'Default' }] },
      { model: 'gpt-6-private', description: 'Not allowed', efforts: [{ value: 'high', description: 'Deep' }] }] };
  const calls = [];
  const chosen = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex', tags: {}, candidates: [candidate] });
  assert.deepEqual(modelOptions(calls.at(-1)).map(option => option.model), ['gpt-5.4']);
  assert.equal(chosen.model, 'gpt-5.4');
  assert.equal(chosen.useRuntimeDefaultModel, undefined);
  // A model the list does not allow is never offered, observed or not.
  await assert.rejects(registrationLaunchChooser(async input => answer(input))({
    message: '@codex model:gpt-6-private', tags: { model: 'gpt-6-private' }, candidates: [candidate] }),
  error => error.code === 'registration_model_unavailable');
  // Without any observed catalog entry, the allowed models themselves are the options.
  const unobserved = [];
  const declared = await registrationLaunchChooser(async input => { unobserved.push(input); return answer(input); })({
    message: '@codex', tags: {}, candidates: [{ ...candidate, modelCatalog: undefined }] });
  assert.deepEqual(modelOptions(unobserved.at(-1)).map(option => [option.model, option.default]), [['gpt-5.4', undefined], ['gpt-5.5', undefined]]);
  assert.equal(declared.model, 'gpt-5.5');
  assert.equal(declared.useRuntimeDefaultModel, undefined);
});

test('observed models retain automatic model and supported effort selection', async () => {
  const candidate = { ...candidates[0], models: ['large'], supportsRequestedEffort: true,
    modelCatalog: [{ model: 'large', description: 'Runtime report', efforts: [{ value: 'high', description: 'Thorough' }] }] };
  const chosen = await registrationLaunchChooser(async input => answer(input))({
    message: '@codex', tags: {}, candidates: [candidate] });
  assert.equal(chosen.useRuntimeDefaultModel, undefined);
  assert.equal(chosen.model, 'large');
  assert.equal(chosen.effort, 'high');
});

test('a listed repository comes first; directories are offered only when no repository is', async () => {
  const repo = (name) => ({ reference: `repo:owner/${name}`, repo: `owner/${name}`, machineId: 'first', description: name });
  const candidate = { ...candidates[0], workspaceReferences: ['workspace-a', 'repo:owner/project', 'repo:owner/docs'],
    workspaces: [candidates[0].workspaces[0], repo('project'), repo('docs')] };
  const calls = [];
  const chosen = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex', tags: {}, candidates: [candidate], managedWorkspace: true });
  assert.deepEqual(Object.values(calls[0].questions.workspace.criteria).map(value => JSON.parse(value).repo), ['owner/project', 'owner/docs']);
  assert.equal(chosen.workspaceReference, 'repo:owner/docs');
  assert.deepEqual(chosen.parameterEvidence.selections, { model: 'large', workspaceKind: 'repo', repo: 'owner/docs' });
  // An explicit pwd: still names its directory, even beside repositories.
  const explicit = await registrationLaunchChooser(async input => answer(input))({ message: '@codex pwd:/projects/a', tags: { pwd: '/projects/a' }, candidates: [candidate] });
  assert.equal(explicit.workspaceReference, 'workspace-a');
  assert.equal(explicit.parameterEvidence.selections.workspaceKind, 'local-path');
  assert.equal(explicit.parameterEvidence.selections.repo, undefined);
  // Without a repository, registered and managed directories are the choices.
  calls.length = 0;
  const directory = await registrationLaunchChooser(async input => { calls.push(input); return answer(input, { workspace: 'workspace_0' }); })({
    message: '@codex', tags: {}, candidates: [candidates[0]], managedWorkspace: true });
  assert.equal(Object.keys(calls[0].questions.workspace.criteria).length, 3);
  assert.equal(directory.workspaceReference, 'workspace-a');
  assert.equal(directory.parameterEvidence.selections.repo, undefined);
});

const summon = { text: '@codex', start: 0, end: 6, authorKind: 'agent' };
test('Jev answers intent in the first call; a non-request starts nothing', async () => {
  const calls = [];
  const choose = registrationLaunchChooser(async input => { calls.push(input); return answer(input, { intent: 'explanation' }); });
  await assert.rejects(choose({ message: '@codex was started by my heading', tags: {}, candidates, summon }),
    error => error.code === 'summon_intent_explanation' && error.status === 409);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions), ['intent', 'workspace', 'modelEffort']);
  assert.deepEqual(calls[0].state.summon, summon);
});
test('a request launches and keeps the intent evidence', async () => {
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input, { intent: 'summon' }); })({
    message: '@codex inspect', tags: {}, candidates, summon });
  assert.equal(calls.length, 1, "intent, location and model are read together");
  assert.equal(result.parameterEvidence.intent.source, 'jev');
  assert.equal(result.parameterEvidence.intent.probabilities.summon, 1);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
});
test('launch:force skips only the intent question', async () => {
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@auto launch:force inspect', tags: { launch: 'force' }, candidates: twoHarnesses, summon });
  assert.deepEqual(Object.keys(calls[0].questions), ['workspace', 'fit_0', 'fit_1']);
  assert.equal(Object.hasOwn(calls[0].state, 'summon'), false);
  assert.deepEqual(result.parameterEvidence.intent, { source: 'author' });
});
test('a message that summons nobody asks Jev whether to start and a no refuses', async () => {
  const calls = [];
  const choose = registrationLaunchChooser(async input => { calls.push(input); return answer(input, { intent: 'conversation' }); });
  await assert.rejects(choose({ message: 'thanks everyone', tags: {}, candidates: twoHarnesses, askToStart: true }),
    error => error.code === 'start_intent_declined' && error.status === 409);
  assert.deepEqual(Object.keys(calls[0].questions), ['intent', 'workspace', 'fit_0', 'fit_1']);
  assert.deepEqual(Object.keys(calls[0].questions.intent.criteria), ['summon', 'conversation']);
  const result = await registrationLaunchChooser(async input => answer(input, { intent: 'summon' }))({
    message: 'fix the flaky login test', tags: {}, candidates, askToStart: true });
  assert.equal(result.parameterEvidence.intent.source, 'jev');
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
});


test("dynamic parameters constrain eligible harnesses and the model which advertised them", async () => {
  const parameters = [{ id: "future-speed", label: "Speed", options: ["turbo"] }];
  const tags = { parameters: JSON.stringify({ "future-speed": "turbo" }) };
  const catalog = [{ ...candidates[0], key: { ...candidates[0].key, harness: "kimi" }, supportsRequestedParameters: true, parameters, parameterModel: "large" },
    { ...candidates[1], parameters: [] }];
  const calls = [];
  const chooser = registrationLaunchChooser(async input => { calls.push(input); return answer(input); });
  const selected = await chooser({ message: "@auto param.future-speed:turbo", tags, candidates: catalog });
  assert.equal(selected.key.harness, "kimi");
  assert.equal(selected.model, "large");
  assert.deepEqual(selected.parameters, { "future-speed": "turbo" });
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [["workspace", "modelEffort"]],
    "one harness offers it: Jev scores no fit");
  await assert.rejects(chooser({ message: "@auto", tags, candidates: [{ ...catalog[0], parameters: [] }] }),
    error => error.code === "registration_parameter_unavailable");
  await assert.rejects(chooser({ message: "@auto", tags: { ...tags, model: "small" }, candidates: catalog }),
    error => error.code === "registration_model_unavailable");
  const aliased = await chooser({ message: "@auto", tags, candidates: [{ ...catalog[0],
    models: ["alias"], modelAliases: { alias: "large" } }] });
  assert.equal(aliased.model, "alias");
});


test("cold catalogs defer authored parameters only to a capable native runtime", async () => {
  const chooser = registrationLaunchChooser(async input => answer(input));
  const tags = { parameters: JSON.stringify({ fast: "true" }) };
  const cold = { ...candidates[0], supportsRequestedParameters: true };
  const selected = await chooser({ message: "@auto fast:true", tags, candidates: [cold] });
  assert.deepEqual(selected.parameters, { fast: "on" });
  for (const candidate of [{ ...cold, parameters: [] }, { ...cold, supportsRequestedParameters: false }]) {
    await assert.rejects(chooser({ message: "@auto", tags, candidates: [candidate] }),
      error => error.code === "registration_parameter_unavailable");
  }
});

test('a machine kept out of automatic assignment runs only work that names it', async () => {
  // 2026-10-05: an owner's laptop must never take auto-assigned work, since it may close at any time.
  const kept = candidates.map(candidate => candidate.key.machineId === 'last' ? { ...candidate, autoAssign: false } : candidate);
  const offered = [];
  const auto = await registrationLaunchChooser(async input => { offered.push(input); return answer(input); })({
    message: '@codex', tags: {}, candidates: kept });
  assert.equal(auto.key.machineId, 'first');
  // Load alone would prefer it, and still it is not chosen.
  const busy = { ...kept[0], observations: { evaluatedAt: 'now', outstandingMachineAllocations: 9,
    outstandingRegistrationAllocations: 9, quota: { remainingPercent: 100, assumed: true } } };
  assert.equal((await registrationLaunchChooser(async input => answer(input))({
    message: '@codex', tags: {}, candidates: [busy, kept[1]] })).key.machineId, 'first');
  await assert.rejects(registrationLaunchChooser(async () => assert.fail('Jev must not be called'))({
    message: '@codex', tags: {}, candidates: [kept[1]] }), error => error.code === 'registration_machine_not_auto_assigned');
  // Named by `machine:` or by a directory registered on it, it runs the work.
  assert.equal((await registrationLaunchChooser(async input => answer(input))({
    message: '@codex machine:last', tags: { machine: 'last' }, candidates: kept })).key.machineId, 'last');
  const byDirectory = await registrationLaunchChooser(async input => answer(input))({
    message: '@codex pwd:/projects/a', tags: { pwd: '/projects/a' }, candidates: [kept[1]] });
  assert.equal(byDirectory.key.machineId, 'last');
});

test("a laptop is the machine's own form; Jev is not asked and headroom still picks", async () => {
  const resources = (formFactor, cpuUsagePercent) => ({ evaluatedAt: 'now', outstandingMachineAllocations: 0,
    outstandingRegistrationAllocations: 0, quota: { remainingPercent: 100, assumed: true },
    machineResources: { observedAt: 'now', cpuLogicalCount: 8, cpuUsagePercent, ...(formFactor ? { formFactor } : {}) } });
  // The idle laptop has the most headroom, so it runs the work. Its form is not a question.
  const mixed = [{ ...candidates[0], observations: resources(undefined, 80) }, { ...candidates[1], observations: resources('laptop', 5) }];
  const asked = [];
  const selected = await registrationLaunchChooser(async input => { asked.push(input); return answer(input); })({
    message: '@codex migrate every service overnight', tags: {}, candidates: mixed });
  assert.equal(selected.key.machineId, 'last');
  assert.equal(Object.hasOwn(asked[0].questions, 'placement'), false);
  assert.deepEqual(asked.map(call => Object.keys(call.questions)), [['workspace', 'modelEffort']]);
  assert.equal(selected.parameterEvidence.choices.some(choice => choice.key === 'placement'), false);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(selected.parameterEvidence), selected.parameterEvidence);
});


test('a Human-confirmed draft reading skips only intent and keeps the remaining launch selection', async () => {
  const calls = [];
  const result = await registrationLaunchChooser(async input => { calls.push(input); return answer(input); })({
    message: '@codex inspect', tags: {}, candidates, summon: { ...summon, readInDraft: true } });
  assert.deepEqual(calls.map(call => Object.keys(call.questions)), [['workspace', 'modelEffort']]);
  assert.deepEqual(result.parameterEvidence.intent, { source: 'draft' });
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(result.parameterEvidence), result.parameterEvidence);
});

test('an environment that failed to start in the last 30 minutes goes after every one that did not', async () => {
  // 2026-10-17: `@auto` sent a new user's first task to a Grok that could not start, twice in a row.
  const machine = (id, load, startupFailedAt) => ({ ...candidates[0], key: { ...candidates[0].key, machineId: id },
    ...(startupFailedAt ? { startupFailedAt } : {}),
    observations: { evaluatedAt: 'now', outstandingMachineAllocations: 0, outstandingRegistrationAllocations: 0,
      quota: { remainingPercent: 100, assumed: true },
      machineResources: { observedAt: 'now', cpuLogicalCount: 8, loadAverage: [load, 0, 0] } } });
  const failed = machine('failed', 0, '2026-10-17T09:38:00.000Z'), busy = machine('busy', 6);
  const ranked = jointRanking([failed, busy], () => 1);
  assert.deepEqual(ranked.map(item => item.candidate.key.machineId), ['busy', 'failed']);
  // Weighed only against its own kind: the failed one does not push the busy one off the frontier.
  assert.deepEqual(ranked.map(item => item.frontier), [true, true]);
  // A better fit that failed still goes last; with nothing else, it still runs the work.
  assert.equal(jointRanking([failed, busy], candidate => candidate === failed ? 1 : 1 / 3)[0].candidate, busy);
  assert.equal(jointRanking([failed], () => 1)[0].candidate, failed);
  // The chooser records the breaker in its evidence.
  const chosen = await registrationLaunchChooser(async input => answer(input))({ message: '@codex', tags: {},
    candidates: [{ ...candidates[0], ...failed, key: candidates[0].key }, { ...candidates[1], observations: busy.observations }] });
  assert.deepEqual(chosen.key, candidates[1].key);
  assert.equal(chosen.parameterEvidence.placement.ranking[1].startupFailedAt, '2026-10-17T09:38:00.000Z');
  assert.equal(chosen.parameterEvidence.placement.ranking[0].startupFailedAt, undefined);
});

test('equally fit, the harness that measurably replies sooner runs the work; a strong fit may still be slower', async () => {
  // 2026-10-17 production medians, connected Run to first reply: Claude 22 s, Grok 60 s, OpenCode 160 s.
  const harness = (name, responseLatencyMs) => ({ ...candidates[0],
    key: { ...candidates[0].key, harness: name }, ...(responseLatencyMs ? { responseLatencyMs } : {}),
    observations: { evaluatedAt: 'now', outstandingMachineAllocations: 0, outstandingRegistrationAllocations: 0,
      quota: { remainingPercent: 100, assumed: true },
      machineResources: { observedAt: 'now', cpuLogicalCount: 8, loadAverage: [0, 0, 0] } } });
  const claude = harness('claude', 22_000), grok = harness('grok', 60_000), opencode = harness('opencode', 160_000);
  const ranked = jointRanking([opencode, grok, claude], () => 1 / 3);
  assert.deepEqual(ranked.map(item => item.candidate.key.harness), ['claude', 'grok', 'opencode']);
  assert.deepEqual(ranked.map(item => Math.round(item.responseQuality * 100) / 100), [1, 0.37, 0.14]);
  assert.deepEqual(ranked.map(item => item.frontier), [true, false, false]);
  // A strong fit outweighs a slower reply until the wait costs more than the fit gains.
  const strong = name => candidate => candidate.key.harness === name ? 2 / 3 : 1 / 3;
  assert.equal(jointRanking([claude, grok], strong('grok'))[0].candidate, grok);
  assert.equal(jointRanking([claude, opencode], strong('opencode'))[0].candidate, claude);
  // Without enough launches a harness is not judged on speed, and the only
  // measured one is its own fastest: neither is held back.
  const unmeasured = harness('kimi');
  assert.equal(jointRanking([unmeasured, grok], () => 1 / 3)[0].responseQuality, undefined);
  assert.deepEqual(jointRanking([grok, unmeasured], () => 1 / 3).map(item => [item.candidate.key.harness, item.frontier]),
    [['grok', true], ['kimi', true]]);
  // The chooser records each one's measured latency, and the evidence parses.
  const chosen = await registrationLaunchChooser(async input => answer(input))({ message: '@auto', tags: {},
    candidates: [grok, claude] });
  assert.equal(chosen.key.harness, 'claude');
  assert.deepEqual(chosen.parameterEvidence.placement.ranking.map(item => [item.harness, item.responseLatencyMs, item.responseQuality]),
    [['claude', 22_000, 1], ['grok', 60_000, 0.367]]);
  const { parseLaunchParameterEvidence } = await import('@xmatrix/protocol');
  assert.deepEqual(parseLaunchParameterEvidence(chosen.parameterEvidence), chosen.parameterEvidence);
});

test('level on the weakest side, the next-weakest decides: a slow network does not hand the work to the worse fit', () => {
  // 2026-10-17 15:46: on one machine whose network quality was 0.05, every
  // environment was level on it, and a 0.25 fit Cursor beat a 0.94 fit Grok
  // on reply time alone.
  const now = Date.now(), observedAt = new Date(now - 1000).toISOString();
  const slowNetwork = (harness, responseLatencyMs) => ({ ...candidates[0], key: { ...candidates[0].key, harness },
    responseLatencyMs, observations: { evaluatedAt: observedAt, outstandingMachineAllocations: 0, outstandingRegistrationAllocations: 0,
      quota: { remainingPercent: 100, assumed: true },
      machineResources: { observedAt, cpuLogicalCount: 8, loadAverage: [0, 0, 0], network: { observedAt,
        target: 'cloudflare-speed', protocol: 'https', attempts: 10, failures: 0, latencyP95Ms: 700, latencyMedianMs: 300 } } } });
  const cursor = slowNetwork('cursor', 52_951), grok = slowNetwork('grok', 54_801), claude = slowNetwork('claude', 22_220);
  const fits = { cursor: 0.25, grok: 0.94, claude: 0.01 };
  const fast = { ...claude, key: { ...claude.key, machineId: 'fast' }, observations: { ...claude.observations,
    machineResources: { ...claude.observations.machineResources, network: { ...claude.observations.machineResources.network,
      latencyP95Ms: 35, latencyMedianMs: 20 } } } };
  const ranked = jointRanking([cursor, grok, claude, fast], candidate => fits[candidate.key.harness], now);
  assert.equal(ranked[0].candidate, grok);
  assert.deepEqual(ranked.slice(1, 3).map(item => item.candidate.key.harness), ['cursor', 'claude']);
});
