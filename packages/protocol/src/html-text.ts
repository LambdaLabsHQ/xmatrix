/**
 * Plain-text helpers for HTML. Each one scans forward once, so hostile input
 * (thousands of `<` or unclosed elements) costs linear time, unlike the
 * `/<[^>]*>/` family of regexes that rescan from every `<`.
 */

/** `html` with each comment and `<…>` tag replaced by `replacement`; an unclosed `<` stays as text. */
export function stripHtmlTags(html: string, replacement = ""): string {
  let output = "";
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    const commentEnd = html.startsWith("<!--", open) ? html.indexOf("-->", open + 4) : -1;
    const end = commentEnd >= 0 ? commentEnd + 3 : html.indexOf(">", open + 1) + 1;
    if (end === 0) break;
    output += html.slice(index, open) + replacement;
    index = end;
  }
  return output + html.slice(index);
}

const WORD = /[A-Za-z0-9_]/u;

/** `html` without the named elements and everything inside them, matched case-insensitively. */
export function dropHtmlElements(html: string, names: readonly string[]): string {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  let output = "";
  let index = 0;
  for (;;) {
    let open = -1;
    let name = "";
    for (const candidate of names) {
      if (unclosed.has(candidate)) continue;
      let at = lower.indexOf(`<${candidate}`, index);
      while (at >= 0 && WORD.test(lower[at + candidate.length + 1] ?? "")) {
        at = lower.indexOf(`<${candidate}`, at + 1);
      }
      if (at >= 0 && (open < 0 || at < open)) [open, name] = [at, candidate];
    }
    if (open < 0) break;
    const end = closingTagEnd(lower, name, open + name.length + 1);
    if (end < 0) {
      // No closing tag anywhere later, so no later opening of this element can close either.
      unclosed.add(name);
      continue;
    }
    output += html.slice(index, open);
    index = end;
  }
  return output + html.slice(index);
}

/** The offset just past the first `</name\s*>` at or after `from`, or -1. */
function closingTagEnd(lower: string, name: string, from: number): number {
  for (let at = lower.indexOf(`</${name}`, from); at >= 0; at = lower.indexOf(`</${name}`, at + 1)) {
    let end = at + name.length + 2;
    while (end < lower.length && /\s/u.test(lower[end]!)) end += 1;
    if (lower[end] === ">") return end + 1;
  }
  return -1;
}
