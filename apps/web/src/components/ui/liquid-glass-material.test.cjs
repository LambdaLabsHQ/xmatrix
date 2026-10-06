const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (...parts) => fs.readFileSync(path.join(__dirname, ...parts), "utf8");
const material = read("liquid-glass-material.ts");
const surface = read("liquid-glass-surface.tsx");
const liquidGlassCss = read("..", "..", "app", "liquid-glass.css");
const tokensCss = read("..", "..", "app", "tokens.css");
const rail = read("..", "dashboard", "workspace-shell-chrome.tsx");
const details = read("..", "dashboard", "workspace-composer-dialogs.tsx");
const billing = read("..", "dashboard", "settings-billing.tsx");
const materialsCss = read("..", "..", "app", "themes", "materials.css");
const labPage = read("..", "..", "app", "dev", "glass-lab", "page.tsx");

test("every material parameter drives a custom property the recipe reads", () => {
  for (const token of [
    "--app-liquid-surface-bg",
    "--app-liquid-shared-surface-bg",
    "--app-liquid-material",
    "--app-liquid-vibrancy",
    "--app-liquid-glass-thickness",
    "--app-liquid-bezel-width",
    "--app-liquid-edge-light",
    "--app-liquid-shadow",
    "--app-liquid-shadow-small",
    "--app-glass-edge",
  ]) {
    assert.match(material, new RegExp(`style\\["${token}"\\]`), `${token} is set from the material`);
    assert.match(tokensCss, new RegExp(`${token}\\s*:`), `${token} has a default in tokens.css`);
  }
  assert.match(
    liquidGlassCss,
    /\.app-shared-chip, \.identity-avatar-face, \.identity-avatar-badge\) \{\s*--app-glass-edge: var\(--app-liquid-rim-layers\), var\(--app-liquid-shadow-small\);/,
    "chips take their shadow from the token a context can tune",
  );
});

test("a surface takes its own material and redraws its lens when the lens fields change", () => {
  assert.match(surface, /material\?: LiquidGlassMaterial;/);
  assert.match(surface, /style=\{material \? \{ \.\.\.liquidGlassMaterialStyle\(material\), \.\.\.style \} : style\}/);
  assert.match(surface, /useLiquidGlassLens\(surfaceRef, enabled && fill, liquidGlassLensVersion\(material\)\)/);
});

test("wood is only the background: it sets no glass material", () => {
  assert.doesNotMatch(material, /LIQUID_GLASS_ON_WOOD/, "no wood preset of the glass");
  assert.doesNotMatch(rail, /liquidGlassMaterialStyle/);
  assert.doesNotMatch(details, /liquidGlassMaterialStyle/);
  assert.doesNotMatch(billing, /liquidGlassMaterialStyle/);
  assert.doesNotMatch(materialsCss, /:is\(\.app-rail, \.app-sidebar, \.app-details, \.app-mobile-chat-pane\) \{[^}]*--app-liquid-surface-bg/, "the slabs do not tint the glass on them");
});

test("the glass lab is a development bench only", () => {
  assert.match(labPage, /if \(process\.env\.NODE_ENV === "production"\) notFound\(\);/);
});
