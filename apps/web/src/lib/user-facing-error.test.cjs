const assert = require("node:assert/strict");
const test = require("node:test");

require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { XMatrixApiError, unexpectedResponse } = require("./query/api-client.ts");
const { UserFacingProblem, describeError, userErrorMessage } = require("./user-facing-error.ts");

const action = "Couldn't load transfer proposals";
const api = (input) => new XMatrixApiError({ message: "Request failed (500)", status: 500, ...input });

test("a request its caller cancelled is not a failure to show", () => {
  assert.equal(describeError(new DOMException("signal is aborted without reason", "AbortError"), action), null);
  assert.equal(describeError(Object.assign(new Error("x"), { name: "CancelledError" }), action), null);
  assert.equal(describeError(null, action), null);
  assert.equal(userErrorMessage(undefined, action), null);
});

test("browser and runtime errors never reach the screen", (t) => {
  t.mock.method(console, "error", () => {});
  for (const raw of [new TypeError("Failed to fetch"), new SyntaxError("Unexpected token '<'"), new Error("Invalid invocation page")]) {
    const shown = describeError(raw, action);
    assert.doesNotMatch(shown.message, new RegExp(raw.message.replace(/[()']/g, ".")));
    assert.equal(shown.message, "Couldn't load transfer proposals. Something went wrong. Try again, and report it if it keeps happening.");
  }
});

test("transient failures say what to do and can be retried", () => {
  assert.deepEqual(describeError(api({ status: 0, code: "network_error", message: "Failed to fetch", retryable: true }), action), {
    message: "Couldn't load transfer proposals. Check your connection and try again.", retryable: true, reference: "network_error",
  });
  const busy = describeError(api({ status: 503, code: "postgres_unavailable", message: "xMatrix is briefly unavailable; try again", retryable: true }), action);
  assert.equal(busy.message, "Couldn't load transfer proposals. xMatrix is busy right now. Try again in a moment.");
  assert.equal(busy.retryable, true);
  assert.match(describeError(api({ status: 504, message: "xMatrix hub did not respond in time." }), action).message, /took too long/);
  assert.match(describeError(new DOMException("Request exceeded its deadline", "TimeoutError"), action).message, /took too long/);
});

test("generic Hub rejections are told by category, not by their developer wording", () => {
  assert.equal(describeError(api({ status: 409, code: "conflict", message: "membership version conflict" }), action).message,
    "Couldn't load transfer proposals. It changed in the meantime. Refresh and try again.");
  assert.equal(describeError(api({ status: 403, code: "forbidden", message: "Instance owner mismatch" }), action).message,
    "Couldn't load transfer proposals. You don't have permission to do this.");
  assert.equal(describeError(api({ status: 404, code: "not_found", message: "runtime entity not found" }), action).message,
    "Couldn't load transfer proposals. It may have been deleted, or you no longer have access.");
  assert.equal(describeError(api({ status: 401, message: "Invalid or expired auth token" }), action).message,
    "Couldn't load transfer proposals. Your session has ended. Sign in again.");
  assert.equal(describeError(api({ status: 500, code: "internal_error", message: "Internal error" }), action).reference, "internal_error");
});

test("a specific Hub rejection keeps its own reason; a bare code does not", () => {
  assert.equal(describeError(api({ status: 409, code: "space_exists", message: "space id already exists" }), action).message,
    "Couldn't load transfer proposals. Space id already exists.");
  assert.equal(describeError(api({ status: 403, code: "page_edit_forbidden", message: "page_edit_forbidden" }), action).message,
    "Couldn't load transfer proposals. You don't have permission to do this.");
});

test("client sentences and desktop refusals are shown as written", () => {
  assert.deepEqual(describeError(new UserFacingProblem("Sign in before inviting members"), "Couldn't send the invite"), {
    message: "Couldn't send the invite. Sign in before inviting members.", retryable: false,
  });
  assert.equal(describeError(new Error("Error invoking remote method 'desktop:add-workspace': Error: Workspace path is not a directory"),
    "Couldn't add the folder").message, "Couldn't add the folder. Workspace path is not a directory.");
});

test("a response missing what it promised is a reported defect", () => {
  const shown = describeError(unexpectedResponse("The Automation"), "Couldn't update the Automation");
  assert.equal(shown.reference, "unexpected_response");
  assert.match(shown.message, /Something went wrong on our side/);
});

test("a transient failure the retry policy gave up on says it is no longer passing", () => {
  const { shouldRetryXMatrixQuery } = require("./query/api-client.ts");
  const outage = api({ status: 503, code: "postgres_unavailable", message: "x", retryable: true });
  assert.equal(shouldRetryXMatrixQuery(0, outage), true);
  assert.equal(shouldRetryXMatrixQuery(2, outage), false);
  assert.match(describeError(outage, action).message, /still unavailable after several tries/);
  const offline = api({ status: 0, code: "network_error", message: "Failed to fetch", retryable: true });
  shouldRetryXMatrixQuery(2, offline);
  assert.match(describeError(offline, action).message, /still can't be reached/);
});

test("an internal failure carries the Hub's report so a person can quote it", async () => {
  const { errorFromResponse } = require("./query/api-client.ts");
  const failure = await errorFromResponse(Response.json(
    { error: "Internal error", code: "internal_error", retryable: false, reference: "0123456789abcdef0123456789abcdef" },
    { status: 500 }));
  assert.deepEqual(describeError(failure, action), {
    message: "Couldn't load transfer proposals. Something went wrong on our side. Try again, and report it if it keeps happening.",
    retryable: true, reference: "internal_error", report: "0123456789abcdef0123456789abcdef",
  });
});

test("a browser defect report keeps the message shape but not what it quoted", () => {
  const { redactDefectMessage } = require("./client-defect-report.ts");
  assert.equal(redactDefectMessage(`Unexpected token 'h', "hello secret" is not valid JSON`),
    "Unexpected token '…', \"…\" is not valid JSON");
});
