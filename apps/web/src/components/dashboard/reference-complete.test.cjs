const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const {
  channelReferenceCandidates, completeReference, findActiveReference, pageReferenceCandidates, referenceInsertion,
  sectionReferenceCandidates,
} = require("./reference-complete.ts");

const at = (draft) => findActiveReference(draft, draft.length);

test("# opens channel completion where a channel name can start", () => {
  assert.deepEqual(at("see #rel"), { kind: "channel", start: 4, end: 8, query: "rel" });
  assert.deepEqual(at("#"), { kind: "channel", start: 0, end: 1, query: "" });
  assert.deepEqual(at("看下＃发布"), { kind: "channel", start: 2, end: 5, query: "发布" });
  assert.equal(at("fixed in #3484")?.kind, undefined, "a pull request number is not a channel");
  assert.equal(at("https://x.sh/a#frag"), null);
  assert.equal(at("&#123"), null);
  assert.equal(at("## Heading"), null);
  assert.equal(at("# Heading"), null, "a space ends the name");
  assert.equal(at("line one #a\nline two"), null);
});

test("[[ and 【【 open page completion; # inside them picks a section", () => {
  assert.deepEqual(at("read [[Road map"), { kind: "page", start: 5, end: 15, query: "Road map", section: null });
  assert.deepEqual(at("【【路线"), { kind: "page", start: 0, end: 4, query: "路线", section: null });
  assert.deepEqual(at("[[Roadmap#go"), { kind: "page", start: 0, end: 12, query: "Roadmap", section: "go" });
  assert.equal(at("[[Roadmap]] then"), null);
  assert.equal(at("[[ spaced"), null);
  assert.equal(at("[[Roadmap]] #rel")?.kind, "channel");
});

const channels = [
  { id: "11111111-1111-4111-8111-111111111111", spaceId: "s", name: "release-train", topic: "Ships", mode: "open" },
  { id: "22222222-2222-4222-8222-222222222222", spaceId: "s", name: "general", mode: "open" },
  { id: "33333333-3333-4333-8333-333333333333", spaceId: "other", name: "release-other", mode: "open" },
  { id: "44444444-4444-4444-8444-444444444444", spaceId: "s", name: "", mode: "open" },
];

test("channel candidates stay in the Space, rank prefixes first and put the current channel last", () => {
  assert.deepEqual(channelReferenceCandidates(channels, "rel", "s", null).map((c) => c.label), ["release-train"]);
  assert.deepEqual(channelReferenceCandidates(channels, "", "s", channels[0].id).map((c) => c.label),
    ["general", "release-train"]);
  assert.equal(channelReferenceCandidates(channels, "train", "s", null)[0].detail, "Ships");
});

test("page and section candidates, and what a pick writes", () => {
  const pages = [
    { pageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", parentPageId: null, title: "Roadmap" },
    { pageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", parentPageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Release roadmap" },
  ];
  const found = pageReferenceCandidates(pages, "road");
  assert.deepEqual(found.map((c) => [c.label, c.detail]), [["Roadmap", ""], ["Release roadmap", "Roadmap"]]);
  const sections = sectionReferenceCandidates(pages[0],
    [{ id: "", title: "", depth: 0 }, { id: "goals", title: "Goals", depth: 2 }, { id: "risks", title: "Risks", depth: 2 }], "");
  assert.deepEqual(sections.map((c) => c.label), ["Roadmap", "Goals", "Risks"]);
  assert.deepEqual(referenceInsertion(sections[1], "Roadmap"),
    { text: "[[Roadmap#Goals]]", token: "page:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#goals" });
  assert.deepEqual(referenceInsertion(channelReferenceCandidates(channels, "gen", "s", null)[0]),
    { text: "#general", token: "channel:22222222-2222-4222-8222-222222222222" });
});

test("completing replaces the trigger, absorbs typed closing brackets and adds one space", () => {
  const draft = "see [[Road]] now";
  const active = findActiveReference(draft, 10);
  assert.deepEqual(completeReference(draft, active, "[[Roadmap]]"),
    { value: "see [[Roadmap]] now", cursor: 15, start: 4, end: 15 });
  const channelDraft = "ping #gen";
  assert.deepEqual(completeReference(channelDraft, at(channelDraft), "#general"),
    { value: "ping #general ", cursor: 14, start: 5, end: 13 });
});
