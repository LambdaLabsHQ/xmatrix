import assert from "node:assert/strict";
import test from "node:test";
import { githubRead } from "./github-read.mjs";

// The planner's existing transport test covers JSON/network/5xx recovery.
// These cases own binary-body recovery and refusal of unusable evidence.
test("an interrupted artifact body is retried and returned byte-for-byte", async (t) => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/owner/repo/actions/artifacts/7/zip");
    assert.ok(options.signal instanceof AbortSignal);
    calls += 1;
    return calls === 1 ? new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("terminated")); },
    })) : new Response(bytes);
  });
  assert.deepEqual(await githubRead("/repos/owner/repo/actions/artifacts/7/zip", "token", {
    binary: true, delayMs: 1,
  }), bytes);
  assert.equal(calls, 2);
});

test("client errors and invalid JSON are refused without retry", async (t) => {
  for (const status of [401, 403, 404, 429, 200]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response("invalid JSON", { status }));
    await assert.rejects(githubRead("/evidence", "token", { delayMs: 1 }),
      status === 200 ? /JSON/u : new RegExp(`: ${status}$`, "u"));
    assert.equal(fetch.mock.callCount(), 1, `status ${status}`);
    fetch.mock.restore();
  }
});

test("persistent server failure exhausts the attempt bound without evidence", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  await assert.rejects(githubRead("/evidence", "token", { attempts: 3, delayMs: 1 }), /: 503$/u);
  assert.equal(fetch.mock.callCount(), 3);
});
