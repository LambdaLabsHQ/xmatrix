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
  waitForTask,
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

test("the Space-wide catalog reads a page's schedules and changes them through their lines; only a line makes one", async () => {
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
      message: { body: "Review the open work and report blockers." },
      intervalMinutes: 60,
    });
    const secondTask = await createTask(worker, {
      spaceId: second.space.id,
      message: { body: "Post in the other Space." },
      intervalMinutes: 120,
    });

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

    // What it does and when is its line; the catalog does not edit it.
    const update = await worker.fetch(`/api/automations/${encodeURIComponent(created.id)}`, {
      method: "PATCH", headers: authHeaders,
      body: JSON.stringify({ expectedVersion: created.version, intervalMinutes: 24 * 60 }),
    });
    assert.equal(update.status, 409);
    assert.equal((await update.json()).code, "schedule_lives_in_its_line");

    const global = await listTasks(worker);
    assert.deepEqual(
      new Set(global.automations.map((task) => task.id)),
      new Set([created.id, secondTask.id]),
    );
    const scoped = await listTasks(worker, first.space.id);
    assert.deepEqual(scoped.automations.map((task) => task.id), [created.id]);

    // An Automation is a line of a page; the Space-wide route makes none.
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

    const forgedPause = await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}/pause`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expectedVersion: created.version, authorityRootUserId: "attacker" }),
      },
    );
    assert.equal(forgedPause.status, 400);

    // Pausing writes `[-]` on its line, whose revision then pauses it.
    const pausing = (await json(await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}/pause`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expectedVersion: created.version }),
      },
    ))).automation;
    assert.equal(pausing.id, created.id);
    const paused = await waitForTask(worker, created.id, (task) => task.enabled === false);
    const page = (await json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(first.space.id)}/pages/${encodeURIComponent(created.pageId)}`,
      { headers: authHeaders }))).page;
    assert.match(page.body, /^- \[-\] Review the open work/mu);

    // Deleting removes its line.
    const removed = await worker.fetch(
      `/api/automations/${encodeURIComponent(created.id)}`,
      { method: "DELETE", headers: authHeaders, body: JSON.stringify({ expectedVersion: paused.version }) },
    );
    assert.equal(removed.status, 200);
    const deadline = Date.now() + 15_000;
    while ((await listTasks(worker)).automations.some((task) => task.id === created.id)) {
      assert.ok(Date.now() < deadline, "removing its line deletes it");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const after = (await json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(first.space.id)}/pages/${encodeURIComponent(created.pageId)}`,
      { headers: authHeaders }))).page;
    assert.doesNotMatch(after.body, /Review the open work/u);
  } finally {
    await worker.stop();
  }
});
