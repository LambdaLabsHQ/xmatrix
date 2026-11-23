import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBrowserReadAnswer } from "@xmatrix/protocol";
import { BrowserReadWaits, browserReadText } from "../src/browser-read.ts";
import { BROWSE_COMMAND } from "../src/cli-commands-call.ts";

test("a page read waits for its owner's answer, and only theirs", async () => {
  const waits = new BrowserReadWaits();
  const waiting = waits.wait("req-1", "owner", 5_000);
  assert.equal(waits.answer("req-1", "someone-else", { refusal: "denied" }), false);
  assert.equal(waits.answer("req-1", "owner", { title: "T", href: "https://a.test/", text: "x" }), true);
  assert.deepEqual(await waiting, { title: "T", href: "https://a.test/", text: "x" });
  // Settled once: a second answer finds nothing waiting.
  assert.equal(waits.answer("req-1", "owner", { refusal: "denied" }), false);
});

test("a page read nobody answers ends empty, and a retry takes over the earlier wait", async () => {
  const waits = new BrowserReadWaits();
  assert.equal(await waits.wait("req-2", "owner", 10), null);
  const first = waits.wait("req-3", "owner", 5_000);
  const second = waits.wait("req-3", "owner", 5_000);
  assert.equal(await first, null);
  waits.answer("req-3", "owner", { refusal: "offline" });
  assert.deepEqual(await second, { refusal: "offline" });
});

test("answers from the browser are bounded, and only web pages", () => {
  assert.equal(parseBrowserReadAnswer({ title: "T", href: "file:///etc/passwd", text: "x" }), null);
  assert.equal(parseBrowserReadAnswer({ title: "T", href: "https://a.test/", text: "x".repeat(200_001) }), null);
  assert.deepEqual(parseBrowserReadAnswer({ refusal: "denied" }), { refusal: "denied" });
  assert.equal(parseBrowserReadAnswer({ refusal: "x".repeat(501) }), null);
  assert.equal(parseBrowserReadAnswer(null), null);
});

test("the Agent sees the page as text, with where it came from", () => {
  assert.equal(browserReadText({ title: "Docs", href: "https://a.test/", text: "  body  " }), "# Docs\nhttps://a.test/\n\nbody\n");
  assert.equal(browserReadText({ title: "", href: "https://a.test/", text: "b" }), "# https://a.test/\nhttps://a.test/\n\nb\n");
});

test("`xmatrix browse` is a command", () => {
  assert.deepEqual(BROWSE_COMMAND.path, ["browse"]);
});

test("the side panel's page-reading capability survives hibernation", async () => {
  const { parseHumanHibernationAttachment, serializeHumanHibernationAttachment } = await import("../src/runtime-transport/human-hibernation.ts");
  const session = { user: { id: "u1", email: "u@example.test" }, connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(), focusedChannelId: null, browserRead: true };
  const restored = parseHumanHibernationAttachment(JSON.parse(JSON.stringify(serializeHumanHibernationAttachment(session, Date.now() + 60_000))));
  assert.equal(restored?.session.browserRead, true);
  const without = parseHumanHibernationAttachment(JSON.parse(JSON.stringify(serializeHumanHibernationAttachment({ ...session, browserRead: undefined }, Date.now() + 60_000))));
  assert.equal(without?.session.browserRead, undefined);
});
