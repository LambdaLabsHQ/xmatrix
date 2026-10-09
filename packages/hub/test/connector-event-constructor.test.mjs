import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorEvent } from "../src/connectors/event-format.ts";

test("connectorEvent bounds the summary and links the url in message and event", () => {
  const event = connectorEvent({ eventId: "x:1", sourceRef: "x:*", feature: "f", summary: "s".repeat(250),
    provider: "X", title: "Title", url: "https://example.test/1", details: ["detail", undefined] });
  assert.equal(event.summary.length, 200);
  assert.equal(event.body, "**X** — Title\nhttps://example.test/1\ndetail");
  assert.equal(event.url, "https://example.test/1");
  assert.equal("url" in connectorEvent({ eventId: "x:2", sourceRef: "x:*", feature: "f", summary: "s",
    provider: "X", title: "T" }), false);
});
