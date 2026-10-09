"use client";
import { loadImage, canvasToBlob } from "./image-canvas";
export { loadImage, canvasToBlob } from "./image-canvas";
import { attachmentMediaMimeType } from "./attachment-media-type";
import { meterTone, type MachineGlanceReading } from "./machine-load";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import { useOpenMachine } from "./machine-link";
import type { PresentedChannelMemberPresence as ChannelMemberPresence } from "./workspace-shell-presence";
import { channelVisibilityScope, digestCanonicalCloneCborV1, parseLlmQuotaAccount, parseQuotaObservedAt, isUnlistedParameterTag, statusTagIcon, type AgentInvocationSelections, type DraftSummonIntent, type StatusTagIcon } from "@xmatrix/protocol";
import { formatLocalClock, formatZonedDateTime } from "./time-display";

import { matchClaimableOutgoing } from "./outgoing-message-claim";
import { currentHumanDisplayName } from "./human-profile-summary";
import { messageLinkOrigin } from "./message-link-origin";
import {
  MessageSendDeadlineError,
  performBoundedMessageAppend,
} from "@/lib/relay-v2/message-send-deadline";

import {
  channelMembersByPresence,
  isChannelResidentPresence,
  isOlderThan,
  isOnlinePresence,
  latestAgentWorkEvent,
  memberPresence,
  presenceStatusLabel,
} from "./workspace-shell-presence";

import { statusChipClass } from "@/components/ui/status-tone";
import { TAG_SHAPE_CLASS, Tag, UsageMeterFill } from "./status-tag";

export {
  agentInstanceDisplayStatus,
  agentInstancePresenceLabel,
  agentTraceEventPhase,
  channelMembersByPresence,
  isAgentLlmTraceEvent,
  isAgentSpawnEvent,
  isAgentTraceEvent,
  isDaemonChannelMember,
  isLlmTraceEvent,
  isOlderThan,
  isOnlinePresence,
  isTraceDeltaPhase,
  latestAgentWorkEvent,
  memberPresence,
  presenceStatusLabel,
  relativeTime,
} from "./workspace-shell-presence";

import type {
  AgentTraceTarget,
  AgentWorkItem,
  ChannelAgentAvatarItem,
  ComposerChannelAttachment,
  ThreadReplyParticipant,
  TimelineItem,
} from "./workspace-shell-message-model";

import {
  agentInstanceDisplayName,
  isXMatrixSystemNoticeMessage,
  messageAttachmentBindings,
  messageProvenance,
  messageRichMetadata,
  replyPreviewSequence,
  shortId,
  systemNoticeTone,
  timelineItemId,
} from "./workspace-shell-message-model";

import {
  agentInstanceDisplayStatus,
} from "./workspace-shell-presence";

import {
  AGENT_SPAWN_HANDOFF_GRACE_MS,
  AGENT_SPAWN_PENDING_MAX_AGE_MS,
  MARKDOWN_ATTACHMENT_EXTENSIONS,
  MARKDOWN_ATTACHMENT_TYPES,
  MAX_COMPRESSED_IMAGE_DIMENSION,
  MAX_IMAGE_ATTACHMENT_BYTES,
  XMATRIX_SYSTEM_AVATAR_URL,
} from "./workspace-shell-constants";

import {
  channelAttachmentKindForMimeType,
  agentInstanceUsageLimit,
  attentionSummaryFromEvent,
  formatPercent,
  formatQuotaResetAt,
  metadataString,
} from "./workspace-shell-formatters";

import {
  ChannelHistoryCacheEntry,
  LlmQuotaUsage,
  LlmUsage,
  OutgoingMessage,
  agentBusyTraceStaleActivity,
} from "./workspace-shell-helpers";

import {
  timestampMs,
} from "./workspace-shell-helpers-extra";

import {
  encodedImageDimensions,
  fitImageDimensions,
  nextImageCompressionDimensions,
} from "./image-attachment-compression";
import type { ImageDimensions } from "./image-attachment-compression";

import { LoadingImage, MediaSkeleton } from "./content-skeleton";
import { threadReplyPreviews } from "./thread-reply-preview";

import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { createPortal } from "react-dom";

import {
  AlertTriangle,
  AtSign,
  Cpu,
  FileText,
  FolderOpen,
  Gauge,
  Monitor,
  Paperclip,
  Pin,
  UserRound,
  Video,
  X,
  Zap,
} from "lucide-react";

import { IdentityAvatar } from "@/components/dashboard/identity-avatar";

import type { StatusChip } from "./workspace-shell-domain-types";

import { RepoOcticon } from "@/components/ui/octicons";

import {
  parseAppMentions,
} from "@/components/dashboard/mention-complete";

import {
  filterHistoryForChannel,
} from "@/components/dashboard/channel-history";

import {
  agentTraceInstanceIds,
} from "@/components/dashboard/agent-trace-target";

import {
  runIdempotentMutationFetchWithRetry,
} from "@/components/dashboard/workspace-refresh-policy";

import { secretRequestMetadata } from "@/components/dashboard/secret-request-card";

import { normalizeMessageBodyForDisplay } from "@/components/dashboard/message-text";

import {
  type DesktopBridge,
  type DesktopContext,
} from "@/lib/desktop/bridge";
import { requireAcceptedAppCompatibilityIdentity } from "@/lib/app-client-compatibility";

import {
  commitMessageAttachmentRefs,
  prepareMessageAttachmentUpload,
} from "@/lib/relay-v2/message-attachment-upload-client";

import { cn } from "@/lib/utils";

import { WEB_PROXY_ROUTES, agentAvatarUrlFromMetadata } from "@xmatrix/protocol";

import type {
  AgentGoalStatus,
  ChannelAttachment,
  ChannelMessage,
  MessageSender,
  ObservabilityEvent,
  SerializedAgent,
  SerializedAgentLaunch,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedSpace,
} from "@xmatrix/protocol";
import { xmatrixRawResponse, XMatrixApiError } from "@/lib/query/api-client";
import { UserFacingProblem } from "@/lib/user-facing-error";

// Recovered monofile top-level declarations missing from split modules
// (inMemoryRelayClientProfileId lives in workspace-shell-helpers.tsx)

export type PendingAttachment = {
  id: string;
  kind: ChannelAttachment["kind"];
  name: string;
  size: number;
  status: "reading" | "uploading" | "failed";
  progress: number;
  error?: string;
  /** A local object URL for an image, so it can be seen before it is uploaded. */
  previewUrl?: string;
};

