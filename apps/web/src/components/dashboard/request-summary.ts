/**
 * What a request's chip says: the start of what was asked, short enough to
 * stay a chip. A program's task is often one long paragraph, and a chip that
 * carries all of it is a highlighted wall no one reads; the whole request is
 * in the chip's preview.
 */

/** About one and a half lines of a narrow timeline, in Latin letters. */
const BUDGET = 72;

/** A CJK or full-width character takes the room of two Latin letters. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const SENTENCE_END = /[。！？；]|[.!?;](?=\s|$)/u;

export function requestSummary(text: string, budget = BUDGET): string {
  const lines = text.split("\n").map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const characters = [...first];
  let width = 0;
  let fits = 0;
  // The last place inside the budget where a sentence ends, and where a word does.
  let sentence = 0;
  let word = 0;
  for (; fits < characters.length; fits += 1) {
    const character = characters[fits]!;
    width += WIDE.test(character) ? 2 : 1;
    if (width > budget) break;
    if (SENTENCE_END.test(character + (characters[fits + 1] ?? ""))) sentence = fits + 1;
    if (character === " ") word = fits;
    else if (WIDE.test(character)) word = fits + 1;
  }
  if (fits === characters.length) return lines.length > 1 ? `${first.replace(/[\s,，、:：;；]+$/u, "")} …` : first;
  // A sentence that fills at least a third of the chip is the better place to stop.
  const cut = sentence >= fits / 3 ? sentence : word >= fits / 2 ? word : fits;
  return `${characters.slice(0, cut).join("").replace(/[\s,，、:：]+$/u, "")} …`;
}
