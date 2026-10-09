const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { agentDocFiles, agentGuideFiles, aiAskLinks, joinAgentGuides } = require("./agent-docs.ts");

const publicDir = path.join(__dirname, "..", "..", "public");
const read = (file) => fs.readFileSync(path.join(publicDir, file), "utf8");

test("every agent doc the footer lists is published", () => {
  for (const file of agentDocFiles) assert.ok(fs.existsSync(path.join(publicDir, file)), file);
});

test("llms.txt links every guide and only published guides", () => {
  const linked = [...read("llms.txt").matchAll(/\(https:\/\/xmatrix\.sh\/([a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
  for (const file of agentGuideFiles) assert.ok(linked.includes(file), `llms.txt does not link ${file}`);
  for (const file of linked) assert.ok(fs.existsSync(path.join(publicDir, file)), `llms.txt links missing ${file}`);
});

test("llms-full.txt joins the current guides", () => {
  const expected = joinAgentGuides(agentGuideFiles.map((file) => ({ file, body: read(file) })));
  if (process.env.UPDATE_AGENT_DOCS === "1") fs.writeFileSync(path.join(publicDir, "llms-full.txt"), expected);
  assert.equal(read("llms-full.txt"), expected, "run with UPDATE_AGENT_DOCS=1 to regenerate public/llms-full.txt");
});

test("ask-AI links prefill a question that cites llms.txt", () => {
  assert.deepEqual(aiAskLinks.map((link) => link.label), ["ChatGPT", "Claude", "Perplexity", "Gemini", "Grok"]);
  for (const { href } of aiAskLinks) {
    assert.match(new URL(href).searchParams.get("q"), /https:\/\/xmatrix\.sh\/llms\.txt/);
  }
});
