const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appRoot = __dirname;
const source = (relativePath) => fs.readFileSync(path.join(appRoot, relativePath), "utf8");
const layoutSource = source("layout.tsx");
const siteCss = source("themes/site.css");
const tokensCss = source("tokens.css");
const navbarSource = source("../components/shared/navbar.tsx");
const heroSource = source("../components/landing/hero.tsx");

test("public routes share one warm material layer", () => {
  assert.match(layoutSource, /import "\.\/themes\/wood\.css";\s*import "\.\/themes\/site\.css";/);
  assert.match(layoutSource, /<body className="site-canvas antialiased">/);
  assert.match(tokensCss, /--site-wood:/);
  assert.match(tokensCss, /--site-paper:/);
  assert.doesNotMatch(tokensCss, /--site-glass-fill:/);

  for (const route of [
    "page.tsx",
    "docs/page.tsx",
    "download/page.tsx",
    "login/page.tsx",
    "billing/page.tsx",
    "console/page.tsx",
  ]) {
    assert.match(source(route), /site-page/, `${route} must opt into the shared public material layer`);
  }
});

test("hero image can extend under the fixed public navbar", () => {
  assert.match(heroSource, /min-h-svh/);
  assert.match(heroSource, /pt-20/);
  assert.match(heroSource, /md:absolute md:inset-0/);
});

test("Get started renders the product live instead of a screenshot", () => {
  const quickStartSource = source("../components/landing/quick-start.tsx");
  assert.match(quickStartSource, /<AppWindow \/>/);
  assert.match(source("../components/landing/app-window-preview.tsx"), /MessageTimeline[\s\S]*ChannelSidebar|ChannelSidebar[\s\S]*MessageTimeline/);
  assert.doesNotMatch(quickStartSource, /next\/image|\.png|\.webp/);
  assert.match(source("page.tsx"), /<Hero \/>\s*<QuickStart \/>/);
});

test("public site labels carry no decorative eyebrow bar", () => {
  assert.doesNotMatch(siteCss, /\.x-eyebrow::before/);
});