export function PendingAttachmentCard({
  attachment,
  onOpen,
  onRemove,
}: {
  attachment: PendingAttachment;
  onOpen?: () => void;
  onRemove: () => void;
}) {
  const Icon =
    attachment.kind === "video"
      ? Video
      : attachment.kind === "markdown"
        ? FileText
        : Paperclip;
  const failed = attachment.status === "failed";
  const progress = Math.max(0, Math.min(100, Math.round(attachment.progress)));
  const statusLabel = failed
    ? "Failed"
    : attachment.status === "uploading"
      ? progress >= 95
        ? "Verifying upload"
        : `Uploading ${progress}%`
      : "Preparing";
  return (
    <div className="group relative flex h-20 w-44 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      {attachment.previewUrl && onOpen ? (
        <button
          type="button"
          aria-label={`Open ${attachment.name}`}
          className="block size-20 shrink-0 cursor-zoom-in bg-background"
          onClick={onOpen}
        >
          <LoadingImage
            src={attachment.previewUrl}
            alt={attachment.name}
            className="block h-full w-full object-cover"
          />
        </button>
      ) : attachment.kind === "image" ? (
        <MediaSkeleton label="Loading image" className="app-media-skeleton-thumb" />
      ) : (
        <div className={cn("flex size-20 shrink-0 items-center justify-center", attachment.kind === "video" ? "bg-black text-white" : "bg-background text-muted-foreground")}>
          <Icon className="size-6" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2 py-2">
        <div className="truncate text-xs font-bold text-foreground" title={attachment.name}>
          {attachment.name}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {statusLabel} · {formatFileSize(attachment.size)}
        </div>
        {failed ? (
          <div className="line-clamp-1 text-[11px] text-destructive" title={attachment.error}>
            {attachment.error || "Upload failed"}
          </div>
        ) : (
          <div className="h-1.5 overflow-hidden rounded-full bg-background">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.max(4, progress)}%` }}
            />
          </div>
        )}
      </div>
      <button
        type="button"
        title={failed ? "Remove failed upload" : "Cancel upload"}
        aria-label={failed ? `Remove ${attachment.name}` : `Cancel ${attachment.name}`}
        onClick={onRemove}
        className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background text-foreground shadow ring-1 ring-border hover:bg-muted"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function isMarkdownAttachmentFile(file: File): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return MARKDOWN_ATTACHMENT_TYPES.has(type) || MARKDOWN_ATTACHMENT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function attachmentMimeTypeForFile(file: File): string {
  if (isMarkdownAttachmentFile(file)) return "text/markdown";
  return normalizeAttachmentMimeType(attachmentMediaMimeType(file.type, file.name));
}

export function normalizeAttachmentMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)
    ? normalized
    : "application/octet-stream";
}

export function channelAttachmentKindForFile(file: File): ChannelAttachment["kind"] {
  if (isMarkdownAttachmentFile(file)) return "markdown";
  return channelAttachmentKindForMimeType(file.type, file.name);
}

export function defaultAttachmentName(kind: ChannelAttachment["kind"]): string {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "markdown") return "document.md";
  return "attachment";
}

export /**
 * Every human message, including a thread reply, owns its attachments through
 * the same immutable ref transaction. The child thread only changes channelId;
 * it never inherits or copies the root message's media references.
 */
async function appendChannelMessageWithAttachments(input: {
  token: string;
  channel: Pick<SerializedChannel, "id" | "mode" | "spaceId">;
  clientMessageId: string;
  body: string;
  attachments: readonly ChannelAttachment[];
  replyToMessageId?: string;
  appMentions: ReturnType<typeof parseAppMentions>;
  invocationSelections?: AgentInvocationSelections;
  /** Jev's reading of each summon while the author typed this exact body. */
  summonIntents?: DraftSummonIntent[];
  deadlineMs?: number;
}): Promise<{
  message?: unknown;
  channel?: SerializedChannel;
  appConnectorResultChannels?: SerializedChannel[];
}> {
  if (input.invocationSelections && input.invocationSelections.sourceBodyHash !== await digestCanonicalCloneCborV1(input.body)) {
    throw new Error("Agent selection does not match the message body");
  }
  const attachmentBindings = messageAttachmentBindings(input.attachments);
  if (attachmentBindings.length > 0) {
    await commitMessageAttachmentRefs({
      token: input.token,
      messageId: input.clientMessageId,
      visibilityScopeId: channelVisibilityScope({ mode: input.channel.mode, channelId: input.channel.id, spaceId: input.channel.spaceId }),
      attachments: attachmentBindings,
    });
  }
  const requestBody = JSON.stringify({
    body: input.body,
    clientMessageId: input.clientMessageId,
    replyToMessageId: input.replyToMessageId,
    appMentions: input.appMentions.length > 0 ? input.appMentions : undefined,
    invocationSelections: input.invocationSelections,
    summonIntents: input.summonIntents?.length ? input.summonIntents : undefined,
    attachments: attachmentBindings.length > 0 ? attachmentBindings : undefined,
  });
  // The deadline, retry bounding and outcome classification live in
  // `message-send-deadline` so production and its tests run the same code. A
  // classification bug here decides whether a person is told their message
  // failed or that its fate is unknown, which is not something to duplicate.
  const outcome = await performBoundedMessageAppend({
    deadlineMs: input.deadlineMs,
    withRetry: (attempt, options) => runIdempotentMutationFetchWithRetry(attempt, options),
    send: (signal) =>
      xmatrixRawResponse(WEB_PROXY_ROUTES.channel_messages(input.channel.id), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: requestBody,
        cache: "no-store",
        signal,
      }),
  });
  if (outcome.kind === "unconfirmed") throw new MessageSendDeadlineError();
  if (outcome.kind === "failed") throw new XMatrixApiError(outcome);
  return outcome.payload as {
    message?: unknown;
    channel?: SerializedChannel;
    appConnectorResultChannels?: SerializedChannel[];
  };
}

export async function uploadChannelAttachment(
  visibilityScopeId: string,
  token: string,
  file: File,
  onProgress?: (progress: number) => void,
  /** Return false to cancel before the request is sent; see prepareMessageAttachmentUpload. */
  onRequest?: (request: XMLHttpRequest) => boolean | void
): Promise<ChannelAttachment> {
  const mimeType = attachmentMimeTypeForFile(file);
  const upload = await prepareMessageAttachmentUpload({
    file,
    token,
    visibilityScopeId,
    mimeType,
    onProgress,
    onRequest,
  });
  return {
    id: upload.attachmentId,
    kind: channelAttachmentKindForFile(file),
    name: upload.name,
    mimeType,
    size: file.size,
    url: URL.createObjectURL(file),
    objectKey: upload.objectKey,
    contentHash: upload.contentHash,
    relayV2Upload: upload,
  } as ComposerChannelAttachment;
}

export async function attachVideoMetadata(
  file: File,
  attachment: ChannelAttachment
): Promise<ChannelAttachment> {
  const metadata = await readVideoAttachmentMetadata(file).catch(() => null);
  if (!metadata) return attachment;

  return {
    ...attachment,
    durationMs: metadata.durationMs,
    width: metadata.width,
    height: metadata.height,
    transcodingStatus: "not_required",
  };
}

export type VideoAttachmentMetadata = {
  durationMs?: number;
  width?: number;
  height?: number;
};

export async function readVideoAttachmentMetadata(file: File): Promise<VideoAttachmentMetadata> {
  if (typeof document === "undefined") return {};

  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new UserFacingProblem("This video couldn't be read."));
      video.src = objectUrl;
    });

    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined;
    const width = video.videoWidth || undefined;
    const height = video.videoHeight || undefined;
    const seekTarget = Number.isFinite(video.duration) && video.duration > 1 ? Math.min(1, video.duration / 10) : 0;
    if (seekTarget > 0) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = seekTarget;
      });
    }

    return { durationMs, width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function prepareImageAttachmentFile(file: File): Promise<File | null> {
  if (file.size <= MAX_IMAGE_ATTACHMENT_BYTES || file.type === "image/gif") {
    return file;
  }

  const compressed = await compressImageFileForUpload(file).catch(() => null);
  const uploadFile = compressed && compressed.size < file.size ? compressed : file;
  return uploadFile.size <= MAX_IMAGE_ATTACHMENT_BYTES ? uploadFile : null;
}

export async function compressImageFileForUpload(file: File): Promise<File | null> {
  if (typeof document === "undefined" || file.type === "image/gif") return null;

  const blob =
    (await compressImageBitmapToJpegBlob(file).catch(() => null)) ??
    (await compressImageElementToJpegBlob(file, MAX_IMAGE_ATTACHMENT_BYTES));
  if (!blob) return null;

  const baseName = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
}

/**
 * Preferred path: `createImageBitmap` decodes without blocking the main thread
 * and `OffscreenCanvas.convertToBlob` encodes asynchronously. A lightweight
 * header read supplies dimensions so the bitmap is resized while decoding,
 * rather than decoding a full-resolution source only to shrink it on canvas.
 */
async function compressImageBitmapToJpegBlob(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return null;

  const resize = await imageBitmapResizeDimensions(file).catch(() => null);
  const bitmap = resize
    ? await createImageBitmap(file, {
      resizeWidth: resize.width,
      resizeHeight: resize.height,
      resizeQuality: "high",
    })
    : await createImageBitmap(file);
  try {
    return await encodeJpegLadder({
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      targetBytes: MAX_IMAGE_ATTACHMENT_BYTES,
      encode: async (width, height, quality) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.clearRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        return canvas.convertToBlob({ type: "image/jpeg", quality });
      },
    });
  } finally {
    bitmap.close?.();
  }
}

const IMAGE_DIMENSION_HEADER_BYTES = 256 * 1024;

async function imageBitmapResizeDimensions(file: File): Promise<ImageDimensions | null> {
  const header = new Uint8Array(await file.slice(0, IMAGE_DIMENSION_HEADER_BYTES).arrayBuffer());
  const source = encodedImageDimensions(header);
  if (!source) return null;
  const resize = fitImageDimensions(source, MAX_COMPRESSED_IMAGE_DIMENSION);
  return resize.width < source.width || resize.height < source.height ? resize : null;
}

async function compressImageElementToJpegBlob(file: File, targetBytes: number): Promise<Blob | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await compressImageSourceToJpegBlob(objectUrl, targetBytes);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function compressImageSourceToJpegBlob(src: string, targetBytes: number): Promise<Blob | null> {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;

  return encodeJpegLadder({
    sourceWidth: image.naturalWidth || image.width,
    sourceHeight: image.naturalHeight || image.height,
    targetBytes,
    encode: async (width, height, quality) => {
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      return canvasToBlob(canvas, "image/jpeg", quality);
    },
  });
}

/** Shared quality/scale ladder so both encoders produce the same result. */
async function encodeJpegLadder(input: {
  sourceWidth: number;
  sourceHeight: number;
  targetBytes: number;
  encode: (width: number, height: number, quality: number) => Promise<Blob | null>;
}): Promise<Blob | null> {
  let { width, height } = fitImageDimensions(
    { width: input.sourceWidth, height: input.sourceHeight },
    MAX_COMPRESSED_IMAGE_DIMENSION,
  );

  let bestBlob: Blob | null = null;
  for (const quality of [0.86, 0.74, 0.62]) {
    const blob = await input.encode(width, height, quality);
    if (!blob) return bestBlob;
    if (!bestBlob || blob.size < bestBlob.size) {
      bestBlob = blob;
    }
    if (blob.size <= input.targetBytes) {
      return blob;
    }

    ({ width, height } = nextImageCompressionDimensions({
      dimensions: { width, height },
      encodedBytes: blob.size,
      targetBytes: input.targetBytes,
    }));
  }

  return bestBlob;
}

export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];

  const itemFiles = Array.from(data.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);

  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(data.files || []).filter((file) => file.type.startsWith("image/"));
}

export function clipboardHasTextPayload(data: DataTransfer): boolean {
  const types = Array.from(data.types || []);
  if (types.some((type) => type === "text/plain" || type === "text" || type.startsWith("text/"))) {
    return true;
  }

  return Boolean(data.getData("text/plain") || data.getData("text"));
}

export function isValidMessageSender(sender: unknown): sender is MessageSender {
  if (!sender || typeof sender !== "object") return false;
  const candidate = sender as Partial<MessageSender>;
  return (
    // Every sender kind shows, including ones this client does not know yet.
    typeof candidate.kind === "string" && candidate.kind.length > 0 &&
    typeof candidate.label === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.email === "string"
  );
}

export function isValidChannelMessage(entry: unknown): entry is ChannelMessage {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ChannelMessage>;
  if (
    typeof candidate.messageId !== "string" ||
    typeof candidate.channelId !== "string" ||
    typeof candidate.body !== "string" ||
    typeof candidate.sentAt !== "string" ||
    !isValidMessageSender(candidate.from)
  ) {
    return false;
  }
  return true;
}

export function matchOutgoingClientId(
  entry: ChannelMessage,
  pending: OutgoingMessage[]
): string | undefined {
  // The decision lives in `outgoing-message-claim` so it can be tested: it is a
  // heuristic over message content (a committed message carries no
  // `clientMessageId`), and claiming the wrong row retires somebody else's
  // message.
  return matchClaimableOutgoing(entry, pending);
}

export function claimOutgoingClientIdForEntry(
  entry: ChannelMessage,
  pending: OutgoingMessage[],
  outboundClientIdsByMessageId: Map<string, string>,
  outboundPreviewByClientId: Map<string, { sentAt: string; attachments: ChannelAttachment[] }>
): string | undefined {
  const existing = outboundClientIdsByMessageId.get(entry.messageId);
  if (existing) return existing;
  const matched = matchOutgoingClientId(entry, pending);
  if (!matched) return undefined;
  outboundClientIdsByMessageId.set(entry.messageId, matched);
  const source = pending.find((item) => item.clientMessageId === matched);
  if (source && !outboundPreviewByClientId.has(matched)) {
    outboundPreviewByClientId.set(matched, {
      sentAt: source.sentAt,
      attachments: source.attachments,
    });
  }
  return matched;
}

export function appendOutgoingTimelineItems(
  timeline: TimelineItem[],
  outgoing: OutgoingMessage[],
  channelId: string | undefined,
  currentUser?: { id: string; email: string; name?: string; avatarUrl?: string } | null
): TimelineItem[] {
  if (!channelId || outgoing.length === 0) return timeline;
  const confirmedClientIds = new Set(
    timeline
      .map((message) => message.clientMessageId)
      .filter((value): value is string => Boolean(value))
  );
  const pendingItems = outgoing
    .filter(
      (message) =>
        message.channelId === channelId && !confirmedClientIds.has(message.clientMessageId)
    )
    .map((message): TimelineItem => ({
      id: timelineItemId(message.clientMessageId, undefined),
      channelId: message.channelId,
      clientMessageId: message.clientMessageId,
      author: currentUser ? currentHumanDisplayName(currentUser) : "You",
      body: message.body,
      replyToMessageId: message.replyToMessageId,
      replyTo: message.replyTo,
      attachments: message.attachments.length > 0 ? message.attachments : undefined,
      sentAt: message.sentAt,
      avatarUrl: currentUser?.avatarUrl,
      own: true,
      senderKind: "user",
      senderStatus: "online",
      sendStatus: message.status,
      sendError: message.error,
    }));
  if (pendingItems.length === 0) return timeline;
  return [...timeline, ...pendingItems].sort(
    (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()
  );
}

export function buildTimeline(
  history: ChannelMessage[],
  channel: SerializedChannel | null,
  channels: SerializedChannel[],
  events: ObservabilityEvent[],
  currentUser?: { id: string; email: string; name?: string; avatarUrl?: string } | null,
  channelReadCounts: Record<string, number> = {},
  historyCache?: Map<string, ChannelHistoryCacheEntry>,
  outboundClientIdsByMessageId?: Map<string, string>,
  outboundPreviewByClientId?: Map<string, { sentAt: string; attachments: ChannelAttachment[] }>,
  spaceMembers: SerializedSpace["members"] = [],
): TimelineItem[] {
  const currentUserEmail = currentUser?.email.trim().toLowerCase();
  const currentUserIdentityId = currentUser ? `user:${currentUser.id}` : undefined;
  const channelHistory = channel
    ? filterHistoryForChannel(channel.id, history)
    : history;
  const presenceByMember = new Map<string, ChannelMemberPresence>();
  const presenceByEmail = new Map<string, ChannelMemberPresence>();
  const presenceByLabel = new Map<string, ChannelMemberPresence>();
  // An agent sender's identity need not match the member entry its live Instance
  // sits under; the instance id is the one key both sides share, so an agent
  // sender resolves through it before any name lookup.
  const presenceByInstanceId = new Map<string, ChannelMemberPresence>();

  if (channel) {
    for (const member of channelMembersByPresence(channel)) {
      const presence = memberPresence(channel, member);
      presenceByMember.set(member, presence);
      const email = presence.email?.trim().toLowerCase();
      if (email && !presenceByEmail.has(email)) presenceByEmail.set(email, presence);
      const label = (presence.label || member).trim().toLowerCase();
      if (label && !presenceByLabel.has(label)) presenceByLabel.set(label, presence);
      for (const instance of presence.instances || []) {
        if (instance.id && !presenceByInstanceId.has(instance.id)) {
          presenceByInstanceId.set(instance.id, presence);
        }
      }
    }
  }

  const safeChannelHistory = channelHistory.filter(isValidChannelMessage);
  const historyById = new Map(safeChannelHistory.map((message) => [message.messageId, message]));
  const messageItems = safeChannelHistory.filter((message) => !isAgentSpawnStatusMessage(message)).map((message) => {
    const senderEmail = message.from.email.trim().toLowerCase();
    const senderLabel = message.from.label.trim().toLowerCase();
    const senderIdentityId = message.from.identityId;
    // A Channel Agent member is keyed by its Instance, not the sender's `agent:` identity.
    const exactSenderInstance = message.from.kind === "agent" && message.from.instanceId
      ? presenceByInstanceId.get(message.from.instanceId)?.instances?.find(instance => instance.id === message.from.instanceId)
      : undefined;
    const senderInstanceLabel = message.from.instanceLabel;
    const authorLabel =
      message.from.kind === "agent" && senderInstanceLabel
        ? senderInstanceLabel
        : message.from.label;
    // System notices carry the owner's principal, so they must not resolve the
    // owner's presence, avatar, own-message affordances, or human kind badge.
    const systemNotice = isXMatrixSystemNoticeMessage(message);
    // A cross-Channel link names where its sender lives; a relayed reply
    // shows who answered elsewhere under the link owner's principal. Neither
    // sender is a member here: this Channel's presence, ordinals, and the
    // owner's own-message affordances say nothing about them.
    const linkOrigin = messageLinkOrigin(message, channels);
    const linkedSender = linkOrigin?.kind === "link";
    const relayedReply = linkOrigin?.kind === "reply";
    const own =
      !systemNotice && !relayedReply &&
      message.from.kind === "user" &&
      (senderIdentityId === (currentUser?.id ? `user:${currentUser.id}` : undefined) ||
        message.from.userId === currentUser?.id ||
        Boolean(senderEmail && senderEmail === currentUserEmail));
    const matchedPresence = systemNotice || relayedReply
      ? undefined
      : (message.from.kind === "agent" && message.from.instanceId
          ? presenceByInstanceId.get(message.from.instanceId)
          : undefined) ||
        (senderIdentityId ? presenceByMember.get(senderIdentityId) : undefined) ||
        (message.from.userId ? presenceByMember.get(`user:${message.from.userId}`) : undefined) ||
        (senderEmail ? presenceByEmail.get(senderEmail) : undefined) ||
        (senderLabel ? presenceByLabel.get(senderLabel) : undefined);
    const kindMatchedPresence =
      matchedPresence && presenceKindMatchesSender(matchedPresence, message.from.kind)
        ? matchedPresence
        : undefined;
    const reservedSystemAgent = isXMatrixMessageSender(message.from) || systemNotice;
    const matchedAvatar = reservedSystemAgent
      ? XMATRIX_SYSTEM_AVATAR_URL
      : historicalSenderAvatarUrl({
          snapshotAvatarUrl: message.from.avatarUrl,
          presenceAvatarUrl: presenceAvatarUrl(kindMatchedPresence),
          ownAvatarUrl: own ? currentUser?.avatarUrl : undefined,
        });
    const senderInstanceId = message.from.instanceId;
    const senderChannelInstanceId = message.from.channelInstanceId;
    const senderHasInstanceIdentity = Boolean(senderInstanceId || senderChannelInstanceId);
    // `@name:N` here would reach a local namesake, not the sender elsewhere.
    const senderMention = linkedSender || relayedReply ? undefined : mentionForMessageSender(message.from);
    // The committed registration survives disconnect and cross-Channel writes.
    // Older senders may resolve only through their exact Instance, not a local namesake.
    const senderRegistration = message.from.kind === "agent" && !reservedSystemAgent
      ? message.from.registration ?? (exactSenderInstance && kindMatchedPresence?.kind === "agent"
          ? kindMatchedPresence.registration : undefined)
      : undefined;
    const senderOwner = senderRegistration &&
      spaceMembers.find(member => member.userId === senderRegistration.ownerUserId);
    const matchedInstance = senderHasInstanceIdentity
      ? kindMatchedPresence?.instances?.find(
          (instance) =>
            // Opaque Instance ids and Channel ordinals are separate domains.
            // A known Instance must never fall back to another instance's slot.
            senderInstanceId
              ? instance.id === senderInstanceId
              : instance.channelInstanceId === senderChannelInstanceId
        )
      : undefined;
    const senderInstanceStale =
      message.from.kind === "agent" && senderHasInstanceIdentity && !matchedInstance && !linkedSender;
    const humanPresenceStatus =
      kindMatchedPresence?.kind === "user" ? kindMatchedPresence.status : undefined;
    const senderStatus =
      message.from.kind === "agent"
        ? senderInstanceStale
          ? "offline"
          : linkedSender && !matchedInstance
            ? undefined
            : agentInstanceDisplayStatus({
              agentId: senderIdentityId,
              channelId: message.channelId,
              events,
              instance: matchedInstance,
              fallbackStatus: matchedInstance?.status || "offline",
              name: authorLabel,
              activity: matchedInstance?.activity || kindMatchedPresence?.activity,
            })
        : relayedReply ? undefined : humanPresenceStatus || (own ? "online" : "offline");
    const senderTraceStaleActivity =
      message.from.kind === "agent" && !senderInstanceStale
        ? agentBusyTraceStaleActivity({
            agentId: senderIdentityId,
            channelId: message.channelId,
            events,
            instance: matchedInstance,
            fallbackStatus: matchedInstance?.status || "offline",
            name: authorLabel,
            activity: matchedInstance?.activity || kindMatchedPresence?.activity,
          })
        : undefined;
    const senderActivity =
      senderInstanceStale
        ? "Instance is no longer live"
        : senderTraceStaleActivity ||
          matchedInstance?.activity ||
          kindMatchedPresence?.activity ||
          (senderStatus === "busy" ? "Processing" : undefined);
    const senderGoal =
      message.from.kind === "agent"
        ? message.from.goal
        : undefined;
    const senderGitBranch =
      message.from.kind === "agent"
        ? message.from.gitBranch
        : undefined;
    const senderModel =
      message.from.kind === "agent"
        ? cleanModelLabel(message.from.model)
        : undefined;
    const senderEffort =
      message.from.kind === "agent"
        ? cleanEffortLabel(message.from.effort)
        : undefined;
    const senderStatusChips =
      message.from.kind === "agent"
        ? cleanStatusChips(message.from.statusChips, senderModel, senderEffort)
        : undefined;
    const replyTarget = message.replyToMessageId
      ? historyById.get(message.replyToMessageId)
      : undefined;
    const replyTo =
      message.replyTo && isValidMessageSender(message.replyTo.from)
        ? {
            messageId: message.replyTo.messageId,
            author: message.replyTo.from.label,
            body: message.replyTo.recalledAt ? "Message recalled" : message.replyTo.bodyPreview,
            // Prefer the locally loaded target's sequence: it is authoritative
            // here, and the wire preview may predate the sequence field.
            ...replyPreviewSequence(replyTarget?.sequence ?? message.replyTo.sequence),
          }
        : replyTarget
          ? {
              messageId: replyTarget.messageId,
              author: replyTarget.from.label,
              body: replyTarget.recalledAt ? "Message recalled" : replyTarget.body,
              ...replyPreviewSequence(replyTarget.sequence),
            }
          : undefined;
    const threadChannel = channel && message.messageId
      ? threadChannelForMessage(channels, channel.id, message.messageId)
      : undefined;
    const threadMessages = threadChannel ? historyCache?.get(threadChannel.id)?.messages : undefined;
    const loadedThreadReplyCount = loadedThreadReplyCountForChannel(threadChannel, threadMessages);
    const loadedThreadReplyParticipants = threadReplyParticipantsForChannel(
      threadChannel,
      threadMessages
    );

    const clientMessageId =
      outboundClientIdsByMessageId?.get(message.messageId) ||
      (message as ChannelMessage & { clientMessageId?: string }).clientMessageId;
    const outboundPreview = clientMessageId
      ? outboundPreviewByClientId?.get(clientMessageId)
      : undefined;
    // Prefer local preview media/time so confirm does not reload images or jump timestamps.
    const displayAttachments =
      outboundPreview?.attachments && outboundPreview.attachments.length > 0
        ? outboundPreview.attachments
        : message.attachments;
    const displaySentAt = outboundPreview?.sentAt || message.sentAt;
    return {
      id: timelineItemId(clientMessageId, message.messageId),
      messageId: message.messageId,
      clientMessageId,
      channelId: message.channelId,
      sequence: message.sequence,
      author: own && currentUser ? currentHumanDisplayName(currentUser) : authorLabel,
      body: message.body,
      replyToMessageId: message.replyToMessageId,
      replyTo,
      attachments: displayAttachments,
      metadata: messageRichMetadata(message),
      mentionReadStatuses: effectiveMentionReadStatuses(
        message,
        currentUserIdentityId,
        channelReadCounts[message.channelId]
      ),
      reactions: message.reactions,
      threadChannelId: threadChannel?.id ?? message.thread?.channelId,
      threadChannel,
      threadReplyCount: loadedThreadReplyCount ?? message.thread?.replyCount ??
        threadReplyCountForChannel(threadChannel),
      threadUpdatedAt: threadChannel?.updatedAt ?? message.thread?.updatedAt,
      threadReplies: threadReplyPreviews(
        threadChannel?.id ?? message.thread?.channelId,
        message.messageId,
        threadChannel ? metadataString(threadChannel.metadata, "threadRootCopyMessageId") : undefined,
        message.thread?.replies.filter(isValidChannelMessage),
        threadMessages?.filter(isValidChannelMessage),
      ),
      threadReplyParticipants: loadedThreadReplyCount === undefined
        ? threadReplyParticipantsFromSummary(message)
        : loadedThreadReplyParticipants,
      editedAt: message.editedAt,
      recalledAt: message.recalledAt,
      ...(message.supersededBy && !message.recalledAt ? { supersededBy: message.supersededBy } : {}),
      sentAt: displaySentAt,
      avatarUrl: matchedAvatar,
      own,
      senderKind: relayedReply ? linkOrigin.replierKind ?? message.from.kind : message.from.kind,
      senderId: reservedSystemAgent || relayedReply ? undefined : senderIdentityId,
      senderOwnerLabel: !reservedSystemAgent && senderRegistration
        ? senderOwner?.name || senderOwner?.email || senderRegistration.ownerUserId : undefined,
      senderMachineId: senderRegistration?.machineId,
      senderMachineOwnerUserId: senderRegistration?.ownerUserId,
      senderMachineLabel: !reservedSystemAgent && senderRegistration
        ? exactSenderInstance?.hostName || exactSenderInstance?.hostId || senderRegistration.machineId
        : undefined,
      senderInstanceId: reservedSystemAgent ? undefined : matchedInstance?.id || senderInstanceId,
      senderMention,
      // xMatrix has its own product identity, while the delegated runtime
      // remains the source of truth for whether it is actively working.
      senderStatus,
      senderActivity,
      senderInstanceStale: reservedSystemAgent ? false : senderInstanceStale,
      ...(linkOrigin ? { linkOrigin } : {}),
      senderGoal: reservedSystemAgent ? undefined : senderGoal,
      senderGitBranch: reservedSystemAgent ? undefined : senderGitBranch,
      senderStatusChips: reservedSystemAgent ? undefined : senderStatusChips,
      provenance: messageProvenance(messageRichMetadata(message)),
      reservedSystemAgent,
    };
  });

  return messageItems.sort(
    (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()
  );
}

export function historicalSenderAvatarUrl(input: {
  snapshotAvatarUrl?: string;
  presenceAvatarUrl?: string;
  ownAvatarUrl?: string;
}): string | undefined {
  return input.snapshotAvatarUrl ||
    input.presenceAvatarUrl ||
    input.ownAvatarUrl;
}

export function effectiveMentionReadStatuses(
  message: ChannelMessage,
  currentUserIdentityId: string | undefined,
  readSequence: number | undefined
): ChannelMessage["mentionReadStatuses"] {
  if (!message.mentionReadStatuses || message.mentionReadStatuses.length === 0) {
    return message.mentionReadStatuses;
  }
  if (
    !currentUserIdentityId ||
    !message.sequence ||
    readSequence === undefined ||
    readSequence < message.sequence
  ) {
    return message.mentionReadStatuses;
  }

  let changed = false;
  const next = message.mentionReadStatuses.map((status) => {
    if (
      status.targetKind !== "user" ||
      status.targetId !== currentUserIdentityId ||
      status.status === "read"
    ) {
      return status;
    }
    changed = true;
    return {
      ...status,
      status: "read" as const,
      readSequence,
    };
  });
  return changed ? next : message.mentionReadStatuses;
}

export function presenceKindMatchesSender(
  presence: ChannelMemberPresence,
  senderKind: ChannelMessage["from"]["kind"]
): boolean {
  if (senderKind === "agent") return presence.kind === "agent";
  if (senderKind === "user") return presence.kind === "user";
  return false;
}

export function mentionForMessageSender(sender: MessageSender): string {
  if (sender.kind === "agent") {
    const instanceLabel = sender.instanceLabel?.trim().replace(/^[@＠]/, "");
    if (instanceLabel) return instanceLabel;
    const agentName = sender.label.trim();
    const channelInstanceId = sender.channelInstanceId?.trim();
    if (agentName && channelInstanceId) return `${agentName}:${channelInstanceId}`;
  }
  return sender.label.trim();
}

export function isAgentSpawnStatusMessage(message: ChannelMessage): boolean {
  if (message.from.label !== "xMatrix" && message.from.agentName !== "xMatrix") return false;
  // Hide only transient start/success noise. Failure notices must remain visible
  // so users see a product-quality reason instead of a silent "Launch failed".
  if (messageRichMetadata(message)?.source === "machine_run_failure") return false;
  if (/^xMatrix could not start\b/i.test(message.body) || /^Couldn't start @/i.test(message.body)) {
    return false;
  }
  return /^xMatrix (is starting|started) .+/.test(message.body);
}

export function isMachineRunFailureNotice(
  message: Pick<TimelineItem, "body" | "metadata" | "author">,
): boolean {
  if (message.metadata?.source === "machine_run_failure") return true;
  if (message.author !== "xMatrix") return false;
  return /^Couldn't start @/i.test(message.body) ||
    /^xMatrix could not start\b/i.test(message.body);
}

export function humanizeLegacyMachineRunFailureBody(body: string): string {
  // Older notices dumped raw daemon/git lines under "Runtime error:". Rewrite
  // those for display so history does not keep the unacceptable developer dump.
  const match = body.match(/^([\s\S]*?)\n+Runtime error:\n([\s\S]+)$/iu);
  if (!match) return body;
  const header = match[1]?.trim() || "Couldn't start the agent.";
  const detail = match[2]?.trim() || "";
  const lower = detail.toLowerCase();
  if (
    lower.includes("remote repo worktree") ||
    (lower.includes("git fetch") && (lower.includes("timed out") || lower.includes("stalled")))
  ) {
    return [
      header.replace(/^xMatrix could not start/iu, "Couldn't start"),
      "",
      "xMatrix could not finish preparing a fresh copy of the selected repository on that machine before launch.",
      "",
      "Check that machine's network and GitHub access, then try again. If a local checkout already exists, summon without re-selecting the remote repo.",
    ].join("\n");
  }
  if (lower.includes("not accessible")) {
    return [
      header.replace(/^xMatrix could not start/iu, "Couldn't start"),
      "",
      "That machine cannot access the selected repository.",
      "",
      "Confirm GitHub authentication on the machine and repository permissions, then try again.",
    ].join("\n");
  }
  const compact = detail
    .replace(/\bgit\s+fetch\b[^\n]*/giu, "repository refresh")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280);
  return [
    header.replace(/^xMatrix could not start/iu, "Couldn't start"),
    "",
    compact || "The agent process could not start.",
  ].join("\n");
}

export function MachineRunFailureNotice({ body, machineName }: { body: string; machineName?: string }) {
  const lines = humanizeLegacyMachineRunFailureBody(body)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines[0] || "Couldn't start the agent";
  const rest = lines.slice(1);

  // Parse "Couldn't start @agent on machine during error_code" into readable metadata.
  const startMatch = title.match(
    /^Couldn't start @(\S+?)(?: on (.+?))?(?: during (\S+?))?\.?$/iu
  );
  const headline = startMatch ? "Couldn't start agent" : title;
  const meta = startMatch
    ? {
        target: `@${startMatch[1]} · ${machineName || "Unnamed machine"}`,
        error: startMatch[3],
      }
    : null;
  // The notice names the harness that failed to start; its icon is the harness's.
  const targetName = startMatch?.[1];
  const targetAvatarUrl = targetName ? agentAvatarUrlFromMetadata({}, targetName) : undefined;

  return (
    <div
      className="mt-1 w-full max-w-2xl rounded-md border border-border bg-muted/35 px-3 py-2.5"
      role="alert"
      data-system-notice="machine_run_failure"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {targetName && targetAvatarUrl ? (
          <IdentityAvatar
            kind="agent"
            label={targetName}
            initials={avatarInitials(targetName)}
            imageUrl={targetAvatarUrl}
            size="sm"
            shape="circle"
          />
        ) : (
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-bold text-foreground">{headline}</span>
            {meta ? (
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {meta.target}
              </span>
            ) : null}
          </div>
          {meta?.error ? (
            <code className="mt-1.5 inline-block max-w-full rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-destructive [overflow-wrap:anywhere]">
              {meta.error}
            </code>
          ) : null}
          {rest.length > 0 ? (
            <div className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-muted-foreground">
              {rest.map((line) => (
                <p key={line} className="[overflow-wrap:anywhere]">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function isXMatrixMessageSender(sender: MessageSender): boolean {
  return sender.kind === "agent" &&
    (sender.label.trim().toLowerCase() === "xmatrix" ||
      sender.agentName?.trim().toLowerCase() === "xmatrix");
}

export function truncateNotificationText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function nativeMessageNotificationTitle(message: ChannelMessage): string {
  if (secretRequestMetadata(messageRichMetadata(message))) return "Secret requested";
  return message.from.label || "xMatrix";
}

export function nativeMessageNotificationBody(message: ChannelMessage): string {
  const secretRequest = secretRequestMetadata(messageRichMetadata(message));
  if (secretRequest) {
    return truncateNotificationText(`${secretRequest.agentName || "An Agent"} asks for the secret ${secretRequest.secretRef}`);
  }
  const preview = normalizeMessageBodyForDisplay(message.body, message.from.kind).trim().replace(/\s+/g, " ");
  const attachmentFallback = message.attachments?.length
    ? message.attachments.length === 1
      ? "Sent an attachment"
      : `Sent ${message.attachments.length} attachments`
    : "Sent a message";
  const body = preview || attachmentFallback;
  return truncateNotificationText(body);
}

export function nativeNotificationEventMessageId(event: ObservabilityEvent): string | null {
  const messageId = event.metadata?.messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId : null;
}

export function nativeNotificationEventMessageIdWasHandled(
  event: ObservabilityEvent,
  notifiedMessageIds: Set<string>
): boolean {
  const messageId = nativeNotificationEventMessageId(event);
  return Boolean(messageId && notifiedMessageIds.has(messageId));
}

export function isNativeNotificationEvent(event: ObservabilityEvent): boolean {
  // Mentions of the current user surface a native banner regardless of whether
  // an agent or a human sent them (channel_mention events already target the
  // current user). Realtime message banners separately require the Hub's
  // recipient-scoped notification decision.
  return event.type === "channel_mention";
}

export function loginPathWithNext(nextPath: string): string {
  if (!nextPath || nextPath === "/" || nextPath.startsWith("/login")) return "/login";
  return `/login?next=${encodeURIComponent(nextPath)}`;
}

export { decodePathSegment } from "./workspace-shell-path";

/**
 * Decides which Channel stays open after the route or the Channel list moved.
 *
 * Browser back/forward can reach the Channel-list URL without first clearing
 * the local selection, and there the route has to win or the detail view stays
 * over the list. But `routeChannelId` is a resolution result, not a statement
 * about the URL: a Channel the list has not caught up with resolves to null
 * while the URL still names it. Treating that as "the reader asked for the
 * list" drops them out of the Channel they are reading and puts them back once
 * the row arrives, which is seen as the open Channel jumping on its own. Only a
 * route that names no Channel at all is a request for the list.
 */
export function selectedChannelIdAfterRouteChange({
  channels,
  current,
  routeChannelId,
  routeNamesChannel,
  routeSelectionChanged,
}: {
  channels: SerializedChannel[];
  current: string | null;
  routeChannelId: string | null;
  routeNamesChannel: boolean;
  routeSelectionChanged: boolean;
}): string | null {
  if (routeSelectionChanged && !routeChannelId && !routeNamesChannel) return null;
  return resolveSelectedChannelIdAfterChannelListChange({
    channels,
    current,
    requestedChannelId: current === null || routeSelectionChanged ? routeChannelId : null,
  });
}

/**
 * The Channel open after the list changes: the one the route asks for once its
 * row is here, otherwise whatever is open, or nothing. Nothing is ever opened
 * that the reader did not ask for; with no Channel open, the list is the answer.
 */
export function resolveSelectedChannelIdAfterChannelListChange({
  channels,
  current,
  requestedChannelId,
}: {
  channels: SerializedChannel[];
  current: string | null;
  requestedChannelId: string | null;
}): string | null {
  if (requestedChannelId && channels.some((channel) => channel.id === requestedChannelId)) {
    return requestedChannelId;
  }
  return current;
}

export function threadChannelForMessage(
  channels: SerializedChannel[],
  parentChannelId: string,
  messageId: string
): SerializedChannel | undefined {
  return channels.find(
    (channel) =>
      metadataString(channel.metadata, "threadRootChannelId") === parentChannelId &&
      channel.metadata?.kind === "thread" &&
      metadataString(channel.metadata, "threadRootMessageId") === messageId
  );
}

export function threadReplyCountForChannel(
  channel?: SerializedChannel,
  loadedMessages?: ChannelMessage[]
): number | undefined {
  const loadedReplyCount = loadedThreadReplyCountForChannel(channel, loadedMessages);
  if (loadedReplyCount !== undefined) return loadedReplyCount;
  if (!channel || channel.messageCount === undefined) return undefined;
  const rootMessageCount = channel.metadata?.kind === "thread" ? 1 : 0;
  return Math.max(0, channel.messageCount - rootMessageCount);
}

function loadedThreadReplyMessages(
  channel?: SerializedChannel,
  loadedMessages?: ChannelMessage[],
): ChannelMessage[] | undefined {
  if (!channel || !loadedMessages || loadedMessages.length === 0) return undefined;
  const rootMessageId = metadataString(channel.metadata, "threadRootMessageId");
  const rootCopyMessageId = metadataString(channel.metadata, "threadRootCopyMessageId");
  const filteredMessages = filterHistoryForChannel(channel.id, loadedMessages);
  const channelMessages = (filteredMessages.length > 0 ? filteredMessages : loadedMessages)
    .filter(isValidChannelMessage);
  if (channelMessages.length === 0) return undefined;
  return channelMessages.filter((message) =>
    message.messageId !== rootCopyMessageId && message.messageId !== rootMessageId);
}

export function loadedThreadReplyCountForChannel(
  channel?: SerializedChannel,
  loadedMessages?: ChannelMessage[]
): number | undefined {
  return loadedThreadReplyMessages(channel, loadedMessages)?.length;
}

export function threadReplyParticipantsForChannel(
  channel?: SerializedChannel,
  loadedMessages?: ChannelMessage[]
): ThreadReplyParticipant[] | undefined {
  const replies = loadedThreadReplyMessages(channel, loadedMessages)
    ?.sort((left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime());
  return uniqueThreadReplyParticipants(replies);
}

export function threadReplyParticipantsFromSummary(
  message: ChannelMessage
): ThreadReplyParticipant[] | undefined {
  const replies = message.thread?.replies
    .filter(isValidChannelMessage);
  return uniqueThreadReplyParticipants(replies);
}

function uniqueThreadReplyParticipants(
  replies?: readonly ChannelMessage[]
): ThreadReplyParticipant[] | undefined {
  if (!replies || replies.length === 0) return undefined;
  const participants: ThreadReplyParticipant[] = [];
  const seen = new Set<string>();
  for (const reply of replies) {
    const id = reply.from.identityId ||
      (reply.from.userId ? `user:${reply.from.userId}` : "") ||
      reply.from.email ||
      `${reply.from.kind}:${reply.from.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    participants.push({ id, author: reply.from.label, avatarUrl: reply.from.avatarUrl });
    if (participants.length === 2) break;
  }
  return participants.length > 0 ? participants : undefined;
}

export { shortId } from "./workspace-shell-message-model";

export function browserDevicePresence(
  bridge: DesktopBridge | null
): { client: string; label: string; platform?: string; version: string; protocolVersion: number } {
  const compatibility = requireAcceptedAppCompatibilityIdentity();
  if (bridge?.client) {
    const client = bridge.client.trim();
    const platform = bridge.platform || undefined;
    return {
      client,
      label: nativeDeviceLabel(client, platform),
      platform,
      version: compatibility.version,
      protocolVersion: compatibility.protocolVersion,
    };
  }
  if (typeof navigator === "undefined") {
    return {
      client: "web",
      label: "web",
      version: compatibility.version,
      protocolVersion: compatibility.protocolVersion,
    };
  }

  const userAgentData = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData;
  return {
    client: "web",
    label: "web",
    platform: userAgentData?.platform || navigator.platform || undefined,
    version: compatibility.version,
    protocolVersion: compatibility.protocolVersion,
  };
}

export function nativeDeviceLabel(client: string, platform?: DesktopContext["platform"]): string {
  if (client === "ios" || client === "android") return client;
  if (client === "desktop") {
    const platformLabel = platform ? nativePlatformLabel(platform) : undefined;
    return platformLabel ? `${platformLabel} app` : `${client} app`;
  }
  return client;
}

export function nativePlatformLabel(platform: DesktopContext["platform"]): string | undefined {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return platform || undefined;
}

export function memberDeviceLine(presence: ChannelMemberPresence): string | undefined {
  const instances = presence.instances || [];
  if (!instances.length) return undefined;
  const labels = instances
    .map((instance) => instance.hostName || instance.label || instance.machineId || instance.hostId)
    .filter((label): label is string => Boolean(label));
  if (!labels.length) return undefined;
  const uniqueLabels = Array.from(new Set(labels));
  return uniqueLabels.length === 1 ? uniqueLabels[0] : uniqueLabels.join(", ");
}

export function formatMember(
  channel: SerializedChannel,
  member: string,
  agentsById?: Map<string, SerializedAgent>
): string {
  const namedMember = channel.memberPresence?.[member]?.label;
  if (namedMember) return namedMember;
  const agent = agentsById?.get(member);
  if (agent) return agent.name;
  if (member.startsWith("user:")) return `web:${shortId(member.slice(5))}`;
  return member;
}

/* moved to workspace-shell-presence (0) */

/* moved to workspace-shell-presence (1) */

export function presenceAvatarUrl(
  presence: ChannelMemberPresence | undefined
): string | undefined {
  return (presence as (ChannelMemberPresence & { avatarUrl?: string }) | undefined)?.avatarUrl;
}

export function buildAgentWorkItems(
  channel: SerializedChannel | null,
  events: ObservabilityEvent[],
  launches: readonly SerializedAgentLaunch[] = [],
): AgentWorkItem[] {
  if (!channel) return [];

  const items: AgentWorkItem[] = [];

  for (const member of channelMembersByPresence(channel)) {
    const presence = memberPresence(channel, member);
    if (presence.kind !== "agent") continue;

    const agentLabel = presence.label || member;
    for (const instance of presence.instances || []) {
      if (!isChannelResidentPresence(instance)) continue;
      const avatarUrl = presence.avatarUrl;
      const target: AgentTraceTarget = {
        id: member,
        instanceId: instance.id,
        instanceIds: agentTraceInstanceIds(instance),
        exactInstanceIds: [instance.id],
        instanceScoped: true,
        channelId: channel.id,
        connectedAt: instance.connectedAt,
        name: agentInstanceDisplayName(instance),
        status: instance.status,
        avatarUrl,
        activity: presenceStatusLabel(instance),
        gitBranch: instance.gitBranch,
        runtimeState: instance.runtimeState || presence.runtimeState,
        usage: instance.usage || presence.usage,
      };
      const latestEvent = latestAgentWorkEvent(events, target, channel.id);

      items.push({
        key: `${member}:${instance.id}`,
        agentId: member,
        instance,
        sortIndex: items.length,
        label: instance.label || instance.id,
        agentLabel,
        status: instance.status,
        avatarUrl,
        avatarKind: "agent",
        activity: instance.activity || presence.activity,
        intent: instance.intent || presence.intent,
        files: instance.files?.length ? instance.files : presence.files,
        usage: instance.usage || presence.usage,
        // Same verdict, same inputs as the detail row: the avatar badge shows
        // what this resolves to instead of deriving a limit of its own.
        usageLimit: agentInstanceUsageLimit(presence, instance),
        lastSeenAt: instance.lastSeenAt,
        latestEvent,
        target,
        canStop: true,
      });
    }
  }

  const membersWithInstances = new Set(items.map((item) => item.agentId));
  const visibleMembers = new Set(channelMembersByPresence(channel));
  const launchedInstanceIds = new Set(launches.map((launch) => launch.instanceId));
  for (const launch of launches) {
    const actorId = launch.instanceId;
    if (launch.state === "connected" || launch.state === "cancelled" ||
        membersWithInstances.has(actorId)) continue;
    const failed = launch.state === "failed";
    const label = launch.targetName || actorId;
    const status: SerializedAgentInstance["status"] = failed ? "offline" : "busy";
    const activity = failed ? "Launch failed" : launch.state === "queued" && launch.daemonOffline
      ? "Queued — daemon offline" : launch.state === "prepared" ? "Preparing" : "Starting";
    const instance: SerializedAgentInstance = { id: launch.instanceId,
      label: `run ${shortId(launch.runId)}`, connectedAt: launch.createdAt,
      lastSeenAt: launch.updatedAt, status, activity };
    const target: AgentTraceTarget = { id: actorId, instanceId: launch.instanceId,
      instanceIds: [launch.instanceId], instanceScoped: true, channelId: channel.id,
      connectedAt: launch.createdAt, name: label, status, avatarUrl: launch.targetAvatarUrl,
      activity };
    items.push({ key: `${actorId}:${launch.instanceId}`,
      agentId: actorId, instance, sortIndex: items.length,
      label: instance.label || "starting", agentLabel: label, status,
      avatarUrl: launch.targetAvatarUrl, activity, lastSeenAt: launch.updatedAt,
      target, canStop: false });
  }
  for (const event of latestSpawnEventsByAgent(events, channel)) {
    const routedAs = eventMetadataString(event, "routedAs");
    if (routedAs?.startsWith("management_")) continue;
    const agentId = event.agentId || event.targetAgentId;
    if (!agentId || membersWithInstances.has(agentId) || launchedInstanceIds.has(agentId)) continue;
    if (!visibleMembers.has(agentId)) continue;

    const agentLabel = event.agentName || channel.memberPresence?.[agentId]?.label || agentId;
    const avatarUrl = channel.memberPresence?.[agentId]?.avatarUrl;
    const runLabel = eventMetadataString(event, "runLabel");
    const launchInstanceId = eventMetadataString(event, "runId") || event.id;
    const timestamp = event.timestamp;
    const failedSpawn =
      event.type === "agent_spawn_finished" && eventMetadataString(event, "status") === "failed";
    const successfulSpawn = event.type === "agent_spawn_finished" && !failedSpawn;
    const pendingSpawn = event.type === "agent_spawn_started";
    if (pendingSpawn && isOlderThan(event.timestamp, AGENT_SPAWN_PENDING_MAX_AGE_MS)) continue;
    if (successfulSpawn && isOlderThan(event.timestamp, AGENT_SPAWN_HANDOFF_GRACE_MS)) continue;

    const status: SerializedAgentInstance["status"] =
      failedSpawn ? "offline" : successfulSpawn ? "online" : "busy";
    const activity = failedSpawn ? "Launch failed" : successfulSpawn ? "Started" : "Starting";
    const target: AgentTraceTarget = {
      id: agentId,
      instanceId: launchInstanceId,
      instanceIds: [launchInstanceId],
      instanceScoped: true,
      channelId: channel.id,
      connectedAt: timestamp,
      name: agentLabel,
      status,
      avatarUrl,
      activity,
    };

    items.push({
      key: `${agentId}:${launchInstanceId}`,
      agentId,
      instance: {
        id: launchInstanceId,
        label: runLabel ? `run ${runLabel}` : "starting",
        connectedAt: timestamp,
        lastSeenAt: timestamp,
        status,
        activity,
      },
      sortIndex: items.length,
      label: runLabel ? `run ${runLabel}` : "starting",
      agentLabel,
      status,
      avatarUrl,
      activity,
      lastSeenAt: timestamp,
      latestEvent: event,
      target,
      canStop: false,
    });
  }

  // Birth order only — never reshuffle by activity, lastSeen, or status.
  return items.sort((left, right) => {
    const leftTime = Date.parse(left.instance.connectedAt || left.target.connectedAt || "");
    const rightTime = Date.parse(right.instance.connectedAt || right.target.connectedAt || "");
    const hasLeft = Number.isFinite(leftTime);
    const hasRight = Number.isFinite(rightTime);
    if (hasLeft && hasRight && leftTime !== rightTime) return leftTime - rightTime;
    if (hasLeft !== hasRight) return hasLeft ? -1 : 1;
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex;
    return left.key.localeCompare(right.key);
  });
}

/* moved to workspace-shell-presence (2) */

/* moved to workspace-shell-presence (3) */

export function latestEventTimestampMs(events: ObservabilityEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, timestampMs(event.timestamp)), 0);
}

