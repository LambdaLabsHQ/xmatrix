const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { verifyBetterAuthOtpWithRetry, isTransientAuthSessionError } = require("./auth-client.ts");

// Exercise the real Better Auth client and retry/recovery boundary. HTTP alone
// supplies the observed account; the test does not implement recovery policy.
function signInService(t, { attempts, email, sessionStatus = 200 }) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname;
    requests.push(path);
    if (path.endsWith("/sign-in/email-otp")) {
      const status = attempts.shift();
      assert.ok(status, "no extra verification request");
      return Response.json(status === 200 ? {} : { message: "Code refused", code: "INVALID_OTP" }, { status });
    }
    if (path.endsWith("/get-session")) return Response.json(email
      ? { user: { id: "observed-user", email }, session: { token: "session" } } : null, { status: sessionStatus });
    if (path.endsWith("/token")) return Response.json({ token: "jwt" });
    assert.fail(`Unexpected account request: ${path}`);
  });
  return requests;
}

for (const terminal of ["refused", "unanswered"]) {
  test(`OTP recovery after ${terminal} retries requires the requested account`, async (t) => {
    for (const email of ["alice@example.com", "bob@example.com", undefined]) {
      await t.test(email ?? "no session", async (t) => {
        signInService(t, { attempts: terminal === "refused" ? [503, 400] : [503, 503, 503], email });
        const result = verifyBetterAuthOtpWithRetry(" Alice@Example.com ", "123456");
        if (email === "alice@example.com") assert.equal(await result, "signed_in");
        else await assert.rejects(result, terminal === "refused"
          ? (error) => error.code === "INVALID_OTP" : isTransientAuthSessionError);
      });
    }
  });
}

test("a refused first attempt is not recovered by an existing session", async (t) => {
  const requests = signInService(t, { attempts: [400], email: "alice@example.com" });
  await assert.rejects(verifyBetterAuthOtpWithRetry("alice@example.com", "123456"),
    (error) => error.code === "INVALID_OTP");
  assert.equal(requests.some((path) => path.endsWith("/get-session")), false);
});

test("unavailable session evidence preserves the verification refusal", async (t) => {
  signInService(t, { attempts: [503, 400], sessionStatus: 503 });
  await assert.rejects(verifyBetterAuthOtpWithRetry("alice@example.com", "123456"),
    (error) => error.code === "INVALID_OTP");
});
