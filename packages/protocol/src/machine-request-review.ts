/**
 * Frames an older daemon still sends when it asks its owner to approve a host
 * command. Host-command approval is retired: the Hub refuses these, and keeps
 * the types only so it can recognize and answer them.
 */
export interface MachineRequestNoticeMessage {
  type: "machine_request_notice";
  requestId?: string;
  channelId: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface MachineRequestNoticeAcceptedMessage {
  type: "machine_request_notice_accepted";
  requestId?: string;
  channelId: string;
  messageId: string;
}