test("public actions use shared materials and the Hero has one wood CTA", () => {
  assert.match(layoutSource, /LiquidGlassFilter/);
  assert.match(navbarSource, /WoodPanel/);
  assert.match(navbarSource, /LiquidGlassPill/);
  assert.doesNotMatch(navbarSource, /x-glass-button/);
  assert.doesNotMatch(navbarSource, /bg-\[#68462f\]|bg-\[#513522\]/);
  assert.match(heroSource, /WoodPanel[\s\S]*as=\{Link\}[\s\S]*href="\/login"/);
  assert.match(siteCss, /\.site-page \.app-material-wood-panel\.site-wood-pill \{\s*border-radius: 999px;/);
  assert.doesNotMatch(heroSource, /landing-liquid-button/);
  assert.match(heroSource, /Start Free/);
  assert.doesNotMatch(heroSource, /Set up with your agent|See How It Works|Shared space|clear handoffs/);
});

test("homepage panels reuse app wood and liquid-glass primitives", () => {
  assert.match(siteCss, /\.site-page \.app-material-wood-panel/);
  assert.doesNotMatch(siteCss, /backdrop-filter:\s*blur\(1[468]px\)/);
  assert.doesNotMatch(siteCss, /\.site-page :is\(\.x-card, \.matrix-panel, \[data-slot="card"\]\)/);
  assert.doesNotMatch(
    siteCss,
    /--app-liquid-surface-bg:\s*oklch\(1 0 0 \/ 0\.72\)/,
    "site pills must not retune the selected-channel glass fill to opaque white",
  );
  assert.match(siteCss, /--site-wood-ink:/);
  assert.match(siteCss, /font-weight:\s*700/);
});

test("docs content panels use wood instead of large glass cards", () => {
  const docsSource = source("docs/page.tsx");
  assert.match(docsSource, /WoodPanel/);
  assert.match(docsSource, /quickStart\.map[\s\S]*<WoodPanel /);
  assert.match(docsSource, /launchCommands\.map[\s\S]*<WoodPanel /);
  assert.match(docsSource, /<WoodPanel className="min-w-0 p-6">[\s\S]*Recommended flow/);
});

test("navbar keeps wood chrome beside selected-channel glass pills and woods the mobile sheet", () => {
  assert.match(navbarSource, /<WoodPanel className="site-navbar-inner\b[^"]*">/);
  assert.match(navbarSource, /site-nav-sheet app-material-wood-panel/);
  assert.match(navbarSource, /navLinks\.map\([\s\S]*LiquidGlassPill/);
  assert.match(navbarSource, /WoodPanel/);
});

test("navbar keeps the 3D logo off a centered sticky wood bar", () => {
  const brandIndex = navbarSource.indexOf("<BrandMark");
  const woodIndex = navbarSource.indexOf('<WoodPanel className="site-navbar-inner');
  assert.ok(brandIndex >= 0 && woodIndex > brandIndex, "brand mark must sit outside the wood bar");
  assert.match(navbarSource, /iconSrc="\/brand\/xmatrix-icon-transparent\.png"/);
  assert.match(navbarSource, /site-navbar-brand/);
  assert.match(navbarSource, /--navbar-wood-reveal/);
  assert.match(navbarSource, /className="site-navbar fixed top-0/);
  assert.match(siteCss, /\.site-navbar-layout \{[\s\S]*?justify-content:\s*center/);
  assert.match(siteCss, /\.site-navbar \.site-navbar-inner \{[\s\S]*opacity:\s*var\(--navbar-wood-reveal\)/);
  assert.match(siteCss, /\.site-navbar \{[\s\S]*background:\s*transparent/);
  assert.doesNotMatch(siteCss, /\.site-navbar::before/);
  assert.doesNotMatch(navbarSource, /xmatrix-icon\.png/);
});

test("public connector list shows only connected services with checked-in icons", () => {
  const connectorsSource = source("../components/landing/connectors.tsx");
  const ids = [...connectorsSource.matchAll(/\{ id: "([a-z]+)", name: "[^"]+" \}/g)].map((match) => match[1]);
  assert.deepEqual(ids, [
    "github", "gitlab", "linear", "notion", "google", "slack", "sentry",
    "vercel", "netlify", "cloudflare", "grafana", "buildkite", "webhook",
  ]);
  for (const id of ids) {
    assert.ok(
      fs.existsSync(path.join(appRoot, "../../public/app-connectors", `${id}.svg`)),
      `${id} needs a checked-in icon`,
    );
  }
  // Glass pills sit directly on one wood panel; no glass card wraps them.
  assert.match(connectorsSource, /<WoodPanel[\s\S]*publicConnectors\.map[\s\S]*<LiquidGlassPill/);
  assert.doesNotMatch(connectorsSource, /LiquidGlassCard/);
  assert.match(source("page.tsx"), /<HowItWorks \/>\s*<Connectors \/>/);
  assert.match(source("docs/page.tsx"), /<ConnectorList /);
});

test("homepage display headings use the self-hosted Manrope face", () => {
  const globalsCss = source("globals.css");
  assert.match(globalsCss, /font-family: "Manrope Variable";[\s\S]*?url\("\/fonts\/manrope-latin-wght-normal\.woff2"\)/);
  assert.ok(fs.existsSync(path.join(appRoot, "../../public/fonts/manrope-latin-wght-normal.woff2")));
  assert.ok(fs.existsSync(path.join(appRoot, "../../public/fonts/manrope-latin-ext-wght-normal.woff2")));
  assert.match(tokensCss, /--font-site-display-family: "Manrope Variable", var\(--font-sans-family\);/);
  assert.match(siteCss, /\.site-display \{\s*font-family: var\(--font-site-display-family\);/);
  assert.match(heroSource, /<h1 className="site-display /);
  assert.doesNotMatch(heroSource, /tracking-\[-0\.055em\]/);
});
