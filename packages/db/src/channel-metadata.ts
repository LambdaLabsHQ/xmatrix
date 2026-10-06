import type { QueryResultRow } from "pg";
import { channelSummarySource } from "@xmatrix/protocol";

type ChannelMetadata = Record<string, unknown> | undefined;

/** Who created a Channel: the creator its metadata records, else the row's fallback. */
export function channelCreator(metadata: ChannelMetadata, fallback: string | undefined): string | undefined {
  return typeof metadata?.xmatrixCreatedByUserId === "string"
    ? metadata.xmatrixCreatedByUserId
    : typeof metadata?.createdBy === "string" ? metadata.createdBy : fallback;
}

/** A Channel's topic, its summary and where that summary came from, as a serialized Channel carries them. */
export function channelDescription(metadata: ChannelMetadata): Record<string, unknown> {
  const summarySource = typeof metadata?.summary === "string" ? channelSummarySource(metadata) : undefined;
  return {
    ...(typeof metadata?.topic === "string" ? { topic: metadata.topic } : {}),
    ...(typeof metadata?.summary === "string" ? { summary: metadata.summary } : {}),
    ...(summarySource ? { summarySource } : {}),
  };
}

/** The Channel fields shared by catalog and control reads. */
export interface ChannelPresentationRow extends QueryResultRow {
  channel_id: string;
  space_id: string;
  name: string;
  mode: string;
  metadata_json: Record<string, unknown> | null;
  version: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export function channelIdentity(row: ChannelPresentationRow): Record<string, unknown> {
  return { id: row.channel_id, version: Number(row.version), spaceId: row.space_id, name: row.name,
    ...channelDescription(row.metadata_json ?? undefined), mode: row.mode };
}

/** Optional metadata and its creator, read consistently by control and catalog serializers. */
export function channelPresentation(row: ChannelPresentationRow & { created_by_fallback?: string }) {
  const metadata = row.metadata_json ?? undefined;
  return { metadata, createdBy: channelCreator(metadata, row.created_by_fallback) };
}
