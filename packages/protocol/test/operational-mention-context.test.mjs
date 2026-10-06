import assert from "node:assert/strict";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createInstanceMentionScanner } from "../dist/agent-mention.js";
import { mentionAddressTokens, scanMentionAddresses } from "../dist/mention-address.js";
import { filterOperationalMentions, hasOperationalAgentInvocation, literalMentionSourceOffsets,
  nonOperationalMentionRanges, isOperationalMentionStart } from "../dist/operational-mention-context.js";

const address = "@Alpha:new:/tmp/project";
test("address rendering preserves full invocation tails with spaces and dotted names", () => {
  const addresses = ['＠Alpha:new:"C:\\work space\\repo.v2"', '@Alpha:1:handoff:@Beta.dev', '@Alpha:1:reborn'];
  const body = addresses.join(" next ");
  assert.deepEqual(scanMentionAddresses(body, mentionAddressTokens(["Alpha"]))
    .map(match => body.slice(match.start, match.end)), addresses);
});
test("Markdown examples and quoted contexts cannot start invocations", () => {
  for (const body of [
    `\`${address}\``, `\`\`\`sh\n${address}\n\`\`\``, `~~~\n${address}\n~~~`, `    ${address}`,
    `> ${address}`, `> quote\n>\n> ${address}`, `[${address}](https://example.test)`,
    `![${address}](https://example.test/image.png)`, `~~${address}~~`,
    `<div>\n${address}\n</div>`, `<!-- ${address} -->`, `[x]: https://example.test " ${address} "`,
    `> ${address}\ncontinuation of the quote ${address}`,
  ]) assert.equal(hasOperationalAgentInvocation(body), false, body);
});

test("ordinary list and heading calls survive with exact UTF-16 and CRLF positions", () => {
  const body = `😀\r\n\`\`\`\r\n${address}\r\n\`\`\`\r\n# ＠Beta:once:"C:\\work space\\repo"\r\n\r\n- ${address}`;
  const matches = [...body.matchAll(createInstanceMentionScanner())].map(match => ({
    start: match.index + match[0].length - match[1].length - 1,
    end: match.index + match[0].length,
  }));
  assert.deepEqual(filterOperationalMentions(body, matches).map(match => body.slice(match.start, match.end)),
    ["＠Beta:once:\"C:\\work space\\repo\"", address]);
  assert.equal(hasOperationalAgentInvocation(`- item\n  - ${address}`), true);
  assert.equal(hasOperationalAgentInvocation(`\`example\`${address}`), false, "filtering must not invent an opening boundary");
});

test("quoted working directory bytes are not rewritten by Markdown context filtering", () => {
  const body = '@Alpha:new:"/tmp/a `literal` folder" inspect';
  assert.equal(hasOperationalAgentInvocation(body), true);
  const start = body.indexOf("@");
  assert.equal(isOperationalMentionStart(start, nonOperationalMentionRanges(body)), true);
  assert.equal(body, '@Alpha:new:"/tmp/a `literal` folder" inspect');
});

test("rendered escapes and entities do not acquire another occurrence's invocation state", () => {
  const raw = `\\${address} &commat;Alpha:new:/tmp/project 😀 ${address}`;
  const rendered = fromMarkdown(raw).children[0].children[0].value;
  const positions = literalMentionSourceOffsets(raw, rendered);
  assert.equal(positions.size, 1);
  assert.deepEqual([...positions.values()], [raw.lastIndexOf("@")]);
  assert.equal(literalMentionSourceOffsets("different", address), undefined);
});
