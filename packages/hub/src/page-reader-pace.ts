/**
 * How fast an Agent's words reach a page a person has open (pages-live-document.md §4.2): a word at a
 * time, as long as reading it takes, with a breath where a sentence or a line ends. A harness writes far
 * faster than anyone reads, so whatever an Agent writes into a page someone is reading, streamed from its
 * reply or typed in from its edit, is given at this pace; the reader sees it being written and follows it.
 * With nobody reading, it lands as it comes.
 */
export interface PageReaderPace {
  /** Characters read a second. A wide character (Han, kana, Hangul) holds a word's worth and reads as two. */
  charsPerSecond: number;
  /** The breath after a sentence or a line. */
  sentencePauseMs: number;
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/**
 * A reader's step through text: whitespace, or a word with the punctuation and spaces after it. A wide
 * character is a word, and a very long word is read in pieces.
 */
const STEP = /\s+|(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}_]){1,16}|[^\s\p{L}\p{N}\p{M}_])[^\s\p{L}\p{N}\p{M}_]{0,8}\s*/uy;
/** What may close a sentence after its stop: quotes, brackets, emphasis. */
const CLOSING = String.raw`["'”’」』）)\]*_~\x60]*`;
/** A full-width stop ends a sentence wherever it stands. */
const WIDE_STOP = new RegExp(String.raw`[。！？；…]${CLOSING}\s*$`, "u");
/** A full stop ends one only before a space or the end: "1.0" and "e.g." go on. */
const STOP = new RegExp(String.raw`[.!?;]${CLOSING}(\s*)$`, "u");

/** The next step of a reader through `text`: what is shown at once. */
export function readingStep(text: string): string {
  STEP.lastIndex = 0;
  return STEP.exec(text)?.[0] || (Array.from(text)[0] ?? "");
}

/**
 * How long a reader takes over `text`, before the words `next` that follow it ("" where the text ends,
 * null while they are not known yet): its characters' reading time, and a breath where a sentence or
 * a line ends.
 */
export function readingMs(text: string, next: string | null, pace: PageReaderPace): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  const stop = STOP.exec(text);
  const ends = /\n\s*$/u.test(text) || WIDE_STOP.test(text)
    || (stop !== null && (stop[1] !== "" || next === "" || (next !== null && /^\s/u.test(next))));
  return Math.round(width * 1000 / pace.charsPerSecond) + (ends ? pace.sentencePauseMs : 0);
}
