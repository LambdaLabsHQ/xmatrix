import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { pageCardResource } from "../src/mcp-page-card.ts";

// The iframe owns the content-to-DOM and source-link boundaries. Exercise the
// actual shipped script so hostile page data cannot become markup or navigation.
test("the page card handshakes with its host, renders hostile text safely, and bounds source links", () => {
  const nodes = new Map(["title", "revision", "body", "open"].map((id) => [id, { textContent: "", disabled: true }]));
  const outbound = [];
  let receive;
  const parent = { postMessage: (message) => outbound.push(message) };
  const window = { parent, addEventListener: (_type, callback) => { receive = callback; } };
  const resource = pageCardResource("https://xmatrix.test");
  const script = resource.text.slice(resource.text.indexOf("<script>") + "<script>".length, resource.text.lastIndexOf("</script>"));
  runInNewContext(script, { window, document: { getElementById: (id) => nodes.get(id) }, URL });
  const deliver = (data, source = parent) => receive({ source, data: { jsonrpc: "2.0", ...data } });
  const page = { title: '<img src=x onerror="steal()">', body: "<script>steal()</script>" + "x".repeat(5000),
    revision: 3, url: "https://xmatrix.test/app/space/pages?page=page" };
  const result = (data) => ({ method: "ui/notifications/tool-result", params: { structuredContent: data } });
  assert.equal(outbound[0].method, "ui/initialize");
  deliver(result(page));
  assert.equal(nodes.get("title").textContent, "", "host must complete initialization first");
  deliver({ id: 1, result: { protocolVersion: "2026-01-26" } });
  assert.equal(outbound[1].method, "ui/notifications/initialized");
  deliver(result(page), {});
  assert.equal(nodes.get("title").textContent, "", "another frame cannot inject a result");
  deliver(result(page));
  assert.equal(nodes.get("title").textContent, page.title);
  assert.equal(nodes.get("body").textContent, page.body.slice(0, 4000) + "\n…");
  assert.equal(nodes.get("open").disabled, false);
  nodes.get("open").onclick();
  assert.equal(outbound.at(-1).method, "ui/open-link");
  assert.equal(outbound.at(-1).params.url, page.url);
  for (const url of ["javascript:steal()", "https://evil.test/app/space/pages?page=p",
    "https://xmatrix.test/oauth/authorize?page=p", "https://user:password@xmatrix.test/app/space/pages?page=p"]) {
    deliver(result({ ...page, url }));
    assert.equal(nodes.get("open").disabled, true);
    const count = outbound.length;
    nodes.get("open").onclick();
    assert.equal(outbound.length, count, "an invalid source URL cannot be opened");
  }
  deliver({ method: "ui/notifications/tool-result", params: { isError: true } });
  assert.equal(nodes.get("body").textContent, "");
  assert.equal(nodes.get("open").disabled, true);
});
