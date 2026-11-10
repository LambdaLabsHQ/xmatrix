import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToPageDoc, pageDocDiff } from "../dist/page-document.js";

const SIGN = { added: "+", removed: "-", edited: "~", replaced: "%" };

/** A block's words as the diff marks them: {+put in+} and [-taken out-]. */
function words(node) {
  let out = "";
  node.forEach((child) => {
    const text = child.isText ? child.text : `<${child.type.name}>`;
    const mark = child.marks.find((entry) => entry.type.name === "inserted" || entry.type.name === "deleted");
    out += !mark ? text : mark.type.name === "inserted" ? `{+${text}+}` : `[-${text}-]`;
  });
  return out;
}

/** The merged document a line per block: its change, then how it reads. */
function lines(node, depth = 0, out = []) {
  node.forEach((child) => {
    const lead = `${SIGN[child.attrs.change] ?? " "}${"  ".repeat(depth)}`;
    if (child.type.name === "table_row") {
      const cells = [];
      child.forEach((cell) => cells.push(`${SIGN[cell.attrs.change] ?? ""}${words(cell)}`));
      out.push(`${lead}| ${cells.join(" | ")} |`);
    } else if (child.isTextblock) {
      out.push(`${lead}${words(child)}`);
    } else if (child.isLeaf) {
      out.push(`${lead}<${child.type.name}>`);
    } else {
      out.push(`${lead}${child.type.name}`);
      lines(child, depth + 1, out);
    }
  });
  return out;
}

function diff(before, after) {
  const result = pageDocDiff(markdownToPageDoc(before), markdownToPageDoc(after));
  return { lines: lines(result.doc), sections: result.sections };
}

test("two versions that read the same show nothing as changed", () => {
  const { lines: drawn, sections } = diff("# Plan\n\nShip it.\n", "# Plan\n\nShip it.\n");
  assert.deepEqual(drawn, [" Plan", " Ship it."]);
  assert.deepEqual(sections, []);
});

test("words changed in a line that kept most of its words are marked among them", () => {
  assert.deepEqual(diff("# Plan\n\nShip the relay next week.\n", "# Plan\n\nShip the new relay this week.\n").lines,
    [" Plan", "~Ship the {+new+} relay [-next-] {+this+} week."]);
  assert.deepEqual(diff("状态：进行中，下周发布\n", "状态：进行中，明天发布\n").lines, ["~状态：进行中，[-下周-] {+明天+}发布"]);
});

test("a rewritten phrase is one change, not its words interleaved with the few it shares by chance", () => {
  const before = "未预订，所以避开人多的打卡点。按 11/12 晚的苍古活动照常参加来排。车程和价格是估计，未逐项核实。\n";
  const after = "未预订，所以避开人多的打卡点。先 Sidemen 后乌布是我的建议，顺序待他确认。车程和价格是估计，未逐项核实。\n";
  assert.deepEqual(diff(before, after).lines, ["~未预订，所以避开人多的打卡点。[-按 11/12 晚的苍古活动照常参加来排-] "
    + "{+先 Sidemen 后乌布是我的建议，顺序待他确认+}。车程和价格是估计，未逐项核实。"]);
});

test("a paragraph rewritten past recognition is the old one taken out and the new one put in, each whole", () => {
  assert.deepEqual(diff("# Plan\n\nIn progress, waiting on review.\n\nNotes\n", "# Plan\n\nShipped on Tuesday to everyone.\n\nNotes\n").lines,
    [" Plan", "-In progress, waiting on review.", "+Shipped on Tuesday to everyone.", " Notes"]);
});

test("text added to a short line stays that line, with the new words marked", () => {
  assert.deepEqual(diff("Leave on 3 November.\n", "Leave on 3 November from Shanghai on GA 859, landing at 23:40 local time.\n").lines,
    ["~Leave on 3 November {+from Shanghai on GA 859, landing at 23:40 local time+}."]);
});

