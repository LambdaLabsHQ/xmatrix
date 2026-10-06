import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  connectTestRuntime,
  createTestInbox,
  humanWsUrl,
  openWebSocket,
  prepareFreshCodexRun,
} from "./e2e-utils.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

/* The tags on an Agent message header -- model, effort, status chips -- are an
   immutable send-time snapshot, so a message committed without one is bare
   forever. This drives the real socket and the real REST send: a runtime
   reports its presentation the way the CLI does, sends a message the way the
   CLI does, and the committed record is asked what it carries.

   Scope, stated exactly, because the honest answer is not the flattering one:
   the Hub worker under test runs the *Durable Object* message authority, and
   the two-week outage was on the PostgreSQL one. This test passes against the
   broken route -- verified, not assumed. It guards the Durable Object path and
   the end-to-end shape; it does not guard the regression that prompted it.

   That guard is `a committed Agent message carries the Instance row's
   presentation` in postgres-message-authority.test.mjs, which drives
   `postgresMessageAppend` directly and does fail against the pre-fix source.
   The gap between these two is itself the lesson: test configuration never
   sets the production authority, so a read on that path can be born dead and
   stay green. */

const MOCK_TOKEN = "agent-message-header-presentation-token";

test("an Agent message commits the presentation its runtime reported", async () => {
  const userId = `agent-header-presentation-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "agent-header-presentation@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Agent Header Presentation",
    },
  });
  let runtime;
  let human;
  try {
    const prepared = await prepareFreshCodexRun(worker, `header-presentation-agent-${randomUUID()}`, MOCK_TOKEN);
    const channelId = prepared.body.metadata.autoJoinChannelId;

    runtime = await connectTestRuntime(
      worker,
      { ...prepared.body, autoProvisionRun: false },
      prepared.token,
      createTestInbox,
    );

    /* A presence update is not echoed to its own sender, so watch it land on a
       Human socket -- the same frame the Details rail reads. */
    human = await openWebSocket(humanWsUrl(worker));
    const humanInbox = createTestInbox(human);
    human.send(JSON.stringify({
      type: "human_connect",
      token: MOCK_TOKEN,
      device: { client: "desktop", version: "0.16.282", protocolVersion: 2 },
    }));
    await humanInbox.waitFor((message) => message.type === "human_connected", "human_connected");

    // Exactly what a runtime reports when the Human runs /model and /effort.
    runtime.ws.send(JSON.stringify({
      type: "presence_update",
      requestId: randomUUID(),
      status: "online",
      model: "gpt-6-astra",
      effort: "high",
      gitBranch: "feat/hub-instance-presentation-row",
      statusChips: [
        { id: "model", label: "Model", value: "gpt-6-astra", source: "codex" },
        { id: "effort", label: "Effort", value: "high", source: "codex" },
      ],
    }));
    await humanInbox.waitFor(
      (message) => message.type === "enhanced_presence" &&
        message.agent?.model === "gpt-6-astra",
      "enhanced_presence carrying the reported model",
    );

    // The REST send path: the one the Rust CLI uses, and the one that broke.
    const sent = await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${prepared.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          body: "a message whose header must carry its own tags",
          clientMessageId: randomUUID(),
        }),
      },
    );
    const payload = await sent.json();
    assert.equal(sent.status, 200, JSON.stringify(payload));

    const from = payload.message?.from;
    assert.ok(from, `committed message carries no sender: ${JSON.stringify(payload)}`);
    assert.equal(from.model, "gpt-6-astra", JSON.stringify(from));
    assert.equal(from.effort, "high", JSON.stringify(from));
    assert.equal(from.gitBranch, "feat/hub-instance-presentation-row", JSON.stringify(from));
    assert.deepEqual(
      (from.statusChips || []).map((chip) => [chip.id, chip.value]),
      [["model", "gpt-6-astra"], ["effort", "high"]],
      JSON.stringify(from.statusChips),
    );
  } finally {
    human?.close();
    runtime?.ws.close();
    await worker.stop();
  }
});
