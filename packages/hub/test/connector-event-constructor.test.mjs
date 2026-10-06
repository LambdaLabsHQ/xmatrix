import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { connectorEvent } from "../src/connectors/event-format.ts";

const connectors = new URL("../src/connectors/", import.meta.url);

test("connectorEvent bounds the summary and links the url in message and event", () => {
  const event = connectorEvent({ eventId: "x:1", sourceRef: "x:*", feature: "f", summary: "s".repeat(250),
    provider: "X", title: "Title", url: "https://example.test/1", details: ["detail", undefined] });
  assert.equal(event.summary.length, 200);
  assert.equal(event.body, "**X** — Title\nhttps://example.test/1\ndetail");
  assert.equal(event.url, "https://example.test/1");
  assert.equal("url" in connectorEvent({ eventId: "x:2", sourceRef: "x:*", feature: "f", summary: "s",
    provider: "X", title: "T" }), false);
});

test("provider event receivers build their events with connectorEvent", () => {
  const receivers = readdirSync(connectors).filter((name) => name.endsWith("-events.ts"));
  assert.ok(receivers.length > 5);
  for (const name of receivers) {
    const source = readFileSync(new URL(name, connectors), "utf8");
    assert.doesNotMatch(source, /\bbody:\s*(?:eventMessage\(|\[)/u, `${name} assembles an event body by hand`);
    assert.doesNotMatch(source, /\.\.\.\(url \? \{ url \} : \{\}\)/u, `${name} spreads an event url by hand`);
  }
});
