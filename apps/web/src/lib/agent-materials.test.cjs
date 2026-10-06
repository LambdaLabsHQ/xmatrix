const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { agentOnboardingPrompt, xmatrixSkill, xmatrixSkillInstallCommand } = require("./agent-materials.ts");
const xmatrixSkillFiles = xmatrixSkillInstallCommand.match(/for skill_file in (.+); do/)[1].split(" ");
const skillRoot = path.join(__dirname, "..", "..", "public", "skills", "xmatrix");
const skillBundle = xmatrixSkillFiles.filter((file) => file.endsWith(".md"))
  .map((file) => fs.readFileSync(path.join(skillRoot, file), "utf8")).join("\n");

function publicMaterial(relativePath) {
  return fs
    .readFileSync(path.join(__dirname, "..", "..", "public", relativePath), "utf8")
    .replace(/\r?\n/g, "\r\n");
}

test("agent materials embed public docs with secret guidance", () => {
  assert.equal(agentOnboardingPrompt, publicMaterial("prompts/agent-cli-onboarding.md"));
  assert.equal(xmatrixSkill, publicMaterial("skills/xmatrix/SKILL.md"));

  const canonicalPromptDoc = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "..", "docs", "prompts", "agent-cli-onboarding.md"),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const publicPrompt = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "prompts", "agent-cli-onboarding.md"),
    "utf8"
  ).replace(/\r\n/g, "\n").trimEnd();
  assert.ok(
    canonicalPromptDoc.includes(`\`\`\`\`text\n${publicPrompt}\n\`\`\`\``),
    "canonical, public, and embedded onboarding prompts must stay in lockstep"
  );

  for (const material of [agentOnboardingPrompt, skillBundle]) {
    assert.doesNotMatch(material, /xmatrix request run|--with-secret|approval card/);
    assert.match(material, /xmatrix request secrets/);
    assert.match(material, /xmatrix secret exec --secret <secretRef>\[=<ENV_NAME>\]/);
    assert.match(material, /Secret values are never printed|values are never printed/);
    assert.match(material, /Settings -> Secrets/);
    assert.match(material, /Windows PowerShell 5\.1/);
    assert.match(material, /one complete (script )?argv/);
  }

  assert.match(agentOnboardingPrompt, /agent add <harness> --space <space-id>/);
  assert.doesNotMatch(agentOnboardingPrompt, /agent (create|approve|requests|edit)\b|Agent Profile|--access /);
  assert.match(agentOnboardingPrompt, /its own included/);
  assert.doesNotMatch(`${agentOnboardingPrompt}\n${skillBundle}`, /decides when (to stop|its work is complete)|stop work complete|stop itself/);
  assert.match(agentOnboardingPrompt, /xmatrix page automation create <page-id> --block <heading-slug>/);
  assert.match(agentOnboardingPrompt, /as your owner, so it keeps running after this Run ends/);
  assert.match(agentOnboardingPrompt, /never runs someone else's text under another name/);
  assert.match(skillBundle, /agent add <harness> --space <space-id>/);
  assert.doesNotMatch(skillBundle, /agent (create|approve|requests|edit)\b|management agents|Agent Profile|--access /);
  // Roles are retired: no material teaches Role Packages, Role Cards, or `xmatrix role`.
  assert.doesNotMatch(xmatrixSkillInstallCommand, /references\/roles\.md/);
  for (const material of [agentOnboardingPrompt, skillBundle]) {
    assert.doesNotMatch(material, /Role (Package|Card)|references\/roles\.md|xmatrix role\b|\brole (assign|summon|publish|visibility)\b/);
  }
});

test("product materials teach tagged launches and reject retired suffixes", () => {
  const startMd = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "start.md"),
    "utf8"
  );

  for (const material of [agentOnboardingPrompt, xmatrixSkill, startMd]) {
    assert.match(
      material,
      /@auto repo:<owner\/repo>/,
      "materials must teach tagged launches with explicit repo selection"
    );
    assert.doesNotMatch(material, /oneshot:/, "materials must not expose a lifetime option");
    assert.match(
      material,
      /suffixes are rejected|are rejected, not translated/,
      "materials must state the retired :new/:once suffixes are rejected"
    );
    assert.doesNotMatch(
      material,
      /@<agent(?:-name)?>:new:/,
      "materials must not teach the retired :new suffix"
    );
    assert.doesNotMatch(
      material,
      /@<agent(?:-name)?>:once:/,
      "materials must not teach the retired :once suffix"
    );
    assert.doesNotMatch(
      material,
      /With no repo\/workspace parameter, xMatrix creates a run-scoped managed directory/,
      "materials must not teach no-workspace managed-directory auto-create"
    );
    assert.doesNotMatch(
      material,
      /creates one in a new xMatrix-managed directory unless a repo\/workspace is explicitly selected/,
      "materials must not describe optional workspace with managed-directory default"
    );
  }

  assert.match(
    agentOnboardingPrompt,
    /local path\s+directly, never an opaque workspace ID/,
    "onboarding should teach visible local paths rather than workspace IDs"
  );
  assert.match(
    xmatrixSkill,
    /local path\s+directly, never an opaque workspace ID/,
    "skill should teach visible local paths rather than workspace IDs"
  );
});

test("skill installation includes every distributed file and resolves workflow links", () => {
  const distributed = fs.readdirSync(skillRoot, { recursive: true })
    .filter((file) => fs.statSync(path.join(skillRoot, file)).isFile())
    .map((file) => file.replaceAll(path.sep, "/"));
  assert.deepEqual([...xmatrixSkillFiles].sort(), distributed.sort());
  assert.equal(new Set(xmatrixSkillFiles).size, xmatrixSkillFiles.length);
  for (const file of xmatrixSkillFiles) {
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."));
    assert.ok(xmatrixSkillInstallCommand.includes(file), `website installer misses ${file}`);
    const posix = agentOnboardingPrompt.split("```sh")[1].split("```")[0];
    const powershell = agentOnboardingPrompt.split("```powershell")[1].split("```")[0];
    assert.ok(posix.includes(file), `POSIX onboarding misses ${file}`);
    assert.ok(powershell.includes(file), `PowerShell onboarding misses ${file}`);
    if (!file.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(skillRoot, file), "utf8");
    for (const [, href] of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href));
      assert.ok(xmatrixSkillFiles.includes(target), `${file} links to uninstalled ${target}`);
    }
  }
});
