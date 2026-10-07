import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/** The page that states a Space's rules (its governance page,
 * docs/design/open-project-governance.md §4), named on every Run's spawn so
 * the Agent reads and follows it. Only the id travels: the Agent reads the
 * page on demand, so a launch never carries a copy of page text
 * (guardrail P2#9). A page deleted since it was chosen names nothing. */
export async function spaceRulesSpawnFields(tx: DatabaseTransaction, spaceId: string): Promise<{ spaceRulesPageId?: string }> {
  const rows = await tx.query<QueryResultRow & { page_id: string }>({
    name: "space_rules_spawn_page_v1",
    text: `SELECT p.page_id FROM data.spaces s
      JOIN data.pages p ON p.space_id=s.space_id AND p.page_id=s.metadata_json->>'governancePageId'
      WHERE s.space_id=$1`,
    values: [spaceId], maxRows: 1 });
  const pageId = rows[0]?.page_id;
  return pageId ? { spaceRulesPageId: String(pageId) } : {};
}
