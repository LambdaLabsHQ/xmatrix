import selectorParser from "postcss-selector-parser";

const MATCH_ANY = new Set([":is", ":where"]);
const MAX_SELECTORS = 64;

function isMatchAny(node) {
  return node.type === "pseudo" && MATCH_ANY.has(node.value.toLowerCase());
}

function plainClass(argument) {
  if (argument.nodes.length !== 1) return null;
  const node = argument.first;
  return node.type === "class" && /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/.test(node.value)
    && node.toString().trim() === `.${node.value}` ? node.value : null;
}

/** Give an unkeyed subject a necessary class key without changing its predicate
 * or specificity: O implies (A or B), so (O and A) or (O and B) is still O.
 * The complete original :is/:where stays; each added :where(key) weighs zero. */
export function bucketSubjectSelectors(selectorText, cap = MAX_SELECTORS) {
  if (!Number.isSafeInteger(cap) || cap < 1) return null;
  const limit = Math.min(cap, MAX_SELECTORS);
  let root;
  try {
    root = selectorParser().astSync(selectorText, { lossless: true });
  } catch {
    return null;
  }
  let unsafe = false;
  root.walk(node => { if (node.type === "nesting" || node.namespace != null) unsafe = true; });
  if (unsafe) return null;

  const selectors = [];
  let changed = false;
  for (const selector of root.nodes) {
    let from = 0;
    selector.nodes.forEach((node, index) => { if (node.type === "combinator") from = index + 1; });
    const compound = selector.nodes.slice(from);
    const pseudoElements = compound.filter(node => node.type === "pseudo" &&
      (node.value.startsWith("::") || /^:(?:before|after|first-line|first-letter)$/i.test(node.value)));
    const terminal = pseudoElements.length === 0 || (pseudoElements.length === 1 &&
      pseudoElements[0] === selector.last && /^:{1,2}(?:before|after)$/i.test(selector.last.value));
    const keyed = compound.some(node => node.type === "class" || node.type === "id" ||
      (isMatchAny(node) && node.nodes?.length === 1 && node.first.nodes.length === 1 && node.first.first.type === "class"));
    const any = compound.find(node => isMatchAny(node) && node.nodes?.length > 1);
    const keys = terminal && !keyed && any ? any.nodes.map(plainClass) : [];
    if (!keys.length || keys.some(key => key === null)) {
      selectors.push(selector.clone());
    } else {
      changed = true;
      const at = selector.nodes.indexOf(any);
      for (const key of new Set(keys)) {
        const copy = selector.clone();
        const guard = selectorParser.pseudo({ value: ":where", nodes: [selectorParser.selector({
          nodes: [selectorParser.className({ value: key })],
        })] });
        copy.insertBefore(copy.nodes[at], guard);
        selectors.push(copy);
        if (selectors.length > limit) return null;
      }
    }
    if (selectors.length > limit) return null;
  }
  return changed ? selectorParser.root({ nodes: selectors }).toString() : null;
}

function isStandaloneRule(rule) {
  if (rule.nodes?.some(node => node.type === "rule" || node.type === "atrule")) return false;
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "rule" || (parent.type === "atrule" && /^(?:-[a-z]+-)?keyframes$/i.test(parent.name))) return false;
  }
  return true;
}

/** Run after the other PostCSS visitors; leave declarations, groups and source
 * order intact, and never reinterpret implicit or explicit CSS nesting. */
export default function cssSubjectBuckets() {
  return {
    postcssPlugin: "xmatrix-css-subject-buckets",
    OnceExit(root) {
      root.walkRules(rule => {
        if (!isStandaloneRule(rule)) return;
        const next = bucketSubjectSelectors(rule.selector);
        if (next) rule.selector = next;
      });
    },
  };
}

cssSubjectBuckets.postcss = true;
