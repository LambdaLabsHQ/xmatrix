import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import * as deliveryProof from "../src/connectors/delivery-proof.ts";
import * as protocol from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const catalog = await compileCommonJsSourceModule(new URL("../src/github-catalog-events.ts", import.meta.url));
const routes = await compileCommonJsSourceModule(new URL("../src/index-routes-auth-space-management.ts", import.meta.url));

test("only signed catalog-changing GitHub events invalidate linked Spaces and publish content-free refreshes", async () => {
  const invalidations = [], notices = [];
  const changed = catalog(name => ({
    "@xmatrix/protocol": protocol,
    "./apps": { appRepository: () => ({ invalidateGitHubRepositoryCatalog: async input => {
      invalidations.push(input); return ["space-a", "space-b"];
    } }) },
    "./workspace-resource-notification": { notifyWorkspaceResource: async (_env, input) => notices.push(input) },
  })[name] ?? {});
  const app = new Hono();
  routes(name => ({
    "./connectors/delivery-proof": deliveryProof,
    "./github-catalog-events": changed,
    "./automation-triggers": { fireGitHubAutomationTriggers: async () => {} },
    "./product-github-webhook-authority-adapter": { dispatchProductGitHubWebhook: async () => ({ ok: true }) },
  })[name] ?? {}).registerIndexRoutesAuthSpaceManagement(app);
  const request = (event, payload, signature = true) => {
    const body = JSON.stringify(payload);
    return app.request("/api/apps/github/webhook", { method: "POST", body, headers: {
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature ? createHmac("sha256", "test-secret").update(body).digest("hex") : "invalid"}`,
    } }, { GITHUB_WEBHOOK_SECRET: "test-secret" });
  };
  assert.equal((await request("installation_repositories", { installation: { id: 777 } }, false)).status, 401);
  assert.equal(invalidations.length, 0);
  for (const event of ["installation", "installation_repositories", "repository", "push", "member", "membership", "organization"]) {
    assert.equal((await request(event, { installation: { id: 777 }, repository: { name: "private-name" } })).status, 200);
    assert.equal(invalidations.at(-1).installationId, "777");
    assert.equal(invalidations.at(-1).limit, 1000);
    assert.deepEqual(notices.at(-1), { spaceIds: ["space-a", "space-b"], resource: "launch_targets" });
  }
  const count = invalidations.length;
  for (const [event, payload] of [["issues", { installation: { id: 777 } }], ["repository", {}],
    ["repository", { installation: { id: "../../other-space" } }]]) {
    assert.equal((await request(event, payload)).status, 200);
  }
  assert.equal(invalidations.length, count);
  assert.equal(notices.length, count);
});
