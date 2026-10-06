import assert from "node:assert/strict";
import test from "node:test";
import { hasRetiredAgentLaunchMention, parseAutoLaunchMentions, formatAutoLaunchMention } from "../dist/agent-auto-mention.js";

test("direct runtime addresses share launch conditions and reject conflicting runtimes", () => {
  for (const name of ["codex", "claude", "claude_code"]) {
    const [mention] = parseAutoLaunchMentions(`@${name} repo:owner/repo effort:high task`);
    assert.equal(mention.tags.harness, name === "claude_code" ? "claude" : name);
    assert.equal(mention.tags.repo, "owner/repo");
    assert.equal(Object.hasOwn(mention.tags, "oneshot"), false);
    assert.equal(mention.error, undefined);
  }
  assert.ok(parseAutoLaunchMentions("@codex harness:claude repo:owner/repo")[0].error);
  for (const body of ["@codex:1 task", "@claude:new:owner/repo", "`@codex repo:owner/repo`",
    "> @claude repo:owner/repo", "```\n@codex\n```", "@xMatrix task", "@unknown task"]) {
    assert.deepEqual(parseAutoLaunchMentions(body), [], body);
  }
  assert.equal(formatAutoLaunchMention({ harness: "claude_code", repo: "owner/repo" }, true),
    "@claude repo:owner/repo");
});

test("Auto tags round trip with paths, quotes, Unicode and arbitrary parameter order", () => {
  for (const pwd of ['/Users/me/My Projects', 'C:\\work\\你好', '/srv/a]b', '/srv/"quoted"']) {
    const tags = { pwd, model: "model", effort: "high", machine: "machine" };
    const text = formatAutoLaunchMention(tags);
    assert.deepEqual(parseAutoLaunchMentions(`${text} task`)[0].tags, tags);
  }
  assert.deepEqual(parseAutoLaunchMentions("@auto effort:high repo:owner/repo task")[0].tags,
    { repo: "owner/repo", effort: "high" });
  assert.deepEqual(parseAutoLaunchMentions("@auto do it")[0].tags, {});
  assert.equal(parseAutoLaunchMentions("😀 ＠auto task")[0].start, 3);
});

test("machine completion spells the scoped UUID once and preserves its exact identity", () => {
  const id = "machine:c04a3f1d-a863-477d-b169-5a089ed17971";
  const short = "c04a3f1d-a863-477d-b169-5a089ed17971";
  assert.equal(formatAutoLaunchMention({ machine: id }), `@auto machine:${short}`);
  assert.equal(parseAutoLaunchMentions(`@auto machine:${short} task`)[0].tags.machine, id);
  assert.equal(parseAutoLaunchMentions(`@auto machine:${id} task`)[0].tags.machine, id,
    "previously sent long form stays valid");
  assert.equal(formatAutoLaunchMention({ machine: "machine:custom" }), "@auto machine:machine:custom",
    "non-UUID machine identities keep their established spelling");
  assert.equal(formatAutoLaunchMention({ machine: "build01" }), "@auto machine:build01");
  assert.equal(parseAutoLaunchMentions("@auto machine:build01 Hi")[0].tags.machine, "build01");
  assert.equal(formatAutoLaunchMention({ machine: "Registered Mac" }), '@auto machine:"Registered Mac"');
});

test("invalid parameters never become an unconstrained launch", () => {
  for (const text of ["@auto repo:owner/repo pwd:/srv", "@auto model:a model:b",
    '@auto model:"" x', "@auto pwd:relative", "@auto oneshot:other"]) {
    assert.ok(parseAutoLaunchMentions(text)[0]?.error, text);
  }
  assert.equal(parseAutoLaunchMentions("@auto repo:https://user:secret@example.test/owner/repo")
    .some(mention => !mention.error), false);
});

test("quoted examples, code, links and other identities cannot invoke Auto", () => {
  for (const text of ["`@auto task`", "> @auto task", "```\n@auto task\n```", "mail@auto task",
    "[@auto task](https://example.test)", "@automatic task", "@xMatrix task", "@auto:2 task"]) {
    assert.deepEqual(parseAutoLaunchMentions(text), [], text);
  }
});

test("conditions are key:value words in the grammar the rest of @ uses", () => {
  const [mention] = parseAutoLaunchMentions("@auto repo:LambdaLabsHQ/xmatrix harness:codex read the README");
  assert.equal(mention.error, undefined);
  assert.deepEqual(mention.tags, { repo: "LambdaLabsHQ/xmatrix", harness: "codex" });
  // The mention ends at the last condition; the task is everything after it.
  assert.equal(mention.text, "@auto repo:LambdaLabsHQ/xmatrix harness:codex");
  assert.equal(formatAutoLaunchMention(mention.tags), mention.text);
});

