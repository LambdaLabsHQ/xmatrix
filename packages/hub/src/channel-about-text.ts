/**
 * Channel About text that a non-UTF-8 shell already destroyed. A Windows
 * shell on a legacy code page passes CJK arguments as `?`, and a lossy decode
 * leaves U+FFFD; either way the words are gone before the Hub sees them. Such
 * text is refused, never stored, so the About session can write it again from
 * a UTF-8 shell. The test is deliberately narrow: ordinary text with a
 * question mark or an emphatic `???` passes.
 */
export function mangledChannelAboutText(value: string): boolean {
  if (value.includes("�")) return true;
  const visible = [...value].filter(character => !/\s/u.test(character));
  const marks = visible.filter(character => character === "?").length;
  // A name or summary made only of `?` once had letters.
  if (marks >= 2 && marks === visible.length) return true;
  // A run of lost characters that is a large share of everything written.
  return /\?{3,}/u.test(value) && marks / visible.length >= 0.3;
}

/** The refusal an About session sees for mangled text, or undefined. */
export function channelAboutTextRefusal(fields: { summary?: string; name?: unknown }) {
  const field = fields.summary !== undefined && mangledChannelAboutText(fields.summary) ? "summary"
    : typeof fields.name === "string" && mangledChannelAboutText(fields.name) ? "name" : undefined;
  if (!field) return undefined;
  return {
    error: `The Channel About ${field} arrived with its characters replaced by "?" or U+FFFD, as a shell using a non-UTF-8 code page does. Nothing was saved. Run the command again from a UTF-8 shell (on Windows, for example after \`chcp 65001\`).`,
    code: "channel_about_text_mangled",
    field,
  };
}
