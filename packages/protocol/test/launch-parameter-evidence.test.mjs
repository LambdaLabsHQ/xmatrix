import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLaunchParameterEvidence } from '../dist/launch-parameter-evidence.js';
import { parsePresentedRoutingDecision } from '../dist/agent-routing.js';
const evidence = () => ({ rubricVersion: 'launch-parameters-v1', evaluatedAt: '2026-09-22T19:00:00Z', inputDigest: 'a'.repeat(64),
  selections: { model: 'model-B', effort: 'high', workspaceKind: 'local-path', privatePath: '/private' },
  choices: [{ key: 'modelEffort', selected: 'model_1', probabilities: { model_0: .1, model_1: .9 } },
    { key: 'workspace', selected: 'workspace_0', probabilities: { workspace_0: 1 } }],
  privateCatalog: ['/private'] });
test('shared evidence preserves all decisions without leaking private catalogs', () => {
  const parsed = parsePresentedRoutingDecision({ source: 'jev', rows: [], parameters: evidence() });
  assert.equal(parsed.parameters.selections.model, 'model-B');
  assert.equal(parsed.parameters.choices.length, 2);
  assert.equal(parsed.parameters.choices[0].probabilities.model_1, .9);
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
});
test('incomplete, mismatched and invalid decisions cannot appear as verified choices', () => {
  for (const change of [e => e.choices.pop(), e => e.choices.push(e.choices[0]),
    e => e.choices[0].selected = 'invented',
    e => e.choices[0].probabilities.model_1 = NaN, e => e.inputDigest = 'bad',
    e => e.choices[1].probabilities = { '/private': 1 }]) {
    const input = evidence(); change(input);
    assert.equal(parseLaunchParameterEvidence(input), undefined);
  }
});

test('v9 records a skipped model decision without inventing a selection', () => {
  const input = evidence();
  input.rubricVersion = 'registration-parameters-v9';
  input.selections = { workspaceKind: 'local-path' };
  input.choices.shift();
  assert.deepEqual(parseLaunchParameterEvidence(input).selections, { workspaceKind: 'local-path' });
  assert.deepEqual(parsePresentedRoutingDecision({ source: 'jev', rows: [], parameters: input }).parameters.choices, input.choices);
  for (const change of [e => e.rubricVersion = 'registration-parameters-v8',
    e => e.selections.model = '', e => e.selections.model = 'claimed', e => e.selections.effort = 'high',
    e => e.choices.unshift(evidence().choices[0]), e => e.choices = []]) {
    const malformed = structuredClone(input); change(malformed);
    assert.equal(parseLaunchParameterEvidence(malformed), undefined);
  }
});

test('environment choice survives public projection without private candidate fields', () => {
  const input = evidence();
  input.environment = { inputDigest: 'b'.repeat(64), selected: 'candidate_1', probabilities: { candidate_0: .2, candidate_1: .8 }, privatePath: '/private' };
  const parsed = parseLaunchParameterEvidence(input);
  assert.equal(parsed.environment.selected, 'candidate_1');
  assert.equal(parsed.environment.probabilities.candidate_0, .2);
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
  // The pick is shown as made, whatever the probabilities say.
  assert.equal(parseLaunchParameterEvidence({ ...input, environment: { ...input.environment, selected: 'candidate_0' } }).environment.selected, 'candidate_0');
  for (const bad of [
    { ...input.environment, inputDigest: 'wrong' },
    { ...input.environment, probabilities: { '/private': 1 } } ]) {
    assert.equal(parseLaunchParameterEvidence({ ...input, environment: bad }), undefined);
  }
});

