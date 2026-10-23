import assert from "node:assert/strict";
import test from "node:test";
import { countAuthMetricsIn, logAuthMetric } from "../src/auth-observability.ts";

test("every sign-in metric is also a diagnostics point, and a failing dataset never fails the sign-in", async (t) => {
  t.mock.method(console, "log", () => {});
  const points = [];
  countAuthMetricsIn({ writeDataPoint: (point) => points.push(point) });
  await logAuthMetric({ routeGroup: "app_sign_in_token", status: 200, outcome: "issued", authProvider: "better-auth", userId: "user-1" });
  await logAuthMetric({ routeGroup: "login_code_send", status: 429, outcome: "rate_limited" });
  assert.deepEqual(points.map(({ blobs }) => blobs), [
    ["auth", "better-auth", "app_sign_in_token", "issued", "200"],
    ["auth", "", "login_code_send", "rate_limited", "429"],
  ]);
  assert.match(points[0].indexes[0], /^[0-9a-f]{24}$/u, "a person is counted by a short hash, never by id");
  assert.deepEqual(points[1].indexes, ["auth"]);

  countAuthMetricsIn({ writeDataPoint: () => { throw new Error("dataset unavailable"); } });
  await logAuthMetric({ routeGroup: "device_start", status: 200, outcome: "created" });
  countAuthMetricsIn(undefined);
});
