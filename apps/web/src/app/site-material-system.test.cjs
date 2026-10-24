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
    "download/page.tsx",
    "../components/auth/auth-shell.tsx",
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
  assert.match(source("page.tsx"), /<Hero \/>\s*<AgentStrip \/>\s*<LivePage \/>\s*<QuickStart \/>/);
});

test("public site labels carry no decorative eyebrow bar", () => {
  assert.doesNotMatch(siteCss, /\.x-eyebrow::before/);
});

test("public actions use shared materials and the Hero has one wood CTA", () => {
  assert.match(layoutSource, /LiquidGlassFilter/);
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

test("navbar is one glass bar with no wood slab, and woods the mobile sheet", () => {
  assert.doesNotMatch(navbarSource, /<WoodPanel/);
  assert.doesNotMatch(siteCss, /site-navbar-inner|navbar-wood-reveal/);
  assert.match(navbarSource, /<span aria-hidden className="site-navbar-glass">\s*<LiquidGlassPill className="size-full">/);
  assert.match(navbarSource, /href="\/login"\s*onSlab/, "Start Free sits on the bar glass without a nested backdrop");
  assert.match(navbarSource, /site-nav-sheet app-material-wood-panel/);
  assert.match(navbarSource, /navLinks\.map\([\s\S]*LiquidGlassPill/);
});

test("navbar glass spans the logo and every link on a centered sticky bar", () => {
  const glassIndex = navbarSource.indexOf('className="site-navbar-glass"');
  const brandIndex = navbarSource.indexOf("<BrandMark");
  const barIndex = navbarSource.indexOf('className="site-navbar-bar"');
  assert.ok(glassIndex >= 0 && brandIndex > glassIndex && barIndex > brandIndex, "one glass layer sits behind brand and bar");
  assert.match(navbarSource, /iconSrc="\/brand\/xmatrix-icon-transparent-128\.png"/);
  assert.match(navbarSource, /--navbar-glass-reveal/);
  assert.match(navbarSource, /className="site-navbar fixed top-0/);
  assert.match(siteCss, /\.site-navbar-layout \{[\s\S]*?justify-content:\s*center/);
  assert.match(siteCss, /\.site-navbar-glass \{[\s\S]*?inset:\s*0;[\s\S]*?opacity:\s*var\(--navbar-glass-reveal\)/);
  assert.match(siteCss, /\.site-navbar \{[\s\S]*background:\s*transparent/);
  assert.doesNotMatch(siteCss, /\.site-navbar::before/);
  assert.doesNotMatch(navbarSource, /xmatrix-icon\.png/);
});

test("homepage display headings use the self-hosted Manrope face", () => {
  const globalsCss = source("globals.css");
  const face = globalsCss.match(/font-family: "Manrope Variable";[\s\S]*?url\("\/fonts\/(manrope-latin-wght-normal\.[0-9a-f]{10}\.woff2)"\)/);
  assert.ok(face, "Manrope must be served from its content-addressed file");
  assert.ok(fs.existsSync(path.join(appRoot, "../../public/fonts", face[1])));
  assert.ok(fs.readdirSync(path.join(appRoot, "../../public/fonts")).some((name) => /^manrope-latin-ext-wght-normal\.[0-9a-f]{10}\.woff2$/.test(name)));
  assert.match(tokensCss, /--font-site-display-family: "Manrope Variable", var\(--font-sans-family\);/);
  assert.match(siteCss, /\.site-display \{\s*font-family: var\(--font-site-display-family\);/);
  assert.match(heroSource, /<h1 className="site-display /);
  assert.doesNotMatch(heroSource, /tracking-\[-0\.055em\]/);
  assert.ok(heroSource.includes(`preload("/fonts/${face[1]}", { as: "font"`), "the hero preloads the face the CSS uses");
});
