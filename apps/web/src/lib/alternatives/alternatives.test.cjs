const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  alternativePages,
  findAlternativePageByRouteSlug,
  findAlternativeRedirect,
  relatedAlternatives,
} = require("./index.ts");

test("every competitor alternative page uses a flat root /<slug>-alternatives URL served at the site origin", async () => {
  const { isSitePath } = await import("../../../site-host.mjs");
  const slugs = new Set();

  assert.ok(alternativePages.length >= 19, "publishes the full competitor alternatives set");
  assert.equal(isSitePath("/alternatives"), false, "no /alternatives hub page is exposed at the site origin");

  for (const page of alternativePages) {
    assert.match(page.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `slug must be kebab-case: ${page.slug}`);
    assert.equal(slugs.has(page.slug), false, `duplicate slug: ${page.slug}`);
    slugs.add(page.slug);
    assert.equal(page.routeSlug, `${page.slug}-alternatives`);
    assert.equal(page.href, `/${page.slug}-alternatives`);
    assert.equal(findAlternativePageByRouteSlug(page.routeSlug), page);
    assert.equal(isSitePath(page.href), true, `${page.href} must not redirect away from the site origin`);
    assert.match(page.metaTitle, /Alternatives/u, `${page.slug} metaTitle must target the search phrase`);
    assert.ok(page.metaTitle.length <= 60, `${page.slug} metaTitle too long for SERP (${page.metaTitle.length})`);
    assert.match(page.headline, /Alternative/u, `${page.slug} H1 must include Alternative`);
    assert.ok(page.productCaption.length > 30, `${page.slug} needs a product showcase caption`);
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

  assert.equal(findAlternativePageByRouteSlug("does-not-exist-alternatives"), undefined);
});

test("legacy competitor brand names redirect to their current canonical alternative page", async () => {
  const { isSitePath } = await import("../../../site-host.mjs");
  for (const [legacy, target] of [
    ["superset-alternatives", "/paradev-alternatives"],
    ["slock-alternatives", "/raft-alternatives"],
    ["lobechat-alternatives", "/lobehub-alternatives"],
    ["evermemos-alternatives", "/everos-alternatives"],
    ["google-jules-alternatives", "/jules-alternatives"],
  ]) {
    assert.equal(isSitePath(`/${legacy}`), true, `/${legacy} must be served at the site origin to redirect`);
    assert.equal(findAlternativeRedirect(legacy), target);
    assert.ok(findAlternativePageByRouteSlug(target.slice(1)), `redirect target ${target} must exist`);
  }
});