export function traceEventChannelInstanceLabel(event: ObservabilityEvent): string {
  const agent = tracePayloadRecord(event)?.agent;
  if (!agent || typeof agent !== "object") return "";
  const channelInstanceId = (agent as Record<string, unknown>).channelInstanceId;
  return typeof channelInstanceId === "string" && channelInstanceId.trim() ? channelInstanceId.trim() : "";
}

export function latestSpawnEventsByAgent(
  events: ObservabilityEvent[],
  channel: SerializedChannel
): ObservabilityEvent[] {
  const byAgent = new Map<string, ObservabilityEvent>();
  const visibleMembers = new Set(channelMembersByPresence(channel));
  for (const event of events) {
    if (event.channelId !== channel.id) continue;
    if (event.type !== "agent_spawn_started" && event.type !== "agent_spawn_finished") continue;
    const agentId = event.agentId || event.targetAgentId;
    if (!agentId || !visibleMembers.has(agentId)) continue;
    const previous = byAgent.get(agentId);
    if (!previous || new Date(event.timestamp).getTime() > new Date(previous.timestamp).getTime()) {
      byAgent.set(agentId, event);
    }
  }
  return Array.from(byAgent.values());
}

/* moved to workspace-shell-presence (4) */

/* moved to workspace-shell-presence (5) */

