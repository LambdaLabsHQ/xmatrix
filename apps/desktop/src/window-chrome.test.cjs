const assert = require("node:assert/strict");

const test = require("node:test");

let DEFAULT_SHELL_BACKGROUND_COLOR;
let WINDOWS_TITLE_BAR_OVERLAY;
let desktopTitleBarOptions;

test.before(async () => {
  const loaded = await import("./window-chrome.ts");
  DEFAULT_SHELL_BACKGROUND_COLOR = loaded.DEFAULT_SHELL_BACKGROUND_COLOR;
  WINDOWS_TITLE_BAR_OVERLAY = loaded.WINDOWS_TITLE_BAR_OVERLAY;
  desktopTitleBarOptions = loaded.desktopTitleBarOptions;
});

test("Every desktop shell paints the wood app's paper before the page loads", () => {
  assert.equal(DEFAULT_SHELL_BACKGROUND_COLOR, "#f5efe5");
});

test("Windows drops the system title bar and overlays transparent caption buttons", () => {
  const options = desktopTitleBarOptions("win32", { x: 18, y: 18 });
  assert.equal(options.titleBarStyle, "hidden");
  assert.deepEqual(options.titleBarOverlay, { color: "#00000000", symbolColor: "#2a1c10", height: 36 });
  assert.deepEqual(options.titleBarOverlay, { ...WINDOWS_TITLE_BAR_OVERLAY });
  assert.equal("trafficLightPosition" in options, false);
});

test("macOS insets the traffic lights and Linux keeps the window manager frame", () => {
  assert.deepEqual(desktopTitleBarOptions("darwin", { x: 18, y: 18 }), {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
  });
  assert.deepEqual(desktopTitleBarOptions("linux", { x: 18, y: 18 }), { titleBarStyle: "default" });
});
