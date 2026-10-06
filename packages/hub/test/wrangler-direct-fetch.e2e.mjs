import assert from "node:assert/strict";
import { test } from "node:test";
import { startHubWorker } from "./e2e-utils.mjs";

for (const directLocalFetch of [false, true]) {
  test(`local fetch preserves request semantics (direct=${directLocalFetch})`, async () => {
    const worker = await startHubWorker({
      entrypoint: "test/fixtures/local-proxy-echo.ts",
      config: "test/fixtures/local-proxy-echo.toml",
      experimental: { directLocalFetch },
    });
    try {
      for (let count = 1; count <= 2; count++) {
        const body = `message ${count}: 中文`;
        const response = await worker.fetch("https://fixture.example/echo?limit=20", {
          method: "POST", body, headers: { "x-repro-probe": "preserved" },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          body, path: "/echo", search: "?limit=20", method: "POST",
          probe: "preserved", count,
        });
      }
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(worker.fetch("/echo", {
        method: "POST", body: "must not arrive", signal: controller.signal,
      }), { name: "AbortError" });
      const final = await (await worker.fetch("/echo")).json();
      assert.equal(final.count, 3, "aborted writes must not be sent or replayed");
    } finally {
      await worker.stop();
    }
  });
}
