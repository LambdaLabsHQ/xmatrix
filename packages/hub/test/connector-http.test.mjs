import assert from "node:assert/strict";
import { test } from "node:test";
import { providerJson, ProviderRequestError } from "../src/connectors/http.ts";

test("provider JSON preserves its response/error policy and refuses excess bytes before clone cleanup", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async () => Response.json({ answer: "界" });
  assert.deepEqual(await providerJson("https://example.test"), { answer: "界" });
  globalThis.fetch = async () => Response.json({ error: { message: "Unavailable" } }, { status: 503 });
  await assert.rejects(providerJson("https://example.test"), error => error instanceof ProviderRequestError &&
    error.status === 503 && error.message === "Provider returned 503: Unavailable");

  const source = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); } });
  const [body, sibling] = source.tee();
  t.after(async () => { await sibling.cancel(); });
  globalThis.fetch = async () => new Response(body);
  const result = providerJson("https://example.test", { maxBytes: 3 }).catch(error => error);
  const answer = await Promise.race([result, new Promise(resolve => setImmediate(() => resolve(null)))]);
  assert.ok(answer instanceof ProviderRequestError);
  assert.equal(answer.status, 502);
  assert.equal(answer.message, "Provider response is too large");
});
