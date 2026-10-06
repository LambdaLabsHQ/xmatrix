import type { DatabaseTransaction } from "./contracts.js";

/**
 * Appends one `data.outbox` row. Every authority path writes the same fourteen
 * columns, so they share this one statement and keep only their own telemetry
 * name, topic, aggregate identity, payload, and time. The written row is
 * identical to the statement each caller used to inline.
 */
export async function writeOutbox(
  transaction: DatabaseTransaction,
  input: {
    name: string;
    outboxId: string;
    spaceId: string;
    topic: string;
    aggregateKind: string;
    aggregateId: string;
    aggregateSequence: number;
    payload: unknown;
    at: string;
  },
): Promise<void> {
  await transaction.query({
    name: input.name,
    text: `INSERT INTO data.outbox
      (outbox_id,space_id,topic,aggregate_kind,aggregate_id,aggregate_sequence,
       payload_json,status,attempts,available_at,lease_until,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',0,$8,NULL,$8,$8)`,
    values: [input.outboxId, input.spaceId, input.topic, input.aggregateKind,
      input.aggregateId, input.aggregateSequence, JSON.stringify(input.payload), input.at],
    maxRows: 0,
  });
}
