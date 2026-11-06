import { mergeInstanceRecord, type InstanceRecord } from "@xmatrix/protocol";

/**
 * The Instance record each live connection of this cell last wrote, exactly
 * as the database answered it. A connection's later reports of temporary work
 * show it beside them, so any report can place the Instance; nothing here is
 * composed by the Hub. Memory only: after hibernation the connection's next
 * write answers again.
 */
export class InstanceRecordCache {
  private readonly records = new Map<string, InstanceRecord>();

  get(instanceId: string): InstanceRecord | undefined {
    return this.records.get(instanceId);
  }

  /** Keep the further-along of what is held and what was answered. */
  remember(record: InstanceRecord): InstanceRecord {
    const held = this.records.get(record.id);
    const kept = held && held.channelId === record.channelId ? mergeInstanceRecord(held, record) : record;
    this.records.set(record.id, kept);
    return kept;
  }

  forget(instanceId: string): void {
    this.records.delete(instanceId);
  }
}