test("a value carrying whitespace is quoted with doubled quotes", () => {
  const [mention] = parseAutoLaunchMentions('@auto pwd:"/Users/me/my ""work""" do it');
  assert.equal(mention.error, undefined);
  assert.equal(mention.tags.pwd, '/Users/me/my "work"');
  assert.equal(formatAutoLaunchMention(mention.tags), '@auto pwd:"/Users/me/my ""work"""');
});

test("an unknown key is task text, and a bad known field still fails closed", () => {
  const [prose] = parseAutoLaunchMentions("@auto TODO: read the README");
  assert.equal(prose.error, undefined);
  assert.deepEqual(prose.tags, {});
  assert.equal(prose.text, "@auto");
  for (const body of ["@auto oneshot:weekly x", "@auto repo:a/b repo:c/d x", "@auto repo:a/b pwd:/tmp x"]) {
    assert.ok(parseAutoLaunchMentions(body)[0].error, `expected ${body} to fail closed`);
  }
});

test("each condition reports where it sits, so a reader marks up the author's text", () => {
  const body = "@auto repo:LambdaLabsHQ/xmatrix effort:high go";
  const [mention] = parseAutoLaunchMentions(body);
  assert.deepEqual(mention.conditions.map(item => item.field), ["repo", "effort"]);
  for (const condition of mention.conditions) {
    assert.equal(body.slice(condition.start, condition.valueStart), `${condition.field}:`);
    assert.equal(body.slice(condition.valueStart, condition.end), mention.tags[condition.field]);
  }
});

test("every horizontal space keeps the next field a condition", () => {
  // A narrower space list dropped `effort` out of the mention, so the reader
  // drew it as prose while `repo` stayed highlighted.
  for (const space of [" ", "\t", "\u00A0", "\u3000"]) {
    const body = `@auto repo:LambdaLabsHQ/xmatrix${space}effort:high go`;
    const [mention] = parseAutoLaunchMentions(body);
    assert.equal(mention.error, undefined, space);
    assert.deepEqual(mention.conditions.map(item => item.field), ["repo", "effort"]);
  }
  const nextLine = parseAutoLaunchMentions("@auto repo:LambdaLabsHQ/xmatrix\neffort:high go")[0];
  assert.deepEqual(nextLine.conditions.map(item => item.field), ["repo"]);
  assert.equal(nextLine.text, "@auto repo:LambdaLabsHQ/xmatrix");
});

test("the bracket block that shipped is not a mention at all", () => {
  // It is gone rather than tolerated: a body carrying it reads as the prose it
  // looks like and starts nothing, so there is one grammar to know.
  for (const body of ['@auto[repo="LambdaLabsHQ/xmatrix"] task', "@auto[model=a] task", "@auto[] task"]) {
    assert.deepEqual(parseAutoLaunchMentions(body), [], body);
  }
  assert.equal(formatAutoLaunchMention({ repo: "LambdaLabsHQ/xmatrix", harness: "codex" }),
    "@auto repo:LambdaLabsHQ/xmatrix harness:codex");
});

test("retired launch suffixes are detected for rejection but stay non-executable prose in literals", () => {
  for (const body of ["@grok:new:LambdaLabsHQ/xmatrix Hi", "@codex:once:/srv task",
    "＠codex:new! task", "@auto task @grok:new:owner/repo other"]) {
    assert.equal(hasRetiredAgentLaunchMention(body), true, body);
  }
  for (const body of ["`@grok:new:owner/repo`", "> @grok:new:owner/repo",
    "```\n@grok:new:owner/repo\n```", "@grok:3 task", "@grok:3:stop", "@auto repo:owner/repo go",
    "ordinary prose"]) {
    assert.equal(hasRetiredAgentLaunchMention(body), false, body);
  }
});

test("launch:force is a launch condition with one value", async () => {
  const [forced] = parseAutoLaunchMentions("@claude repo:owner/repo launch:force fix the build");
  assert.equal(forced.error, undefined);
  assert.deepEqual(forced.tags, { harness: "claude", repo: "owner/repo", launch: "force" });
  const [invalid] = parseAutoLaunchMentions("@claude launch:now fix the build");
  assert.match(invalid.error, /Launch must be force/);
});


test("retired lifetime conditions fail closed without executing a different launch", () => {
  for (const body of ["@auto oneshot:on task", "@codex repo:o/r oneshot:off task", "@auto oneshot:maybe task"]) {
    assert.match(parseAutoLaunchMentions(body)[0].error, /lifecycle option was removed/);
  }
});
