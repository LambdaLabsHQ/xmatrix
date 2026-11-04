/**
 * Pictures are blocks of what is written (Daniel 2026-11-03: 图片嵌在正文里，有顺序，可以多个，一行可以多个). In a
 * draft each picture is a line `![name](attachment:<id>)` naming the composer's attachment; pictures on adjacent
 * lines are one row. Sending writes each as the message's own attachment by its place among them
 * (`attachment:1` is the first), so the words need no rewriting once uploads land, and leaves a blank line
 * around each row so it is its own paragraph. A message draws the pictures it names where they were put; any
 * attachment it does not name stays under its words, as every attachment did before.
 */

/** A picture's line in a draft or a message: its name and what it points at. */
const PICTURE_LINE = /^!\[((?:[^\]\\\n]|\\.)*)\]\(attachment:([^\s()]+)\)$/u;

export type DraftPicture = { line: number; name: string; ref: string };

export function pictureOfLine(line: string): { name: string; ref: string } | null {
  const match = PICTURE_LINE.exec(line);
  return match ? { name: match[1]!.replace(/\\([[\]\\])/gu, "$1"), ref: match[2]! } : null;
}

/** The pictures a draft holds, by line. */
export function draftPictures(text: string): DraftPicture[] {
  return text.split("\n").flatMap((line, index) => {
    const picture = pictureOfLine(line);
    return picture ? [{ line: index, ...picture }] : [];
  });
}

export function pictureLine(name: string, ref: string): string {
  return `![${name.replace(/\s+/gu, " ").replace(/[[\]\\]/gu, "\\$&")}](attachment:${ref})`;
}

/**
 * The draft with a block's lines put on the line after the caret's, or in place of the caret's line when that is
 * empty, and the caret on the line after them, where writing goes on; one is made when none follows.
 */
export function putBlockInDraft(draft: string, cursor: number, block: string[]): { value: string; cursor: number } {
  if (!block.length) return { value: draft, cursor };
  const lines = draft.split("\n");
  const at = Math.max(0, draft.slice(0, Math.max(0, Math.min(cursor, draft.length))).split("\n").length - 1);
  // The empty-paste anchor (\u200B) holds an empty line; it is still empty.
  const blank = !lines[at]?.replaceAll("\u200B", "");
  const index = blank ? at : at + 1;
  const tail = blank || index >= lines.length ? [""] : [];
  lines.splice(index, blank ? 1 : 0, ...block, ...tail);
  const value = lines.join("\n");
  const offset = lines.slice(0, index + block.length).reduce((sum, line) => sum + line.length + 1, 0);
  return { value, cursor: Math.min(offset, value.length) };
}

/** The draft with pictures put after the caret's line, as one row; put beside a row, they join it. */
export function insertPicturesIntoDraft(draft: string, cursor: number, pictures: { name: string; ref: string }[]):
  { value: string; cursor: number } {
  return putBlockInDraft(draft, cursor, pictures.map((picture) => pictureLine(picture.name, picture.ref)));
}

/**
 * The draft as it is sent: each picture by its place among the message's attachments, a picture whose file is no
 * longer there dropped, and each row of pictures a paragraph of its own. Selections keep pointing at the same text.
 */
export function sentPictures<T extends { start: number; end: number }>(draft: { body: string; selections: T[] },
  placeOf: (ref: string) => number | undefined): { body: string; selections: T[] } {
  if (!draft.body.includes("](attachment:")) return draft;
  const lines = draft.body.split("\n");
  const out: string[] = [];
  const moved: { from: number; to: number; delta: number }[] = [];
  let source = 0;
  let written = 0;
  let previous: "picture" | "text" | "blank" | null = null;
  for (const line of lines) {
    const picture = pictureOfLine(line);
    const place = picture ? placeOf(picture.ref) : undefined;
    const kind = picture ? (place ? "picture" : null) : line.trim() ? "text" : "blank";
    if (kind) {
      // A row and the words beside it are separate paragraphs.
      if (previous && previous !== "blank" && kind !== "blank" && (previous === "picture") !== (kind === "picture")) {
        out.push("");
        written += 1;
      }
      const next = kind === "picture" ? pictureLine(picture!.name, String(place)) : line;
      moved.push({ from: source, to: source + line.length, delta: written - source });
      out.push(next);
      written += next.length + 1;
      previous = kind;
    }
    source += line.length + 1;
  }
  const shift = (offset: number) => {
    const span = moved.find((entry) => offset >= entry.from && offset <= entry.to);
    return offset + (span?.delta ?? 0);
  };
  // The line left to write on after the last pictures is not part of the message.
  return { body: out.join("\n").replace(/\n+$/u, ""), selections: draft.selections.map((selection) =>
    ({ ...selection, start: shift(selection.start), end: shift(selection.end) })) };
}
