import assert from "node:assert/strict";
import test from "node:test";
import { configureReleaseStorage, RELEASE_STORAGE } from "./configure-release-storage.mjs";

test("release storage bootstrap creates missing buckets and verifies exact retention rules", async () => {
  const requests = [];
  const configured = new Map();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    const pathname = parsed.pathname.replace("/client/v4/accounts/account/r2", "");
    requests.push({
      method,
      pathname,
      body: options.body ? JSON.parse(options.body) : null,
    });
    let result;
    if (pathname === "/buckets" && method === "POST") result = options.body ? JSON.parse(options.body) : null;
    else if (pathname === "/buckets" && method === "GET") result = { buckets: [] };
    else if (method === "PUT") {
      configured.set(pathname, JSON.parse(options.body));
      result = {};
    } else result = configured.get(pathname);
    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await configureReleaseStorage({
    accountId: "account",
    token: "token",
    fetchImpl,
  });
  assert.equal(requests.filter((request) => request.method === "POST").length, 2);
  assert.equal(requests.filter((request) => request.method === "PUT").length, 4);
  assert.deepEqual(
    configured.get("/buckets/xmatrix-release-assets/lock"),
    RELEASE_STORAGE["xmatrix-release-assets"].lock
  );
  assert.equal(
    RELEASE_STORAGE["xmatrix-release-receipts"].lifecycle.rules[0].deleteObjectsTransition.condition.maxAge,
    90 * 24 * 60 * 60
  );
});
