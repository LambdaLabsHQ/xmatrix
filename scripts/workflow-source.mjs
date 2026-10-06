import { parseDocument, visit } from "yaml";

// Policy checks read the effective steps and selectors, including shared YAML
// anchors. Preserve their original shell text and comments for source guards.
export function expandWorkflowAnchors(source) {
  const document = parseDocument(source);
  if (document.errors.length) throw document.errors[0];
  const anchors = new Map();
  const aliases = [];
  visit(document, {
    Node(_key, node) {
      if (node.anchor) anchors.set(node.anchor, node);
    },
    Alias(_key, node) { aliases.push(node); },
  });
  const edits = [];
  for (const [name, node] of anchors) {
    const start = source.lastIndexOf(`&${name}`, node.range[0]);
    edits.push({ start, end: node.range[0], text: "" });
  }
  for (const alias of aliases) {
    const target = anchors.get(alias.source);
    if (!target) throw new Error(`Unknown workflow anchor: ${alias.source}`);
    edits.push({
      start: alias.range[0], end: alias.range[1],
      text: source.slice(target.range[0], target.range[1]).trimEnd(),
    });
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

// A shared workflow can contain several independently authorized release
// jobs. Policy checks inspect the real header and selected jobs together.
export function workflowSourceForJobs(source, jobs) {
  source = expandWorkflowAnchors(source);
  const start = source.indexOf("\njobs:");
  if (start < 0) throw new Error("Workflow has no jobs");
  const sections = jobs.map((job) => {
    if (!/^[\w-]+$/u.test(job)) throw new Error(`Invalid workflow job: ${job}`);
    const section = source.match(new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "mu"));
    if (!section) throw new Error(`Workflow has no job: ${job}`);
    return section[0];
  });
  return `${source.slice(0, start)}\njobs:\n${sections.join("\n")}`;
}
