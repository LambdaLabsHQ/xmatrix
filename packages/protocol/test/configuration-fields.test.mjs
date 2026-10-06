import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpaceAgentConfiguration } from '../dist/agent-registration-configuration.js';
import { parseRegistrationResourceLimits } from '../dist/agent-registration-access.js';

test('unknown configuration is reported without values, discarded and never mutates the input', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const input = { workspaceReferences: [], secretReferences: [], maxConcurrent: 0,
      'unsafe\nname': 'private-value', futureOption: { secret: 'private-value' } };
    const snapshot = structuredClone(input);
    assert.deepEqual(parseSpaceAgentConfiguration(input), { workspaceReferences: [] });
    assert.deepEqual(input, snapshot);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0][1].fields, ['maxConcurrent', '<invalid-field-name>', 'futureOption']);
    assert.equal(JSON.stringify(warnings).includes('private-value'), false);
    assert.throws(() => parseSpaceAgentConfiguration({ ...input, workspaceReferences: ['*'] }));
    assert.deepEqual(parseRegistrationResourceLimits({ workspaces: [], models: [], secrets: [], capabilities: [],
      maxConcurrent: 'invalid retired value', admin: true }), { workspaces: [], models: [], capabilities: [] });
  } finally { console.warn = original; }
});
