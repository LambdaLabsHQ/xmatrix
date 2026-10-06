import assert from "node:assert/strict";
import test from "node:test";
import {
  agentAvatarUrlFromMetadata,
  agentLaunchExecutable,
  agentPresetById,
  agentPresetForLauncher,
  normalizeAgentPresetRuntime,
} from "../dist/index.js";

test("cursor preset keeps the Cursor vendor icon", () => {
  assert.equal(agentPresetById("cursor")?.avatarUrl, "/agent-vendors/cursor.png");
});

test("normalizeAgentPresetRuntime maps Cursor launcher aliases", () => {
  assert.equal(normalizeAgentPresetRuntime("cursor-agent"), "cursor");
  assert.equal(normalizeAgentPresetRuntime("cursor-agent.exe"), "cursor");
  assert.equal(normalizeAgentPresetRuntime("C:\\\\bin\\\\cursor-agent.cmd"), "cursor");
  assert.equal(normalizeAgentPresetRuntime("claude_code"), "claude");
});

test("cursor-agent does not inherit the shared ACP backend's Kimi vendor", () => {
  assert.equal(
    agentAvatarUrlFromMetadata(
      { presetId: "custom", tool: "cursor-agent", backend: "acp" },
      "cursor-agent",
    ),
    "/agent-vendors/cursor.png",
  );
});

test("cursor launcher names resolve the Cursor vendor without a preset id", () => {
  assert.equal(
    agentAvatarUrlFromMetadata({ tool: "cursor-agent.exe", backend: "acp" }, "custom"),
    "/agent-vendors/cursor.png",
  );
});

test("kimi still resolves through its own runtime", () => {
  assert.equal(
    agentAvatarUrlFromMetadata({ presetId: "kimi", backend: "acp" }, "kimi"),
    "/agent-vendors/kimi.svg",
  );
});

test("opencode and pi are generic ACP presets with their own vendor icons", () => {
  const opencode = agentPresetById("opencode");
  assert.equal(opencode?.backend, "acp");
  assert.equal(opencode?.runtime, "opencode");
  assert.deepEqual(opencode?.acpArgs, ["acp"]);
  assert.equal(opencode?.installHint, "npm install -g opencode-ai");
  // Pi has no ACP server; the launcher is the ACP-registry pi-acp bridge,
  // which already speaks ACP with no subcommand.
  const pi = agentPresetById("pi");
  assert.equal(pi?.backend, "acp");
  assert.equal(pi?.runtime, "pi-acp");
  assert.deepEqual(pi?.acpArgs, []);
  assert.equal(
    agentAvatarUrlFromMetadata({ tool: "/opt/homebrew/bin/opencode", backend: "acp" }, "opencode"),
    "/agent-vendors/opencode.svg",
  );
  assert.equal(
    agentAvatarUrlFromMetadata({ tool: "pi-acp", backend: "acp" }, "custom"),
    "/agent-vendors/pi.svg",
  );
});

test("ACP-native harnesses are registry entries with a launcher, ACP argv and icon", async () => {
  const { existsSync } = await import("node:fs");
  const expected = {
    copilot: ["copilot", ["--acp"]],
    gemini: ["gemini", ["--acp"]],
    qwen: ["qwen", ["--acp"]],
    goose: ["goose", ["acp"]],
    junie: ["junie", ["--acp=true"]],
    vibe: ["vibe-acp", []],
    kiro: ["kiro-cli", ["acp"]],
    hermes: ["hermes", ["acp"]],
    openclaw: ["openclaw", ["acp"]],
  };
  for (const [id, [runtime, acpArgs]] of Object.entries(expected)) {
    const preset = agentPresetById(id);
    assert.equal(preset?.backend, "acp", id);
    assert.equal(preset?.runtime, runtime, id);
    assert.deepEqual(preset?.acpArgs, acpArgs, id);
    assert.ok(preset?.installHint, id);
    assert.ok(preset?.classicConfigDirs.length, id);
    assert.equal(normalizeAgentPresetRuntime(`/usr/local/bin/${runtime}.exe`), id);
    assert.ok(existsSync(new URL(`../../../apps/web/public${preset.avatarUrl}`, import.meta.url)), id);
  }
  // The vibe preset launches the ACP entrypoint, so a bare `vibe` harness key
  // still resolves to `vibe-acp` rather than the interactive TUI.
  assert.equal(normalizeAgentPresetRuntime("vibe"), "vibe");
  assert.equal(agentLaunchExecutable("vibe"), "vibe-acp");
  assert.equal(agentLaunchExecutable("kiro"), "kiro-cli");
});

test("normalizeAgentPresetRuntime derives every alias from the registry", () => {
  assert.equal(normalizeAgentPresetRuntime("pi-acp"), "pi");
  assert.equal(normalizeAgentPresetRuntime("/usr/local/bin/codex"), "codex");
  assert.equal(normalizeAgentPresetRuntime("claude-code.exe"), "claude");
  assert.equal(normalizeAgentPresetRuntime("kimi.cmd"), "kimi");
  // Unknown runtimes and the launcher-less custom preset pass through.
  assert.equal(normalizeAgentPresetRuntime("aider"), "aider");
  assert.equal(normalizeAgentPresetRuntime("custom"), "custom");
  assert.equal(normalizeAgentPresetRuntime("  "), undefined);
});

test("agentPresetForLauncher never resolves the custom preset", () => {
  assert.equal(agentPresetForLauncher("custom"), undefined);
  assert.equal(agentPresetForLauncher(""), undefined);
  assert.equal(agentPresetForLauncher("C:\\bin\\Cursor-Agent.CMD")?.id, "cursor");
  assert.equal(agentPresetForLauncher("claude_code")?.id, "claude");
});
