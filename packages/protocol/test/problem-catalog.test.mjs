import assert from "node:assert/strict";
import test from "node:test";
import {
  HANDOFF_REFUSALS, REBORN_REFUSALS, STARTUP_FAILURES, startupFailureWords, LAUNCH_REJECTION_CAUSES_ZH, lifecycleRefusalCode, lifecycleRefusalRow,
  lifecycleRefusalText, lifecycleRefusalWords, launchRejectionCause,
} from "../dist/problem-catalog.js";
import { publicMachineStartupFailure } from "../dist/machine-startup-failure.js";
import { PREPARATION_REJECTION_MESSAGES, REGISTRATION_PREPARATION_REJECTION_CODES } from "../dist/invocation-failure.js";

const placeholders = (text) => [...text.matchAll(/\{([a-z]+)\}/gu)].map(match => match[1]);
const used = (words) => new Set([words.title, words.explanation, ...words.steps].flatMap(placeholders));
const LIFECYCLE_VALUES = new Set(["source", "successor", "other"]);

for (const [family, rows] of Object.entries({ handoff: HANDOFF_REFUSALS, reborn: REBORN_REFUSALS })) {
  test(`every ${family} row says the same thing in each language, with values it is given`, () => {
    for (const [code, row] of Object.entries(rows)) {
      assert.deepEqual(Object.keys(row).sort(), ["en", "zh"], code);
      assert.deepEqual([...used(row.zh)].sort(), [...used(row.en)].sort(), `${family}.${code} placeholders differ`);
      for (const name of used(row.en)) assert.ok(LIFECYCLE_VALUES.has(name), `${family}.${code} names {${name}}`);
      // The Web draws a note on the `@` its text names (command-notices.ts noticesNaming).
      assert.ok(used(row.en).has("source"), `${family}.${code} names the address it answers`);
      for (const words of Object.values(row)) {
        assert.ok(words.title.trim(), `${family}.${code} has a title`);
        assert.ok(words.steps.length > 0, `${family}.${code} says what to do next`);
        assert.doesNotMatch(JSON.stringify(words), /\b[a-z]+_[a-z_]+\b/u, `${family}.${code} shows no error code`);
      }
    }
  });
}

test("every launch rejection code the Hub can record has Chinese words, and no stray rows", () => {
  const codes = new Set([...Object.keys(PREPARATION_REJECTION_MESSAGES), ...REGISTRATION_PREPARATION_REJECTION_CODES]);
  for (const code of codes) assert.ok(Object.hasOwn(LAUNCH_REJECTION_CAUSES_ZH, code), `${code} has no Chinese cause`);
  for (const code of Object.keys(LAUNCH_REJECTION_CAUSES_ZH)) assert.ok(codes.has(code), `${code} is not a rejection code`);
  for (const [code, text] of Object.entries(LAUNCH_REJECTION_CAUSES_ZH)) {
    assert.match(text, /[一-鿿]/u, `${code} is Chinese`);
    assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/u, `${code} shows no error code`);
  }
  assert.equal(launchRejectionCause("registration_quota_exhausted", "zh"), LAUNCH_REJECTION_CAUSES_ZH.registration_quota_exhausted);
  assert.equal(launchRejectionCause("registration_quota_exhausted", "en"),
    PREPARATION_REJECTION_MESSAGES.registration_quota_exhausted.replace(/ No launch was allocated\.$/u, ""));
});

test("a refusal's Channel text is its English row with the code last", () => {
  const text = lifecycleRefusalText("handoff", "registration_quota_exhausted", { source: "@claude:1", successor: "@claude" });
  assert.match(text, /^@claude couldn't take over @claude:1: out of quota\. @claude:1 has stopped and its work is kept, .* send @claude:1:handoff:@auto\. .* \[registration_quota_exhausted\]$/u);
  assert.doesNotMatch(text, /\{[a-z]+\}/u, "every placeholder is filled");
  const zh = lifecycleRefusalWords("handoff", "registration_quota_exhausted", "zh", { source: "@claude:1", successor: "@claude" });
  assert.equal(zh.title, "@claude 额度用完了，没能接手 @claude:1");
  assert.match(lifecycleRefusalWords("handoff", "registration_quota_exhausted", "en", { source: "@a:1", successor: "@auto" }).steps[0],
    /@a:1:handoff:@<agent>/u, "a failed @auto is not offered @auto again");
});

test("codes without their own row read from their family's", () => {
  assert.equal(lifecycleRefusalRow("handoff", "registration_harness_unavailable"), HANDOFF_REFUSALS.no_machine);
  assert.equal(lifecycleRefusalRow("handoff", "registration_model_unavailable"), HANDOFF_REFUSALS.launch_failed);
  assert.equal(lifecycleRefusalRow("handoff", "something_new"), HANDOFF_REFUSALS.registration_handoff_failed);
  assert.equal(lifecycleRefusalRow("reborn", "something_new"), REBORN_REFUSALS.registration_reborn_failed);
});

test("a note's code is recorded beside it, or read from the fixed sentence older notes used", () => {
  assert.equal(lifecycleRefusalCode({ code: "registration_quota_exhausted", body: "…" }), "registration_quota_exhausted");
  assert.equal(lifecycleRefusalCode({ body: "xMatrix could not hand off @claude:1 to @claude (registration_quota_exhausted)." }),
    "registration_quota_exhausted");
  assert.equal(lifecycleRefusalCode({ body: "Reborn failed [registration_daemon_offline] for @codex:2. No recovery was queued." }),
    "registration_daemon_offline");
  assert.equal(lifecycleRefusalCode({ body: "xMatrix could not find @codex:2 to reborn." }), "lifecycle_source_not_found");
  assert.equal(lifecycleRefusalCode({ body: "xMatrix refused an invalid handoff source for @codex:2." }), "lifecycle_source_invalid");
  assert.equal(lifecycleRefusalCode({ body: "Something else (registration_quota_exhausted)." }), undefined);
});

test("every startup failure code the classifier answers with has a row in both languages", () => {
  const samples = ["something odd happened", "repository_access_unavailable: no", "machine_not_answering: no",
    "harness_missing: codex", "harness_session_in_use: held", "base_ref_unresolved", "No space left on device",
    "fetch_required_failed", "git fetch timed out", "remote repository x is not accessible"];
  const codes = new Set([...samples.map(sample => publicMachineStartupFailure(sample).code), "machine_unavailable"]);
  assert.equal(codes.size, 11, "each sample reaches its own code");
  for (const code of codes) assert.ok(Object.hasOwn(STARTUP_FAILURES, code), `${code} has no row`);
  for (const [code, row] of Object.entries(STARTUP_FAILURES)) {
    assert.ok(codes.has(code), `${code} is not a startup failure code`);
    assert.deepEqual([...used(row.zh)].sort(), [...used(row.en)].sort(), `${code} placeholders differ`);
    for (const name of used(row.en)) assert.ok(["agent", "machine"].includes(name), `${code} names {${name}}`);
    for (const words of Object.values(row)) assert.doesNotMatch(JSON.stringify(words), /\b[a-z]+_[a-z_]+\b/u, `${code} shows no code`);
  }
  assert.equal(startupFailureWords("machine_disk_full", "zh", { agent: "@codex", machine: "mac-mini" }).title, "mac-mini 磁盘满了");
  assert.equal(startupFailureWords("brand_new", "en", { agent: "@codex" }).title, "@codex couldn't start on its computer");
});
