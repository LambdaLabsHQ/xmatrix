import { test } from "node:test";
import assert from "node:assert/strict";
import { withOwnerWorker } from "./owner-worker.mjs";

const mailLink = (call, options = {}) => call("/api/setup-link-email", { method: "POST", body: {}, ...options });

test("a person mails the setup link to their own address, a couple of times a minute", () =>
  withOwnerWorker("Owner", async ({ call }) => {
    assert.equal((await mailLink(call, { anonymous: true })).status, 401);

    // The test Worker has no email binding, so delivery names what is missing.
    const first = await mailLink(call);
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.code, "email_delivery_configuration_error");
    assert.equal((await mailLink(call)).status, 503);

    const third = await mailLink(call);
    assert.equal(third.status, 429, JSON.stringify(third.body));
  }));
