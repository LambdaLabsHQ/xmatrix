import { homeSpaceId, startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  channelHistory,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";

function contentAuthority(history) {
  const authority = history.contentAuthority;
  assert.ok(authority, "channel-history must carry contentAuthority");
  assert.equal(authority.protocolVersion, 1);
  assert.ok(
    Number.isInteger(authority.contentRevision) && authority.contentRevision >= 0,
    `contentRevision must be a non-negative integer, got ${authority.contentRevision}`,
  );
  return authority.contentRevision;
}

async function messageMutation(worker, channelId, messageId, init) {
  const response = await worker.fetch(
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}${init.suffix ?? ""}`,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${MOCK_TOKEN}`,
        "content-type": "application/json",
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    },
  );
  return json(response);
}

async function revisionChannel(worker, name) {
  return (await json(await worker.fetch("/api/channels", {
    method: "POST", headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: "closed", name, access: [] }),
  }))).channel;
}

async function editFirstMessage(worker, channelId, messageId) {
  const edited = await messageMutation(worker, channelId, messageId, {
    method: "PATCH", body: { body: "first, edited" },
  });
  assert.equal(edited.ok, true, `edit failed: ${JSON.stringify(edited)}`);
}

test("contentRevision ignores appends and bumps on edit, reaction, and recall", async () => {
  const worker = await startMockUserHubWorker({ id: `content-revision-${randomUUID()}`, email: "content-revision@example.com", name: "Content Revision" });
  try {
    const channel = await revisionChannel(worker, `content-revision-${randomUUID()}`);

    const first = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "first")).message;
    const second = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "second")).message;
    const baseline = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));

    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "third");
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "fourth");
    const afterAppends = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.equal(afterAppends, baseline, "append must never move the content revision");

    await editFirstMessage(worker, channel.id, first.messageId);
    const afterEdit = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.ok(afterEdit > afterAppends, "an edit must bump the content revision");

    const reaction = await messageMutation(worker, channel.id, second.messageId, {
      method: "POST",
      suffix: "/reactions",
      body: { emoji: "👍" },
    });
    assert.ok(!reaction.error, `reaction failed: ${JSON.stringify(reaction)}`);
    const afterReaction = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.ok(afterReaction > afterEdit, "a reaction must bump the content revision");

    const recalled = await messageMutation(worker, channel.id, second.messageId, {
      method: "DELETE",
    });
    assert.equal(recalled.ok, true, `recall failed: ${JSON.stringify(recalled)}`);
    const afterRecall = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.ok(afterRecall > afterReaction, "a recall must bump the content revision");

    const hardDeleted = await messageMutation(worker, channel.id, first.messageId, {
      method: "DELETE",
      suffix: "?permanent=true",
    });
    assert.equal(hardDeleted.ok, true, `hard delete failed: ${JSON.stringify(hardDeleted)}`);
    const afterDelete = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.ok(afterDelete > afterRecall, "a hard delete must bump the content revision");

    const idle = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.equal(idle, afterDelete, "reads alone must never move the content revision");
  } finally {
    await worker.stop();
  }
});

async function catalogRow(worker, channelId) {
  const catalog = await json(await worker.fetch("/api/channels", {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  }));
  const row = (catalog.channels ?? []).find((candidate) => candidate.id === channelId);
  assert.ok(row, "channel must appear in the catalog");
  return row;
}

test("channel catalog rows carry the same contentAuthority watermark as history", async () => {
  const worker = await startMockUserHubWorker({ id: `catalog-content-revision-${randomUUID()}`, email: "catalog-content-revision@example.com", name: "Catalog Content Revision" });
  try {
    const channel = await revisionChannel(worker, `catalog-revision-${randomUUID()}`);

    const first = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "first")).message;
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "second");

    const baselineRow = await catalogRow(worker, channel.id);
    const baseline = contentAuthority(baselineRow);
    const historyBaseline = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.equal(baseline, historyBaseline, "catalog and history must report one watermark");

    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "third");
    const afterAppend = contentAuthority(await catalogRow(worker, channel.id));
    assert.equal(afterAppend, baseline, "append must never move the catalog content revision");

    await editFirstMessage(worker, channel.id, first.messageId);
    const afterEditRow = await catalogRow(worker, channel.id);
    const afterEdit = contentAuthority(afterEditRow);
    assert.ok(afterEdit > baseline, "an edit must bump the catalog content revision");
    const historyAfterEdit = contentAuthority(await channelHistory(worker, MOCK_TOKEN, channel.id));
    assert.equal(afterEdit, historyAfterEdit, "catalog must track the history watermark after mutations");
  } finally {
    await worker.stop();
  }
});
