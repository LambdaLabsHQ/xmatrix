import fs from "node:fs";
import path from "node:path";

import type { Page, TestInfo } from "@playwright/test";

/**
 * Computed-style snapshot of a test's final page, for proving a stylesheet
 * refactor changes nothing a user sees.
 *
 * Off unless CSS_DUMP_DIR is set. When it is, every test writes one JSON file
 * mapping each element (by its DOM index path) to a hash of its computed
 * style and of its ::before/::after styles. CSS_DUMP_FULL=1 writes the style
 * text instead of hashes, for reading what differs.
 *
 * Transitions and animations are stopped before reading, so every value is
 * its settled end state, and custom properties are skipped: they only reach
 * the screen through the real properties that use them, which are compared.
 *
 * Compare two runs with `node scripts/css-computed-diff.mjs`.
 */
export async function dumpComputedStyles(page: Page, testInfo: TestInfo): Promise<void> {
  const directory = process.env.CSS_DUMP_DIR;
  if (!directory || page.isClosed()) return;
  const full = process.env.CSS_DUMP_FULL === "1";
  const styles = await page.evaluate((fullText) => {
    const freeze = document.createElement("style");
    freeze.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(freeze);
    void document.body.offsetHeight;
    const hash = (text: string) => {
      let value = 5381;
      for (let index = 0; index < text.length; index += 1) value = ((value << 5) + value + text.charCodeAt(index)) | 0;
      return (value >>> 0).toString(36);
    };
    const styleText = (style: CSSStyleDeclaration) => {
      let text = "";
      for (let index = 0; index < style.length; index += 1) {
        const property = style[index]!;
        if (property.startsWith("--") || property.startsWith("transition") || property.startsWith("animation")) continue;
        text += `${property}:${style.getPropertyValue(property)};`;
      }
      return text;
    };
    const elementPath = (element: Element) => {
      const parts: string[] = [];
      for (let current: Element | null = element; current && current !== document.documentElement; current = current.parentElement) {
        const parent: Element | null = current.parentElement;
        parts.unshift(`${current.tagName.toLowerCase()}${parent ? Array.prototype.indexOf.call(parent.children, current) : 0}`);
      }
      return parts.join(">");
    };
    const result: Record<string, [string, string]> = {};
    for (const element of [document.documentElement, ...Array.from(document.body.querySelectorAll("*")), document.body]) {
      if (element === freeze) continue;
      const own = styleText(getComputedStyle(element));
      const before = getComputedStyle(element, "::before");
      const after = getComputedStyle(element, "::after");
      const pseudo = `${before.content === "none" ? "" : styleText(before)}|${after.content === "none" ? "" : styleText(after)}`;
      result[elementPath(element)] = fullText ? [own, pseudo] : [hash(own), hash(pseudo)];
    }
    freeze.remove();
    return result;
  }, full).catch(() => null);
  if (!styles) return;
  const name = `${testInfo.project.name}__${testInfo.titlePath.join("__")}`.replace(/[^a-z0-9]+/gi, "_").slice(0, 180);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(styles));
}
