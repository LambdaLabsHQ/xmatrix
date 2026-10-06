const assert = require("node:assert/strict");

const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const { selectComposerInvocation, updateComposerInvocationDraft, composerSendDraft, selectComposerReference } =
  require("./composer-invocation-bindings.ts");
const { registrationMentionCandidates } = require("./registration-mention-candidates.ts");

const {
  clearChannelComposerDraft,
  emptyChannelComposerDraft,
  isChannelComposerDraftEmpty,
  readChannelComposerDraft,
  writeChannelComposerDraft,
} = require("./channel-composer-drafts.ts");

test("empty drafts report as empty and omit store entries", () => {
  const store = new Map();
  assert.equal(isChannelComposerDraftEmpty(emptyChannelComposerDraft()), true);
  writeChannelComposerDraft(store, "channel-a", emptyChannelComposerDraft());
  assert.equal(store.has("channel-a"), false);
});

test("drafts are isolated per channel and restored independently", () => {
  const store = new Map();

  writeChannelComposerDraft(store, "channel-a", {
    text: "hello a",
    workspaceTarget: "/work/project",
    attachments: [{ id: "att-a" }],
  });
  writeChannelComposerDraft(store, "channel-b", {
    text: "hello b",
    workspaceTarget: null,
    attachments: [],
  });

  assert.deepEqual(readChannelComposerDraft(store, "channel-a"), {
    text: "hello a",
    workspaceTarget: "/work/project",
    attachments: [{ id: "att-a" }],
  });
  assert.deepEqual(readChannelComposerDraft(store, "channel-b"), {
    text: "hello b",
    workspaceTarget: null,
    attachments: [],
  });
  assert.deepEqual(readChannelComposerDraft(store, "channel-c"), emptyChannelComposerDraft());
  assert.deepEqual(readChannelComposerDraft(store, null), emptyChannelComposerDraft());
});

test("read returns a copy of attachments so callers cannot mutate the store", () => {
  const store = new Map();
  writeChannelComposerDraft(store, "channel-a", {
    text: "with attachment",
    workspaceTarget: null,
    attachments: [{ id: "att-1" }],
  });

  const restored = readChannelComposerDraft(store, "channel-a");
  restored.attachments.push({ id: "att-2" });
  restored.text = "mutated";

  assert.deepEqual(readChannelComposerDraft(store, "channel-a"), {
    text: "with attachment",
    workspaceTarget: null,
    attachments: [{ id: "att-1" }],
  });
});

test("clear removes only the requested channel draft", () => {
  const store = new Map();
  writeChannelComposerDraft(store, "channel-a", {
    text: "a",
    workspaceTarget: null,
    attachments: [],
  });
  writeChannelComposerDraft(store, "channel-b", {
    text: "b",
    workspaceTarget: null,
    attachments: [],
  });

  clearChannelComposerDraft(store, "channel-a");
  assert.equal(store.has("channel-a"), false);
  assert.equal(store.has("channel-b"), true);
  clearChannelComposerDraft(store, null);
  assert.equal(store.has("channel-b"), true);
});

test("overwriting a channel draft with empty content deletes the entry", () => {
  const store = new Map();
  writeChannelComposerDraft(store, "channel-a", {
    text: "temporary",
    workspaceTarget: "/work/project",
    attachments: [{ id: "x" }],
  });
  writeChannelComposerDraft(store, "channel-a", emptyChannelComposerDraft());
  assert.equal(store.has("channel-a"), false);
});

const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
const selection = { start: 0, end: 6, text: "@codex", target: { kind: "registration", key } };

test("selected identities survive channel switching, attachment changes and immutable reads", () => {
  const store = new Map();
  const invocationDraft = selectComposerInvocation(undefined, "@codex task", selection);
  writeChannelComposerDraft(store, "a", { text: invocationDraft.body, invocationDraft, attachments: [], workspaceTarget: null });
  writeChannelComposerDraft(store, "b", { text: "@codex", attachments: [], workspaceTarget: null });
  writeChannelComposerDraft(store, "a", { text: "Please @codex task", attachments: [{ id: "file" }], workspaceTarget: null });
  const restored = readChannelComposerDraft(store, "a");
  assert.deepEqual(composerSendDraft(restored.invocationDraft, restored.text).selections, [{ ...selection, start: 7, end: 13 }]);
  restored.invocationDraft.bindings[0].target.key.machineId = "tampered";
  assert.equal(readChannelComposerDraft(store, "a").invocationDraft.bindings[0].target.key.machineId, "machine");
  assert.equal(readChannelComposerDraft(store, "b").invocationDraft, undefined);
});

test("editing selected text sends it as written, never bound to the old pick", () => {
  const initial = selectComposerInvocation(undefined, "@codex task", selection);
  const edited = updateComposerInvocationDraft(initial, "@claude task");
  assert.deepEqual(composerSendDraft(edited, edited.body).selections, []);
  const selected = selectComposerInvocation(edited, "@claude task", {
    start: 0, end: 7, text: "@claude", target: { kind: "capability", harness: "claude" },
  });
  assert.equal(composerSendDraft(selected, selected.body).selections[0].target.harness, "claude");
  const removed = updateComposerInvocationDraft(initial, " task");
  assert.deepEqual(composerSendDraft(removed, "task").selections, []);
});

test("UTF-16 spans survive send trimming and edits outside the selected token", () => {
  const body = "  😀 @codex task  ";
  const initial = selectComposerInvocation(undefined, body, { ...selection, start: 5, end: 11 });
  assert.deepEqual(composerSendDraft(initial, body.trim()).selections, [{ ...selection, start: 3, end: 9 }]);
  const appended = updateComposerInvocationDraft(initial, `${body}more`);
  assert.deepEqual(composerSendDraft(appended, appended.body).selections, [{ ...selection, start: 5, end: 11 }]);
  assert.deepEqual(updateComposerInvocationDraft(initial, "").bindings, []);
});