/* moved to workspace-shell-presence (6) */

/* moved to workspace-shell-presence (7) */

export function eventMetadataString(event: ObservabilityEvent, key: string): string {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : "";
}

export function tracePayloadRecord(event: ObservabilityEvent): Record<string, unknown> | null {
  const payload = event.metadata?.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

export function traceUsage(event: ObservabilityEvent): LlmUsage | null {
  const payload = tracePayloadRecord(event);
  const usage = normalizeLlmUsage(payload?.usage) || normalizeLlmUsage(traceInnerPayload(payload)?.usage);
  return usage && Object.keys(usage).length > 0 ? usage : null;
}

export function normalizeLlmUsage(value: unknown): LlmUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const quotaObservedAt = parseQuotaObservedAt(record.quotaObservedAt ?? record.quota_observed_at);
  return {
    inputTokens: numericUsage(record.inputTokens ?? record.input_tokens ?? record.promptTokens ?? record.prompt_tokens),
    outputTokens: numericUsage(
      record.outputTokens ?? record.output_tokens ?? record.completionTokens ?? record.completion_tokens
    ),
    totalTokens: numericUsage(record.totalTokens ?? record.total_tokens),
    contextUsedTokens: numericUsage(
      record.contextUsedTokens ??
        record.context_used_tokens ??
        record.contextTokens ??
        record.context_tokens
    ),
    contextWindowTokens: numericUsage(
      record.contextWindowTokens ??
        record.context_window_tokens ??
        record.contextLimitTokens ??
        record.context_limit_tokens ??
        record.contextWindow ??
        record.context_window ??
        record.contextLimit ??
        record.context_limit
    ),
    contextUsagePercent: numericUsage(
      record.contextUsagePercent ??
        record.context_usage_percent ??
        record.contextPercent ??
        record.context_percent ??
        record.contextUsagePct ??
        record.context_usage_pct ??
        record.contextPct ??
        record.context_pct
    ),
    quotaSource: record.quotaSource === "provider_api" ? "provider_api" : undefined,
    ...(quotaObservedAt ? { quotaObservedAt } : {}),
    quotaUsages: normalizeLlmQuotaUsages(
      record.quotaUsages ??
        record.quota_usages ??
        record.quotas ??
        record.quota
    ),
    quotaAccount: parseLlmQuotaAccount(record.quotaAccount),
    cachedInputTokens: numericUsage(
      record.cachedInputTokens ??
        record.cached_input_tokens ??
        record.input_cached_tokens ??
        record.cacheReadInputTokens ??
        record.cache_read_input_tokens
    ),
    cacheCreationInputTokens: numericUsage(
      record.cacheCreationInputTokens ?? record.cache_creation_input_tokens
    ),
    cacheReadInputTokens: numericUsage(record.cacheReadInputTokens ?? record.cache_read_input_tokens),
    reasoningTokens: numericUsage(record.reasoningTokens ?? record.reasoning_tokens),
    toolCallCount: numericUsage(record.toolCallCount ?? record.tool_call_count),
    costUsd: numericUsage(record.costUsd ?? record.cost_usd),
  };
}

