const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..", "..", "..", "..", "..");
const admin = fs.readFileSync(path.join(__dirname, "workspace-admin-views.tsx"), "utf8");

const cliArgs = fs.readFileSync(
  path.join(repoRoot, "packages", "cli-rs", "crates", "args", "src", "lib.rs"),
  "utf8",
);
const bootstrap = fs.readFileSync(
  path.join(repoRoot, "packages", "cli-rs", "crates", "core", "src", "bootstrap.rs"),
  "utf8",
);
const onboarding = fs.readFileSync(
  path.join(repoRoot, "apps", "web", "public", "prompts", "agent-cli-onboarding.md"),
  "utf8",
);
const skill = fs.readFileSync(
  path.join(repoRoot, "apps", "web", "public", "skills", "xmatrix", "references", "automations.md"),
  "utf8",
);
function assertAutomationSemantics(source, label) {
  assert.doesNotMatch(source, /oneshot:/, `${label} must not offer a lifetime option`);
  assert.match(source, /--every|resume interval|cadence/, `${label} must distinguish cadence`);
  assert.match(
    source,
    /(?:every|other) live Agents receive(?: the scheduled message)?(?: as)? context(?: only)?|everyone else receives context only/,
    `${label} must classify non-target live Agents as context`,
  );
  assert.match(
    source,
    /No Agent mention|Without an Agent mention|without an Agent mention|An expression without an Agent mention/,
    `${label} must forbid implicit Agent selection`,
  );
}

test("UI, CLI, bootstrap, and public Agent materials retain one Automation contract", () => {
  for (const [label, source] of [
    ["Web guidance", admin],
    ["CLI help", cliArgs],
    ["trusted bootstrap", bootstrap],
    ["Agent onboarding", onboarding],
    ["public xMatrix skill", skill],
  ]) {
    assertAutomationSemantics(source, label);
  }
});
