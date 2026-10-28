const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { calendarEventDraft, calendarRepeatText } = require("./calendar-event-preview.tsx");

test("Calendar approval keeps every clause of a repeat it cannot fully describe", () => {
  // RFC 5545's week-start example has different occurrences for MO and SU.
  // Likewise these UNTIL instants admit different last occurrences.
  for (const rule of [
    ...["MO", "SU"].map(day => `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${day}`),
    ...["103000", "233000"].map(time => `RRULE:FREQ=DAILY;UNTIL=20261102T${time}Z`),
    "RRULE:FREQ=MONTHLY;BYDAY=1MO",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1",
    "RRULE:FREQ=DAILY;FREQ=WEEKLY",
    "RRULE:FREQ=constructor",
    "RRULE:FREQ=WEEKLY;BYDAY=__proto__",
    "RRULE:FREQ=DAILY;INTERVAL=0",
    "EXDATE;TZID=America/New_York:20261102T103000",
  ]) assert.equal(calendarRepeatText(rule), rule);
  assert.equal(calendarRepeatText("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU"),
    "Every 2 weeks on Tue, Sun · 4 times");
});

test("an unknown notification mode cannot become an approvable Calendar draft", () => {
  const preview = { change: "create", calendar: "team@example.test", title: "Review",
    start: "2026-10-30T15:00:00+08:00", end: "2026-10-30T16:00:00+08:00", timeZone: "Asia/Shanghai" };
  for (const sendUpdates of ["constructor", "__proto__", "outsideOrganization"]) {
    assert.match(calendarEventDraft({ ...preview, sendUpdates }).problem, /unknown sendUpdates/u);
  }
});
