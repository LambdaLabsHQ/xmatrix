import assert from "node:assert/strict";
import { test } from "node:test";
import { onboardingLocale } from "../dist/index.js";

test("any zh tag gets Chinese onboarding; everything else stays English", () => {
  for (const tag of ["zh", "zh-CN", "zh-Hans-CN", "zh-TW", "ZH-hk", "zh_CN", " zh-CN "]) assert.equal(onboardingLocale(tag), "zh", tag);
  for (const tag of [undefined, null, "", "en-US", "ja", "zha", "x-zh"]) assert.equal(onboardingLocale(tag), "en", String(tag));
});
