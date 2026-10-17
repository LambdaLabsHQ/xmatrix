import assert from "node:assert/strict";
import test from "node:test";
import { appSignInCallback, appSignInRedirectUri, isPkceChallenge, pkceVerifierMatches } from "../src/app-sign-in.ts";

test("an app's code goes back only to its own scheme or a loopback port", () => {
  for (const accepted of ["xmatrix://auth", "http://127.0.0.1:53682/callback", "http://[::1]:5000/callback"]) {
    assert.ok(appSignInRedirectUri(accepted), accepted);
  }
  for (const refused of [undefined, "", "xmatrix://auth/other", "xmatrix://login", "https://127.0.0.1:53682/callback",
    "http://localhost:53682/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:53682/other",
    "http://127.0.0.1:53682/callback?next=x", "http://user@127.0.0.1:53682/callback", "https://evil.example/callback"]) {
    assert.equal(appSignInRedirectUri(refused), null, String(refused));
  }
});

test("PKCE S256: the RFC 7636 verifier matches its challenge, any other does not", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.ok(isPkceChallenge(challenge));
  assert.equal(await pkceVerifierMatches(verifier, challenge), true);
  assert.equal(await pkceVerifierMatches(`${verifier.slice(0, -1)}A`, challenge), false);
  assert.equal(await pkceVerifierMatches("short", challenge), false);
});

test("the app's callback carries its code or the refusal, and always its own state", () => {
  assert.equal(appSignInCallback("xmatrix://auth", "state-0123456789ab", { code: "c0de" }),
    "xmatrix://auth?code=c0de&state=state-0123456789ab");
  assert.equal(appSignInCallback("http://127.0.0.1:53682/callback", "state-0123456789ab", { error: "access_denied" }),
    "http://127.0.0.1:53682/callback?error=access_denied&state=state-0123456789ab");
});
