import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { SpaceControlError } from "./space-control.js";

export type TransferRole = "outbound" | "inbound";
export interface TransferRow extends QueryResultRow {
  space_id: string; proposal_id: string; target_space_id: string; channel_id: string;
  target_parent_id: string | null; created_by_kind: "user" | "agent"; created_by_id: string;
  snapshot_json: TransferSnapshot; outbound_user_id: string | null; inbound_user_id: string | null;
  outbound_at: string | Date | null; inbound_at: string | Date | null;
  status: "pending" | "completed"; created_at: string | Date; expires_at: string | Date;
}
interface TreeRow extends QueryResultRow {
  channel_id: string; space_id: string; name: string; mode: string; version: string | number;
}
interface MemberRow extends QueryResultRow {
  space_id: string; user_id: string; role: string; version: string | number; display_name?: string;
}
interface AccessRow extends QueryResultRow {
  channel_id: string; subject_kind: string; subject_id: string; grant_version: string | number;
}
export interface TransferSnapshot {
  tree: TreeRow[];
  spaces: Array<{ space_id: string; name: string; version: string | number }>;
  members: MemberRow[];
  access: AccessRow[];
  targetParent: TreeRow[];
}
const LIMIT = 10_000;
const conflict = () => new SpaceControlError("transfer_snapshot_changed", 409,
  "The tree or access changed. Create a new proposal and confirm both roles again.");

/** A target parent no longer exists; one an older proposal recorded is not compared. */
export function sameTransferSnapshot(left: unknown, right: unknown): boolean {
  const withoutParent = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), targetParent: [] } : value;
  left = withoutParent(left);
  right = withoutParent(right);
  const canonical = (value: unknown): string => {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return canonical(left) === canonical(right);
}

export async function transferSnapshot(tx: DatabaseTransaction, source: string, target: string,
  channelId: string): Promise<TransferSnapshot> {
  const spaces = await tx.query<TransferSnapshot["spaces"][number]>({
    name: "transfer_spaces_v1", text: `SELECT space_id, name, version FROM data.spaces
      WHERE space_id = ANY($1::text[]) ORDER BY space_id LIMIT 2`,
    values: [[source, target]], maxRows: 2,
  });
  if (spaces.length !== 2) throw new SpaceControlError("space_not_found", 404, "Space unavailable");
  // A conversation moves alone; whatever once sat under it stays in its Space.
  const tree = await tx.query<TreeRow>({
    name: "transfer_tree_snapshot_v3", text: `SELECT channel_id, space_id, name,
      mode, version, metadata_json FROM data.channels WHERE channel_id = $1 LIMIT 1`,
    values: [channelId], maxRows: 1,
  });
  const root = tree.find((row) => row.channel_id === channelId);
  if (!root || root.space_id !== source) throw new SpaceControlError("channel_not_found", 404, "Channel not found");
  const members = await tx.query<MemberRow>({
    name: "transfer_members_snapshot_v1", text: `SELECT space_id, user_id, role, version, display_name
      FROM data.space_members WHERE space_id = ANY($1::text[])
      ORDER BY space_id, user_id LIMIT ${LIMIT}`,
    values: [[source, target]], maxRows: LIMIT,
  });
  const access = await tx.query<AccessRow>({
    name: "transfer_access_snapshot_v1", text: `SELECT channel_id, subject_kind, subject_id, grant_version
      FROM data.channel_access WHERE space_id = $1 AND channel_id = ANY($2::text[])
      ORDER BY channel_id, subject_kind, subject_id LIMIT ${LIMIT}`,
    values: [source, tree.map((row) => row.channel_id)], maxRows: LIMIT,
  });
  if (members.length >= LIMIT || access.length >= LIMIT) throw new SpaceControlError(
    "transfer_snapshot_too_large", 409, "Transfer access review exceeds the supported bound");
  return { tree: [...tree], spaces: [...spaces], members: [...members], access: [...access],
    targetParent: [] };
}

export function requireTransferAdmin(snapshot: TransferSnapshot, spaceId: string, userId: string): void {
  if (!snapshot.members.some((row) => row.space_id === spaceId && row.user_id === userId &&
      (row.role === "owner" || row.role === "admin"))) throw new SpaceControlError(
    "transfer_admin_required", 403, "This role requires a current admin of its Space");
}

export function transferView(row: TransferRow, viewerUserId: string): Record<string, unknown> {
  const snapshot = row.snapshot_json;
  const source = snapshot.members.filter((member) => member.space_id === row.space_id);
  const target = new Set(snapshot.members.filter((member) => member.space_id === row.target_space_id)
    .map((member) => member.user_id));
  const lostUsers = source.filter((member) => !target.has(member.user_id) &&
    snapshot.tree.some((channel) => channel.mode === "open" || ["owner", "admin"].includes(member.role) ||
      snapshot.access.some((grant) => grant.channel_id === channel.channel_id &&
        grant.subject_kind === "user" && grant.subject_id === member.user_id)));
  const canAck = (spaceId: string) => snapshot.members.some((member) => member.space_id === spaceId &&
    member.user_id === viewerUserId && ["owner", "admin"].includes(member.role));
  return { id: row.proposal_id, sourceSpaceId: row.space_id, targetSpaceId: row.target_space_id,
    channelId: row.channel_id, targetParentId: row.target_parent_id, status: row.status,
    createdAt: row.created_at, expiresAt: row.expires_at,
    sourceName: snapshot.spaces.find((space) => space.space_id === row.space_id)?.name,
    targetName: snapshot.spaces.find((space) => space.space_id === row.target_space_id)?.name,
    tree: snapshot.tree.map((channel) => ({ id: channel.channel_id, name: channel.name })),
    lostUserIds: lostUsers.map((member) => member.user_id),
    lostUsers: lostUsers.map((member) => ({ id: member.user_id, name: member.display_name || member.user_id })),
    // An Agent grant names an Instance of a Run registered in the source Space,
    // so the moved tree never keeps it.
    lostAgentIds: [...new Set(snapshot.access.filter((grant) => grant.subject_kind === "agent")
      .map((grant) => grant.subject_id))],
    outbound: row.outbound_user_id ? { userId: row.outbound_user_id, at: row.outbound_at } : null,
    inbound: row.inbound_user_id ? { userId: row.inbound_user_id, at: row.inbound_at } : null,
    canAckOutbound: canAck(row.space_id), canAckInbound: canAck(row.target_space_id),
  };
}

export async function lockTransfer(tx: DatabaseTransaction, sourceSpaceId: string,
  proposalId: string): Promise<TransferRow> {
  const rows = await tx.query<TransferRow>({ name: "transfer_lock_v1",
    text: `SELECT * FROM data.channel_transfer_proposals
      WHERE space_id = $1 AND proposal_id = $2 FOR UPDATE`,
    values: [sourceSpaceId, proposalId], maxRows: 1 });
  if (!rows[0]) throw new SpaceControlError("transfer_not_found", 404, "Transfer proposal unavailable");
  return rows[0];
}

export async function validateTransfer(tx: DatabaseTransaction, row: TransferRow): Promise<TransferSnapshot> {
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new SpaceControlError(
    "transfer_expired", 409, "Transfer proposal expired; create a new proposal");
  const current = await transferSnapshot(tx, row.space_id, row.target_space_id, row.channel_id);
  if (!sameTransferSnapshot(current, row.snapshot_json)) throw conflict();
  return current;
}
