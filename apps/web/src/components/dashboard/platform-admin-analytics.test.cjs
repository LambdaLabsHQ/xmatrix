const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");
const analytics = compileTsModules(__dirname, ["platform-admin-analytics"]);

const {
  adminActivationFunnel,
  adminBucketPoints,
  adminChange,
  adminDayNumber,
  adminNiceCeiling,
  adminPeriod,
  adminPeriodFigures,
  adminRecentActiveDays,
  adminRegisteredSeries,
  adminWeeklyRetention,
  formatAdminChange,
} = analytics.exports;

test.after(analytics.dispose);

function series(length, endDate, fill = () => ({})) {
  const end = adminDayNumber(endDate);
  return Array.from({ length }, (_, index) => {
    const day = end - length + 1 + index;
    return {
      date: new Date(day * 86_400_000).toISOString().slice(0, 10),
      messages: 0, humanMessages: 0, agentMessages: 0, ownMessages: 0,
      activeUsers: 0, activeUsers7d: 0, activeUsers30d: 0, activeSpaces: 0, signups: 0, runsStarted: 0,
      ...fill(index, day),
    };
  });
}

test("a range is the last N days, compared with the N days before when the read reaches back that far", () => {
  const activity = series(40, "2026-10-27");
  const week = adminPeriod(activity, "7d");
  assert.equal(week.current.length, 7);
  assert.equal(week.current.at(-1).date, "2026-10-27");
  assert.equal(week.previous.length, 7);
  assert.equal(week.previous.at(-1).date, "2026-10-20");
  assert.equal(week.end - week.start + 1, 7);
  assert.equal(adminPeriod(activity, "30d").previous, null, "40 days cannot hold two 30-day ranges");
  assert.equal(adminPeriod(activity, "unknown").current.length, 30, "an unknown range reads as 30 days");
});

test("all time starts at the first registration or message of someone's own", () => {
  const activity = series(20, "2026-10-27", (index) => index < 5
    ? { messages: 3 } // imported history only
    : index === 5 ? { signups: 1 } : {});
  const all = adminPeriod(activity, "all");
  assert.equal(all.current.length, 15);
  assert.equal(all.previous, null);
});

test("period figures count distinct people, average complete days, and leave out unknown signups", () => {
  const points = series(3, "2026-10-27", (index) => ({
    activeUsers: [2, 4, 1][index], activeUsers30d: 10, ownMessages: 5, messages: 10,
    humanMessages: 4, agentMessages: 6, activeSpaces: [1, 3, 9][index], signups: 1, runsStarted: 2,
  }));
  const end = adminDayNumber("2026-10-27");
  const users = [
    { userId: "a", activeDays: [end - 2, end] },
    { userId: "b", activeDays: [end - 30] },
    { userId: "c" },
  ];
  const figures = adminPeriodFigures(points, users, end - 2, end);
  assert.equal(figures.activePeople, 1);
  assert.equal(figures.averageDailyActive, 3, "today is still running and stays out of the average");
  assert.equal(figures.stickiness, 0.3);
  assert.equal(figures.signups, 3);
  assert.equal(figures.averageActiveSpaces, 2);
  assert.equal(figures.runsStarted, 6);
  const withoutSignups = points.map(({ signups, ...point }) => point);
  assert.equal(adminPeriodFigures(withoutSignups, users, end - 2, end).signups, null);
});

test("changes read as signed whole percentages and stay quiet without a base", () => {
  assert.equal(formatAdminChange(adminChange(12, 10)), "+20%");
  assert.equal(formatAdminChange(adminChange(5, 10)), "−50%");
  assert.equal(formatAdminChange(adminChange(10, 10)), "no change");
  assert.equal(formatAdminChange(adminChange(3, 0)), undefined);
  assert.equal(formatAdminChange(adminChange(null, 3)), undefined);
});

test("registered accounts count back from today's total by each day's signups", () => {
  const points = series(3, "2026-10-27", (index) => ({ signups: [1, 0, 2][index] }));
  assert.deepEqual(adminRegisteredSeries(points, 10), [8, 8, 10]);
  assert.equal(adminRegisteredSeries([{ date: "2026-10-27", messages: 0, humanMessages: 0, agentMessages: 0 }], 1), null);
});

test("the activation funnel follows accounts registered in the range", () => {
  const end = adminDayNumber("2026-10-27");
  const at = (day) => new Date(day * 86_400_000 + 3_600_000).toISOString();
  const overview = {
    userAccess: { registeredUsers: 4 },
    users: [
      { userId: "new-active", registeredAt: at(end - 1), spaces: 1, machines: 1, agentRegistrations: 2, messages: 4,
        activeDays: [end] },
      // An onboarding notice is authored as the person but is not a message of their own.
      { userId: "new-space", registeredAt: at(end - 2), spaces: 1, machines: 0, agentRegistrations: 0, messages: 1 },
      { userId: "old", registeredAt: at(end - 40), spaces: 1, machines: 1, agentRegistrations: 1, messages: 9,
        activeDays: [end] },
      { userId: "no-account", spaces: 1, machines: 0, agentRegistrations: 0, messages: 0 },
    ],
  };
  assert.deepEqual(adminActivationFunnel(overview, end - 6, end).map((step) => [step.key, step.people]), [
    ["registered", 2], ["space", 2], ["machine", 1], ["agent", 1], ["message", 1], ["active", 1],
  ]);
});

test("weekly retention groups accounts by their Monday and leaves weeks to come empty", () => {
  // 2026-10-26 is a Monday.
  const monday = adminDayNumber("2026-10-26");
  const at = (day) => new Date(day * 86_400_000).toISOString();
  const users = [
    { userId: "a", registeredAt: at(monday - 7), activeDays: [monday - 6, monday + 1] },
    { userId: "b", registeredAt: at(monday - 5), activeDays: [monday - 5] },
    { userId: "c", registeredAt: at(monday + 1) },
  ];
  const cohorts = adminWeeklyRetention(users, monday + 1, 3);
  assert.deepEqual(cohorts.map((cohort) => [cohort.week, cohort.people]),
    [["2026-10-19", 2], ["2026-10-26", 1]], "weeks before the first registration are left out");
  const [lastWeek, thisWeek] = cohorts;
  assert.deepEqual(lastWeek.weeks.map((cell) => cell && cell.active), [2, 1, null]);
  assert.equal(lastWeek.weeks[0].share, 1);
  assert.deepEqual(thisWeek.weeks.map((cell) => cell && cell.active), [0, null, null]);
});

test("long ranges sum into weeks so every bar stays readable", () => {
  const points = series(130, "2026-10-27", () => ({ messages: 1 }));
  const sum = (bucket) => ({ messages: bucket.reduce((total, point) => total + point.messages, 0) });
  const weeks = adminBucketPoints(points, sum);
  assert.ok(weeks.length <= 20);
  assert.equal(weeks.reduce((total, week) => total + week.messages, 0), 130);
  assert.equal(weeks.at(-1).days, 2, "Monday and Tuesday of the running week");
  assert.equal(adminBucketPoints(points.slice(0, 30), sum).length, 30);
});

test("recent active days and axis ceilings", () => {
  const today = adminDayNumber("2026-10-27");
  assert.equal(adminRecentActiveDays({ activeDays: [today, today - 29, today - 30] }, today), 2);
  assert.equal(adminRecentActiveDays({}, today), 0);
  assert.deepEqual([0, 1, 3, 7, 12, 41, 250, 2897].map(adminNiceCeiling), [2, 2, 4, 8, 12, 50, 300, 3000]);
});
