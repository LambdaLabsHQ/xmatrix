import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_INPUT_BYTES } from '@xmatrix/decision-model';
import {
  routingPrerequisiteInputBatches,
} from "../scripts/agent-routing-prerequisite-input.ts";

const input = count => ({ state: { task: 'Fix tests', requirements: { model: 'same-model', requiredCapabilities: [] } },
  questions: { environment: { type: 'choice', instructions: 'Select', criteria: {
    abstain: 'No match', ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`candidate_${i}`,
      JSON.stringify({ harness: 'codex', fits: '普通编码环境'.repeat(40), capabilities: [], scheduling: { quota: 90 } })])),
  } } } });

test('UTF-8 byte batches preserve all 100 candidates and explicit requirements', () => {
  const original = input(100);
  const before = JSON.stringify(original);
  const batches = routingPrerequisiteInputBatches(original);
  assert.ok(batches.length > 1);
  const handles = [];
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') <= MAX_INPUT_BYTES);
    assert.deepEqual(batch.state.requirements, original.state.requirements);
    handles.push(...Object.keys(batch.state.candidates));
    for (const [handle, candidate] of Object.entries(batch.state.candidates)) {
      assert.equal('scheduling' in candidate, false);
      for (const dimension of ['access', 'platform', 'continuity']) {
        assert.ok(batch.questions[`${handle}_${dimension}`]);
      }
    }
    assert.equal(Object.keys(batch.questions).length, Object.keys(batch.state.candidates).length * 3);
  }
  assert.deepEqual(handles, Array.from({ length: 100 }, (_, i) => `candidate_${i}`));
  assert.equal(JSON.stringify(original), before);
});

test('oversized individual facts and malformed handles fail instead of dropping candidates', () => {
  const large = input(1);
  large.questions.environment.criteria.candidate_0 = JSON.stringify({ fits: 'x'.repeat(MAX_INPUT_BYTES) });
  assert.throws(() => routingPrerequisiteInputBatches(large), /exceeds input limit/);
  const malformed = input(1);
  malformed.questions.environment.criteria['private-owner'] = '{}';
  assert.throws(() => routingPrerequisiteInputBatches(malformed), /Invalid prerequisite candidate/);
  assert.throws(() => routingPrerequisiteInputBatches(input(101)), /candidate count/);
});
