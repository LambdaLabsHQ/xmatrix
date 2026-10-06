import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";

// docs/cross-space-read-grants.md, through the real Hub routes and PostgreSQL.
test("a Run reads another of its owner's Spaces only while the owner's grant stands", async () => {
  const token = "cross-space-read-owner";
  const ownerId = `cross-space-owner-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ token, id: ownerId,
    email: "cross-space-owner@example.com", name: "Cross Space Owner" });
  try {
    const owner = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const createSpace = async (name) => {
      const response = await worker.fetch("/api/spaces", { method: "POST", headers: owner,
        body: JSON.stringify({ name }) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).space;
    };
    const home = await createSpace("Agent home");
    const other = await createSpace("Owner's other Space");
    const channel = async (spaceId, name) => {
      const response = await worker.fetch("/api/channels", { method: "POST", headers: owner,
        body: JSON.stringify({ spaceId, mode: "open", name: `${name}-${randomUUID()}` }) });
      assert.ok(response.ok, await response.clone().text());
      return (await response.json()).channel;
    };
    const target = await channel(other.id, "debug-me");
    const sibling = await channel(other.id, "sibling");
    const posted = await worker.fetch(`/api/channels/${encodeURIComponent(target.id)}/messages`, {
      method: "POST", headers: owner, body: JSON.stringify({ body: "why did the launch fail" }) });
    assert.ok(posted.ok, await posted.clone().text());

    const prepared = await prepareTestAgentRun(worker, {
      name: `cross-space-agent-${randomUUID()}`, agentType: "codex", spaceId: home.id,
    }, token);
    const agent = { Authorization: `Bearer ${prepared.token}`, "content-type": "application/json" };
    const history = (channelId) => worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=20`, { headers: agent });

    const before = await history(target.id);
    assert.equal(before.status, 403, await before.clone().text());
    assert.equal((await before.json()).code, "cross_space_read_grant_required",
      "the refusal names the way to ask");

    const requested = await worker.fetch("/api/cross-space-read/requests", { method: "POST", headers: agent,
      body: JSON.stringify({ channelId: target.id, reason: "debug a launch" }) });
    assert.equal(requested.status, 201, await requested.clone().text());
    const { grant } = await requested.json();
    assert.equal(grant.status, "pending");
    assert.equal(grant.ref, `${other.id}/${grant.id}`);

    const homeChannel = prepared.body.metadata.autoJoinChannelId;
    const pending = await worker.fetch(
      `/api/channels/${encodeURIComponent(homeChannel)}/cross-space-read-grants/pending`, { headers: owner });
    assert.equal(pending.status, 200, await pending.clone().text());
    assert.deepEqual((await pending.json()).grants.map((waiting) => waiting.id), [grant.id],
      "the owner's Pending approvals dock lists it from the Hub, not from the loaded timeline");

    const ownerRead = await worker.fetch(
      `/api/spaces/${encodeURIComponent(other.id)}/cross-space-read-grants/${encodeURIComponent(grant.id)}`,
      { headers: owner });
    assert.equal(ownerRead.status, 200, await ownerRead.clone().text());
    assert.equal((await ownerRead.json()).grant.status, "pending", "the owner's card reads its grant");

    const agentDecides = await worker.fetch(
      `/api/spaces/${encodeURIComponent(other.id)}/cross-space-read-grants/${encodeURIComponent(grant.id)}/decision`,
      { method: "POST", headers: agent, body: JSON.stringify({ action: "approve" }) });
    assert.notEqual(agentDecides.status, 200, "a Run never approves its own grant");

    const approved = await worker.fetch(
      `/api/spaces/${encodeURIComponent(other.id)}/cross-space-read-grants/${encodeURIComponent(grant.id)}/decision`,
      { method: "POST", headers: owner, body: JSON.stringify({ action: "approve" }) });
    assert.equal(approved.status, 200, await approved.clone().text());

    const granted = await history(target.id);
    assert.equal(granted.status, 200, await granted.clone().text());
    assert.ok((await granted.json()).messages.some((message) => message.body === "why did the launch fail"));
    assert.equal((await history(sibling.id)).status, 403, "the grant covers its Channel family only");
    // Launch targets are the Space's, so they take a Space-wide grant; the Run's own Space needs none.
    const launchTargets = (spaceId) => worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/launch-targets`, { headers: agent });
    const ownTargets = await launchTargets(home.id);
    assert.equal(ownTargets.status, 200, await ownTargets.clone().text());
    const otherTargets = await launchTargets(other.id);
    assert.equal(otherTargets.status, 403, await otherTargets.clone().text());
    assert.equal((await otherTargets.json()).code, "cross_space_read_grant_required",
      "a Channel grant does not read the Space's launch catalog");

    const send = await worker.fetch(`/api/channels/${encodeURIComponent(target.id)}/messages`, {
      method: "POST", headers: agent, body: JSON.stringify({ body: "writing is not reading" }) });
    assert.ok(send.status >= 400, "a read grant never authorizes a write");

    const revoked = await worker.fetch(
      `/api/spaces/${encodeURIComponent(other.id)}/cross-space-read-grants/${encodeURIComponent(grant.id)}/decision`,
      { method: "POST", headers: owner, body: JSON.stringify({ action: "revoke" }) });
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.equal((await history(target.id)).status, 403, "revocation ends the read");
  } finally {
    await worker.stop();
  }
});
