const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { admissionPolicyStanding } = require("./admission-policy-standing.ts");

const policy = { pageId: "page-1", libraryName: "Access", sourceText: "old", adoptedAt: "2026-11-27T00:00:00.000Z" };
const setting = (over) => ({ address: "admission:page-1/Access", state: "set", satisfied: false, canWrite: true, value: "new", ...over });

test("an adopted policy says how it stands against its Page", () => {
  assert.deepEqual(admissionPolicyStanding({ policy, canAdopt: true }), { word: "Adopted" });
  assert.deepEqual(admissionPolicyStanding({ policy, canAdopt: true, setting: setting({ satisfied: true }) }), { word: "Adopted" });
  // The Page's newer text is offered only to someone who may adopt it.
  assert.equal(admissionPolicyStanding({ policy, canAdopt: true, setting: setting() }).adoptable, "new");
  const member = admissionPolicyStanding({ policy: { ...policy, sourceText: "" }, canAdopt: false, setting: setting({ canWrite: false, value: undefined }) });
  assert.equal(member.word, "Changed on its Page");
  assert.equal(member.adoptable, undefined);
  // A Page text that no longer checks is not offered; the adopted one stays in force.
  const broken = admissionPolicyStanding({ policy, canAdopt: true, setting: setting({ state: "invalid", canWrite: false, problem: "1:1 no admit" }) });
  assert.equal(broken.adoptable, undefined);
  assert.match(broken.note, /stays in force\. 1:1 no admit$/u);
});
