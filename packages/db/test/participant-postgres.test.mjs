import { connectedAuthority, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { PostgresChannelCatalogRepository, PostgresSpaceControlRepository } from "../dist/index.js";
import { requireChannelCapability } from "../dist/channel-capability-policy.js";


// Open-project governance §2–§3: a participant reads the Space, starts
// conversations that are their intake, acts only there, and their intake is
// its own list rather than everyone's.
integration("a participant's conversations are their intake: theirs to act in, out of everyone else's list", async () => {
  const unique = crypto.randomUUID();
  const spaceId = `open-${unique}`;
  const [owner, participant] = [`owner-${unique}`, `participant-${unique}`];
  const { client, session } = await connectedAuthority({ shard: true });
  try {
    const spaces = new PostgresSpaceControlRepository(session, "shard-0");
    await spaces.createSpace({ requestId: `space-${unique}`, commandId: `space-${unique}`, spaceId,
      ownerUserId: owner, kind: "workspace", name: "Open project" });
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ($1,$2,'participant',1,'p@example.test','Participant',now(),now())`, [spaceId, participant]);
    const create = (principal, name, metadata) => spaces.createChannel({ requestId: `c-${name}`, commandId: `c-${name}-${unique}`,
      channelId: `${name}-${unique}`, spaceId, name, mode: "open", principal: { kind: "user", id: principal },
      ...(metadata ? { metadata } : {}) });
    await create(owner, "roadmap");
    await create(participant, "question", { intakeOf: owner });
    const [question] = (await client.query("SELECT metadata_json FROM data.channels WHERE channel_id=$1",
      [`question-${unique}`])).rows;
    assert.equal(question.metadata_json.intakeOf, participant, "intake is theirs, whatever the caller says");
    await create(owner, "spoofed", { intakeOf: participant });
    const [spoofed] = (await client.query("SELECT metadata_json FROM data.channels WHERE channel_id=$1",
      [`spoofed-${unique}`])).rows;
    assert.equal(spoofed.metadata_json.intakeOf, undefined, "a member cannot make a conversation someone's intake");

    const may = (userId, channel) => session.transaction({ requestId: `cap-${channel}-${userId}`, operation: "cap",
      placement: { spaceId, shardId: "shard-0", placementEpoch: 1 } }, (tx) => requireChannelCapability(tx, {
      capability: "message_active_command", channelId: `${channel}-${unique}`, spaceId,
      principal: { kind: "user", id: userId }, error: (failure) => Object.assign(new Error(failure.code), failure) }))
      .then(() => true, () => false);
    assert.equal(await may(participant, "question"), true, "a participant writes in their intake");
    assert.equal(await may(participant, "roadmap"), false, "and nowhere else");
    assert.equal(await may(owner, "question"), true, "maintainers can answer intake");

    const catalog = new PostgresChannelCatalogRepository(session, true);
    const list = (userId, view) => catalog.page({ requestId: `list-${view}-${userId}`, spaceId,
      principal: { kind: "user", id: userId }, view, filter: "all", limit: 50 })
      .then((page) => page.rows.map((row) => row.channel.name).sort());
    assert.deepEqual(await list(owner, "flat"), ["roadmap", "spoofed"], "intake is not everyone's list");
    assert.deepEqual(await list(owner, "intake"), ["question"]);
    assert.deepEqual(await list(participant, "flat"), ["question", "roadmap", "spoofed"],
      "a participant sees their own intake among the Space's conversations");
  } finally {
    await session.close();
    await client.end();
  }
});

// §1 and §4: owners open the project and name the governance page; only
// maintainers edit that page.
integration("owners open a project and name its governance page, which only maintainers edit", async () => {
  const { PostgresGovernanceRepository, PostgresPageRepository } = await import("../dist/index.js");
  const unique = crypto.randomUUID();
  const spaceId = `governed-${unique}`;
  const [owner, member] = [`owner-${unique}`, `member-${unique}`];
  const { client, session } = await connectedAuthority({ shard: true });
  try {
    await new PostgresSpaceControlRepository(session, "shard-0").createSpace({ requestId: `space-${unique}`,
      commandId: `space-${unique}`, spaceId, ownerUserId: owner, kind: "workspace", name: "Governed" });
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ($1,$2,'member',1,'m@example.test','Member',now(),now())`, [spaceId, member]);
    const governance = new PostgresGovernanceRepository(session);
    const pages = new PostgresPageRepository(session);
    const r = () => crypto.randomUUID();
    const rules = (await pages.create({ requestId: r(), spaceId, principal: { kind: "user", id: owner, label: "Owner" },
      title: "Governance", body: "# Governance\n\nBe kind.\n" })).page;
    const roadmap = (await pages.create({ requestId: r(), spaceId, principal: { kind: "user", id: owner, label: "Owner" },
      title: "Roadmap", body: "# Roadmap\n" })).page;

    assert.deepEqual(await governance.read({ requestId: r(), spaceId }),
      { spaceId, ownerUserId: owner, openParticipation: false, governancePageId: null });
    await assert.rejects(governance.update({ requestId: r(), spaceId, userId: member, openParticipation: true }),
      (error) => error.code === "governance_maintainers_only");
    const set = await governance.update({ requestId: r(), spaceId, userId: owner, openParticipation: true,
      governancePageId: rules.pageId });
    assert.equal(set.openParticipation, true);
    assert.equal(set.governancePageId, rules.pageId);

    const tree = async (userId) => (await pages.tree({ requestId: r(), spaceId,
      principal: { kind: "user", id: userId, label: userId } })).pages;
    const editable = async (userId) => Object.fromEntries((await tree(userId)).map((page) => [page.title, page.canEdit]));
    assert.deepEqual(await editable(member), { Governance: false, Roadmap: true });
    assert.deepEqual(await editable(owner), { Governance: true, Roadmap: true });
    // Everyone's tree marks it, so the triage Agent finds the rules it applies.
    assert.deepEqual((await tree(member)).filter((page) => page.governance).map((page) => page.title), ["Governance"]);
    await governance.update({ requestId: r(), spaceId, userId: owner, governancePageId: null });
    assert.deepEqual(await editable(member), { Governance: true, Roadmap: true });
    assert.ok((await tree(member)).every((page) => !page.governance));
    assert.ok(roadmap);
  } finally {
    await session.close();
    await client.end();
  }
});
