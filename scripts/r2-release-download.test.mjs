import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { downloadObjectS3 } from "./r2-release-store.mjs";

async function downloadFixture(t, handler) {
  const root = await mkdtemp(path.join(tmpdir(), "xmatrix-s3-download-"));
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    bucket: "xmatrix-release-assets",
    key: "handoffs/desktop/123/1/macos/xMatrix.dmg",
    destination: path.join(root, "artifact.dmg"),
    timeoutMs: 2_000,
    configuration: {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
      maxAttempts: 1,
    },
  };
}

test("S3 release reads stream exact binary bytes from the requested bucket and key", async (t) => {
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  let target;
  const fixture = await downloadFixture(t, (request, response) => {
    target = new URL(request.url, "http://localhost").pathname;
    response.writeHead(200, { "Content-Length": bytes.length });
    response.write(bytes.subarray(0, 2));
    setImmediate(() => response.end(bytes.subarray(2)));
  });
  assert.equal(await downloadObjectS3(fixture), true);
  assert.equal(target, `/${fixture.bucket}/${fixture.key}`);
  assert.deepEqual(await readFile(fixture.destination), bytes);
});

test("S3 missing objects are optional only for an explicit NoSuchKey 404", async (t) => {
  for (const [code, status, missing] of [
    ["NoSuchKey", 404, true],
    ["NoSuchBucket", 404, false],
    ["AccessDenied", 403, false],
    ["NoSuchKey", 403, false],
  ]) {
    await t.test(`${code} ${status}`, async (t) => {
      const fixture = await downloadFixture(t, (_request, response) => {
        response.writeHead(status, { "Content-Type": "application/xml" });
        response.end(`<Error><Code>${code}</Code><Message>test error</Message></Error>`);
      });
      await writeFile(fixture.destination, "partial prior attempt");
      const download = downloadObjectS3({ ...fixture, allowMissing: true });
      if (missing) assert.equal(await download, false);
      else await assert.rejects(download);
      await assert.rejects(readFile(fixture.destination), { code: "ENOENT" });
    });
  }
});

test("S3 deadlines cover both waiting for headers and a stalled response body", async (t) => {
  for (const phase of ["headers", "body"]) {
    await t.test(phase, async (t) => {
      let responseStarted = false;
      const fixture = await downloadFixture(t, (_request, response) => {
        responseStarted = true;
        if (phase === "body") {
          response.writeHead(200, { "Content-Length": 100 });
          response.write("partial");
        }
      });
      const start = Date.now();
      await assert.rejects(downloadObjectS3({ ...fixture, timeoutMs: 200 }), /timed out after 200ms/u);
      assert.equal(responseStarted, true);
      assert.ok(Date.now() - start < 2_000);
      await assert.rejects(readFile(fixture.destination), { code: "ENOENT" });
    });
  }
});

test("an interrupted S3 body never leaves an apparently complete artifact", async (t) => {
  const fixture = await downloadFixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": 100 });
    response.write("truncated");
    setImmediate(() => response.destroy());
  });
  await assert.rejects(downloadObjectS3(fixture));
  await assert.rejects(readFile(fixture.destination), { code: "ENOENT" });
});
