import { diffIndices } from "node-diff3";

/**
 * Who wrote each piece of a page (pages-live-document.md §3, Facts): every character of a revision's markdown
 * is owed to the first revision in the page's line that put it there. Revision N's blame is derived from
 * revision N-1's and the two bodies alone, as `git blame` walks commits: lines that did not change keep their
 * characters' revisions, and within the lines that did, the words that stayed keep theirs. Only markdown is
 * compared, never parsed documents, so a change of marks (`**`) leaves the words it marks with whoever wrote
 * them. Text moved elsewhere reads as written by whoever moved it.
 *
 * A blame travels as runs, `[length, revision, length, revision, …]` over the body's UTF-16 code units.
 */
export type PageBlameRuns = readonly number[];

/** Words compared inside one run of changed lines; past it, the run's text is all the newer revision's. */
const MAX_WORD_DIFF_TOKENS = 20_000;

/** A word, a CJK character, a run of spaces, or one other character: what a change is measured in. */
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}\p{M}_]+|\s+|\S/gu;

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

/** Each character's revision, from runs over a text `length` long; what the runs do not cover is `fill`'s. */
export function pageBlameOrigins(runs: PageBlameRuns, length: number, fill = 0): Int32Array {
  const origins = new Int32Array(length).fill(fill);
  let at = 0;
  for (let index = 0; index + 1 < runs.length && at < length; index += 2) {
    const end = Math.min(length, at + runs[index]!);
    origins.fill(runs[index + 1]!, at, end);
    at = end;
  }
  return origins;
}

/** Runs from each character's revision. */
export function pageBlameRuns(origins: ArrayLike<number>): number[] {
  const runs: number[] = [];
  for (let index = 0; index < origins.length;) {
    const revision = origins[index]!;
    let end = index + 1;
    while (end < origins.length && origins[end] === revision) end++;
    runs.push(end - index, revision);
    index = end;
  }
  return runs;
}

/** The blame of the page's first revision: all of it is that revision's. */
export function pageBlameFirst(body: string, revision: number): number[] {
  return body.length ? [body.length, revision] : [];
}

/** Revision `revision`'s blame, from the revision before it in the page's line (its body and blame) and its own body. */
export function pageBlameStep(before: string, beforeRuns: PageBlameRuns, after: string, revision: number): number[] {
  const was = pageBlameOrigins(beforeRuns, before.length, revision);
  const now = new Int32Array(after.length).fill(revision);
  const oldLines = lines(before);
  const newLines = lines(after);
  const oldStarts = starts(oldLines);
  const newStarts = starts(newLines);
  let oldLine = 0;
  let newLine = 0;
  const keep = (oldFrom: number, newFrom: number, length: number) => now.set(was.subarray(oldFrom, oldFrom + length), newFrom);
  // An edit touches a few lines of a long page: only the lines between what is the same at both ends are compared.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < oldLines.length - head && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const middle = diffIndices(oldLines.slice(head, oldLines.length - tail), newLines.slice(head, newLines.length - tail));
  for (const hunk of middle) {
    const [removedStart, removedLength] = [hunk.buffer1[0] + head, hunk.buffer1[1]];
    const [addedStart, addedLength] = [hunk.buffer2[0] + head, hunk.buffer2[1]];
    // The lines before the hunk are the same lines.
    keep(oldStarts[oldLine]!, newStarts[newLine]!, oldStarts[removedStart]! - oldStarts[oldLine]!);
    oldLine = removedStart + removedLength;
    newLine = addedStart + addedLength;
    if (!removedLength || !addedLength) continue;
    const oldFrom = oldStarts[removedStart]!;
    const newFrom = newStarts[addedStart]!;
    const a = words(before.slice(oldFrom, oldStarts[oldLine]!));
    const b = words(after.slice(newFrom, newStarts[newLine]!));
    if (a.length + b.length > MAX_WORD_DIFF_TOKENS) continue;
    let oldWord = 0;
    let newWord = 0;
    const keepWords = (until: number) => {
      for (; oldWord < until; oldWord++, newWord++) keep(oldFrom + a[oldWord]!.at, newFrom + b[newWord]!.at, a[oldWord]!.text.length);
    };
    for (const change of diffIndices(a.map((word) => word.text), b.map((word) => word.text))) {
      keepWords(change.buffer1[0]);
      oldWord = change.buffer1[0] + change.buffer1[1];
      newWord = change.buffer2[0] + change.buffer2[1];
    }
    keepWords(a.length);
  }
  keep(oldStarts[oldLine]!, newStarts[newLine]!, before.length - oldStarts[oldLine]!);
  return pageBlameRuns(now);
}

/** Where each line starts, and after the last, the text's end. */
function starts(list: readonly string[]): number[] {
  const out = [0];
  for (const line of list) out.push(out[out.length - 1]! + line.length);
  return out;
}

function words(text: string): Array<{ text: string; at: number }> {
  return [...text.matchAll(WORD)].map((match) => ({ text: match[0], at: match.index! }));
}