test('a chosen repository is named; a directory never is', () => {
  const input = evidence();
  input.selections = { model: 'model-B', workspaceKind: 'repo', repo: 'owner/project' };
  assert.equal(parseLaunchParameterEvidence(input).selections.repo, 'owner/project');
  delete input.selections.repo;
  assert.equal(parseLaunchParameterEvidence(input).selections.repo, undefined, 'evidence from before the repo field still parses');
  for (const bad of [{ workspaceKind: 'local-path', repo: 'owner/project' }, { workspaceKind: 'repo', repo: '' },
    { workspaceKind: 'repo', repo: 'owner/\nproject' }, { workspaceKind: 'repo', repo: 'x'.repeat(301) }]) {
    assert.equal(parseLaunchParameterEvidence({ ...input, selections: { model: 'm', ...bad } }), undefined);
  }
});

test('a v7 placement choice still parses, and a decision without one does too', () => {
  const input = evidence();
  input.rubricVersion = 'registration-parameters-v7';
  input.choices.push({ key: 'placement', selected: 'placement_stationary', probabilities: { placement_any: .3, placement_stationary: .7 } });
  const parsed = parseLaunchParameterEvidence(input);
  assert.equal(parsed.choices.find(choice => choice.key === 'placement').selected, 'placement_stationary');
  input.choices.pop();
  input.rubricVersion = 'registration-parameters-v8';
  assert.equal(parseLaunchParameterEvidence(input).choices.some(choice => choice.key === 'placement'), false);
});

test('the harness Jev read as suited is kept by harness name; a malformed one is not shown', () => {
  const input = evidence();
  input.harness = { inputDigest: 'c'.repeat(64), selected: 'claude', probabilities: { codex: .3, claude: .7 }, privatePath: '/private' };
  const parsed = parseLaunchParameterEvidence(input);
  assert.deepEqual(parsed.harness, { inputDigest: 'c'.repeat(64), selected: 'claude', probabilities: { codex: .3, claude: .7 } });
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
  for (const bad of [{ ...input.harness, inputDigest: 'wrong' },
    { ...input.harness, probabilities: { 'Claude Code': 1 }, selected: 'Claude Code' },
    'claude']) {
    assert.equal(parseLaunchParameterEvidence({ ...input, harness: bad }), undefined);
  }
});

test('v10 keeps per-harness fit and the joint placement, and rejects malformed ones', () => {
  const input = evidence();
  input.rubricVersion = 'registration-parameters-v10';
  input.selections = { workspaceKind: 'local-path' };
  input.choices.shift();
  input.fit = { inputDigest: 'c'.repeat(64), scores: { codex: { score: 1, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0 } },
    claude: { score: 2.4, probabilities: { 2: .6, 3: .4 } } } };
  input.placement = { profile: 'balanced', ranking: [
    { harness: 'codex', machineId: 'm-idle', machineName: 'srv2006562', fit: 1 / 3, headroom: .86, frontier: true, utility: .334 },
    { harness: 'claude', machineId: 'm-busy', fit: .8, headroom: -.2, frontier: true, utility: -.199, privatePath: '/private' },
    { harness: 'opencode', machineId: 'm-new', fit: 1 / 3, frontier: false, utility: 0 }] };
  const parsed = parseLaunchParameterEvidence(input);
  assert.deepEqual(parsed.fit, input.fit);
  assert.equal(parsed.placement.ranking.length, 3);
  assert.equal(parsed.placement.ranking[2].headroom, undefined);
  assert.doesNotMatch(JSON.stringify(parsed), /private/);
  for (const change of [e => e.fit.scores.codex.score = 4, e => e.fit.scores.codex.probabilities = { 4: 1 },
    e => e.fit.scores['Not A Harness'] = { score: 1, probabilities: {} }, e => e.fit.inputDigest = 'bad',
    e => e.placement.profile = 'greedy', e => e.placement.ranking = [], e => e.placement.ranking[0].fit = 1.5,
    e => e.placement.ranking[0].frontier = 'yes', e => e.placement.ranking[0].machineId = '',
    e => e.placement.ranking = Array.from({ length: 9 }, () => e.placement.ranking[0])]) {
    const malformed = structuredClone(input); change(malformed);
    assert.equal(parseLaunchParameterEvidence(malformed), undefined);
  }
});
