import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  DIAGNOSTICS_CONSENT_FRESH_MS,
  diagnosticsDecision,
  diagnosticsRegimeForCountry,
  parseDiagnosticsConsentState,
} = await loadTypescriptModule(new URL("../src/diagnostics-consent.ts", import.meta.url));

test("EU, EEA, UK and Swiss countries, and an unknown country, require consent; others are default-ok", () => {
  for (const country of ["DE", "fr", "IE", "IS", "LI", "NO", "GB", "CH", "RE", "AX", "JE"]) {
    assert.equal(diagnosticsRegimeForCountry(country), "consent-required", country);
  }
  for (const country of [undefined, null, "", "XX", "T1", "d", "DEU"]) {
    assert.equal(diagnosticsRegimeForCountry(country), "consent-required", String(country));
  }
  for (const country of ["US", "CN", "JP", "BR", "IN", "TR", "UA", "RS", "AU", "CA"]) {
    assert.equal(diagnosticsRegimeForCountry(country), "default-ok", country);
  }
});

const SEND = { send: true, prompt: "none" };
const OFF = { send: false, prompt: "none" };
const NOTICE = { send: true, prompt: "notice" };
const OPT_IN = { send: false, prompt: "opt-in" };

test("the default matrix: build × signup regime × request regime × explicit choice × privacy signal", () => {
  const regimes = ["default-ok", "consent-required"];
  for (const build of ["beta", "stable"]) {
    for (const accountRegime of regimes) {
      for (const requestRegime of regimes) {
        for (const choice of [null, "opted-in", "opted-out"]) {
          for (const privacySignal of [false, true]) {
            const decision = diagnosticsDecision({
              build, consent: { accountRegime, requestRegime, choice }, consentAgeMs: 0, privacySignal,
            });
            let expected;
            if (choice === "opted-in") expected = SEND;
            else if (choice === "opted-out" || privacySignal || build === "stable") expected = OFF;
            else if (accountRegime === "default-ok" && requestRegime === "default-ok") expected = NOTICE;
            else expected = OPT_IN;
            assert.deepEqual(decision, expected,
              JSON.stringify({ build, accountRegime, requestRegime, choice, privacySignal }));
          }
        }
      }
    }
  }
});

test("the stricter regime wins: a default-ok account visiting a consent-required country is asked, not counted", () => {
  assert.deepEqual(diagnosticsDecision({ build: "beta", privacySignal: false,
    consentAgeMs: 0, consent: { accountRegime: "default-ok", requestRegime: "consent-required", choice: null } }), OPT_IN);
  assert.deepEqual(diagnosticsDecision({ build: "beta", privacySignal: false,
    consentAgeMs: 0, consent: { accountRegime: "consent-required", requestRegime: "default-ok", choice: null } }), OPT_IN);
});

test("a failed, timed-out or stale region lookup sends nothing, even for a default-ok signup or an opt-in", () => {
  const defaultOk = { accountRegime: "default-ok", requestRegime: "default-ok", choice: null };
  const optedIn = { ...defaultOk, choice: "opted-in" };
  for (const consent of [defaultOk, optedIn]) {
    assert.deepEqual(diagnosticsDecision({ build: "beta", consent: null, consentAgeMs: 0, privacySignal: false }), OFF);
    assert.deepEqual(diagnosticsDecision({ build: "beta", consent, consentAgeMs: DIAGNOSTICS_CONSENT_FRESH_MS + 1,
      privacySignal: false }), OFF);
    assert.equal(diagnosticsDecision({ build: "beta", consent, consentAgeMs: DIAGNOSTICS_CONSENT_FRESH_MS,
      privacySignal: false }).send, true);
  }
  // A request with no country code is consent-required, never the signup regime.
  assert.equal(diagnosticsRegimeForCountry(undefined), "consent-required");
});

test("a Hub answer parses only with known regimes; an unknown choice is no choice", () => {
  assert.deepEqual(parseDiagnosticsConsentState({ accountRegime: "default-ok", requestRegime: "consent-required",
    choice: "opted-in" }), { accountRegime: "default-ok", requestRegime: "consent-required", choice: "opted-in" });
  assert.deepEqual(parseDiagnosticsConsentState({ accountRegime: "default-ok", requestRegime: "default-ok",
    choice: "maybe" }), { accountRegime: "default-ok", requestRegime: "default-ok", choice: null });
  assert.equal(parseDiagnosticsConsentState({ accountRegime: "on", requestRegime: "default-ok" }), null);
  assert.equal(parseDiagnosticsConsentState(null), null);
});
