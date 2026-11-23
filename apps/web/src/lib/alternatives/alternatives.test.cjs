const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { SITE_LOCALE_IDS, NON_DEFAULT_SITE_LOCALES, localizedAlternates, localizedPath } = require("../site-locales.ts");
const { landingCopy } = require("../landing-copy.ts");
const { sitePagesCopy } = require("../site-pages-copy.ts");
const {
  alternativePages,
  footerAlternativePages,
  findAlternativePageByRouteSlug,
  findAlternativeRedirect,
  relatedAlternatives,
} = require("./index.ts");

test("every competitor alternative page works across all 6 site locales and resolves at the site origin", async () => {
  const { isSitePath } = await import("../../../site-host.mjs");
  const slugs = new Set();

  assert.equal(SITE_LOCALE_IDS.length, 6, "Top6 locales are published");
  assert.ok(alternativePages.length >= 19, "publishes the full competitor alternatives set");
  assert.equal(isSitePath("/alternatives"), false, "no /alternatives hub page is exposed at the site origin");

  for (const page of alternativePages) {
    assert.match(page.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `slug must be kebab-case: ${page.slug}`);
    assert.equal(slugs.has(page.slug), false, `duplicate slug: ${page.slug}`);
    slugs.add(page.slug);
    assert.equal(page.routeSlug, `${page.slug}-alternatives`);
    assert.equal(page.basePath, `/${page.slug}-alternatives`);

    for (const locale of SITE_LOCALE_IDS) {
      const localized = findAlternativePageByRouteSlug(page.routeSlug, locale);
      assert.ok(localized, `${locale}/${page.routeSlug} must exist`);
      assert.equal(localized.href, localizedPath(locale, page.basePath));
      assert.equal(isSitePath(localized.href), true, `${localized.href} must be served at the site origin`);
      assert.ok(localized.metaTitle.length > 10 && localized.metaTitle.length <= 65, `${locale}/${page.slug} metaTitle length (${localized.metaTitle.length})`);
      assert.ok(localized.metaDescription.length >= 40, `${locale}/${page.slug} needs metaDescription`);
      // Search results cut a snippet near 160 characters.
      assert.ok(localized.metaDescription.length <= 160, `${locale}/${page.slug} metaDescription is ${localized.metaDescription.length} characters, over 160`);
      assert.ok(localized.headline.length >= 10, `${locale}/${page.slug} needs headline`);
      assert.ok(
        localized.headline.toLowerCase().includes(page.name.toLowerCase()),
        `${locale}/${page.slug} headline must include competitor display name "${page.name}": "${localized.headline}"`,
      );
      assert.ok(localized.productCaption.length >= 15, `${locale}/${page.slug} needs productCaption`);
      assert.ok(localized.painPoints.length >= 3, `${locale}/${page.slug} needs concrete pain points`);
      for (const point of localized.painPoints) {
        assert.ok(Array.isArray(point.sources) && point.sources.length >= 1, `${locale}/${page.slug} pain point "${point.title}" needs verified source link`);
        for (const src of point.sources) {
          assert.match(src.href, /^https:\/\//u, `source href must be https: ${src.href}`);
        }
      }
      assert.match(localized.verifiedDateIso, /^\d{4}-\d{2}-\d{2}$/u, `${locale}/${page.slug} needs ISO verifiedDateIso`);
      assert.ok(localized.comparisonRows.length >= 5, `${locale}/${page.slug} needs comparison rows`);
      assert.ok(localized.stayWhen.length >= 1 && localized.switchWhen.length >= 2, `${locale}/${page.slug} needs stay/switch guidance`);
      assert.equal(localized.migrationSteps.length, 3, `${locale}/${page.slug} needs three migration steps`);
      assert.ok(localized.faqs.length >= 3, `${locale}/${page.slug} needs FAQs`);

      const siblings = relatedAlternatives(localized, locale);
      assert.equal(siblings.length, page.relatedSlugs.length, `${locale}/${page.slug} has unknown related slug`);
      for (const sibling of siblings) {
        assert.notEqual(sibling.slug, page.slug);
        assert.equal(sibling.href, localizedPath(locale, sibling.basePath));
      }
    }
  }

  assert.equal(findAlternativePageByRouteSlug("does-not-exist-alternatives", "en"), undefined);

  assert.equal(footerAlternativePages.length, 8, "footer links stay focused on 8 flagship/window competitors");
  const bySlug = new Map(alternativePages.map((p) => [p.slug, p]));
  const hops = new Map(footerAlternativePages.map((p) => [p.slug, 0]));
  const queue = footerAlternativePages.map((p) => p.slug);
  while (queue.length > 0) {
    const current = queue.shift();
    const depth = hops.get(current);
    for (const next of bySlug.get(current).relatedSlugs) {
      if (!hops.has(next)) {
        hops.set(next, depth + 1);
        queue.push(next);
      }
    }
  }
  for (const page of alternativePages) {
    assert.ok(hops.has(page.slug) && hops.get(page.slug) <= 2, `${page.slug} must be reachable within 2 hops from footer`);
  }
});

test("legacy competitor brand names redirect to canonical alternative pages in every locale", async () => {
  const { isSitePath } = await import("../../../site-host.mjs");
  for (const [legacy, target] of [
    ["superset-alternatives", "/paradev-alternatives"],
    ["slock-alternatives", "/raft-alternatives"],
    ["lobechat-alternatives", "/lobehub-alternatives"],
    ["evermemos-alternatives", "/everos-alternatives"],
    ["google-jules-alternatives", "/jules-alternatives"],
  ]) {
    assert.equal(findAlternativeRedirect(legacy), target);
    for (const locale of SITE_LOCALE_IDS) {
      const href = localizedPath(locale, `/${legacy}`);
      assert.equal(isSitePath(href), true, `${href} must be served at the site origin to redirect`);
      assert.ok(findAlternativePageByRouteSlug(target.slice(1), locale), `${locale}${target} target must exist`);
    }
  }
});

test("all 6 locales have complete landing copy, page chrome, hreflang alternates, and translated guide markdown", () => {
  const guideRoot = path.join(__dirname, "..", "..", "..", "..", "..", "docs", "guide");
  const enFiles = fs.readdirSync(guideRoot).filter((name) => name.endsWith(".md")).sort();
  const frontMatter = /^---\ntitle: "([^"\n]+)"\ndescription: "([^"\n]+)"\n---\n+/u;

  for (const locale of SITE_LOCALE_IDS) {
    assert.ok(landingCopy[locale], `missing landingCopy for ${locale}`);
    assert.ok(sitePagesCopy[locale], `missing sitePagesCopy for ${locale}`);
    const alt = localizedAlternates(locale, "/download");
    assert.equal(alt.canonical, localizedPath(locale, "/download"));
    assert.equal(alt.languages["x-default"], "/download");
    assert.equal(Object.keys(alt.languages).length, SITE_LOCALE_IDS.length + 1);
  }

  for (const locale of NON_DEFAULT_SITE_LOCALES) {
    const localeDir = path.join(guideRoot, "i18n", locale);
    const files = fs.readdirSync(localeDir).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(files, enFiles, `docs/guide/i18n/${locale} must translate every guide file`);
    for (const file of files) {
      const content = fs.readFileSync(path.join(localeDir, file), "utf8").replaceAll("\r\n", "\n");
      assert.match(content, frontMatter, `docs/guide/i18n/${locale}/${file} missing valid front matter`);
      assert.match(content, /^# .+/mu, `docs/guide/i18n/${locale}/${file} missing H1 heading`);
    }
  }
});
