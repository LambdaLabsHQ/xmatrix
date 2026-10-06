const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { MAX_DISCUSSION_QUOTE_CHARS, discussionDraft, discussionTitle, selectedMessagePassage } = require("./selection-discussion.ts");

test("a discussion is named by its passage, on one line and bounded", () => {
  assert.equal(discussionTitle("  Ship the\n relay  "), "“Ship the relay”");
  const long = discussionTitle("x".repeat(100));
  assert.equal(long, `“${"x".repeat(59)}…”`);
});

test("the draft quotes the passage line by line and links where it came from", () => {
  const draft = discussionDraft("First line\n\nSecond [line] @claude", {
    label: "Yiming in #relay [ops]", href: "https://xmatrix.sh/app/s/channels/c#message:m1" });
  assert.equal(draft,
    "> First line\n>\n> Second [line] @claude\n\n— [Yiming in #relay \\[ops\\]](https://xmatrix.sh/app/s/channels/c#message:m1)\n\n");
});

test("a long passage is cut to the carried bound", () => {
  const draft = discussionDraft("y".repeat(MAX_DISCUSSION_QUOTE_CHARS + 50), { label: "p", href: "h" });
  assert.ok(draft.startsWith(`> ${"y".repeat(MAX_DISCUSSION_QUOTE_CHARS - 1)}…\n`));
});

// A minimal DOM: elements know their parent, attributes and containment.
function element(attributes = {}, parent = null) {
  const node = { nodeType: 1, parentElement: parent, attributes,
    getAttribute: (name) => attributes[name] ?? null,
    closest(selector) {
      const name = selector.slice(1, -1);
      for (let at = node; at; at = at.parentElement) if (name in at.attributes) return at;
      return null;
    },
    contains(other) {
      for (let at = other; at; at = at.parentElement) if (at === node) return true;
      return false;
    } };
  return node;
}
const textIn = (parent) => ({ nodeType: 3, parentElement: parent });
function selection(anchorNode, focusNode, text) {
  return { isCollapsed: false, rangeCount: 1, anchorNode, focusNode, toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 100, left: 20, bottom: 120 }) }) };
}

test("a selection inside one message's text is a passage of that message", () => {
  const root = element();
  const row = element({}, root);
  const body = element({ "data-message-body": "m1" }, row);
  const paragraph = element({}, body);
  const passage = selectedMessagePassage(selection(textIn(paragraph), textIn(body), "  the relay\n\n\n\nstalls "), root);
  assert.equal(passage.messageId, "m1");
  assert.equal(passage.quote, "the relay\n\nstalls");
});

test("a selection across messages, outside a message's text, or outside the timeline is not a passage", () => {
  const root = element();
  const first = element({ "data-message-body": "m1" }, element({}, root));
  const secondRow = element({}, root);
  const second = element({ "data-message-body": "m2" }, secondRow);
  assert.equal(selectedMessagePassage(selection(textIn(first), textIn(second), "a b"), root), null);
  assert.equal(selectedMessagePassage(selection(textIn(first), textIn(secondRow), "a b"), root), null);
  const elsewhere = element({ "data-message-body": "m3" });
  assert.equal(selectedMessagePassage(selection(textIn(elsewhere), textIn(elsewhere), "a"), root), null);
  assert.equal(selectedMessagePassage(selection(textIn(first), textIn(first), "   "), root), null);
  assert.equal(selectedMessagePassage({ ...selection(textIn(first), textIn(first), "a"), isCollapsed: true }, root), null);
  assert.equal(selectedMessagePassage(null, root), null);
});
