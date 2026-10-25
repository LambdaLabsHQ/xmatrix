import assert from "node:assert/strict";
import test from "node:test";

import { PageCoWriteParser, parsePageCoWriteReply } from "../dist/index.js";

/** Feeds an answer in the pieces given and collects what reaches the page, joining adjacent text. */
function read(pieces) {
  const parser = new PageCoWriteParser();
  const events = [...pieces.flatMap((piece) => parser.push(piece)), ...parser.finish()];
  const out = [];
  for (const event of events) {
    const last = out.at(-1);
    if (event.type === "text" && last?.type === "text") last.text += event.text;
    else out.push({ ...event });
  }
  return out;
}

test("an answer's markers open actions whose text follows, and talk outside them never reaches the page", () => {
  const answer = "I'll fill the risks.\n⟦after \"## Risks\"⟧\n- Vendor lock-in\n- Cost\n⟦note “Q3 launch”⟧Is Q3 still right?\nDone.";
  assert.deepEqual(read([answer]), [
    { type: "start", action: "after", quote: "## Risks" },
    { type: "text", text: "- Vendor lock-in\n- Cost\n" },
    { type: "end" },
    { type: "start", action: "note", quote: "Q3 launch" },
    { type: "text", text: "Is Q3 still right?\nDone." },
    { type: "end" },
  ]);
});

test("pieces cut anywhere, inside a marker too, read the same as the whole answer", () => {
  const answer = "⟦replace 「旧的说法」⟧新的说法⟦end⟧ aside ⟦pass⟧";
  const whole = read([answer]);
  assert.deepEqual(whole, [
    { type: "start", action: "replace", quote: "旧的说法" },
    { type: "text", text: "新的说法" },
    { type: "end" },
    { type: "pass" },
  ]);
  for (let cut = 1; cut < answer.length; cut++) {
    assert.deepEqual(read([answer.slice(0, cut), answer.slice(cut)]), whole, `cut at ${cut}`);
  }
  assert.deepEqual(read([...answer]), whole, "one character at a time");
});

test("text streams out as it comes, before its action ends", () => {
  const parser = new PageCoWriteParser();
  assert.deepEqual(parser.push("⟦after \"Goals\"⟧\nFirst"), [
    { type: "start", action: "after", quote: "Goals" }, { type: "text", text: "First" }]);
  assert.deepEqual(parser.push(" words"), [{ type: "text", text: " words" }]);
  assert.deepEqual(parser.finish(), [{ type: "end" }]);
});

test("markers it does not know are dropped, and a bracket that opens nothing is text", () => {
  assert.deepEqual(read(["⟦after \"x\"⟧a ⟦caret Daniel⟧b ⟦ c"]), [
    { type: "start", action: "after", quote: "x" },
    { type: "text", text: "a b ⟦ c" },
    { type: "end" },
  ]);
  // An action needs the words it is about.
  assert.deepEqual(read(["⟦after⟧ lost ⟦after \"\"⟧ lost"]), []);
});

test("a reply from the runtime is read strictly", () => {
  assert.deepEqual(parsePageCoWriteReply({ type: "delta", turn: 3, text: "hi" }), { type: "delta", turn: 3, text: "hi" });
  assert.deepEqual(parsePageCoWriteReply({ type: "done", turn: 3 }), { type: "done", turn: 3 });
  assert.deepEqual(parsePageCoWriteReply({ type: "write", turn: 4, atOnce: true }), { type: "write", turn: 4, atOnce: true });
  assert.deepEqual(parsePageCoWriteReply({ type: "write", turn: 4, atOnce: "yes" }), { type: "write", turn: 4 });
  assert.deepEqual(parsePageCoWriteReply({ type: "delta", turn: 3, text: "hi", paced: { at: 20 } }),
    { type: "delta", turn: 3, text: "hi", paced: { at: 20 } });
  assert.deepEqual(parsePageCoWriteReply({ type: "delta", turn: 3, text: "hi", paced: { at: -1 } }),
    { type: "delta", turn: 3, text: "hi" }, "a paced write says where it starts, or it is not paced");
  assert.deepEqual(parsePageCoWriteReply({ type: "done", turn: 3, paced: { at: 22 } }), { type: "done", turn: 3, paced: { at: 22 } });
  assert.equal(parsePageCoWriteReply({ type: "delta", turn: "3", text: "hi" }), null);
  assert.equal(parsePageCoWriteReply({ type: "other", turn: 1 }), null);
});
