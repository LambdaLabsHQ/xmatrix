/** Set on <html> where a descendant's selection and highlights take their style from an ancestor's. */
export const HIGHLIGHT_INHERITANCE_ATTRIBUTE = "data-highlight-inherit";

/**
 * Run by the root layout before first paint. A `::selection` or `::highlight()`
 * rule that matches every element makes the browser work out one more style
 * for every element it styles: with the app's four such rules, a message row
 * mounted by a scroll cost five times its own style. Where highlights inherit,
 * globals.css names them once, on an ancestor; elsewhere it keeps the rule on
 * every element, which is the only way those engines draw it.
 */
export const HIGHLIGHT_INHERITANCE_MODE_SCRIPT = `
  try {
    const rule = document.createElement("style");
    rule.textContent = "[data-highlight-probe]::selection{background-color:rgb(1,2,3)}";
    const probe = document.createElement("div");
    probe.setAttribute("data-highlight-probe", "");
    const inner = probe.appendChild(document.createElement("span"));
    document.documentElement.append(rule, probe);
    if (getComputedStyle(inner, "::selection").backgroundColor === "rgb(1, 2, 3)") {
      document.documentElement.setAttribute("${HIGHLIGHT_INHERITANCE_ATTRIBUTE}", "");
    }
    rule.remove();
    probe.remove();
  } catch {}
`;
