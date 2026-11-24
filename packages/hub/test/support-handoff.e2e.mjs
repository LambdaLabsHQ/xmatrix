import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

/** The id the Hub gives a person's own Space (src/spaces.ts personalSpaceId), known before the worker starts. */
function personalSpaceId(userId) {
  const hex = createHash("sha256").update(`personal-space\n${userId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// docs/cross-space-read-grants.md#support-handoffs, through the real Hub routes and PostgreSQL.
test("a person hands a conversation to support; support reads only what was ticked, and each hour's read is noted", async () => {
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
    await ok(await call(staff, `${base}/messages`));
    const notes = (await history(customer, channel.id))
      .filter((message) => (message.body ?? "").startsWith("xMatrix support read this conversation ("));
    assert.equal(notes.length, 1, "the person sees that support read it, once for the hour");

    const unshared = await call(staff, `${base}/diagnostics`);
    assert.equal(unshared.status, 403);
    assert.equal((await unshared.json()).code, "support_handoff_part_not_shared");
    assert.equal((await call(customer, `${base}/messages`)).status, 404, "the person is not support");

    await ok(await call(staff, `${base}/replies`, { body: "Restart the daemon and try again." }), 201);
    const reply = (await history(customer, channel.id)).find((message) => message.body === "Restart the daemon and try again.");
    assert.equal(reply?.senderSnapshot?.name ?? reply?.sender?.name ?? reply?.senderName, "xMatrix support");

    assert.equal((await call(staff, `${base}/revoke`, {})).status, 404, "support cannot withdraw it for the person");
    assert.equal((await ok(await call(customer, `${base}/revoke`, {}))).handoff.status, "revoked");
    const ended = await call(staff, `${base}/messages`);
    assert.equal(ended.status, 403);
    assert.equal((await ended.json()).code, "support_handoff_ended", "withdrawal stops reads at once");
  } finally {
    await worker.stop();
  }
});
