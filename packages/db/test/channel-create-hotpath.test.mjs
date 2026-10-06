import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "libpg-query";
import { PostgresSpaceControlRepository } from "../dist/space-control.js";
import { activePlacementRow } from "./recording-database.fixture.mjs";

const input = {
  requestId: "create-test", commandId: "create-once", channelId: "channel-new",
  spaceId: "space-1", name: "New conversation", mode: "open",
  principal: { kind: "user", id: "user-1" },
};
const allowed = { role: "member", space_id: "space-1", channel_exists: false };

function fixture({ check = allowed, insert = true } = {}) {
  const calls = [];
  let receipt;
  const database = {
    cacheMode: "disabled",
    async transaction(context, callback) {
      return callback({ async query(query) {
        calls.push(query);
        switch (query.name) {
          case "space_placement_resolve_v1":
          case "channel_space_directory_placement_fence_v1":
            return [activePlacementRow()];
          case "space_control_idempotency_read_v1": return receipt ? [receipt] : [];
          case "space_control_idempotency_write_v1":
            receipt = { command_kind: query.values[2], request_digest: query.values[3],
              result_json: JSON.parse(query.values[4]) };
            return [];
          case "channel_create_checks_v2": return check ? [check] : [];
          case "channel_create_v4": return insert
            ? [{ channel_id: input.channelId, search_rank_sequence: "pg:00000000000000000042" }] : [];
          case "space_control_head_advance_v1": return [{ commit_sequence: 42 }];
          default: return [];
        }
      } });
    },
  };
  return { calls, repository: new PostgresSpaceControlRepository(database, "shard-0") };
}

for (const [label, check, code] of [
  ["nonmember", null, "forbidden"],
  ["missing Space", { ...allowed, space_id: null }, "space_not_found"],
  ["existing ID", { ...allowed, channel_exists: true }, "channel_exists"],
]) {
  test(`combined create checks reject ${label} before writing`, async () => {
    const f = fixture({ check });
    await assert.rejects(f.repository.createChannel(input), (error) => error.code === code);
    assert.equal(f.calls.some((query) => /INSERT|UPDATE/.test(query.text)), false);
  });
}

test("any member can create a channel", async () => {
  const f = fixture();
  assert.equal((await f.repository.createChannel(input)).id, input.channelId);
});

test("participant intake remains authority-derived", async () => {
  const f = fixture({ check: { ...allowed, role: "participant" } });
  await f.repository.createChannel({ ...input, metadata: { intakeOf: "someone-else" } });
  const insert = f.calls.find((query) => query.name === "channel_create_v4");
  assert.equal(JSON.parse(insert.values[5]).intakeOf, input.principal.id);
});

test("insert conflicts still reject a concurrent duplicate ID", async () => {
  const f = fixture({ insert: false });
  await assert.rejects(f.repository.createChannel(input), (error) => error.code === "channel_exists");
  assert.equal(f.calls.some((query) => query.name === "channel_space_directory_create_v1"), false);
});

test("a direct conversation is refused as retired before anything is read", async () => {
  const f = fixture();
  await assert.rejects(f.repository.createChannel({ ...input, mode: "closed", metadata: {
    kind: "direct", participantKey: "user:user-1\nuser:user-2",
    participants: [{ kind: "user", id: "user-1" }, { kind: "user", id: "user-2" }],
  } }), (error) => error.code === "direct_conversation_retired");
  assert.equal(f.calls.length, 0);
});

test("retry replays the original rank and never allocates or inserts again", async () => {
  const f = fixture();
  const first = await f.repository.createChannel(input);
  const second = await f.repository.createChannel(input);
  assert.deepEqual(second, first);
  assert.equal(first.searchRankSeq, "pg:00000000000000000042");
  assert.equal(f.calls.filter((query) => query.name === "channel_create_v4").length, 1);
  await assert.rejects(f.repository.createChannel({ ...input, name: "Different request" }),
    (error) => error.code === "idempotency_conflict");
});

test("combined checks and inline rank allocation parse as PostgreSQL", async () => {
  const f = fixture();
  await f.repository.createChannel(input);
  for (const name of ["channel_create_checks_v2", "channel_create_v4"]) {
    const query = f.calls.find((query) => query.name === name);
    assert.ok(query);
    await parse(query.text);
  }
});