test("multiple selections preserve independent targets and an edited token loses only its own", () => {
  let draft = selectComposerInvocation(undefined, "@codex and @codex", selection);
  draft = selectComposerInvocation(draft, draft.body, { ...selection, start: 11, end: 17,
    target: { kind: "registration", key: { ...key, machineId: "second" } } });
  assert.equal(draft.bindings[1].target.key.machineId, "second");
  // A character typed against the second token may be inside it, so only that
  // pick is dropped; the text goes out as written, the first pick is kept.
  draft = updateComposerInvocationDraft(draft, "@codex and @codexx");
  assert.deepEqual(composerSendDraft(draft, draft.body).selections, [selection]);
  draft = updateComposerInvocationDraft(draft, "@codex and @other");
  assert.deepEqual(composerSendDraft(draft, draft.body).selections, [selection]);
});

test("normal completion has one capability per harness and explicit locations retain natural keys", () => {
  const locations = ["Workstation", "MacBook"].map((machineName, index) => ({
    key: { ...key, machineId: `machine-${index}` }, machineName, ownerName: "Owner", displayName: "codex",
    state: "enabled", routingReady: true,
  }));
  const catalog = [{ harness: "codex", locations }];
  const existing = [{ id: "legacy-1", kind: "agent", completionSuffix: ":" },
    { id: "legacy-2", kind: "agent", completionSuffix: ":" }, { id: "human", kind: "user" }];
  const candidates = registrationMentionCandidates(existing, catalog, "");
  assert.equal(candidates.filter(item => item.kind === "agent").length, 1);
  assert.deepEqual(candidates[0].invocationTarget, { kind: "capability", harness: "codex" });
  const selected = registrationMentionCandidates(existing, catalog, "codex/mac");
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].invocationTarget, { kind: "registration", key: locations[1].key });
  // A harness row and its locations carry the harness preset icon, not initials.
  assert.equal(candidates[0].avatarUrl, "/agent-vendors/openai.svg");
  assert.equal(selected[0].avatarUrl, "/agent-vendors/openai.svg");
  // An Agent its owner disabled is not offered, as a location or through its harness.
  const disabled = locations.map(location => ({ ...location, routingReady: false, routingBlocker: "owner_environment_disabled" }));
  assert.deepEqual(registrationMentionCandidates(existing, [{ harness: "codex", locations: disabled }], "codex/mac"), []);
  assert.equal(registrationMentionCandidates(existing, [{ harness: "codex", locations: disabled }], "")
    .filter(item => item.invocationTarget?.kind === "capability").length, 0);
  locations[1].state = "revoked";
  assert.deepEqual(registrationMentionCandidates(existing, catalog, "codex/mac"), []);
});

test("an offline location stays in the list and is not selectable", () => {
  const locations = ["Workstation", "Laptop"].map((machineName, index) => ({
    key: { spaceId: "space", ownerUserId: "owner", machineId: `machine-${index}`, harness: "codex" },
    machineName, ownerName: "Owner", displayName: "codex", state: "enabled", routingReady: true,
    live: { machine: { online: index === 0 }, running: [] },
  }));
  const selected = registrationMentionCandidates([], [{ harness: "codex", locations }], "codex/lap");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].unavailable, "Offline");
  assert.equal(selected[0].description, "Offline");
  assert.equal(selected[0].invocationTarget.key.machineId, "machine-1");
});

test("deleting one of two identical labels cannot silently retain the wrong machine", () => {
  let draft = selectComposerInvocation(undefined, "@codex @codex", selection);
  draft = selectComposerInvocation(draft, draft.body, { ...selection, start: 7, end: 13,
    target: { kind: "registration", key: { ...key, machineId: "other-machine" } } });
  draft = updateComposerInvocationDraft(draft, "@codex");
  assert.deepEqual(composerSendDraft(draft, draft.body).selections, []);
  const recovered = selectComposerInvocation(draft, draft.body, selection);
  assert.equal(composerSendDraft(recovered, recovered.body).selections[0].target.key.machineId, "machine");
});

test("picked references go out as id tokens and Agent spans are measured against the sent text", () => {
  const channelId = "da7dacaf-696f-477d-811e-a7cf8311a523";
  const pageId = "0b6c3f2e-1d1a-4c55-9a51-3e0f6d7c8b90";
  let draft = selectComposerReference(undefined, "see #发布 then @codex task", {
    start: 4, end: 7, text: "#发布", reference: `channel:${channelId}`,
  });
  draft = selectComposerInvocation(draft, draft.body, { ...selection, start: 13, end: 19 });
  draft = updateComposerInvocationDraft(draft, `${draft.body} [[Roadmap#Goals]]`);
  draft = selectComposerReference(draft, draft.body, {
    start: 25, end: 42, text: "[[Roadmap#Goals]]", reference: `page:${pageId}#goals`,
  });
  const sent = composerSendDraft(draft, draft.body);
  assert.equal(sent.body, `see channel:${channelId} then @codex task page:${pageId}#goals`);
  const at = sent.body.indexOf("@codex");
  assert.deepEqual(sent.selections, [{ ...selection, start: at, end: at + 6 }]);

  // Editing a picked name sends what was typed, with no id behind it.
  const edited = updateComposerInvocationDraft(draft, draft.body.replace("#发布", "#发"));
  assert.match(composerSendDraft(edited, edited.body).body, /^see #发 then/u);
});
