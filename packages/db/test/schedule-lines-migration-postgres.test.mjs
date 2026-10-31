import assert from "node:assert/strict";

import { pageSchedules } from "@xmatrix/protocol";
import { integration, migrationFixture } from "./postgres-database.fixture.mjs";

const MIGRATION = "0235_contract_schedules_are_lines";

// 0235 rewrites every page Automation's reference into the line that is now
// what it is. The Hub knows an Automation by the line it stores, and changes
// it when the line says anything else; so each line must read back, through
// the protocol's own parser, as exactly what its Automation already does.
integration("each Automation's reference becomes the line that reads back as what it does", async () => {
  const fixture = await migrationFixture("schedule_lines", MIGRATION);
  const { run } = fixture;
  try {
    await run(`INSERT INTO data.spaces (space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
      VALUES ('s','u','S','s',1,now(),now())`);
    await run(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
      created_at,updated_at) VALUES ('c','s','C','c','open','c',1,now(),now())`);
    const body = [
      "# Ops", "",
      "## Audit",
      "[Code audit](xmatrix:automation/audit)",
      "- Cadence: [Merge \\[review\\]](xmatrix:automation/merge.review) and more",
      "",
      "## Renewals",
      "- [Renew domain](xmatrix:automation/renew)",
      "[Tax](xmatrix:automation/tax)",
      "",
    ].join("\n");
    await run(`INSERT INTO data.pages (space_id,page_id,position,access_mode,head_revision,version,created_by_user_id,
      created_at,updated_at) VALUES ('s','p','a','open',1,1,'u',now(),now())`);
    await run(`INSERT INTO data.page_revisions (space_id,page_id,revision,body,authors_json,kind,created_at)
      VALUES ('s','p',1,$1,'[]','edit',now())`, [body]);
    const automation = (id, enabled, payload, extra = {}) => run(`INSERT INTO data.automations
      (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,created_at,updated_at,page_id,
       detached_at,last_run_at) VALUES ($1,'u','c',$2,$3,1,$4::jsonb,now(),now(),'p',$5,$6)`,
    [id, extra.next ?? "2026-11-03T01:00:42Z", enabled, JSON.stringify({ payloadVersion: 3, ...payload }),
      extra.detached ?? null, extra.lastRun ?? null]);
    const text = (value) => ({ input: { datum: { kind: "text", language: "natural-language", text: value } } });
    await automation("audit", true, { ...text("Audit the code\nfor bloat 🔁"), intervalMinutes: 720 });
    await automation("merge.review", false, { ...text("Review each merge"), intervalMinutes: 1440, triggers: [
      { kind: "merged", repository: "acme/api", branch: "main", paths: ["packages/hub", "docs"], installationId: "1" },
      { kind: "event", provider: "sentry", source: "*", feature: "issue.created" }] });
    await automation("renew", true, { ...text("Remind Yiming to renew"), intervalMinutes: 43200, once: true });
    await automation("tax", false, { ...text("Remind Daniel about the tax"), intervalMinutes: 43200, once: true },
      { lastRun: "2026-10-30T01:00:00Z" });
    await automation("orphan", false, { ...text("Sweep Sentry"), intervalMinutes: 10080 },
      { detached: "2026-10-01T00:00:00Z" });

    await run(fixture.source);
    // A second run finds every Automation with its line already.
    await run(fixture.source);

    const [page] = await run("SELECT head_revision FROM data.pages WHERE page_id='p'");
    assert.equal(Number(page.head_revision), 2);
    const [{ body: migrated }] = await run("SELECT body FROM data.page_revisions WHERE page_id='p' AND revision=2");
    assert.equal(migrated, [
      "# Ops", "",
      "## Audit",
      "- [ ] Audit the code for bloat 🔁 every 12 hours",
      "- Cadence: Merge [review] and more",
      "- [-] Review each merge 🔁 every day, on merged:acme/api@main:packages/hub,docs, on sentry:issue.created",
      "",
      "## Renewals",
      "- [ ] Remind Yiming to renew ⏳ 2026-11-03 01:00 Z",
      "- [x] Remind Daniel about the tax ⏳ 2026-11-03 01:00 Z ✅ 2026-10-30",
      "",
      "- [-] Sweep Sentry 🔁 every week",
      "",
    ].join("\n"));

    const rows = await run("SELECT automation_id,enabled,detached_at,payload_json FROM data.automations ORDER BY automation_id");
    const lines = new Map(pageSchedules(migrated).map((line) => [line.source, line]));
    for (const row of rows) {
      const line = lines.get(row.payload_json.source);
      assert.ok(line, `${row.automation_id} has its line`);
      assert.equal(line.error, undefined);
      assert.equal(line.instruction, row.payload_json.input.datum.text);
      assert.equal(line.intervalMinutes, row.payload_json.once ? undefined : row.payload_json.intervalMinutes);
      assert.equal(line.at, row.payload_json.at);
      assert.deepEqual(line.triggers, (row.payload_json.triggers ?? []).map(({ installationId: _, ...trigger }) => trigger));
      assert.equal(line.status === "running", row.enabled);
      assert.equal(row.detached_at, null);
    }
    assert.equal(lines.get(rows.find((row) => row.automation_id === "audit").payload_json.source).blockId, "audit");
  } finally {
    await fixture.close();
  }
});
