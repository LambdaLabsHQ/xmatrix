const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  evaluateExtractedSource,
  extractFunctionSource,
  loadWorkspaceShellModuleMap,
  extractFunctionFromShellModules,
} = require("./workspace-shell-source-fixture.cjs");


const protocolSource = fs.readFileSync(
  path.join(__dirname, "../../../../../packages/protocol/src/authority-runtime.ts"),
  "utf8",
);
const parseQuotaObservedAtSource = extractFunctionSource(protocolSource, "parseQuotaObservedAt", {
  fileName: "authority-runtime.ts",
});
const parseLlmQuotaAccountSource = extractFunctionSource(protocolSource, "parseLlmQuotaAccount", {
  fileName: "authority-runtime.ts",
});

test("a provider read time is a short parseable timestamp", () => {
  const { parseQuotaObservedAt } = evaluateExtractedSource(`${parseQuotaObservedAtSource}\nexports.parseQuotaObservedAt = parseQuotaObservedAt;`);
  assert.equal(parseQuotaObservedAt("2026-09-29T09:00:00.000Z"), "2026-09-29T09:00:00.000Z");
  assert.equal(parseQuotaObservedAt(`${"x".repeat(41)}`), undefined);
  assert.equal(parseQuotaObservedAt("not-a-time"), undefined);
  assert.equal(parseQuotaObservedAt(1), undefined);
});

test("an older quota sample does not replace a newer one", () => {
  const shell = loadWorkspaceShellModuleMap(__dirname);
  const merge = extractFunctionFromShellModules(shell, "mergeLlmUsagePreferringQuotas").source;
  const { mergeLlmUsagePreferringQuotas } = evaluateExtractedSource(`
    function hasQuotaMeterUsage(usage) {
      return usage?.quotaSource === "provider_api" && Array.isArray(usage.quotaUsages) && usage.quotaUsages.length > 0;
    }
    ${merge}
  `);
  const current = {
    inputTokens: 10,
    quotaSource: "provider_api",
    quotaObservedAt: "2026-09-29T10:00:00.000Z",
    quotaUsages: [{ label: "5h", percent: 20 }],
  };
  const older = {
    inputTokens: 11,
    quotaSource: "provider_api",
    quotaObservedAt: "2026-09-29T09:00:00.000Z",
    quotaUsages: [{ label: "5h", percent: 90 }],
  };
  const kept = mergeLlmUsagePreferringQuotas(current, older);
  assert.equal(kept.quotaObservedAt, current.quotaObservedAt);
  assert.equal(kept.quotaUsages[0].percent, 20);
  assert.equal(kept.inputTokens, 11);

  const newer = { ...older, quotaObservedAt: "2026-09-29T11:00:00.000Z" };
  const replaced = mergeLlmUsagePreferringQuotas(current, newer);
  assert.equal(replaced.quotaObservedAt, newer.quotaObservedAt);
  assert.equal(replaced.quotaUsages[0].percent, 90);
});

test("token usage does not keep a quota observation time", () => {
  const shell = loadWorkspaceShellModuleMap(__dirname);
  const source = extractFunctionFromShellModules(shell, "usageWithoutQuota").source;
  const { usageWithoutQuota } = evaluateExtractedSource(`${source}\nexports.usageWithoutQuota = usageWithoutQuota;`);
  assert.deepEqual(usageWithoutQuota({
    inputTokens: 3,
    quotaSource: "provider_api",
    quotaObservedAt: "2026-09-29T10:00:00.000Z",
    quotaUsages: [{ label: "5h", percent: 1 }],
  }), { inputTokens: 3 });
});

test("trace usage keeps the provider read time", () => {
  const shell = loadWorkspaceShellModuleMap(__dirname);
  const names = [
    "normalizeLlmUsage",
    "normalizeLlmQuotaUsages",
    "collectLlmQuotaUsages",
    "normalizeLlmQuotaUsage",
    "numericUsage",
    "stringUsage",
    "temporalUsage",
  ];
  const source = [
    parseQuotaObservedAtSource,
    parseLlmQuotaAccountSource,
    ...names.map((name) => extractFunctionFromShellModules(shell, name).source),
  ].join("\n\n");
  const { normalizeLlmUsage } = evaluateExtractedSource(source);
  const usage = normalizeLlmUsage({
    input_tokens: 4,
    quota_observed_at: "2026-09-29T10:00:00.000Z",
  });
  assert.equal(usage.inputTokens, 4);
  assert.equal(usage.quotaObservedAt, "2026-09-29T10:00:00.000Z");
  assert.equal(normalizeLlmUsage({ quotaObservedAt: "not-a-time" }).quotaObservedAt, undefined);
  assert.deepEqual(normalizeLlmUsage({ quotaAccount: { allowed: true, credits: { balance: 3, extra: 1 } } }).quotaAccount,
    { allowed: true, credits: { balance: 3 } });
});
