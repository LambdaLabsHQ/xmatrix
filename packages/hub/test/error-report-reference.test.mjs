import assert from "node:assert/strict";
import test from "node:test";

import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { requestErrorResponse } from "../src/index-shared.ts";
import { captureErrorReports } from "./support/error-reports.mjs";

test("an internal failure quotes its report, and the report says what the route was doing", async (t) => {
  const envelopes = captureErrorReports(t);
  const { Hono } = await import("hono");
  const app = new Hono();
  app.get("/api/spaces/:spaceId/channels/:channelId", (c) => requestErrorResponse(c, new Error("relation missing")));

  const response = await app.request("/api/spaces/space-1/channels/channel-1?body=secret");
  const body = await response.json();
  await sendErrorReports();

  assert.equal(response.status, 500);
  assert.equal(body.code, "internal_error");
  assert.match(body.reference, /^[0-9a-f]{32}$/u);
  const report = envelopes.join("\n");
  assert.match(report, new RegExp(`"event_id":"${body.reference}"`));
  assert.match(report, /"operation":"GET \/api\/spaces\/:spaceId\/channels\/:channelId"/u);
  assert.match(report, /"spaceId":"space-1"/u);
  assert.match(report, /"channelId":"channel-1"/u);
  assert.doesNotMatch(report, /secret/u);
});
