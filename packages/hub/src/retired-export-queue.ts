/**
 * The retired relay export Queue is still bound to this Worker as a consumer in
 * Cloudflare, and a Worker bound to a consumer must export a queue handler or
 * the deploy is rejected (11001). Nothing produces to the Queue any more, so a
 * stray delivery is acknowledged and dropped. Remove this once the consumer is
 * unbound from the Worker.
 */
export function ackRetiredExportQueue(batch: Pick<MessageBatch<unknown>, "ackAll">): void {
  batch.ackAll();
}
