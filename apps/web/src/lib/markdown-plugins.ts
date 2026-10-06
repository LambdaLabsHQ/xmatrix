import type { Node, Nodes, Parent, PhrasingContent, Root } from "mdast";
import remarkGfm from "remark-gfm";

const proseBoundary = /[，。！？；：、（）［］【】《》〈〉「」『』“”‘’…]/u;

/** GFM treats CJK punctuation as URL content, including any following prose. */
function remarkCjkAutolinks(this: { parse(value: string): Node }) {
  const parseInline = (source: string): PhrasingContent[] => {
    const tree = this.parse(source) as Root;
    const paragraph = tree.children[0];
    return tree.children.length === 1 && paragraph.type === "paragraph"
      ? paragraph.children
      : [{ type: "text", value: source }];
  };

  return (tree: Root, file: { value: unknown }) => {
    const pending: { node: Nodes; parent?: Parent; source: string }[] = [
      { node: tree, source: String(file.value) },
    ];

    while (pending.length) {
      const { node, parent, source } = pending.pop()!;
      if (node.type === "link") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const raw = start !== undefined && end !== undefined
          ? source.slice(start, end)
          : node.children.map((child) => child.type === "text" ? child.value : "").join("");

        // Explicit [label](url), reference links and <url> retain their syntax.
        if (!parent || !/^(?:https?:\/\/|www\.)/i.test(raw)) continue;
        const boundary = raw.search(proseBoundary);
        if (boundary < 0) continue;

        const prefix = raw.slice(0, boundary);
        const suffix = raw.slice(boundary);
        // Reparse the URL to apply GFM's ordinary trailing punctuation and
        // balanced-parenthesis rules; reparse prose to recover later links and
        // formatting that the original oversized autolink swallowed.
        const before = parseInline(prefix);
        const after = parseInline(suffix);
        const index = parent.children.indexOf(node);
        parent.children.splice(index, 1, ...before, ...after);
        for (const child of before) pending.push({ node: child, parent, source: prefix });
        for (const child of after) pending.push({ node: child, parent, source: suffix });
        continue;
      }

      if ("children" in node) {
        for (const child of node.children) pending.push({ node: child, parent: node, source });
      }
    }
  };
}

export const markdownRemarkPlugins = [remarkGfm, remarkCjkAutolinks];
