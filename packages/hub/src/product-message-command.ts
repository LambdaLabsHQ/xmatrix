/** The append command and attachment facts PostgreSQL message authority accepts. */

export interface AuthorityPrincipal {
  kind: "user" | "agent";
  id: string;
  // Worker-asserted registration Space, bound into the Agent Run token at mint
  // time from the authoritative registration read. Absent claim = no
  // allowance; explicit grants still apply.
  agentSpaceId?: string;
}

export interface ProductMessageAttachmentBinding {
  attachmentId: string;
  objectKey: string;
  contentHash: string;
  encodedBytes: number;
  mimeType: string;
  name: string;
  presentationResidual?: Readonly<Record<string, boolean | null | number | string>>;
}

export interface AppendMessageCommand {
  commandId: string;
  messageId: string;
  channelId: string;
  body: string;
  /** Final intent is only valid with the exact authenticated Agent Run proof. */
  finalReplyExecutionId?: string;
  principal: AuthorityPrincipal;
  /**
   * Trusted scheduled-evaluation sponsor, revalidated atomically with append.
   * Public HTTP parsing intentionally omits this field.
   */
  authorityRootUserId?: string;
  /** Open business kind; never a database enum. */
  messageKind?: string;
  /** Immutable sent-time display/runtime facts supplied by a trusted caller. */
  senderSnapshot?: Record<string, unknown>;
  /**
   * Exact live-run proof supplied only by the Agent Instance runtime.
   *
   * Authority uses this to bind every runtime message to its Run and to render an
   * exact management-delegate Run as xMatrix without changing the underlying
   * audited Agent identity.
   */
  agentRunProof?: {
    runId: string;
    executionKey: string;
    instanceId: string;
  };
  /** Only message-owned fields which have no canonical column/aggregate. */
  residual?: Record<string, unknown>;
  /**
   * Human-uploaded refs that Authority binds before the initial live delivery.
   * Binary bodies are never accepted here.
   */
  attachments?: ProductMessageAttachmentBinding[];
  /**
   * Trusted product-gateway-only App author. Authorization continues to use
   * principal; public HTTP parsing intentionally omits this field.
   */
  appAuthorId?: string;
  /**
   * Trusted product-gateway-only: xMatrix itself (`system:xmatrix`) is the
   * author. Authorization continues to use principal; HTTP parsing omits it.
   */
  xmatrixAuthor?: true;
  /** Trusted migration-only overrides; HTTP parsing intentionally omits them. */
  senderId?: string;
  sentAt?: string;
  /**
   * Trusted migration-only: who wrote an imported message in the workspace it
   * came from, presented under their own name, email and avatar. It never
   * resolves to an xMatrix account; HTTP parsing omits it.
   */
  importedAuthor?: { source: "slack"; id: string; name: string; email?: string; avatarUrl?: string };
  /**
   * Trusted thread-creation override. A root copy retains the source sender
   * kind while channel access is still checked against the creating Human.
   * HTTP parsing intentionally omits this field.
   */
  threadRootCopyAuthorKind?: "user" | "agent";
  /** Trusted thread-creation override; HTTP parsing intentionally omits it. */
  threadRootCopyEditedAt?: string;
  /**
   * Stable targets resolved by the Channel's Space authority. Public parsers
   * intentionally omit this field; Channel-family accepts no client target metadata.
   */
  resolvedAttentionTargets?: Array<{
    subjectId: string;
    kind: "mention" | "broadcast";
  }>;
  /** Untrusted structured picker intent; only the owning message authority validates it. */
  invocationSelections?: unknown;
}

export const REDACTED_CONTENT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Product-gateway presentation kind derived from the stored MIME type. */
export function productGatewayAttachmentKind(
  mimeType: string,
): "image" | "video" | "markdown" | "file" {
  const normalized = mimeType.trim().toLowerCase();
  if (
    normalized === "image/png" || normalized === "image/jpeg" ||
    normalized === "image/webp" || normalized === "image/gif"
  ) {
    return "image";
  }
  if (
    normalized === "video/mp4" || normalized === "video/quicktime" ||
    normalized === "video/webm" || normalized === "video/ogg" ||
    normalized === "video/x-m4v"
  ) {
    return "video";
  }
  if (normalized === "text/markdown" || normalized === "text/x-markdown") {
    return "markdown";
  }
  return "file";
}
