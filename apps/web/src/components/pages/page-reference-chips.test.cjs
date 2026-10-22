const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState } = require("prosemirror-state");
const { markdownToPageDoc, pageSchema } = require("@xmatrix/protocol/page-document");
const { pageMentions, referenceChips } = require("./page-reference-chips.ts");

const CHANNEL = "019a0b4c-1d2e-7f30-8a41-b5c6d7e8f901";

const targets = {
  pageTitle: () => null,
  channelName: (id) => id === CHANNEL ? "general" : null,
  openPage: () => {},
  openChannel: () => {},
  mentions: pageMentions([{ name: "Daniel Melody", handle: "daniel", imageUrl: "/face.png" }], ["acme-bot"]),
};

function chips(markdown) {
  const plugin = referenceChips(() => targets);
  const state = EditorState.create({ doc: markdownToPageDoc(markdown), schema: pageSchema, plugins: [plugin] });
  return plugin.props.decorations(state).find().map((decoration) => decoration.spec.key).filter(Boolean);
}

test("an @ naming an Agent or a member is drawn as their mention chip", () => {
  const [agent] = chips("@claude 根据我的邮件，确定行程");
  assert.match(agent, /^mention:@claude:claude:\S+$/);
  assert.deepEqual(chips("ask @daniel and @acme-bot"), ["mention:@daniel:Daniel Melody:/face.png", "mention:@acme-bot:acme-bot:"]);
});

test("an @ no one answers to, or inside code, stays as typed", () => {
  assert.deepEqual(chips("mail me@claude.ai or @nobody"), []);
  assert.deepEqual(chips("`@claude`"), []);
});

test("mentions and references in one line keep their order", () => {
  assert.deepEqual(chips(`@daniel see channel:${CHANNEL}`),
    ["mention:@daniel:Daniel Melody:/face.png", `reference:channel:${CHANNEL}:general`]);
});
