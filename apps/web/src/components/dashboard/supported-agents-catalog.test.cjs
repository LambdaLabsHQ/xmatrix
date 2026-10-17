const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { AGENT_PRESETS } = require("@xmatrix/protocol");
const { LEADING_AGENT_IDS, SUPPORTED_AGENTS, agentInstallCommand } = require("./supported-agents-catalog.ts");

const preset = (id) => AGENT_PRESETS.find((candidate) => candidate.id === id);

test("every registry agent is offered, the ones most people arrive with first", () => {
  assert.deepEqual(SUPPORTED_AGENTS.slice(0, LEADING_AGENT_IDS.length).map((agent) => agent.id), LEADING_AGENT_IDS);
  assert.deepEqual(SUPPORTED_AGENTS.map((agent) => agent.id).sort(),
    AGENT_PRESETS.filter((agent) => agent.id !== "custom").map((agent) => agent.id).sort());
});

test("an installer is shown as a person pastes it, per platform", () => {
  assert.equal(agentInstallCommand(preset("claude"), "unix"), "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(agentInstallCommand(preset("claude"), "windows"), "irm 'https://claude.ai/install.ps1' | iex");
  assert.equal(agentInstallCommand(preset("codex"), "unix"), "npm install -g @openai/codex@latest");
  assert.equal(agentInstallCommand(preset("trae"), "unix"), 'sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)"');
});

test("an agent with no verified installer offers no command to paste", () => {
  assert.equal(agentInstallCommand(preset("zcode"), "unix"), undefined);
  // Amp's hint is prose; pasting it into a terminal would fail.
  assert.equal(agentInstallCommand(preset("amp"), "unix"), undefined);
});
