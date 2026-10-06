/**
 * Where the composer paints the band behind each mention.
 *
 * The band cannot be the mention's own inline background: that box is the
 * font's ascent + descent, which sits high over an `@name` (Inter's ascent
 * leaves room for accents the name does not have, while `@` itself descends),
 * and a word-per-mark workaround cut a summon into tiles. So the component
 * measures where the mention's words landed and this module decides the band,
 * one per line the mention occupies:
 *
 * - one continuous band per line, from the first word's box to the last's, so
 *   a trailing space at a soft wrap never gets painted;
 * - one height everywhere, centred on the ink of the mentions on that line, so
 *   Latin and CJK names both sit in the middle and two bands on one line align;
 * - never taller than the line minus a gap, so wrapped lines never touch;
 * - horizontal room taken only from what is free: a little of a neighbouring
 *   space, a little of a glyph's side bearing, the full amount at a line edge.
 */

export type BandRect = { left: number; top: number; width: number; height: number };

/** One word's box on one line, in the band layer's coordinates. */
export type MentionFragment = {
  line: number;
  left: number;
  right: number;
  /** Ink of the fragment's text above and below the baseline, in px. */
  ascent: number;
  descent: number;
};

export type MentionBandInput = {
  fragments: readonly MentionFragment[];
  /** Free space beside the mention's first and last word; Infinity at a line edge. */
  roomBefore: number;
  roomAfter: number;
};

export type BandMetrics = {
  fontSize: number;
  lineHeight: number;
  /** Top of the first line box, and the baseline's offset inside every line box. */
  firstLineTop: number;
  baseline: number;
};

/** Band height as a share of the font size, before the line's own limit. */
const BAND_HEIGHT_EM = 1.2;
/** The most horizontal room a band takes on either side of its text. */
const BAND_PAD_EM = 0.16;
/** Air kept between the bands of two neighbouring lines. */
const LINE_GAP_PX = 3;

export type PlannedBand = BandRect & { mention: number; lineOrdinal: number };

export function planMentionBands(mentions: readonly MentionBandInput[], metrics: BandMetrics): PlannedBand[] {
  const { fontSize, lineHeight, firstLineTop, baseline } = metrics;
  const height = Math.max(fontSize * 0.9, Math.min(fontSize * BAND_HEIGHT_EM, lineHeight - LINE_GAP_PX));
  const padLimit = fontSize * BAND_PAD_EM;

  // Every band on a line shares one vertical position.
  const lineInk = new Map<number, { ascent: number; descent: number }>();
  for (const { fragments } of mentions) {
    for (const fragment of fragments) {
      const ink = lineInk.get(fragment.line);
      lineInk.set(fragment.line, {
        ascent: Math.max(ink?.ascent ?? 0, fragment.ascent),
        descent: Math.max(ink?.descent ?? 0, fragment.descent),
      });
    }
  }

  // An `@name`'s ink sits below the line box's centre (the font's ascent leaves
  // room for accents; `@` descends), so a band moves off the centre to meet it,
  // but stays inside its own line box.
  const margin = Math.min(0.25, (lineHeight - height) / 2);
  const bands: PlannedBand[] = [];
  mentions.forEach((mention, index) => {
    const lines = new Map<number, { left: number; right: number }>();
    for (const fragment of mention.fragments) {
      const span = lines.get(fragment.line);
      lines.set(fragment.line, {
        left: Math.min(span?.left ?? Infinity, fragment.left),
        right: Math.max(span?.right ?? -Infinity, fragment.right),
      });
    }
    const order = [...lines.keys()].sort((a, b) => a - b);
    order.forEach((line, lineOrdinal) => {
      const span = lines.get(line)!;
      const before = lineOrdinal === 0 ? mention.roomBefore : Infinity;
      const after = lineOrdinal === order.length - 1 ? mention.roomAfter : Infinity;
      // Symmetric, so the text stays centred in its band.
      const pad = Math.max(0, Math.min(padLimit, before, after));
      const ink = lineInk.get(line)!;
      const lineTop = firstLineTop + line * lineHeight;
      const centre = lineTop + baseline - (ink.ascent - ink.descent) / 2;
      const top = Math.min(Math.max(centre - height / 2, lineTop + margin), lineTop + lineHeight - margin - height);
      bands.push({ mention: index, lineOrdinal, left: span.left - pad, width: span.right - span.left + 2 * pad, top, height });
    });
  });
  return bands;
}

/** Room a neighbour leaves: part of a space, part of a glyph's side bearing. */
export function neighbourRoom(kind: "edge" | "space" | "glyph", size: number): number {
  if (kind === "edge") return Infinity;
  return kind === "space" ? size * 0.3 : Math.max(0, size) * 0.45;
}
