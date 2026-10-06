import { homeSpaceId, startPgHubWorker as startHubWorker } from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";

async function historyPage(worker, channelId, params) {
  const query = new URLSearchParams(params).toString();
  return json(
    await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?${query}`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    ),
  );
}

async function startWorkerWithChannel(slug) {
  const worker = await startHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: `${slug}-${randomUUID()}`,
      XMATRIX_MOCK_AUTH_EMAIL: `${slug}@example.com`,
      XMATRIX_MOCK_AUTH_NAME: "History Window",
    },
  });
  const channel = (await json(await worker.fetch("/api/channels", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MOCK_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ spaceId: await homeSpaceId(worker), mode: "closed", name: `${slug}-${randomUUID()}`, access: [] }),
  }))).channel;
  return { worker, channel };
}

test("one history request serves more than one internal SQL batch", async () => {
  const { worker, channel } = await startWorkerWithChannel("history-window");
  try {
    const posted = [];
    for (let index = 1; index <= 60; index += 1) {
      posted.push(
        (await postChannelMessage(worker, MOCK_TOKEN, channel.id, `window ${index}`)).message,
      );
    }

    const full = await historyPage(worker, channel.id, { limit: "200" });
    assert.equal(full.hasMore, false, "60 messages fit one 200-row window");
    assert.deepEqual(
      full.messages.map((message) => message.messageId),
      posted.map((message) => message.messageId),
      "a single request returns every message across internal batches, in order",
    );

    // A bounded window still pages by sequence exactly as before.
    const first = await historyPage(worker, channel.id, { limit: "55" });
    assert.equal(first.hasMore, true);
    assert.equal(first.messages.length, 55);
    const oldest = first.messages[0];
    const rest = await historyPage(worker, channel.id, {
      limit: "55",
      beforeSequence: String(oldest.sequence),
    });
    assert.equal(rest.hasMore, false);
    const combined = [...rest.messages, ...first.messages].map((m) => m.messageId);
    assert.deepEqual(
      combined,
      posted.map((message) => message.messageId),
      "two bounded windows cover the channel exactly once",
    );
  } finally {
    await worker.stop();
  }
});

test("a page of oversized payloads stops at the byte budget, not the row count", async () => {
  const { worker, channel } = await startWorkerWithChannel("history-budget");
  try {
    // Inline messages cap at 64 KiB, so seventy-two ~60 KiB messages cross
    // the 4 MiB page byte budget near the sixty-eighth row — a 200-row
    // request must truncate early and report hasMore.
    const bigBody = "x".repeat(60 * 1024);
    const posted = [];
    for (let index = 1; index <= 72; index += 1) {
      posted.push(
        (await postChannelMessage(worker, MOCK_TOKEN, channel.id, `${index}:${bigBody}`)).message,
      );
    }

    const first = await historyPage(worker, channel.id, { limit: "200" });
    assert.equal(first.hasMore, true, "the byte budget must stop the page early");
    assert.ok(
      first.messages.length < 72,
      `expected a truncated page, got ${first.messages.length} rows`,
    );

    // The truncated page resumes by sequence and the union is exact.
    const collected = [...first.messages];
    let guard = 0;
    while (true) {
      const oldest = collected[0];
      const page = await historyPage(worker, channel.id, {
        limit: "200",
        beforeSequence: String(oldest.sequence),
      });
      collected.unshift(...page.messages);
      if (!page.hasMore) break;
      guard += 1;
      assert.ok(guard < 20, "pagination must terminate");
    }
    assert.deepEqual(
      collected.map((message) => message.messageId),
      posted.map((message) => message.messageId),
      "byte-budget pagination covers every oversized message exactly once",
    );
    const forward = [];
    let afterSequence = 0;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await historyPage(worker, channel.id, {
        limit: "200", afterSequence: String(afterSequence),
      });
      if (pages === 0) assert.equal(page.hasMore, true, "forward reads obey the byte budget too");
      forward.push(...page.messages);
      if (!page.hasMore) break;
      assert.ok(page.messages.length > 0, "a truncated forward page must advance");
      afterSequence = page.messages.at(-1).sequence;
    }
    assert.deepEqual(forward.map(message => message.messageId), posted.map(message => message.messageId),
      "forward byte-budget pagination covers every message exactly once");
  } finally {
    await worker.stop();
  }
});
