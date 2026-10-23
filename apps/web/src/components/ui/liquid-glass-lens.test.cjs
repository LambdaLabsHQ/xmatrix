const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("only filled glass surfaces opt into the lens, and its defs render once", () => {
  const componentsDir = path.join(__dirname, "..");
  const mounts = [];
  for (const dir of fs.readdirSync(componentsDir)) {
    const full = path.join(componentsDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (file.endsWith(".tsx") && /<LiquidGlassLensDefs/.test(fs.readFileSync(path.join(full, file), "utf8"))) {
        mounts.push(`${dir}/${file}`);
      }
    }
  }
  assert.deepEqual(mounts, [], "the root layout is the single mount, so filter ids never repeat");
});

/* A browser just big enough for the lens: Chromium's capabilities, one shared
   ResizeObserver whose reports the test delivers, frames the test runs, and
   surfaces whose computed style the test sets. */
function lensBrowser() {
  const saved = new Map(["window", "navigator", "CSS", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "document"]
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames = [];
  const observers = [];
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", { matchMedia: () => ({ matches: false }) });
  define("navigator", { userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36" });
  define("CSS", { supports: () => true });
  define("ResizeObserver", class {
    constructor(report) { this.report = report; this.watched = new Set(); observers.push(this); }
    observe(element) { this.watched.add(element); }
    unobserve(element) { this.watched.delete(element); }
  });
  define("getComputedStyle", (element) => element.computed);
  define("requestAnimationFrame", (callback) => frames.push(callback));
  define("document", { createElement: () => ({
    getContext: () => ({ createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {} }),
    toDataURL: () => "data:image/png;base64,lens",
  }) });
  const surface = (backdropFilter) => {
    const properties = new Map();
    return {
      isConnected: true,
      computed: { backdropFilter, borderTopLeftRadius: "10px", getPropertyValue: () => "" },
      style: { setProperty: (name, value) => properties.set(name, value), removeProperty: (name) => properties.delete(name) },
      lens: () => properties.get("--app-liquid-lens"),
    };
  };
  return {
    frames,
    surface,
    /** The observer's report of these surfaces at these sizes, as after a layout. */
    report: (sized) => observers.at(-1).report(sized.map(([target, inlineSize, blockSize]) =>
      ({ target, borderBoxSize: [{ inlineSize, blockSize }] }))),
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("a surface that needs no new map is settled in its size report; a map to draw waits for a frame, four to a frame", () => {
  require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
  const browser = lensBrowser();
  try {
    const { watchLiquidGlassLens } = require("./liquid-glass-lens.tsx");
    const flat = browser.surface("none");
    const first = browser.surface("blur(2px)");
    const twin = browser.surface("blur(2px)");
    for (const surface of [flat, first, twin]) watchLiquidGlassLens(surface);

    // Glass the recipe keeps flat has nothing to bend, and asks for no frame.
    browser.report([[flat, 40, 20]]);
    assert.equal(flat.lens(), undefined);
    assert.equal(browser.frames.length, 0);

    // A size no lens exists for yet waits for a frame, where it is drawn.
    browser.report([[first, 40, 20]]);
    assert.equal(first.lens(), undefined);
    assert.equal(browser.frames.length, 1);
    browser.frames.shift()();
    assert.match(first.lens(), /^url\("#xm-lens-0-/u);

    // Another surface of that size takes the same lens in its own report.
    browser.report([[twin, 40, 20]]);
    assert.equal(twin.lens(), first.lens());
    assert.equal(browser.frames.length, 0);

    // Six sizes to draw: four in the first frame, two in the next.
    const many = Array.from({ length: 6 }, () => browser.surface("blur(2px)"));
    for (const surface of many) watchLiquidGlassLens(surface);
    browser.report(many.map((surface, index) => [surface, 60 + index * 10, 20]));
    browser.frames.shift()();
    assert.equal(many.filter((surface) => surface.lens()).length, 4);
    assert.equal(browser.frames.length, 1);
    browser.frames.shift()();
    assert.equal(many.filter((surface) => surface.lens()).length, 6);
    assert.equal(browser.frames.length, 0);
  } finally {
    browser.restore();
  }
});
