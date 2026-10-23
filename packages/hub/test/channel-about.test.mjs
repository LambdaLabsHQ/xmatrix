import assert from "node:assert/strict";
import { test } from "node:test";

import { channelAboutAnswer, channelAboutInput, channelAboutRequest, spaceLanguage } from "../src/channel-about.ts";

const message = (sequence, body, extra = {}) => ({ sequence, body, sentAt: `2026-10-15T10:0${sequence % 10}:00.000Z`,
  from: { label: sequence % 2 ? "Daniel" : "claude", kind: sequence % 2 ? "user" : "agent" }, ...extra });

test("a reading carries the conversation's name, summary and newest messages, oldest first", () => {
  const reading = channelAboutInput({ name: "Login", summary: "Fixing login" }, [
    message(1, "The login test is flaky"),
    message(2, "   "),
    message(3, "I will look at it", { threadSummary: { replyCount: 2 } }),
  ]);
  assert.equal(reading.throughSequence, 3);
  assert.equal(reading.text, [
    "Name: Login",
    "Summary: Fixing login",
    "",
    "#1 Daniel (person) · 2026-10-15 10:01 UTC",
    "The login test is flaky",
    "",
    "#3 Daniel (person) · 2026-10-15 10:03 UTC · answered in its thread (2 replies)",
    "I will look at it",
    "",
  ].join("\n"));
  assert.equal(channelAboutInput({ name: "Empty" }, [message(1, "")]), null, "nothing to read starts nothing");
});

test("a long conversation is read from its newest messages, each cut to a length", () => {
  const long = Array.from({ length: 100 }, (_, index) => message(index + 1, "页".repeat(3_000)));
  const reading = channelAboutInput({ name: "Long" }, long);
  assert.equal(reading.throughSequence, 100);
  assert.ok(Buffer.byteLength(reading.text) <= 64 * 1024);
  assert.match(reading.text, /#100 /u);
  assert.doesNotMatch(reading.text, /#1 /u, "the oldest messages are the ones left out");
  assert.ok(reading.text.includes(`${"页".repeat(2_000)} …`), "a message is cut, not dropped");
});

test("the task's id names the reading it answers", () => {
  assert.deepEqual(channelAboutRequest("channel-about:c-1:3:15:name:123e4567-e89b-12d3-a456-426614174000"),
    { channelId: "c-1", readRevision: 3, throughSequence: 15, named: true });
  assert.equal(channelAboutRequest("page-summary:s:p:1:123e4567-e89b-12d3-a456-426614174000"), null);
  assert.equal(channelAboutRequest("channel-about:c-1:3:15:other:123e4567-e89b-12d3-a456-426614174000"), null);
});

test("an answer is the About in its JSON, whatever the harness wrapped it in", () => {
  assert.deepEqual(channelAboutAnswer('Here it is:\n```json\n{"summary": "  Fixing\\nlogin ", "name": "Login"}\n```', true),
    { summary: "Fixing login", name: "Login" });
  assert.deepEqual(channelAboutAnswer('{"summary": "Fixing login", "name": "Login"}', false), { summary: "Fixing login" },
    "a name nobody asked for is dropped");
  assert.equal([...channelAboutAnswer(JSON.stringify({ summary: "长".repeat(300) }), false).summary].length, 240);
  assert.equal([...channelAboutAnswer(JSON.stringify({ summary: "S", name: "名".repeat(60) }), true).name].length, 40);
  for (const text of ["Fixing login", '{"name": "Login"}', '{"summary": ""}', "[1]", '{"summary": "???? ????"}']) {
    assert.equal(channelAboutAnswer(text, true), null, text);
  }
});

test("the About's language is the Space's setting, never a guess from the conversation", () => {
  assert.equal(spaceLanguage({ locale: { defaultLocale: "zh-CN" }, preferredLanguage: "en" }), "zh",
    "the versioned setting comes first");
  assert.equal(spaceLanguage({ preferredLanguage: "zh" }), "zh");
  assert.equal(spaceLanguage({ locale: { defaultLocale: "fr" } }), "en");
  assert.equal(spaceLanguage({ name: "中文频道" }), "en");
  assert.equal(spaceLanguage(undefined), "en");
});
