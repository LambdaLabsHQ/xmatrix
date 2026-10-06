import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { MessageAuthorityError } from "./message-authority-error.js";
import { inActiveSpace } from "./page-control.js";

/**
 * An open project's standing rules (docs/design/open-project-governance.md):
 * whether anyone with a linked GitHub account may join as a participant, and
 * which page states the rules. Both are a Space owner's or admin's to set.
 */
export class GovernanceError extends MessageAuthorityError {
  constructor(code: string, status: number, message = code) {
    super(code, status, message);
  }
}

export interface SpaceGovernance {
  spaceId: string;
  ownerUserId: string;
  openParticipation: boolean;
  governancePageId: string | null;
}

interface SpaceRow extends QueryResultRow {
  owner_user_id: string;
  metadata_json: Record<string, unknown> | null;
}

function governanceOf(spaceId: string, row: SpaceRow): SpaceGovernance {
  const metadata = row.metadata_json ?? {};
  return {
    spaceId,
    ownerUserId: row.owner_user_id,
    openParticipation: metadata.openParticipation === true,
    governancePageId: typeof metadata.governancePageId === "string" ? metadata.governancePageId : null,
  };
}

export class PostgresGovernanceRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new GovernanceError("cached_authority_forbidden", 500);
  }

  /** Readable by anyone: an open project says so on its public pages. */
  async read(input: { requestId: string; spaceId: string }): Promise<SpaceGovernance> {
    return inActiveSpace(this.database, { requestId: input.requestId, operation: "governance.read",
      spaceId: input.spaceId }, GovernanceError, async (tx) => governanceOf(input.spaceId, await this.space(tx, input.spaceId)));
  }

  /** The person's role in the Space, or null when they are not a member. */
  async roleOf(input: { requestId: string; spaceId: string; userId: string }): Promise<string | null> {
    return inActiveSpace(this.database, { requestId: input.requestId, operation: "governance.role",
      spaceId: input.spaceId }, GovernanceError, async (tx) => (await tx.query<QueryResultRow & { role: string }>({
      name: "governance_member_role_v1",
      text: "SELECT role FROM data.space_members WHERE space_id=$1 AND user_id=$2",
      values: [input.spaceId, input.userId], maxRows: 1 }))[0]?.role ?? null);
  }

  async update(input: { requestId: string; spaceId: string; userId: string;
    openParticipation?: boolean; governancePageId?: string | null }): Promise<SpaceGovernance> {
    return inActiveSpace(this.database, { requestId: input.requestId, operation: "governance.update",
      spaceId: input.spaceId }, GovernanceError, async (tx) => {
      const role = (await tx.query<QueryResultRow & { role: string }>({ name: "governance_member_role_v1",
        text: "SELECT role FROM data.space_members WHERE space_id=$1 AND user_id=$2",
        values: [input.spaceId, input.userId], maxRows: 1 }))[0]?.role;
      if (role !== "owner" && role !== "admin") {
        throw new GovernanceError("governance_maintainers_only", 403, "Only Space owners and admins set how the project is run");
      }
      const current = await this.space(tx, input.spaceId, true);
      if (typeof input.governancePageId === "string") {
        const page = await tx.query({ name: "governance_page_exists_v1",
          text: "SELECT 1 FROM data.pages WHERE space_id=$1 AND page_id=$2",
          values: [input.spaceId, input.governancePageId], maxRows: 1 });
        if (!page[0]) throw new GovernanceError("page_not_found", 404, "That page is not in this Space");
      }
      const metadata = { ...current.metadata_json };
      if (input.openParticipation !== undefined) metadata.openParticipation = input.openParticipation;
      if (input.governancePageId !== undefined) {
        if (input.governancePageId === null) delete metadata.governancePageId;
        else metadata.governancePageId = input.governancePageId;
      }
      await tx.query({ name: "governance_update_v1",
        text: `UPDATE data.spaces SET metadata_json=$2::jsonb, version=version+1, updated_at=now()
          WHERE space_id=$1`,
        values: [input.spaceId, JSON.stringify(metadata)], maxRows: 0 });
      return governanceOf(input.spaceId, { ...current, metadata_json: metadata });
    });
  }

  private async space(tx: DatabaseTransaction, spaceId: string, lock = false): Promise<SpaceRow> {
    const row = (await tx.query<SpaceRow>({ name: lock ? "governance_space_lock_v1" : "governance_space_v1",
      text: `SELECT owner_user_id, metadata_json FROM data.spaces WHERE space_id=$1${lock ? " FOR UPDATE" : ""}`,
      values: [spaceId], maxRows: 1 }))[0];
    if (!row) throw new GovernanceError("space_not_found", 404);
    return row;
  }
}
