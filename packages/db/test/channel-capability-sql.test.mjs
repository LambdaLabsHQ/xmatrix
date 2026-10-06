import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { parse } from "libpg-query";

import {
  CHANNEL_CAPABILITY_POLICIES,
  channelCapabilityCte,
  channelCapabilityPredicate,
  requireChannelCapability,
} from "../dist/channel-capability-policy.js";
import { PostgresChannelCatalogRepository } from "../dist/channel-catalog.js";
import { PostgresSpaceControlRepository } from "../dist/space-control.js";
import { collectStaticNamedQueries } from "../scripts/sql-prepare-audit.mjs";
import { activePlacementRow } from "./recording-database.fixture.mjs";

async function checkSql(text, label) {
  await assert.doesNotReject(() => parse(text), label);
}

// PostgreSQL 17's C parser compiled to WASM. No server, schema, credentials,
// or opt-in environment variable. Behavioral authorization tests stay separate.
test("all Channel capability SQL variants parse with PostgreSQL", async () => {
  for (const capability of Object.keys(CHANNEL_CAPABILITY_POLICIES)) {
    for (const includeLifecycle of [true, false]) {
      const predicate = channelCapabilityPredicate({ capability, channelAlias: "c",
        principalKindSql: "$1", principalIdSql: "$2", includeLifecycle });
      await checkSql(`SELECT c.channel_id FROM data.channels c WHERE ${predicate}
        ORDER BY c.channel_id LIMIT 10`, `${capability}: predicate, lifecycle=${includeLifecycle}`);
    }
    const cte = channelCapabilityCte({ capability, inputCte: "input_scope" });
    await checkSql(`WITH input_scope AS (SELECT $1::text AS space_id,
      $2::text AS channel_id,$3::text AS principal_kind,$4::text AS principal_id),
      ${cte} SELECT * FROM authorized_channel`, `${capability}: CTE`);
    await requireChannelCapability({ async query(query) {
      await checkSql(query.text, query.name);
      return [{ channel_id: "channel", space_id: "space", mode: "open",
        metadata_json: {}, version: 1, archived_at: null }];
    } }, { capability, channelId: "channel", spaceId: "space",
      principal: { kind: "user", id: "owner" }, error: (value) => new Error(value.message) });
  }
});

test("catalog query variants parse after their SQL fragments are assembled", async () => {
  const checked = new Set();
  const transaction = { async query(query) {
    await checkSql(query.text, query.name);
    checked.add(query.name);
    if (query.name.startsWith("channel_catalog_page_")) return [{
      principal_authorized: true, commit_sequence: 1, page_rows: [],
    }];
    if (query.name.startsWith("channel_catalog_counts_")) return [{
      principal_authorized: true, active_count: 0, archive_count: 0,
      direct_count: 0, unread_count: 0, mentions_count: 0,
    }];
    if (query.name.startsWith("channel_catalog_resolve_")) return [{
      principal_authorized: true, resolved_rows: [],
    }];
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow("space", { planClass: "test" })];
    if (query.name === "channel_list_member_v1") return [{ role: "owner" }];
    if (query.name === "channel_list_agent_v3") return [{ present: 1 }];
    if (query.name === "space_control_head_read_v1") return [{ commit_sequence: 1 }];
    return [];
  } };
  const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback(transaction) };
  const catalog = new PostgresChannelCatalogRepository(database, true);
  for (const principal of [{ kind: "user", id: "owner" }, { kind: "agent", id: "agent" }]) {
    const base = { requestId: "catalog", spaceId: "space", principal };
    for (const view of ["tree", "flat", "archive", "direct", "search"]) {
      for (const filter of ["all", "unread"]) {
        for (const cursor of [undefined, { sortGroup: 1, pinRank: 0, channelId: "channel",
          ownActivityAt: "2026-09-15T00:00:00Z", subtreeActivityAt: "2026-09-15T00:00:00Z" }]) {
          await catalog.page({ ...base, view, filter, cursor, limit: 10, includeCounts: true });
        }
      }
    }
    await catalog.page({ ...base, view: "tree", filter: "all", scopeChannelId: "channel", limit: 10 });
    await catalog.resolve({ ...base, channelIds: ["channel"] });
    await catalog.resolve({ ...base, channelIds: [], routeToken: "c72dq68erek" });
    await new PostgresSpaceControlRepository(database, "shard-0").listChannels(base);
    await new PostgresSpaceControlRepository(database, "shard-0").listChannels({
      ...base, familyOfChannelId: "channel",
    });
  }
  assert.ok([...checked].some((name) => name.startsWith("channel_catalog_page_")));
  assert.ok([...checked].some((name) => name.startsWith("channel_catalog_counts_")));
  assert.ok([...checked].some((name) => name.startsWith("channel_catalog_resolve_")));
  assert.ok(checked.has("channel_list_v9"));
});

test("static named SQL and migration statements parse with PostgreSQL", async () => {
  const { queries } = await collectStaticNamedQueries();
  assert.ok(queries.length > 0);
  for (const query of queries) {
    await checkSql(query.text, `${query.file}:${query.line} ${query.name}`);
  }
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    await checkSql(await readFile(new URL(file, directory), "utf8"), file);
  }
});

test("a registered Agent Instance is an agent principal scoped to its Space, its own Channel and grants", () => {
  const predicate = channelCapabilityPredicate({ capability: "message_active_command", channelAlias: "c",
    principalKindSql: "$1", principalIdSql: "$2" });
  // An Agent is only ever a registered Instance; no Profile grants access.
  assert.doesNotMatch(predicate, /agent_profiles/u);
  assert.match(predicate, /JOIN data\.run_agent_registrations channel_registration ON channel_registration\.run_id=channel_instance\.run_id/u);
  assert.match(predicate, /channel_instance\.instance_id=\$2 AND channel_registration\.space_id=c\.space_id/u);
  assert.match(predicate, /channel_instance\.channel_id=c\.channel_id/u);
});