test("new and removed blocks are whole, where they stand", () => {
  assert.deepEqual(diff("# Plan\n\nOne\n\nTwo\n", "# Plan\n\nTwo\n\n## Risks\n\nLate reviews\n").lines,
    [" Plan", "-One", " Two", "+Risks", "+Late reviews"]);
});

test("a table keeps its rows and columns: a row taken out stays a row, a rewritten cell holds old over new", () => {
  const before = "| Day | Stay | Plan |\n|---|---|---|\n| 11/13 | Ubud | Arrive from Canggu by car |\n"
    + "| 11/14 | Ubud | Campuhan ridge at sunrise, then the water temple |\n| 11/18 | — | Leave by 9:30 for the airport |\n";
  const after = "| Day | Stay | Plan |\n|---|---|---|\n"
    + "| 11/14 | Sidemen | Drive from the house to Sidemen, rest, walk the paddies |\n| 11/18 | — | Leave by 9:00 for the airport |\n";
  assert.deepEqual(diff(before, after).lines, [
    " table",
    "   | Day | Stay | Plan |",
    "-  | 11/13 | Ubud | Arrive from Canggu by car |",
    "   | 11/14 | %[-Ubud-]{+Sidemen+} | %[-Campuhan ridge at sunrise, then the water temple-]{+Drive from the house to Sidemen, rest, walk the paddies+} |",
    "   | 11/18 | — | ~Leave by 9:[-30-] {+00+} for the airport |",
  ]);
});

test("a list keeps its items: one changed in place, one added, one taken out", () => {
  const before = "- Book the car a day ahead\n- Carry cash\n- Bring rain jackets\n";
  const after = "- Book the car two days ahead\n- Bring rain jackets\n- Pack mosquito spray\n";
  assert.deepEqual(diff(before, after).lines, [
    " bullet_list",
    "   list_item", "~    Book the car [-a day-] {+two days+} ahead",
    "-  list_item", "     Carry cash",
    "   list_item", "     Bring rain jackets",
    "+  list_item", "     Pack mosquito spray",
  ]);
});

test("a paragraph that became a heading or a list is the old block out and the new one in", () => {
  assert.deepEqual(diff("Risks\n\nLate reviews\n", "## Risks\n\n- Late reviews\n").lines,
    ["-Risks", "+Risks", "-Late reviews", "+bullet_list", "   list_item", "     Late reviews"]);
});

test("code is compared whole", () => {
  assert.deepEqual(diff("```\nlet a = 1\n```\n", "```\nlet a = 2\n```\n").lines, ["-let a = 1", "+let a = 2"]);
});

test("words made bold are put in and not also taken out, and what is bold inside a change stays bold", () => {
  const { doc } = pageDocDiff(markdownToPageDoc("Ship it before the freeze, not after\n"),
    markdownToPageDoc("Ship **it** before the freeze, **never** after\n"));
  const marks = [];
  doc.firstChild.forEach((child) => marks.push(`${child.text}:${child.marks.map((mark) => mark.type.name).join("+")}`));
  assert.deepEqual(marks, ["Ship :", "it:inserted+strong", " before the freeze, :", "not:deleted", " :", "never:inserted+strong", " after:"]);
});

test("where it changed is told by section, once each, in page order", () => {
  const before = "# Bali\n\nDraft.\n\n## Itinerary\n\nLeave on 3 November.\n\nBack on the 18th.\n\n## Budget\n\nTo be decided.\n\n## Notes\n\nnone\n";
  const after = "# Bali\n\nDraft.\n\n## Itinerary\n\nLeave on 4 November.\n\nBack on the 19th.\n\n## Budget\n\nTo be decided.\n\n## Notes\n\nnone\n\n## Stay\n\nUbud\n";
  assert.deepEqual(diff(before, after).sections, [{ title: "Itinerary", index: 3 }, { title: "Stay", index: 9 }]);
  assert.deepEqual(diff("Intro\n\n# Bali\n", "Intro, edited\n\n# Bali\n").sections, [{ title: "", index: 0 }]);
});
