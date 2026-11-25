const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { plannedConversation } = require("./start-conversation.ts");

test("plannedConversation keeps automaticConversationName while tagging chrome-extension metadata", async () => {
  const extConversation = await plannedConversation({
    spaceId: "space-1",
    memberName: "Daniel",
    body: "@claude:13 Explain this paragraph",
    mode: "open",
    metadata: { createdBy: "chrome-extension" },
    userId: "user-1",
    requestKey: "req-1",
  });
  assert.equal(extConversation.name, "Explain this paragraph");
  assert.deepEqual(extConversation.metadata, {
    createdBy: "chrome-extension",
    autoName: true,
  });

  const attachmentOnly = await plannedConversation({
    spaceId: "space-1",
    memberName: "Daniel",
    body: "",
    mode: "open",
    metadata: { createdBy: "chrome-extension" },
    userId: "user-1",
    requestKey: "req-2",
  });
  assert.equal(attachmentOnly.name, "New conversation");
  assert.deepEqual(attachmentOnly.metadata, {
    createdBy: "chrome-extension",
    autoName: true,
  });

  const webConversation = await plannedConversation({
    spaceId: "space-1",
    memberName: "Daniel",
    body: "Plain web message",
    mode: "open",
    userId: "user-1",
    requestKey: "req-3",
  });
  assert.equal(webConversation.name, "Plain web message");
  assert.deepEqual(webConversation.metadata, {
    createdBy: "web",
    autoName: true,
  });

  const namedPassage = await plannedConversation({
    spaceId: "space-1",
    memberName: "Daniel",
    name: "“Quoted passage”",
    mode: "open",
    metadata: { autoName: true, createdBy: "chrome-extension" },
    userId: "user-1",
    requestKey: "req-4",
  });
  assert.equal(namedPassage.name, "“Quoted passage”");
  assert.deepEqual(namedPassage.metadata, {
    createdBy: "chrome-extension",
    autoName: true,
  });
});
