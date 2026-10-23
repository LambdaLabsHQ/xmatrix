/**
 * About text whose characters are already gone: a lossy decode leaves U+FFFD, and a shell on a
 * legacy code page turns CJK into `?`. Such text is never written (channel-about.ts). The test is
 * deliberately narrow: ordinary text with a question mark or an emphatic `???` passes.
 */
export function mangledChannelAboutText(value: string): boolean {
  if (value.includes("\uFFFD")) return true;
  const visible = [...value].filter(character => !/\s/u.test(character));
  const marks = visible.filter(character => character === "?").length;
  // A name or summary made only of `?` once had letters.
  if (marks >= 2 && marks === visible.length) return true;
  // A run of lost characters that is a large share of everything written.
  return /\?{3,}/u.test(value) && marks / visible.length >= 0.3;
}
