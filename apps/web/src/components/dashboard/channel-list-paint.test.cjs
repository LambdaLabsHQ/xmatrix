const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const compiled = compileTsModules(__dirname, ["channel-list-paint"]);
const { channelRowsForPaint } = compiled.exports;
test.after(compiled.dispose);

test("painted rows stay until a loaded answer replaces them", () => {
  const live = [{ id: "live" }];
  const held = [{ id: "painted" }];
  const disk = [{ id: "disk" }];
  const cases = [
    { loaded: true, live, held: [{ id: "held" }], fallback: disk, rows: live, nextHeld: live, confirmed: true },
    { loaded: true, live: [], held: null, fallback: disk, rows: [], nextHeld: [], confirmed: true },
    { loaded: false, live: [], held, fallback: disk, rows: held, nextHeld: held, confirmed: true },
    { loaded: false, live: [{ id: "stale" }], held: [], fallback: disk, rows: [], nextHeld: [], confirmed: true },
    { loaded: false, live: [], held: null, fallback: disk, rows: disk, nextHeld: null, confirmed: false },
    { loaded: false, live: [], held: null, fallback: [], rows: [], nextHeld: null, confirmed: false },
  ];
  for (const item of cases) {
    const decision = channelRowsForPaint(item);
    assert.deepEqual(decision.rows, item.rows);
    assert.deepEqual(decision.held, item.nextHeld);
    assert.equal(decision.confirmed, item.confirmed);
  }
});
