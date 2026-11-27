import assert from "node:assert/strict";
import test from "node:test";

import { parseSettingAddress, sha256Hex } from "@xmatrix/protocol";
import { admissionRefusal } from "../src/index-routes-secrets.ts";
import { admissionSettingsDomain } from "../src/settings-domain-admission.ts";

const POLICY = "pub let admit = (req: Admission.request) =>\n  if req.target == \"database-read\" { Allow } else { AlsoAsk(@alice) }";
const page = (source, name = "Access") => ({ title: "Ops", body: `# Ops\n\n\`\`\`norn 1 lib ${name}\n${source}\n\`\`\`\n` });
const ADDRESS = parseSettingAddress("admission:page-1/Access");
const reader = { env: {}, spaceId: "space-1", userId: "admin-1" };

/** A Space whose Pages and adopted policy the test holds; what was adopted or withdrawn is recorded. */
function space({ pages = { "page-1": page(POLICY) }, canAdopt = true, policy } = {}) {
  const state = { policy, calls: [] };
  const domain = admissionSettingsDomain({
    adopted: async () => ({ canAdopt, ...(state.policy ? { policy: state.policy } : {}) }),
    page: async (_reader, pageId) => pages[pageId],
    adopt: async (_reader, input) => { state.calls.push("adopt"); state.policy = { ...input, adoptedByUserId: "admin-1", adoptedAt: "" }; },
    withdraw: async () => { state.calls.push("withdraw"); state.policy = undefined; },
  });
  return { state, pages, describe: async () => (await domain.describe(reader, [ADDRESS]))[0], write: (value) => domain.write(reader, ADDRESS, value) };
}

test("an admin is shown the library's text and adopts exactly what was shown", async () => {
  const s = space();
  const before = await s.describe();
  assert.deepEqual([before.domain, before.control, before.writer, before.state, before.satisfied, before.canWrite, before.value],
    ["admission", "adopt", "space-admin", "missing", false, true, POLICY]);
  assert.match(before.description, /AlsoAsk, the request gets its card, as without a policy, whoever is named/u);
  await s.write(before.value);
  assert.deepEqual(s.state.policy, { pageId: "page-1", libraryName: "Access", sourceText: POLICY, sourceSha256: await sha256Hex(POLICY),
    adoptedByUserId: "admin-1", adoptedAt: "" });
  const after = await s.describe();
  assert.deepEqual([after.state, after.satisfied], ["set", true]);
});

test("a text that changed on the Page since it was shown is not adopted", async () => {
  const s = space();
  const shown = (await s.describe()).value;
  s.pages["page-1"] = page(`${POLICY}\n// edited`);
  await assert.rejects(s.write(shown), (error) => error.status === 409 && /changed on its Page/u.test(error.message));
  assert.deepEqual(s.state.calls, []);
  // What is adopted stays in force; the card is no longer satisfied, because the Page's text is another.
  const stale = space({ pages: { "page-1": page(`${POLICY}\n// edited`) },
    policy: { pageId: "page-1", libraryName: "Access", sourceText: POLICY, sourceSha256: await sha256Hex(POLICY) } });
  const described = await stale.describe();
  assert.deepEqual([described.state, described.satisfied, described.canWrite], ["set", false, true]);
});

test("a text adopted before the card asked satisfies it at once", async () => {
  const s = space({ policy: { pageId: "page-1", libraryName: "Access", sourceText: POLICY, sourceSha256: await sha256Hex(POLICY) } });
  assert.equal((await domainSince(s)).satisfied, true);
});
const domainSince = (s) => s.describe();

test("what cannot be adopted says why and offers nothing to adopt", async () => {
  const cases = [
    [{ pages: {} }, /not in this Space, or you cannot read it/u],
    [{ pages: { "page-1": page(POLICY, "Other") } }, /no `norn 1 lib Access` block/u],
    [{ pages: { "page-1": page("pub let admit = (req: Admission.request) => confirm(@alice, req.target)") } }, /must export `admit`|has no effect/u],
    [{ pages: { "page-1": page("pub let decide = (req: Admission.request) => Allow") } }, /must export `admit`/u],
    [{ pages: { "page-1": { title: "Ops", body: `${page(POLICY).body}\n${page(POLICY).body}` } } }, /Two library blocks are named Access/u],
  ];
  for (const [options, problem] of cases) {
    const s = space(options);
    const described = await s.describe();
    // The admin still reads a text that has a problem; there is only nothing to adopt.
    assert.deepEqual([described.state, described.satisfied, described.canWrite], ["invalid", false, false], String(problem));
    assert.match(described.problem, problem);
    await assert.rejects(s.write(POLICY), (error) => error.code === "setting_refused");
    assert.deepEqual(s.state.calls, []);
  }
});

test("a reader who may not adopt is not given the text", async () => {
  const described = await space({ canAdopt: false }).describe();
  assert.deepEqual([described.canWrite, described.value, described.state], [false, undefined, "missing"]);
});

test("another Page's library of the same name neither stands in for the address's nor blocks it", async () => {
  const s = space({ pages: { "page-1": page(POLICY), "page-2": page("pub let admit = (req: Admission.request) => Allow") } });
  const described = await s.describe();
  assert.equal(described.value, POLICY);
  assert.equal(described.problem, undefined);
});

test("null withdraws the policy", async () => {
  const s = space({ policy: { pageId: "page-1", libraryName: "Access", sourceText: POLICY, sourceSha256: await sha256Hex(POLICY) } });
  await s.write(null);
  assert.deepEqual(s.state.calls, ["withdraw"]);
  assert.equal((await s.describe()).state, "missing");
});

test("an address names a Page and a library, and nothing else is one", () => {
  assert.deepEqual(parseSettingAddress("admission:0b1c-2d/Access")?.parts, ["0b1c-2d", "Access"]);
  for (const bad of ["admission:Access", "admission:page/access", "admission:page/Access/x", "admission:/Access", "admission:pa ge/Access"]) {
    assert.equal(parseSettingAddress(bad), undefined, bad);
  }
});

test("a refusal never reads as still open to a waiting CLI, whatever the policy wrote", () => {
  assert.equal(admissionRefusal("database-read", "That secret is retired"), "This Space refuses database-read: That secret is retired");
  for (const why of ["PROD key is not saved for patrol", "not configured for this Agent yet", "", "   "]) {
    const text = admissionRefusal("database-read", why);
    assert.equal(/is not saved|not configured for this Agent/u.test(text), false, text);
    assert.match(text, /its adopted policy refuses this request/u);
  }
});
