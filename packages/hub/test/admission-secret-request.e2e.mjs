import assert from "node:assert/strict";
import test from "node:test";
import { programFixture } from "../../db/test/space-admission-policy-postgres.fixture.mjs";
import { admitSecretUse, secretAdmission } from "../src/index-routes-secrets.ts";

const integration = process.env.XMATRIX_TEST_POSTGRES_URL || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true" ? test : test.skip;

/** The policy the Space adopts: the patrol's Run reads the database secret, a retired one is refused, the rest ask. */
const policy = (page) => `pub let admit = (req: Admission.request) =>
  switch req.work {
  | Some(w) if req.what == "secret.use" && req.target == "database-read" && w.program == "${page}/patrol" => Allow
  | _ => if req.target == "retired-key" { Deny("PROD key is not saved for patrol") } else { AlsoAsk(@alice) }
  }`;

integration("a Run working for the Page program reads the secret with no card; any other Run gets the card", async () => {
  const f = await programFixture();
  try {
    for (const secretRef of ["database-read", "retired-key", "other-key"]) {
      await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef, value: `${secretRef}-value` });
    }
    // No policy adopted: every request gets its card.
    assert.equal(await admitSecretUse(f.secret, f.run, "database-read"), "card");

    await f.adopt(policy(f.page));
    // The Run holds no request of the program yet.
    assert.equal(await admitSecretUse(f.secret, f.run, "database-read"), "card");
    await assert.rejects(f.secret.runRead(f.run, ["database-read"]), (error) => error.code === "secret_approval_required");

    // Now it executes the program's delivery.
    await f.execution(f.delivery, "running");
    assert.equal(await admitSecretUse(f.secret, f.run, "database-read"), "readable");
    assert.deepEqual((await f.secret.runRead(f.run, ["database-read"])).secrets.map((secret) => secret.value), ["database-read-value"]);
    // Another secret is not the program's to have: AlsoAsk is the card.
    assert.equal(await admitSecretUse(f.secret, f.run, "other-key"), "card");
    await assert.rejects(f.secret.runRead(f.run, ["other-key"]), (error) => error.code === "secret_approval_required");

    // Deny refuses at once, in words a waiting CLI does not take for "still open".
    await assert.rejects(admitSecretUse(f.secret, f.run, "retired-key"), (error) =>
      error.code === "secret_request_refused" && error.status === 403 &&
      !/is not saved|not configured for this Agent/u.test(error.message));
  } finally { await f.close(); }
});

integration("an adopted text that no longer decides leaves every request to its card", async () => {
  const f = await programFixture();
  try {
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "database-read", value: "v" });
    await f.adopt("pub let admit = (req: Admission.request) => NoLongerAWord");
    await f.execution(f.delivery, "running");
    assert.equal(await admitSecretUse(f.secret, f.run, "database-read"), "card");
    await assert.rejects(f.secret.runRead(f.run, ["database-read"]), (error) => error.code === "secret_approval_required");
  } finally { await f.close(); }
});

integration("what the store says about the Run or the secret stands; only a passing failure falls back to the card", async () => {
  const f = await programFixture();
  try {
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "database-read", value: "v" });
    await f.adopt(policy(f.page));
    await f.execution(f.delivery, "running");
    // The policy's refusal and a Run that stopped: each is the answer, and no card follows.
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "retired-key", value: "v" });
    await assert.rejects(secretAdmission(f.secret, f.run, "retired-key"), (error) => error.code === "secret_request_refused");
    await f.client.query("UPDATE data.runs SET status='stopped' WHERE run_id=$1", [f.ids.run]);
    await assert.rejects(secretAdmission(f.secret, f.run, "database-read"), (error) => error.code === "request_context_unavailable");
    // A store that cannot be reached is not a refusal.
    const unreachable = { runAdmission: async () => { throw new Error("connection lost"); } };
    assert.equal(await secretAdmission(unreachable, f.run, "database-read"), "card");
  } finally { await f.close(); }
});
