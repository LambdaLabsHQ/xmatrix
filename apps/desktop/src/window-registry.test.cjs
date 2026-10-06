const assert = require("node:assert/strict");
const test = require("node:test");

let pickPrimaryWindowId;
let cascadeBounds;
let resolveInternalAppUrl;
let appSpaceKey;
let findWindowForTarget;

test.before(async () => {
  const loaded = await import("./window-registry.ts");
  pickPrimaryWindowId = loaded.pickPrimaryWindowId;
  cascadeBounds = loaded.cascadeBounds;
  resolveInternalAppUrl = loaded.resolveInternalAppUrl;
  appSpaceKey = loaded.appSpaceKey;
  findWindowForTarget = loaded.findWindowForTarget;
});

const window = (id, overrides = {}) => ({
  id,
  destroyed: false,
  focused: false,
  ...overrides,
});

test("pickPrimaryWindowId prefers the focused window over the last focused one", () => {
  assert.equal(
    pickPrimaryWindowId([window(1), window(2, { focused: true })], 1),
    2
  );
});

test("pickPrimaryWindowId falls back to the last focused window, then the oldest", () => {
  assert.equal(pickPrimaryWindowId([window(1), window(2)], 2), 2);
  assert.equal(pickPrimaryWindowId([window(1), window(2)], null), 1);
});

test("pickPrimaryWindowId never returns a destroyed window", () => {
  assert.equal(
    pickPrimaryWindowId([window(1, { destroyed: true }), window(2)], 1),
    2
  );
  assert.equal(
    pickPrimaryWindowId(
      [window(1, { destroyed: true, focused: true }), window(2)],
      1
    ),
    2
  );
  assert.equal(pickPrimaryWindowId([window(1, { destroyed: true })], 1), null);
  assert.equal(pickPrimaryWindowId([], null), null);
});

const WORK_AREA = { x: 0, y: 25, width: 1600, height: 1000 };
const SIZE = { width: 1280, height: 860 };

test("cascadeBounds centers the first window in the work area", () => {
  assert.deepEqual(cascadeBounds(null, WORK_AREA, SIZE), { x: 160, y: 95 });
});

test("cascadeBounds steps a new window down and right from its opener", () => {
  assert.deepEqual(
    cascadeBounds({ x: 160, y: 95, ...SIZE }, WORK_AREA, SIZE),
    { x: 192, y: 127 }
  );
});

test("cascadeBounds restarts at the work-area origin instead of going off-screen", () => {
  // One more step would push the window's bottom past the work area.
  assert.deepEqual(
    cascadeBounds({ x: 160, y: 140, ...SIZE }, WORK_AREA, SIZE),
    { x: 32, y: 57 }
  );
  assert.deepEqual(
    cascadeBounds({ x: 300, y: 95, ...SIZE }, WORK_AREA, SIZE),
    { x: 32, y: 57 }
  );
});

test("resolveInternalAppUrl keeps an in-app path on the app origin", () => {
  assert.equal(
    resolveInternalAppUrl("https://xmatrix.sh/app", "/app/space-a/channels"),
    "https://xmatrix.sh/app/space-a/channels"
  );
  assert.equal(
    resolveInternalAppUrl("http://localhost:3001/app", "/app/space-a?view=overview"),
    "http://localhost:3001/app/space-a?view=overview"
  );
});

test("resolveInternalAppUrl refuses anything that could leave the app origin", () => {
  for (const requested of [
    "https://evil.example/app",
    "//evil.example/app",
    "/\\evil.example/app",
    "\\app\\space-a",
    "app/space-a",
    "javascript:alert(1)",
    "xmatrix://deep-link",
    "",
  ]) {
    assert.equal(
      resolveInternalAppUrl("https://xmatrix.sh/app", requested),
      null,
      `expected ${JSON.stringify(requested)} to be refused`
    );
  }
});

test("appSpaceKey reads the Space segment and ignores Space-less pages", () => {
  assert.equal(appSpaceKey("https://xmatrix.sh/app/space-a/channels/c1"), "space-a");
  assert.equal(appSpaceKey("https://xmatrix.sh/app/space-a"), "space-a");
  assert.equal(appSpaceKey("https://xmatrix.sh/app"), null);
  assert.equal(appSpaceKey("https://xmatrix.sh/app?view=overview"), null);
  assert.equal(appSpaceKey("https://xmatrix.sh/docs"), null);
  assert.equal(appSpaceKey("not a url"), null);
});

test("findWindowForTarget reuses the window already holding that Space", () => {
  const windows = [
    { ...window(1), url: "https://xmatrix.sh/app/space-a/channels" },
    { ...window(2), url: "https://xmatrix.sh/app/space-b/channels" },
  ];
  assert.equal(
    findWindowForTarget(windows, "https://xmatrix.sh/app/space-b/channels/c9"),
    2
  );
  assert.equal(
    findWindowForTarget(windows, "https://xmatrix.sh/app/space-c"),
    null
  );
});

test("findWindowForTarget opens a new window for a Space-less target", () => {
  const windows = [{ ...window(1), url: "https://xmatrix.sh/app/space-a" }];
  assert.equal(findWindowForTarget(windows, "https://xmatrix.sh/app"), null);
});

test("findWindowForTarget skips destroyed windows", () => {
  const windows = [
    { ...window(1, { destroyed: true }), url: "https://xmatrix.sh/app/space-a" },
  ];
  assert.equal(
    findWindowForTarget(windows, "https://xmatrix.sh/app/space-a"),
    null
  );
});

test("aggregateBadge sums the Spaces the open windows are showing", async () => {
  const { aggregateBadge } = await import("./window-registry.ts");
  assert.deepEqual(
    aggregateBadge([
      { key: "space-a", mentionCount: 2, hasUnread: true },
      { key: "space-b", mentionCount: 3, hasUnread: false },
    ]),
    { mentionCount: 5, hasUnread: true }
  );
});

test("aggregateBadge collapses two windows left on the same Space", async () => {
  const { aggregateBadge } = await import("./window-registry.ts");
  assert.deepEqual(
    aggregateBadge([
      { key: "space-a", mentionCount: 4, hasUnread: true },
      { key: "space-a", mentionCount: 4, hasUnread: true },
    ]),
    { mentionCount: 4, hasUnread: true }
  );
});

test("aggregateBadge clears when no window reports anything", async () => {
  const { aggregateBadge } = await import("./window-registry.ts");
  assert.deepEqual(aggregateBadge([]), { mentionCount: 0, hasUnread: false });
  assert.deepEqual(
    aggregateBadge([{ key: "space-a", mentionCount: Number.NaN, hasUnread: false }]),
    { mentionCount: 0, hasUnread: false }
  );
});
