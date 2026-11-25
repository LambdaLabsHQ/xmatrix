import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { inTestTransaction, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { connectUser } from "./agent-mention-spawn.fixture.mjs";
import { prepareTestAgentRun } from "./e2e-utils.mjs";

/** The id the Hub gives a person's own Space (src/spaces.ts personalSpaceId), known before the worker starts. */
function personalSpaceId(userId) {
  const hex = createHash("sha256").update(`personal-space\n${userId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// docs/cross-space-read-grants.md#support-handoffs, through the real Hub routes and PostgreSQL.
test("a person hands a conversation to support; support reads only what was ticked, and every read is noted", async () => {
  const customer = { token: "support-handoff-customer", id: `customer-${randomUUID()}`,
    email: "customer@example.com", name: "Customer" };
  const staff = { token: "support-handoff-staff", id: `staff-${randomUUID()}`,
    email: "staff@example.com", name: "Support Staff" };
  const supportSpaceId = personalSpaceId(staff.id);
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify(Object.fromEntries([customer, staff].map(({ token, ...user }) => [token, user]))),
    SUPPORT_SPACE_ID: supportSpaceId,
  } });
  try {
    const as = (user) => ({ Authorization: `Bearer ${user.token}`, "content-type": "application/json" });
    const call = (user, path, body) => worker.fetch(path, body === undefined ? { headers: as(user) }
      : { method: "POST", headers: as(user), body: JSON.stringify(body) });
    const ok = async (response, status = 200) => {
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    };
    const history = async (user, channelId) => (await ok(await call(user,
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=50`))).messages;

    assert.equal((await ok(await call(staff, "/api/personal-space", {}))).space.id, supportSpaceId);
    const mine = (await ok(await call(customer, "/api/spaces", { name: "Customer's Space" }))).space;
    const channel = (await ok(await call(customer, "/api/channels", { spaceId: mine.id, mode: "open",
      name: `stuck-${randomUUID()}` }))).channel;
    await ok(await call(customer, `/api/channels/${encodeURIComponent(channel.id)}/messages`,
      { body: "the agent never starts" }));
    const handoffs = `/api/channels/${encodeURIComponent(channel.id)}/support-handoffs`;

    const unconsented = await call(customer, handoffs, { line: "it never starts", parts: ["messages"] });
    assert.equal(unconsented.status, 400);
    assert.equal((await unconsented.json()).code, "consent_required", "nothing is sent without the agreement");
    const foreign = await call(staff, handoffs, { line: "not mine", parts: ["messages"], consent: true });
    assert.equal(foreign.status, 404, "no one hands over a conversation they cannot read");

    const { handoff } = await ok(await call(customer, handoffs,
      { line: "it never starts", parts: ["messages"], consent: true }), 201);
    assert.deepEqual([handoff.status, handoff.parts, handoff.supportSpaceId], ["approved", ["messages"], supportSpaceId]);
    const base = `/api/spaces/${encodeURIComponent(handoff.spaceId)}/support-handoffs/${encodeURIComponent(handoff.id)}`;

    const card = (await history(staff, handoff.supportChannelId))
      .find((message) => message.messageId === `support-handoff:${handoff.id}`);
    assert.match(card?.body ?? "", /it never starts/u, "the handoff opens a support conversation with the person's line");
    assert.equal((await call(staff, `/api/channels/${encodeURIComponent(channel.id)}/history`)).status >= 400, true,
      "support's membership alone reads nothing of the person's conversation");

    const read = await ok(await call(staff, `${base}/messages`));
    assert.ok(read.history.messages.some((message) => message.body === "the agent never starts"),
      "support reads the conversation as the person");
    const noteOf = async () => {
      const notes = (await history(customer, channel.id))
        .filter((message) => (message.body ?? "").startsWith("xMatrix support read this conversation"));
      assert.equal(notes.length, 1, "one note for the hour");
      return notes[0].body;
    };
    assert.match(await noteOf(), /^xMatrix support read this conversation \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)\.$/u,
      "the person sees that support read it");
    // The person's open conversation (the Web) is told of each edit as it commits.
    const reader = await connectUser(worker, customer.token);
    const updates = [];
    reader.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "channel_message_updated" && frame.channelId === channel.id) updates.push(frame.message);
    });
    const noteId = (await history(customer, channel.id))
      .find((message) => (message.body ?? "").startsWith("xMatrix support read this conversation")).messageId;
    const updateOf = (messageId, label, text = "") => reader.inbox.waitFor((frame) =>
      frame.type === "channel_message_updated" && frame.message.messageId === messageId &&
      frame.message.body.includes(text), label).then((frame) => frame.message);
    await ok(await call(staff, `${base}/messages`));
    const second = await updateOf(noteId, "the note's second-read edit", "2 times");
    await ok(await call(staff, `${base}/messages`));
    const third = await updateOf(noteId, "the note's third-read edit", "3 times");
    assert.match(await noteOf(), /^xMatrix support read this conversation 3 times \(latest \d\d:\d\d UTC\)\.$/u,
      "later reads in the hour update the same note");
    assert.equal(third.body, await noteOf(), "the live update reads as history does");
    assert.deepEqual([second.entityVersion, third.entityVersion], [2, 3], "each edit is a new version of the note");
    assert.ok(Date.parse(third.editedAt) >= Date.parse(second.editedAt));
    assert.equal(third.metadata?.supportAccess?.grantId, handoff.id, "the update keeps what the note reports");

    // The person's own edit is delivered, and recorded, exactly as the Hub's edit of its note.
    const own = (await ok(await call(customer, `/api/channels/${encodeURIComponent(channel.id)}/messages`,
      { body: "it fails at startup" }))).message;
    const edited = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages/${
      encodeURIComponent(own.messageId)}`, { method: "PATCH", headers: as(customer),
      body: JSON.stringify({ body: "it fails at startup (since Monday)" }) });
    assert.equal(edited.status, 200, await edited.clone().text());
    const ownUpdate = await updateOf(own.messageId, "the person's own edit");
    assert.deepEqual([ownUpdate.body, ownUpdate.entityVersion, typeof ownUpdate.editedAt],
      ["it fails at startup (since Monday)", 2, "string"]);
    assert.deepEqual(Object.keys(third).filter((key) => !(key in ownUpdate)), ["metadata"],
      "both edits arrive in one shape; only the note carries app metadata");
    const recorded = await inTestTransaction(async (tx) => ({
      edits: await tx.query({ text: `SELECT message_id,entity_version,mutation_kind FROM data.message_mutations
        WHERE channel_id=$1 AND message_id = ANY($2) AND mutation_kind<>'create' ORDER BY message_id,entity_version`,
      values: [channel.id, [noteId, own.messageId]] }),
      rows: await tx.query({ text: `SELECT message_id,entity_version,edited_at IS NOT NULL AS edited
        FROM data.messages WHERE channel_id=$1 AND message_id = ANY($2)`, values: [channel.id, [noteId, own.messageId]] }),
    }));
    const versions = (messageId) => recorded.edits.filter((row) => row.message_id === messageId)
      .map((row) => [Number(row.entity_version), row.mutation_kind]);
    assert.deepEqual(versions(noteId), [[2, "edit"], [3, "edit"]]);
    assert.deepEqual(versions(own.messageId), [[2, "edit"]]);
    assert.deepEqual(Object.fromEntries(recorded.rows.map((row) => [row.message_id, [Number(row.entity_version), row.edited]])),
      { [noteId]: [3, true], [own.messageId]: [2, true] }, "both edits bump the version and edit time");
    assert.equal(updates.length, 3, "one live update per edit");
    reader.ws.close();

    const unshared = await call(staff, `${base}/diagnostics`);
    assert.equal(unshared.status, 403);
    assert.equal((await unshared.json()).code, "support_handoff_part_not_shared");
    assert.equal((await call(customer, `${base}/messages`)).status, 404, "the person is not support");

    await ok(await call(staff, `${base}/replies`, { body: "Restart the daemon and try again." }), 201);
    const reply = (await history(customer, channel.id)).find((message) => message.body === "Restart the daemon and try again.");
    assert.equal(reply?.senderSnapshot?.name ?? reply?.sender?.name ?? reply?.senderName, "xMatrix support");

    // A Run working in the support conversation reads the conversation and,
    // above its messages, its name and threads: both through the handoff.
    const prepared = await prepareTestAgentRun(worker, { name: `support-agent-${randomUUID()}`, agentType: "codex",
      spaceId: supportSpaceId, targetChannelId: handoff.supportChannelId }, staff.token);
    const agent = { headers: { Authorization: `Bearer ${prepared.token}` } };
    const family = `/api/channels?familyOfChannelId=${encodeURIComponent(channel.id)}`;
    const agentHistory = `/api/channels/${encodeURIComponent(channel.id)}/history?limit=20`;
    assert.ok((await ok(await worker.fetch(agentHistory, agent))).messages
      .some((message) => message.body === "the agent never starts"), "the Run reads the messages as the person");
    assert.deepEqual((await ok(await worker.fetch(family, agent))).channels.map((each) => each.id), [channel.id],
      "the Channel's context reads through the same handoff");
    assert.match(await noteOf(), /^xMatrix support read this conversation 4 times /u,
      "the Run's read is shown; the context beside it is not a second read");

    assert.equal((await call(staff, `${base}/revoke`, {})).status, 404, "support cannot withdraw it for the person");
    assert.equal((await ok(await call(customer, `${base}/revoke`, {}))).handoff.status, "revoked");
    const ended = await call(staff, `${base}/messages`);
    assert.equal(ended.status, 403);
    assert.equal((await ended.json()).code, "support_handoff_ended", "withdrawal stops reads at once");
    for (const path of [agentHistory, family]) {
      const refused = await worker.fetch(path, agent);
      assert.equal(refused.status, 403, await refused.clone().text());
      assert.equal((await refused.json()).code, "cross_space_read_grant_required", `withdrawal ends the Run's ${path}`);
    }
  } finally {
    await worker.stop();
  }
});