export function normalizeLlmQuotaUsages(value: unknown): LlmQuotaUsage[] | undefined {
  const quotas: LlmQuotaUsage[] = [];
  collectLlmQuotaUsages(value, quotas);
  return quotas.length > 0 ? quotas : undefined;
}

export function collectLlmQuotaUsages(value: unknown, quotas: LlmQuotaUsage[]) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectLlmQuotaUsages(item, quotas));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const quota = normalizeLlmQuotaUsage(record);
  if (quota) {
    quotas.push(quota);
    return;
  }
  Object.values(record).forEach((item) => collectLlmQuotaUsages(item, quotas));
}

export function normalizeLlmQuotaUsage(record: Record<string, unknown>): LlmQuotaUsage | null {
  const label = stringUsage(record.label ?? record.name ?? record.period ?? record.window ?? record.duration);
  const windowLabel = stringUsage(record.window ?? record.period ?? record.duration ?? record.interval);
  const used = numericUsage(record.used ?? record.usage ?? record.current ?? record.consumed);
  const limit = numericUsage(record.limit ?? record.max ?? record.maximum ?? record.quota ?? record.total);
  const remaining = numericUsage(record.remaining ?? record.available ?? record.left);
  const percent = numericUsage(
    record.percent ??
      record.pct ??
      record.usagePercent ??
      record.usage_percent ??
      record.usedPercent ??
      record.used_percent
  );
  const resetAt = temporalUsage(record.resetAt ?? record.reset_at ?? record.resetsAt ?? record.resets_at ?? record.reset);
  const hasWindow = Boolean(label || windowLabel || resetAt);
  const hasUsage =
    percent !== undefined ||
    (used !== undefined && limit !== undefined) ||
    (remaining !== undefined && limit !== undefined);
  return hasWindow && hasUsage
    ? { label, window: windowLabel, used, limit, remaining, percent, resetAt }
    : null;
}

