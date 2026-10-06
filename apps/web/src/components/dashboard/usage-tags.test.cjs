const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "workspace-shell-formatters.tsx"), "utf8");

function compileFunction(name, dependencies = {}) {
  const file = ts.createSourceFile("formatters.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, `${name} declaration`);
  const compiled = ts.transpileModule(declaration.getText(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  new Function("exports", ...Object.keys(dependencies), compiled)(
    exported,
    ...Object.values(dependencies),
  );
  return exported[name] ?? new Function(...Object.keys(dependencies), `${compiled}; return ${name};`)(
    ...Object.values(dependencies));
}

const quotaLabel = (quota) => quota.label || quota.window || "";

function quotaDisplayFixture() {
  const order = ["5h", "1w", "2h", "1mo"];
  return { order, compareQuotaUsageForDisplay: compileFunction("compareQuotaUsageForDisplay", {
    quotaLabel, QUOTA_DISPLAY_ORDER: order,
  }) };
}

test("quota tag identity survives a rolling reset timestamp", () => {
  const quotaTagKey = compileFunction("quotaTagKey", { quotaLabel });
  assert.equal(
    quotaTagKey({ label: "5h", resetAt: "2026-09-19T16:00:00Z" }),
    quotaTagKey({ label: "5h", resetAt: "2026-09-19T17:00:00Z" }),
  );
});

test("quota display selection is independent of provider array order", () => {
  const { order, compareQuotaUsageForDisplay } = quotaDisplayFixture();
  const quotas = order.map((label) => ({ label }));
  const visible = (value) => value.sort(compareQuotaUsageForDisplay).slice(0, 3).map(quotaLabel);
  assert.deepEqual(visible([...quotas]), ["5h", "1w", "2h"]);
  assert.deepEqual(visible([...quotas].reverse()), ["5h", "1w", "2h"]);
});

test("duplicate label and window forms cannot produce duplicate React keys", () => {
  const quotaTagKey = compileFunction("quotaTagKey", { quotaLabel });
  const dedupeQuotaUsagesByLabel = compileFunction("dedupeQuotaUsagesByLabel", { quotaLabel });
  const quotas = dedupeQuotaUsagesByLabel([
    { label: "5h", resetAt: "2026-09-19T16:00:00Z" },
    { window: "5h", resetAt: "2026-09-19T17:00:00Z" },
    { label: "1w" },
  ]);
  const keys = quotas.map(quotaTagKey);
  assert.deepEqual(keys, ["quota:5h", "quota:1w"]);
  assert.equal(new Set(keys).size, keys.length);
});

test("duplicate quota values resolve identically when provider order changes", () => {
  const { compareQuotaUsageForDisplay } = quotaDisplayFixture();
  const dedupeQuotaUsagesByLabel = compileFunction("dedupeQuotaUsagesByLabel", { quotaLabel });
  const quotas = [
    { label: "5h", percent: 52, resetAt: "2026-09-19T16:00:00Z" },
    { window: "5h", percent: 68, resetAt: "2026-09-19T17:00:00Z" },
  ];
  const selectedPercent = (value) =>
    dedupeQuotaUsagesByLabel(value.sort(compareQuotaUsageForDisplay))[0].percent;
  assert.equal(selectedPercent([...quotas]), 68);
  assert.equal(selectedPercent([...quotas].reverse()), 68);

  const sameReset = quotas.map((quota) => ({ ...quota, resetAt: "2026-09-19T17:00:00Z" }));
  assert.equal(selectedPercent([...sameReset]), 68);
  assert.equal(selectedPercent([...sameReset].reverse()), 68);
});

test("an authoritative unnamed hold shows quota exhaustion without inventing a window", () => {
  const normalizeQuotaUsageList = compileFunction("normalizeQuotaUsageList", {
    quotaPercent: compileFunction("quotaPercent"), quotaResetHasPassed: () => false,
    isCodexQuotaUsage: () => false, quotaLabel, compareQuotaUsageForDisplay: () => 0,
    dedupeQuotaUsagesByLabel: compileFunction("dedupeQuotaUsagesByLabel", { quotaLabel }),
  });
  const providerQuotaUsages = compileFunction("providerQuotaUsages", { normalizeQuotaUsageList });
  const tagsFromUsage = compileFunction("tagsFromUsage", { providerQuotaUsages,
    usageContextPercent: compileFunction("usageContextPercent") });
  const accountQuotaUsage = compileFunction("accountQuotaUsage", { providerQuotaUsages });
  const usageLimitSummary = compileFunction("usageLimitSummary");
  const held = { quotaState: "exhausted", quotaSource: "provider_api",
    quotaObservedAt: "2026-10-03T21:01:00Z", quotaUsages: [{ percent: 100 }] };
  assert.deepEqual(providerQuotaUsages(held), [], "the hold does not acquire a 5h or weekly name");
  assert.equal(tagsFromUsage(held)[0].label, "Quota exhausted");
  assert.equal(usageLimitSummary(accountQuotaUsage(held)).severity, "limit");
  assert.deepEqual(tagsFromUsage({ ...held, quotaState: undefined }), [], "raw unnamed percentages cannot invent exhaustion authority");
});

test("the provider's verdict on the account decides whether a used-up window is a limit", () => {
  const quotaPercent = (quota) => quota.percent;
  const quotaAtLimit = compileFunction("quotaAtLimit");
  const usageLimitSummary = compileFunction("usageLimitSummary", {
    providerQuotaUsages: (usage) => usage?.quotaUsages ?? [], quotaPercent, quotaResetHasPassed: () => false,
    quotaResetLabel: (quota) => quota.resetAt, quotaLabel: (quota) => quota.label,
    creditsNote: compileFunction("creditsNote", { formatCompactNumber: String }),
    quotaAtLimit, quotaTitle: (quota) => `${quota.label} - ${quota.percent}%`, formatPercent: (value) => `${value}%`,
    creditsTitle: compileFunction("creditsTitle", { formatCompactNumber: String }),
  });
  const week = { quotaSource: "provider_api", quotaUsages: [{ label: "1w", percent: 100 }] };
  assert.equal(usageLimitSummary(week).severity, "limit", "without a verdict a used-up window is a limit");
  assert.deepEqual(usageLimitSummary({ ...week, quotaAccount: { allowed: true, credits: { balance: 137.5 } } }),
    { label: "credits", severity: "warning", title: "On credits: 1w - 100% - 137.5 credits left",
      window: "1w", percent: 100, note: "137.5 credits", credits: true },
    "credits ride on the used-up window's tag");
  const fine = { quotaSource: "provider_api", quotaUsages: [{ label: "5h", percent: 20 }], quotaAccount: { allowed: false } };
  assert.equal(usageLimitSummary(fine).severity, "limit", "a refusal is a limit whatever the windows say");
  assert.equal(usageLimitSummary({ ...week, quotaUsages: [{ label: "1w", percent: 100, resetAt: "10/10 05:28" }] }).note,
    "10/10 05:28", "a limit tells its window's tag when it comes back");
  assert.equal(usageLimitSummary({ ...week, quotaAccount: { allowed: true, credits: { unlimited: true } } }).note, "credits");
});
