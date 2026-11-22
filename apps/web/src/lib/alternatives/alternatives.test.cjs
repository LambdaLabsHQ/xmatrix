const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  alternativeCategories,
  alternativePages,
  alternativePagesByCategory,
  findAlternativePage,
  relatedAlternatives,
} = require("./index.ts");

test("every competitor alternative page has a unique URL-safe slug and resolves at the site origin", async () => {
  const { isSitePath } = await import("../../../site-host.mjs");
  const slugs = new Set();

  assert.ok(alternativePages.length >= 15, "publishes the full competitor alternatives set");
  assert.equal(isSitePath("/alternatives"), true, "/alternatives must be served at the site origin");

  for (const page of alternativePages) {
    assert.match(page.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `slug must be kebab-case: ${page.slug}`);
    assert.equal(slugs.has(page.slug), false, `duplicate slug: ${page.slug}`);
    slugs.add(page.slug);
    assert.equal(page.href, `/alternatives/${page.slug}`);
    assert.equal(findAlternativePage(page.slug), page);
    assert.equal(isSitePath(page.href), true, `${page.href} must not redirect away from the site origin`);
    assert.ok(page.painPoints.length >= 3, `${page.slug} needs concrete pain points`);
    assert.ok(page.comparisonRows.length >= 5, `${page.slug} needs a side-by-side comparison table`);
    assert.ok(page.stayWhen.length >= 1 && page.switchWhen.length >= 2, `${page.slug} needs honest stay/switch guidance`);
    assert.equal(page.migrationSteps.length, 3, `${page.slug} needs three migration steps`);
    assert.ok(page.faqs.length >= 3, `${page.slug} needs competitor-specific FAQs`);

    const siblings = relatedAlternatives(page);
    assert.equal(siblings.length, page.relatedSlugs.length, `${page.slug} has an unknown related slug`);
    for (const sibling of siblings) {
      assert.notEqual(sibling.slug, page.slug, `${page.slug} must not link to itself`);
    }
  }

  assert.equal(findAlternativePage("does-not-exist"), undefined);
});

test("every alternatives category groups at least one published page", () => {
  let total = 0;
  for (const category of alternativeCategories) {
    const pages = alternativePagesByCategory(category.id);
    assert.ok(pages.length > 0, `category ${category.id} has no pages`);
    total += pages.length;
  }
  assert.equal(total, alternativePages.length);
});