export function numericUsage(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function stringUsage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function temporalUsage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function traceInnerPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const inner = payload?.payload;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

/* moved to workspace-shell-presence (8) */

/* moved to workspace-shell-presence (9) */

/* moved to workspace-shell-presence (10) */

export function humanChannelMembersByPresence(channel: SerializedChannel): string[] {
  return channelMembersByPresence(channel).filter((member) => {
    const presence = memberPresence(channel, member);
    return presence.kind === "user";
  });
}

export function visibleHumanChannelMembers(
  channel: SerializedChannel,
  space: SerializedSpace | null
): string[] {
  if (channel.visibleHumanMemberIds) {
    return Array.from(new Set(channel.visibleHumanMemberIds)).sort((left, right) =>
      left.localeCompare(right)
    );
  }
  if (channel.mode === "open" && space?.id === channel.spaceId) {
    return space.members
      .map((member) => `user:${member.userId}`)
      .sort((left, right) => left.localeCompare(right));
  }
  return humanChannelMembersByPresence(channel);
}

export function spaceMemberForChannelIdentity(
  space: SerializedSpace | null,
  memberId: string
) {
  if (!space || !memberId.startsWith("user:")) return undefined;
  return space.members.find((member) => member.userId === memberId.slice("user:".length));
}

export function channelFocusedHumanMembers(channel: SerializedChannel): string[] {
  return humanChannelMembersByPresence(channel)
    .filter((member) => {
      const presence = memberPresence(channel, member);
      return presence.kind === "user" && presence.focused;
    })
    .sort((left, right) => formatMember(channel, left).localeCompare(formatMember(channel, right)));
}

export function channelOnlineAgentAvatarItems(channel: SerializedChannel | null): ChannelAgentAvatarItem[] {
  if (!channel) return [];

  const items: ChannelAgentAvatarItem[] = [];
  channelMembersByPresence(channel).forEach((member) => {
    const presence = memberPresence(channel, member);
    if (presence.kind !== "agent") return;

    const instances = presence.instances || [];
    const onlineInstances = instances.filter((instance) =>
      isChannelResidentPresence(instance)
    );
    onlineInstances.forEach((instance, instanceIndex) => {
      items.push({
        key: `${member}:${instance.id}`,
        member,
        instance,
        connectedAt: instance.connectedAt,
        instanceIndex,
      });
    });
  });

  return items.sort(compareChannelAgentAvatarBirthOrder);
}

/**
 * Stable Agents list order: birth time ascending, never lastSeen/activity.
 * Status chips may change; position must not.
 */
export function compareChannelAgentAvatarBirthOrder(
  left: ChannelAgentAvatarItem,
  right: ChannelAgentAvatarItem
): number {
  const leftTime = Date.parse(left.connectedAt || left.instance?.connectedAt || "");
  const rightTime = Date.parse(right.connectedAt || right.instance?.connectedAt || "");
  const hasLeftTime = Number.isFinite(leftTime);
  const hasRightTime = Number.isFinite(rightTime);
  if (hasLeftTime && hasRightTime && leftTime !== rightTime) return leftTime - rightTime;
  if (hasLeftTime !== hasRightTime) return hasLeftTime ? -1 : 1;
  // Prefer channel birth slot over object-iteration index so multi-instance
  // agents stay ordered even when presence array order drifts.
  const leftChannelInstanceId = Number(left.instance?.channelInstanceId || 0);
  const rightChannelInstanceId = Number(right.instance?.channelInstanceId || 0);
  if (leftChannelInstanceId !== rightChannelInstanceId) {
    return leftChannelInstanceId - rightChannelInstanceId;
  }
  if (left.member === right.member && left.instanceIndex !== right.instanceIndex) {
    return left.instanceIndex - right.instanceIndex;
  }
  return left.key.localeCompare(right.key);
}

export function memberPresenceSummary(channel: SerializedChannel, space: SerializedSpace | null) {
  return visibleHumanChannelMembers(channel, space).reduce(
    (summary, member) => {
      const presence = memberPresence(channel, member);
      if (presence.kind !== "user") return summary;
      const isOnline = isOnlinePresence(presence.status);
      summary.total += 1;
      if (isOnline) summary.online += 1;
      if (isOnline) summary.onlineHumans += 1;
      return summary;
    },
    { total: 0, online: 0, onlineHumans: 0, onlineAgents: 0, onlineAgentInstances: 0 }
  );
}

export function spaceRoleFor(space: SerializedSpace, userId: string): string {
  return space.members.find((member) => member.userId === userId)?.role || "viewer";
}

export function spaceOwnerLabel(space: SerializedSpace): string {
  const owner = space.members.find((member) => member.userId === space.ownerId);
  return owner?.name || owner?.email || shortId(space.ownerId);
}

export function canInviteToSpace(space: SerializedSpace, userId: string): boolean {
  const role = spaceRoleFor(space, userId);
  return role === "owner" || role === "admin";
}

export function parseInviteEmails(value: string): string[] {
  const emails = value
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return Array.from(new Set(emails));
}

export function initialsFor(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function avatarInitials(value: string): string {
  return initialsFor(value) || "XM";
}

export function GoalStatusBadge({
  goal,
  presentation = "historical",
}: {
  goal?: AgentGoalStatus;
  presentation?: "historical" | "live";
}) {
  const tip = useAnchoredTip<HTMLSpanElement>();
  const label = goalStatusBadgeLabel(goal, presentation);
  if (!label) return null;
  const title = goalStatusTitle(goal, presentation);
  const tone = goalStatusBadgeTone(goal);

  return (
    <span
      className="app-goal-status-badge-shell relative inline-flex shrink-0 align-middle"
      tabIndex={0}
      aria-label={title}
      {...tip.anchorProps}
    >
      <span
        className={cn(
          // Same shape as every other tag; the tone paints its own surface in
          // place of the shared chip material.
          TAG_SHAPE_CLASS,
          "app-goal-status-badge max-w-[10rem] truncate rounded border",
          tone
        )}
      >
        <Pin className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      {tip.open && typeof document !== "undefined"
        ? createPortal(
            <span ref={tip.ref} role="tooltip" className="xmatrix-app app-goal-status-tooltip app-hint-tooltip">
              {title}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

/* A tip portalled to the body and fixed in viewport coordinates: its anchors sit
   in the agent rail and the message header, both of which clip their overflow,
   so an in-place tip lost its ends (user 2026-09-26: goal 这里截断了). It is
   centred under the anchor, kept whole on screen, and opens upward when there
   is no room below. */
/* `lingerMs` keeps the tip up that long after the pointer leaves its anchor, so
   the pointer can cross the gap into a tip that can itself be clicked. */
export function useAnchoredTip<T extends HTMLElement>({ lingerMs = 0 }: { lingerMs?: number } = {}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<T>(null);
  const hideTimer = useRef<number | null>(null);
  const cancelHide = () => {
    if (hideTimer.current === null) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  useEffect(() => cancelHide, []);
  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip || !anchor) return;
    const gap = 6;
    const margin = 8;
    const centred = anchor.left + anchor.width / 2 - tip.offsetWidth / 2;
    const maxLeft = window.innerWidth - tip.offsetWidth - margin;
    tip.style.left = `${Math.max(margin, Math.min(centred, maxLeft))}px`;
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - tip.offsetHeight;
    tip.style.top = `${below + tip.offsetHeight > window.innerHeight - margin && above >= margin ? above : below}px`;
  }, [anchor]);
  const show = (event: { currentTarget: HTMLElement }) => {
    cancelHide();
    setAnchor(event.currentTarget.getBoundingClientRect());
  };
  const close = () => {
    cancelHide();
    setAnchor(null);
  };
  const hide = () => {
    if (lingerMs <= 0) return close();
    cancelHide();
    hideTimer.current = window.setTimeout(close, lingerMs);
  };
  return {
    open: anchor !== null,
    ref,
    close,
    anchorProps: { onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide },
    /** Spread on the tip when it lingers, so resting on it keeps it up. */
    tipProps: lingerMs > 0 ? { onPointerEnter: cancelHide, onPointerLeave: hide } : {},
  };
}

/* The status-tag registry names each tag's icon; this is the one place a name
   becomes a glyph, so a newly listed tag needs no change here. */
const STATUS_TAG_ICON_COMPONENTS: Record<StatusTagIcon, ComponentProps<typeof Tag>["icon"]> = {
  model: Cpu,
  effort: Gauge,
  owner: UserRound,
  machine: Monitor,
  repo: RepoOcticon,
  workspace: FolderOpen,
  name: AtSign,
  fast: Zap,
};

export function StatusChipBadge({
  chip,
  staged,
  expanded,
  onToggleEditor,
  untruncated,
}: {
  chip: StatusChip;
  /** Value chosen in the tag but not yet sent; shown in place of the live one. */
  staged?: string;
  expanded?: boolean;
  /** Present when this tag can be changed from here, absent when it only reports. */
  onToggleEditor?: () => void;
  /** Set where the tag must stay whole; a tag that only adds detail truncates. */
  untruncated?: boolean;
}) {
  const chipId = chip.id.toLowerCase();
  const isMode = chipId === "mode";
  /* The icon names the field, so no tag ever spells it out again: owner, machine
     and name read the same as model and effort, through this one path. */
  const openMachine = useOpenMachine(chipId === "machine" ? chip.machine : undefined);
  const registryIcon = statusTagIcon(chip.id);
  const Icon = registryIcon ? STATUS_TAG_ICON_COMPONENTS[registryIcon] : Zap;
  // Round once so 89.6% and 90.2% both read "90%" and pick the same fill,
  // instead of flickering across the threshold.
  const percent =
    chip.percent === undefined ? undefined : Math.round(Math.max(0, Math.min(100, chip.percent)));
  const fillPercent = percent ?? (chip.busy ? Math.round(Math.max(0, Math.min(100, chip.busy.percent))) : undefined);
  const rawValue = (staged || chip.value)?.trim();
  const displayValue =
    rawValue && isMode && /^[a-z]+(?:[_-][a-z]+)*$/.test(rawValue)
      ? rawValue
          .split(/[_-]/u)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
          .join(" ")
      : rawValue;
  const value = displayValue;
  const text = percent === undefined ? value : `${chip.label} ${formatPercent(percent)}${chip.note ? ` · ${chip.note}` : ""}`;
  const title = [
    `${chip.label}${value ? `: ${value}` : ""}`,
    // Staged, not live: the instance has not confirmed this selection yet.
    staged ? `Pending: ${staged}${chip.value ? ` (now ${chip.value})` : ""}` : undefined,
    percent === undefined ? undefined : `${formatPercent(percent)} used`,
    chip.busy ? `Load: ${chip.busy.glance.map((reading) => `${reading.label} ${formatPercent(reading.percent)}`).join(" · ")}` : undefined,
    chip.resetAt ? `Resets ${formatQuotaResetAt(chip.resetAt, "long") || chip.resetAt}` : undefined,
    onToggleEditor ? `Change ${chip.label.toLowerCase()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const tag = (
    <Tag
      icon={Icon}
      title={chip.busy ? undefined : title}
      chipId={chip.id}
      nowrap={untruncated}
      className={cn("app-status-chip-badge", staged && "text-foreground")}
      fill={fillPercent === undefined ? null : (
        <UsageMeterFill percent={fillPercent} tone={chip.noteTone ?? meterTone(fillPercent)} />
      )}
      {...(onToggleEditor ? { onClick: onToggleEditor, expanded } : {})}
    >
      {text}
    </Tag>
  );
  return chip.busy || openMachine
    ? <MachineLoadTag tag={tag} name={value} label={title} glance={chip.busy?.glance} onOpen={openMachine} />
    : tag;
}

/* The Machine tag opens the Machine's load the way its list row shows it, so
   the tag's tone can be read without leaving the conversation. When the reader
   has a page for that Machine, the tag and its card both open it. */
function MachineLoadTag({ tag, name, label, glance, onOpen }: {
  tag: ReactNode; name?: string; label: string; glance?: MachineGlanceReading[]; onOpen?: () => void;
}) {
  const tip = useAnchoredTip<HTMLSpanElement>({ lingerMs: onOpen ? 160 : 0 });
  const open = onOpen ? () => {
    tip.close();
    onOpen();
  } : undefined;
  return (
    <span className={cn("relative inline-flex shrink-0 align-middle", open && "cursor-pointer")} tabIndex={0}
      aria-label={open ? `${label}\nOpen ${name || "this Machine"}` : label} role={open ? "link" : undefined}
      data-machine-load-tag data-machine-link={open ? "" : undefined} {...tip.anchorProps}
      onClick={open ? (event) => {
        event.stopPropagation();
        open();
      } : undefined}
      onKeyDown={open ? (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        open();
      } : undefined}>
      {tag}
      {glance && tip.open && typeof document !== "undefined"
        ? createPortal(
            <span ref={tip.ref} role="tooltip" data-machine-load-tip {...tip.tipProps}
              className={cn("xmatrix-app app-goal-status-tooltip app-hint-tooltip app-machine-load-tip",
                open && "app-machine-load-tip-link")}
              onClick={open}>
              {name ? <span className="app-machine-load-tip-name">{name}</span> : null}
              <MachineLoadGlanceBars glance={glance} />
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

export function cleanModelLabel(model?: string): string | undefined {
  const value = model?.trim();
  // Cursor variants-mode placeholder when parameterizedModelPicker was missing.
  if (value && /^default\[\s*\]$/iu.test(value)) return undefined;
  return value ? value.slice(0, 128) : undefined;
}

export function cleanEffortLabel(effort?: string): string | undefined {
  const value = effort?.trim();
  return value ? value.slice(0, 64) : undefined;
}

export function cleanStatusChips(
  chips?: Array<{ id?: string; label?: string; value?: string; percent?: number; resetAt?: string; parameterKind?: string }>,
  modelFallback?: string,
  effortFallback?: string
): StatusChip[] | undefined {
  // The instance's current fields are the live authority. A chip list can be
  // carried across a partial presence update, so never let its older built-in
  // labels mask a freshly reported model or reasoning effort.
  const liveModel = modelFallback?.trim().slice(0, 128) || undefined;
  const liveEffort = effortFallback?.trim().slice(0, 64) || undefined;
  const cleaned = (chips || [])
    .map((chip) => {
      const id = chip.id?.trim();
      const label = chip.label?.trim();
      const value = chip.value?.trim();
      const liveValue =
        id?.toLowerCase() === "model"
          ? liveModel || (value && cleanModelLabel(value))
          : id?.toLowerCase() === "effort"
            ? liveEffort
            : value;
      const percent =
        typeof chip.percent === "number" && Number.isFinite(chip.percent) ? chip.percent : undefined;
      // Cursor variants-mode placeholder, and the ambient default Agent mode.
      if (id?.toLowerCase() === "model" && liveValue && /^default\[\s*\]$/iu.test(liveValue)) {
        return null;
      }
      if (id?.toLowerCase() === "mode" && liveValue && /^agent$/iu.test(liveValue)) {
        return null;
      }
      // Snapshots taken before the status-tag registry still carry tags for
      // parameters it does not list (an output style on every message).
      if (id && isUnlistedParameterTag(id)) return null;
      // A meter tag carries no text of its own; it still has something to show.
      if (!id || !label || (!liveValue && percent === undefined)) return null;
      return {
        id: id.slice(0, 64),
        label: label.slice(0, 64),
        ...(liveValue ? { value: liveValue.slice(0, 128) } : {}),
        ...(percent === undefined ? {} : { percent }),
        ...(chip.resetAt?.trim() ? { resetAt: chip.resetAt.trim().slice(0, 64) } : {}),
        ...(chip.parameterKind === "boolean" || chip.parameterKind === "enum" ? { parameterKind: chip.parameterKind } : {}),
      };
    })
    .filter((chip): chip is StatusChip => Boolean(chip))
    .slice(0, 16);
  const ids = new Set(cleaned.map((chip) => chip.id.toLowerCase()));
  const missingBuiltIns: StatusChip[] = [];
  if (liveModel && !ids.has("model")) {
    missingBuiltIns.push({ id: "model", label: "Model", value: liveModel });
  }
  if (liveEffort && !ids.has("effort")) {
    missingBuiltIns.push({ id: "effort", label: "Effort", value: liveEffort });
  }
  const dynamicLimit = Math.max(0, 16 - missingBuiltIns.length);
  const supplemented = [...cleaned.slice(0, dynamicLimit), ...missingBuiltIns];
  return supplemented.length ? supplemented : undefined;
}

export function goalStatusBadgeTone(goal?: AgentGoalStatus): string {
  const status = goal?.status?.trim().toLowerCase();
  if (status === "paused" || status === "pause" || status === "pausing") {
    return "app-goal-status-badge-paused border-zinc-700 bg-zinc-700 text-white shadow-sm";
  }
  if (goal?.active === true || status === "active" || status === "in_progress" || status === "running") {
    return "app-goal-status-badge-active text-white shadow-sm";
  }
  if (status === "completed" || status === "complete" || status === "done" || status === "success") {
    return "app-goal-status-badge-complete text-white shadow-sm";
  }
  if (status === "blocked" || status === "failed" || status === "error" || isUsageLimitGoalStatus(status)) {
    return "app-goal-status-badge-blocked text-white shadow-sm";
  }
  return "app-goal-status-badge-neutral border-zinc-700 bg-zinc-700 text-white shadow-sm";
}

export function goalStatusValue(goal?: AgentGoalStatus): string {
  if (!goal) return "none";
  const objective = goal.objective?.trim();
  const status = goal.status?.trim();
  if (goal.active === false) {
    if (objective && status) return `${status}: ${objective}`;
    if (objective) return objective;
    if (status && !["clear", "cleared"].includes(status.toLowerCase())) return status;
    return "none";
  }
  return objective || status || "active";
}

export function goalStatusBadgeLabel(
  goal?: AgentGoalStatus,
  presentation: "historical" | "live" = "historical"
): string | undefined {
  if (!goal) return undefined;
  const status = goal.status?.trim();
  // usageLimit is a point-in-time interruption reason from the persisted
  // message snapshot, not the current quota state. Present it as paused in
  // the compact badge and keep the specific reason and objective in hover.
  if (presentation === "historical" && isUsageLimitGoalStatus(status)) return "Goal: paused";
  if (goal.active === true) return status ? `Goal: ${status}` : "Goal: active";
  if (goal.active === false) {
    if (status && !["clear", "cleared"].includes(status.toLowerCase())) return `Goal: ${status}`;
    return undefined;
  }
  return status ? `Goal: ${status}` : "Goal";
}

export function isUsageLimitGoalStatus(status?: string): boolean {
  const normalized = status?.trim().toLowerCase().replace(/[\s_-]+/g, "") || "";
  return (
    normalized.includes("usagelimit") ||
    normalized.includes("ratelimit") ||
    normalized.includes("budgetlimit")
  );
}

export function goalStatusDisplayValue(status: string): string {
  return isUsageLimitGoalStatus(status) ? "usage limit" : status;
}

export function goalStatusTitle(
  goal?: AgentGoalStatus,
  presentation: "historical" | "live" = "historical"
): string {
  if (!goal) return "No active goal";
  const tokenUsage = goal.tokensUsed !== undefined ? `${goal.tokensUsed}` : undefined;
  const parts = [
    goal.objective ? `Goal: ${goal.objective}` : `Goal: ${goalStatusValue(goal)}`,
    goal.status
      ? `${presentation === "live" ? "Live status" : "Status when sent"}: ${
          presentation === "live" ? goal.status : goalStatusDisplayValue(goal.status)
        }`
      : undefined,
    goal.reason ? `Reason: ${goal.reason}` : undefined,
    goal.nextAction ? `Next action: ${goal.nextAction}` : undefined,
    tokenUsage ? `Tokens: ${tokenUsage}` : undefined,
    goal.timeUsedSeconds !== undefined ? `Time: ${goal.timeUsedSeconds}s` : undefined,
    goal.iterationCount !== undefined ? `Iterations: ${goal.iterationCount}` : undefined,
    goal.contextUsed !== undefined ? `Context used: ${goal.contextUsed}` : undefined,
    goal.toolCallCount !== undefined ? `Tool calls: ${goal.toolCallCount}` : undefined,
  ].filter(Boolean);
  return parts.join("\n");
}

export function provenanceLabel(
  provenance: NonNullable<TimelineItem["provenance"]>,
  body?: string,
): string {
  if (provenance === "system_fact") {
    const tone = systemNoticeTone(body);
    if (tone === "warning") return "waiting";
    if (tone === "error") return "couldn't start";
    return "system fact";
  }
  if (provenance === "approved_action_result") return "approved action";
  return "management";
}

export function shouldShowProvenanceBadge(provenance: TimelineItem["provenance"]): provenance is "system_fact" | "approved_action_result" {
  return provenance === "system_fact" || provenance === "approved_action_result";
}

export function provenanceTitle(
  provenance: NonNullable<TimelineItem["provenance"]>,
  body?: string,
): string {
  if (provenance === "system_fact") {
    const tone = systemNoticeTone(body);
    if (tone === "warning") {
      return "The agent did not start. The run is queued until the machine daemon reconnects.";
    }
    if (tone === "error") return "xMatrix could not start the requested agent";
    return "Deterministic xMatrix system fact";
  }
  if (provenance === "approved_action_result") return "Result of an approved xMatrix management action";
  return "xMatrix management judgment";
}

export function provenanceBadgeClass(
  provenance: NonNullable<TimelineItem["provenance"]>,
  body?: string,
): string {
  const layout = TAG_SHAPE_CLASS;
  if (provenance === "system_fact") {
    const tone = systemNoticeTone(body);
    if (tone === "warning") return statusChipClass("attention", layout);
    if (tone === "error") return statusChipClass("alert", layout);
    // A plain deterministic fact is the resting state: it is marked as a fact
    // by the label, not by an ink that would claim something is going on.
    return statusChipClass("settled", layout);
  }
  if (provenance === "approved_action_result") {
    return statusChipClass("settled", layout);
  }
  return statusChipClass("attention", layout);
}

export function eventLabel(event: ObservabilityEvent): string {
  if (event.type === "channel_mention") {
    return event.metadata?.reason === "reply" ? "replied to you" : "mentioned you";
  }
  if (event.type === "channel_attention_updated") {
    const attention = attentionSummaryFromEvent(event);
    if (!attention || attention.unreadAttentionCount <= 0) return "read your mentions and replies";
    return attention.primaryTriggerKind === "reply" ? "replied to you" : "mentioned you";
  }
  return event.type.replace(/_/g, " ");
}

/* Bare local time, for a timestamp read down a column of siblings that share
   its zone. Anything standalone wants formatDateTime instead. */
export function formatTime(value: string): string {
  return formatLocalClock(value);
}

/**
 * A standalone instant — a schedule's next run, an expiry, a last-updated —
 * so it names its zone. These are exactly the strings a reader quotes into a
 * channel or a ticket, where "Next: Sep 19, 4:23 AM" means nothing without it.
 */
export function formatDateTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "Unavailable";
  return formatZonedDateTime(value, undefined, undefined, { month: "short" });
}

export function evaluationBindingLabel(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "Legacy compatibility input";
  }
  const record = input as Record<string, unknown>;
  const lineage = record.lineage && typeof record.lineage === "object" && !Array.isArray(record.lineage)
    ? record.lineage as Record<string, unknown>
    : undefined;
  const envRef = record.envRef && typeof record.envRef === "object" && !Array.isArray(record.envRef)
    ? record.envRef as Record<string, unknown>
    : undefined;
  const actor = envRef?.actor && typeof envRef.actor === "object" && !Array.isArray(envRef.actor)
    ? envRef.actor as Record<string, unknown>
    : undefined;
  const depth = lineage?.depth;
  if (typeof depth !== "number" || !Number.isSafeInteger(depth) || typeof actor?.kind !== "string" ||
      typeof actor.id !== "string" || !actor.kind || !actor.id) {
    return "Legacy compatibility input";
  }
  const scope = depth === 0 ? "Root evaluation" : `Child evaluation · depth ${depth}`;
  return `${scope} · actor ${actor.kind}:${actor.id}`;
}

export type { StatusChip } from "./workspace-shell-domain-types";
export { formatCompactNumber } from "./workspace-shell-formatters";

/* moved to workspace-shell-presence (11) */
