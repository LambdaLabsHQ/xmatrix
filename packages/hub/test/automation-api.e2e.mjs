import {
  assert,
  authHeaders,
  createSpaceAndChannel,
  createTask,
  json,
  listTasks,
  MOCK_TOKEN,
  nextAutomationRunAt,
  randomUUID,
  startPgHubWorker,
  test,
} from "./automation-api.fixture.mjs";

test("scheduled cadence stays anchored and coalesces missed intervals", () => {
  assert.equal(
    nextAutomationRunAt("2026-07-31T00:00:00.000Z", 15, Date.parse("2026-07-31T00:46:00.000Z")),
    "2026-07-31T01:00:00.000Z",
  );
  assert.equal(
    nextAutomationRunAt("2026-07-31T00:00:00.000Z", 15, Date.parse("2026-07-31T00:00:00.000Z")),
    "2026-07-31T00:15:00.000Z",
  );
  assert.throws(
    () => nextAutomationRunAt("not-a-time", 15, Date.now()),
    /cadence input is invalid/,
  );
});

test("the Space-wide catalog reads and changes a page's Automations; only a page creates one", async () => {
  const unique = randomUUID();
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: `scheduled-message-api-${unique}`,
      XMATRIX_MOCK_AUTH_EMAIL: "scheduled-message-api@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Scheduled Message API",
    },
  });
  try {
    const first = await createSpaceAndChannel(worker, unique, "first");
    const second = await createSpaceAndChannel(worker, unique, "second");
    const createdAfter = Date.now();
    const created = await createTask(worker, {
      spaceId: first.space.id,
      name: "Morning review",
      message: { body: "Review the open work and report blockers." },
      intervalMinutes: 60,
      deliveryCount: 999,
      lastMessageId: "message:forged",
      lastError: "forged",
    });
    const secondTask = await createTask(worker, {
      spaceId: second.space.id,
      name: "Other Space schedule",
      message: { body: "Post in the other Space." },
      intervalMinutes: 120,
    });

    assert.equal(created.name, "Morning review");
    assert.equal(created.spaceId, first.space.id);
    assert.equal(created.expression.text, "Review the open work and report blockers.");
    assert.equal(created.intervalMinutes, 60);
    assert.equal(created.enabled, true);
    assert.equal(created.canManage, true);
    assert.equal(created.deliveryCount, 0);
    assert.equal(created.lastMessageId, undefined);
    assert.equal(created.lastError, undefined);
    assert.equal(Date.parse(created.nextRunAt) >= createdAfter + 59 * 60_000, true);
    const exact = (await json(await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    ))).automation;
    assert.equal(exact.id, created.id);
    assert.equal(exact.pageId, created.pageId);

    const updated = (await json(await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}`,
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({
          expectedVersion: created.version,
          name: "Daily review",
          expression: { kind: "text", language: "natural-language", text: "Review open work and propose the next action." },
          intervalMinutes: 24 * 60,
        }),
      },
    ))).automation;
    assert.equal(updated.id, created.id, "its author edits it in place");
    assert.equal(updated.name, "Daily review");
    assert.equal(updated.expression.text, "Review open work and propose the next action.");
    assert.equal(updated.intervalMinutes, 24 * 60);
    assert.equal(updated.createdAt, created.createdAt);

    const global = await listTasks(worker);
    assert.deepEqual(
      new Set(global.automations.map((task) => task.id)),
      new Set([created.id, secondTask.id]),
    );
    const scoped = await listTasks(worker, first.space.id);
    assert.deepEqual(scoped.automations.map((task) => task.id), [created.id]);

    // An Automation belongs to a page section; the Space-wide route no longer makes one.
    const channelCreate = await worker.fetch("/api/automations", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        channelId: first.channel.id,
        message: { body: "A conversation's own schedule" },
        intervalMinutes: 60,
      }),
    });
    assert.equal(channelCreate.status, 410);
    assert.equal((await channelCreate.json()).code, "automation_lives_on_a_page");
    const invalidInterval = await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}`,
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ expectedVersion: updated.version, intervalMinutes: 14 }),
      },
    );
    assert.equal(invalidInterval.status, 400);

    const forgedPause = await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}/pause`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expectedVersion: updated.version, authorityRootUserId: "attacker" }),
      },
    );
    assert.equal(forgedPause.status, 400);

    const paused = (await json(await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}/pause`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expectedVersion: updated.version }),
      },
    ))).automation;
    assert.equal(paused.enabled, false);

    const removed = await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}`,
      { method: "DELETE", headers: authHeaders, body: JSON.stringify({ expectedVersion: paused.version }) },
    );
    assert.equal(removed.status, 200);
    assert.equal((await listTasks(worker)).automations.some((task) => task.id === created.id), false);
  } finally {
    await worker.stop();
  }
});
