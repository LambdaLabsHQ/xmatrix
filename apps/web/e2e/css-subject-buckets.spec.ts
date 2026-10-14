import postcss from "postcss";
import cssSubjectBuckets from "../css-subject-buckets.mjs";
import { expect, test, type Page } from "./fixtures";

const css = String.raw`
  #fixture * { color: rgb(1, 2, 3); background-color: transparent; }
  #fixture :is(.red, .blue) { color: rgb(10, 20, 30); }
  #fixture .red { color: rgb(40, 50, 60); }
  #fixture .low { background-color: rgb(70, 80, 90); }
  #fixture :where(.low, .low-alt) { background-color: rgb(20, 30, 40); }
  #fixture :is(.before-a, .before-b):before {
    content: "before"; color: rgb(110, 120, 130);
  }
  #fixture :where(.after-a, .after-b)::after {
    content: "after"; color: rgb(140, 150, 160);
  }
  #fixture :is(.interactive-a, .interactive-b) { outline: 2px solid rgb(1, 2, 3); }
  #fixture :is(.interactive-a, .interactive-b):hover { outline-color: rgb(170, 180, 190); }
  #fixture :is(.interactive-a, .interactive-b):focus { color: rgb(200, 210, 220); }
  #fixture .ancestor:is(.state-a, .state-b) > :is(.desc-a, .desc-b) { font-weight: 700; }

  @layer early, late;
  @layer late {
    #fixture :where(.layer-a, .layer-b) {
      color: rgb(80, 90, 100); padding-left: 7px;
      background-color: rgb(90, 100, 110) !important;
    }
  }
  @layer early {
    #fixture :is(.layer-a, .layer-b) {
      color: rgb(20, 30, 40); padding-left: 3px;
      background-color: rgb(30, 40, 50) !important;
    }
  }
  #fixture :is(.responsive-a, .responsive-b) { width: 10px; }
  @media (min-width: 700px) {
    #fixture :is(.responsive-a, .responsive-b) { width: 30px; }
  }

  #fixture :is(.compound-a.compound-b, .mixed) { color: rgb(11, 22, 33); }
  #fixture .mixed { color: rgb(44, 55, 66); }
  #fixture :is(.context > .deep-a, .deep-b) { font-weight: 800; }
  #fixture :is(.escaped\:a, .escape-b) { color: rgb(77, 88, 99); }
  #fixture .nest {
    & > :is(.nested-a, .nested-b) { color: rgb(101, 102, 103); }
    @media (min-width: 700px) {
      :is(.nested-a, .nested-b) { background-color: rgb(104, 105, 106); }
    }
  }
`;

const html = `
  <main id="fixture">
    <span class="red" data-case="red">red</span>
    <span class="blue" data-case="blue">blue</span>
    <span class="red blue" data-case="both">both alternatives</span>
    <span data-case="neither">neither</span>
    <span class="low" data-case="low">low</span>
    <span class="low-alt" data-case="low-alt">low alternative</span>
    <span class="before-a after-b" data-case="generated">generated</span>
    <button class="interactive-a" data-case="interactive">interactive</button>
    <div class="ancestor state-b"><span class="desc-a" data-case="descendant">descendant</span></div>
    <div class="ancestor"><span class="desc-a" data-case="wrong-ancestor">wrong ancestor</span></div>
    <span class="layer-a" data-case="layer">layer</span>
    <div class="responsive-b" data-case="responsive">responsive</div>
    <span class="compound-a compound-b" data-case="compound">compound</span>
    <span class="mixed" data-case="mixed">mixed specificity</span>
    <span class="compound-a" data-case="partial">partial compound</span>
    <div class="context"><span class="deep-a" data-case="complex">complex</span></div>
    <span class="deep-a" data-case="wrong-parent">wrong parent</span>
    <span class="escaped:a" data-case="escaped">escaped</span>
    <div class="nest"><span class="nested-a" data-case="nested">nested</span></div>
    <span class="nested-a" data-case="outside-nest">outside nesting</span>
  </main>
`;

async function mountFixture(page: Page) {
  const result = await postcss([cssSubjectBuckets()]).process(css, { from: undefined });
  await page.setContent(`<style>${result.css}</style>${html}`);
}

async function renderedStyles(page: Page) {
  return page.locator("[data-case]").evaluateAll((elements) => Object.fromEntries(elements.map((element) => {
    const style = getComputedStyle(element);
    return [element.getAttribute("data-case")!, {
      color: style.color,
      background: style.backgroundColor,
      weight: style.fontWeight,
      width: style.width,
      padding: style.paddingLeft,
    }];
  })));
}

test.use({ viewport: { width: 800, height: 600 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

test("class guards preserve selector matching, specificity and generated content", async ({ page }) => {
  await mountFixture(page);
  expect(await renderedStyles(page)).toMatchObject({
    red: { color: "rgb(40, 50, 60)" },
    blue: { color: "rgb(10, 20, 30)" },
    both: { color: "rgb(40, 50, 60)" },
    neither: { color: "rgb(1, 2, 3)" },
    low: { background: "rgb(70, 80, 90)" },
    "low-alt": { background: "rgb(20, 30, 40)" },
    descendant: { weight: "700" },
    "wrong-ancestor": { weight: "400" },
  });
  const generated = await page.locator('[data-case="generated"]').evaluate((element) =>
    ["::before", "::after"].map((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return { content: style.content, color: style.color };
    }));
  expect(generated).toEqual([
    { content: '"before"', color: "rgb(110, 120, 130)" },
    { content: '"after"', color: "rgb(140, 150, 160)" },
  ]);
  const button = page.locator('[data-case="interactive"]');
  await button.hover();
  await expect(button).toHaveCSS("outline-color", "rgb(170, 180, 190)");
  await button.focus();
  await expect(button).toHaveCSS("color", "rgb(200, 210, 220)");
  await page.mouse.move(0, 0);
  await expect(button).toHaveCSS("outline-color", "rgb(1, 2, 3)");
});

test("class guards retain layer precedence and changing media conditions", async ({ page }) => {
  await mountFixture(page);
  // Normal layers win in declaration order; important layers reverse it.
  // The unlayered fixture reset intentionally wins normal color over both.
  expect(await renderedStyles(page)).toMatchObject({
    layer: { color: "rgb(1, 2, 3)", padding: "7px", background: "rgb(30, 40, 50)" },
    responsive: { width: "30px" },
  });
  await page.setViewportSize({ width: 600, height: 600 });
  expect(await renderedStyles(page)).toMatchObject({
    layer: { color: "rgb(1, 2, 3)", padding: "7px", background: "rgb(30, 40, 50)" },
    responsive: { width: "10px" },
  });
});

test("complex, mixed-specificity, escaped and nested selectors keep their browser behavior", async ({ page }) => {
  await mountFixture(page);
  expect(await renderedStyles(page)).toMatchObject({
    compound: { color: "rgb(11, 22, 33)" },
    mixed: { color: "rgb(11, 22, 33)" },
    partial: { color: "rgb(1, 2, 3)" },
    complex: { weight: "800" },
    "wrong-parent": { weight: "400" },
    escaped: { color: "rgb(77, 88, 99)" },
    nested: { color: "rgb(101, 102, 103)", background: "rgb(104, 105, 106)" },
    "outside-nest": { color: "rgb(1, 2, 3)", background: "rgba(0, 0, 0, 0)" },
  });
  await page.setViewportSize({ width: 600, height: 600 });
  await expect(page.locator('[data-case="nested"]')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
