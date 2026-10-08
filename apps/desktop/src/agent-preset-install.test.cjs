const assert = require('node:assert/strict');
const test = require('node:test');
const { agentPresetInstallCommand, installAgentPreset } = require('./agent-preset-install.ts');

test('installer accepts only native-owned package selections on both platforms', () => {
  assert.deepEqual(agentPresetInstallCommand('codex', 'darwin'), {
    file: 'npm', args: ['install', '--global', '--no-audit', '--no-fund', '@openai/codex'],
  });
  assert.deepEqual(agentPresetInstallCommand('opencode', 'win32'), {
    file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm install --global --no-audit --no-fund opencode-ai'],
  });
  assert.deepEqual(agentPresetInstallCommand('copilot', 'darwin').args.at(-1), '@github/copilot');
  assert.deepEqual(agentPresetInstallCommand('qwen', 'linux').args.at(-1), '@qwen-code/qwen-code');
  assert.deepEqual(agentPresetInstallCommand('qoder', 'linux').args.at(-1), '@qoder-ai/qodercli');
  assert.deepEqual(agentPresetInstallCommand('autohand', 'darwin').args.slice(-2), ['autohand-cli', '@autohandai/autohand-acp']);
  for (const input of ['codex & whoami', '__proto__', 'constructor', '', null, { id: 'codex' }]) {
    assert.throws(() => agentPresetInstallCommand(input, 'win32'));
  }
});

test('unsupported input fails without starting a process or registering a profile', async () => {
  assert.equal((await installAgentPreset('custom', {})).ok, false);
});
