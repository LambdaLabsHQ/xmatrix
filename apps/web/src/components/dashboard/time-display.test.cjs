const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const timeDisplay = compileTsModules(__dirname, ["time-display"]);

const {
  ageInDays,
  formatInstant,
  formatLocalClock,
  formatRelativeAge,
  formatZonedDateTime,
} = timeDisplay.exports;

test.after(timeDisplay.dispose);

const NOW = Date.parse("2026-09-18T20:28:34Z");

test("a relative age is a duration, so it cannot be read in the wrong zone", () => {
  /* The defect this module exists to prevent: a Focus review subtracted a UTC
     transcript from a UTC+8 wall clock and reported 3m49s as eight hours. A
     duration has no zone to get wrong, so the answer is the same whichever
     clock the reader is holding. */
  assert.equal(formatRelativeAge("2026-09-18T20:24:45Z", NOW), "3m ago");
  assert.equal(formatRelativeAge("2026-09-18T20:28:00Z", NOW), "just now");
  assert.equal(formatRelativeAge("2026-09-18T12:28:34Z", NOW), "8h ago");
  assert.equal(formatRelativeAge("2026-09-16T20:28:34Z", NOW), "2d ago");
});

test("ages floor rather than round, so a stated age is always already elapsed", () => {
  assert.equal(formatRelativeAge("2026-09-18T20:27:35Z", NOW), "just now");
  assert.equal(formatRelativeAge("2026-09-18T19:29:00Z", NOW), "59m ago");
  assert.equal(formatRelativeAge("2026-09-17T20:28:35Z", NOW), "23h ago");
});

test("a clock ahead of the server reads as just now, never as a negative age", () => {
  assert.equal(formatRelativeAge("2026-09-18T20:30:00Z", NOW), "just now");
});

test("an unparseable timestamp has no age, so the caller decides what to show", () => {
  assert.equal(formatRelativeAge("not a time", NOW), null);
  assert.equal(formatRelativeAge(undefined, NOW), null);
  assert.equal(ageInDays("not a time", NOW), null);
  assert.equal(ageInDays("2026-09-16T20:28:34Z", NOW), 2);
});

test("a zoned instant names its zone in every zone it can be rendered in", () => {
  /* Same instant, three readers. Without the zone suffix the three strings are
     mutually contradictory and nothing in them says why. */
  const instant = "2026-09-18T20:28:34Z";
  assert.equal(formatZonedDateTime(instant, "en-US", "Asia/Shanghai"), "9/19/2026, 4:28 AM GMT+8");
  assert.equal(formatZonedDateTime(instant, "en-US", "UTC"), "9/18/2026, 8:28 PM UTC");
  assert.equal(
    formatZonedDateTime(instant, "en-US", "America/Los_Angeles"),
    "9/18/2026, 1:28 PM PDT",
  );
});

test("a local clock reading stays bare, because its neighbours share its zone", () => {
  assert.equal(formatLocalClock("2026-09-18T20:28:34Z", "en-US", "Asia/Shanghai"), "4:28 AM");
});

test("an unparseable timestamp renders as itself rather than as Invalid Date", () => {
  assert.equal(formatZonedDateTime("nonsense", "en-US", "UTC"), "nonsense");
  assert.equal(formatInstant("nonsense", "en-US", { timeZone: "UTC" }), "nonsense");
});
