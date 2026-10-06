"use client";
export { exchangeDesktopCliSession } from "@/lib/desktop/session-exchange";
import { attachmentMediaType, directMediaLink } from "./attachment-media-type";
import { MediaLink } from "./media-player";
import { LoadingImage } from "./content-skeleton";
import { formatInstant, formatZonedDateTime } from "./time-display";

import { messageRichMetadata } from "./workspace-shell-message-model";
import { isOnlinePresence } from "./workspace-shell-presence";

import {
  COLLAPSED_MESSAGE_PREVIEW_LENGTH,
  COLLAPSED_MESSAGE_PREVIEW_LINES,
  COLLAPSIBLE_MESSAGE_LENGTH,
  COLLAPSIBLE_MESSAGE_LINES,
  XMATRIX_RELEASE_VERSION,
  IMAGE_ATTACHMENT_TYPES,
  MARKDOWN_ATTACHMENT_TYPES,
} from "./workspace-shell-constants";

import type {
  LlmQuotaUsage,
  LlmUsage,
  LocalManagedAgent,
  StatusChip,
  UsageLimitSummary,
} from "./workspace-shell-domain-types";

export type {
  LlmQuotaUsage,
  LlmUsage,
  LocalManagedAgent,
  UsageLimitSummary,
} from "./workspace-shell-domain-types";

import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { type Components } from "react-markdown";

import {
  Check,
  Copy,
} from "lucide-react";

import { NonOperationalMentions, renderMentionChildren } from "@/components/dashboard/mention-read-chip";
import { MessageReferenceChip } from "@/components/dashboard/page-reference-chip";
import { loneMessageReference } from "@xmatrix/protocol";

import {
  type AgentTraceTimelineBlock,
  type AgentTraceTimelineField,
} from "@/components/dashboard/agent-trace-stream";

import {
  workspaceForInstance,
} from "@/components/dashboard/agent-workspaces";

import {
  compactWorkspacePathTail,
  repoReferenceForWorkspace,
} from "@/components/dashboard/workspace-labels";

import {
  type DesktopUpdateStatus,
} from "@/lib/desktop/bridge";

import { cn } from "@/lib/utils";

import { AGENT_PRESETS, agentAvatarUrlFromMetadata } from "@xmatrix/protocol";

import type {
  AgentPreset,
  ChannelMessage,
  ChannelMemberPresence,
  ObservabilityEvent,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";

export function collapsedMessagePreview(body: string): string {
  if (body.length <= COLLAPSED_MESSAGE_PREVIEW_LENGTH) {
    const lineBreaks = body.match(/\n/g);
    if (!lineBreaks || lineBreaks.length < COLLAPSED_MESSAGE_PREVIEW_LINES) return body;
  }

  const normalized = body.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const lineLimited = lines.length > COLLAPSED_MESSAGE_PREVIEW_LINES
    ? lines.slice(0, COLLAPSED_MESSAGE_PREVIEW_LINES).join("\n")
    : normalized;
  if (lineLimited.length <= COLLAPSED_MESSAGE_PREVIEW_LENGTH) return lineLimited;
  return lineLimited.slice(0, COLLAPSED_MESSAGE_PREVIEW_LENGTH);
}

export function createMessageMarkdownComponents(
  onOpenInternalAppLink?: (href: string) => boolean
): Components {
  return {
  h1: ({ children, node }) => <h1 className="mt-2 text-lg font-black leading-6 first:mt-0">{renderMentionChildren(children, node)}</h1>,
  h2: ({ children, node }) => <h2 className="mt-2 text-base font-black leading-6 first:mt-0">{renderMentionChildren(children, node)}</h2>,
  h3: ({ children, node }) => <h3 className="mt-2 text-[15px] font-black leading-5 first:mt-0">{renderMentionChildren(children, node)}</h3>,
  h4: ({ children, node }) => <h4 className="mt-2 text-[15px] font-black leading-5 first:mt-0">{renderMentionChildren(children, node)}</h4>,
  h5: ({ children, node }) => <h5 className="mt-2 text-sm font-bold first:mt-0">{renderMentionChildren(children, node)}</h5>,
  h6: ({ children, node }) => <h6 className="mt-2 text-sm font-bold first:mt-0">{renderMentionChildren(children, node)}</h6>,
  // Mentions carry read state, so body text runs pass through the mention
  // renderer. Code spans keep their children untouched.
  p: ({ children, node }) => (
    <p className="mt-1 whitespace-pre-wrap first:mt-0">{renderMentionChildren(children, node)}</p>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l-2 border-primary/60 pl-3 text-muted-foreground first:mt-0">
      <NonOperationalMentions>{children}</NonOperationalMentions>
    </blockquote>
  ),
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>
  ),
  li: ({ children, node }) => <li>{renderMentionChildren(children, node)}</li>,
  a: ({ href, children }) => {
    const safeHref = typeof href === "string" && isSafeRichTextHref(href) ? href : undefined;
    if (!safeHref) return <>{children}</>;
    if (directMediaLink(safeHref)) return <MediaLink href={safeHref}>{children}</MediaLink>;
    const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (
        !onOpenInternalAppLink ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      if (onOpenInternalAppLink(safeHref)) {
        event.preventDefault();
      }
    };
    return (
      <a href={safeHref} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2" onClick={handleClick}>
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    if (typeof src !== "string" || !isSafeMessageImageSrc(src)) return null;
    return (
      <LoadingImage
        src={src}
        alt={typeof alt === "string" ? alt : ""}
        className="mt-2 max-h-[28rem] max-w-full object-contain"
      />
    );
  },
  code: ({ className, children }) => {
    const language = /language-([A-Za-z0-9_-]+)/.exec(className || "")?.[1];
    if (language) {
      return (
        <code className={cn("block min-w-max font-mono", className)}>
          {children}
        </code>
      );
    }
    // Agents often wrap `page:<id>` or `channel:<id>` in backticks; promote a lone reference to the same live chip.
    const span = loneMessageReference(markdownTextContent(children));
    if (span) return <MessageReferenceChip span={span} />;
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] [overflow-wrap:anywhere]">{children}</code>;
  },
  pre: MarkdownPre,
  table: ({ children }) => (
    <div className="message-table-scroll mt-2 max-w-full overflow-x-auto first:mt-0">
      <table className="message-table w-full min-w-max border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children, node }) => (
    <th scope="col" className="border border-border bg-muted/70 px-2.5 py-1.5 font-bold text-foreground">
      {renderMentionChildren(children, node)}
    </th>
  ),
  td: ({ children, node }) => (
    <td className="border border-border px-2.5 py-1.5 align-top">{renderMentionChildren(children, node)}</td>
  ),
  del: ({ children }) => <del className="text-muted-foreground"><NonOperationalMentions>{children}</NonOperationalMentions></del>,
  section: ({ children, node: _node, ...props }) => <section {...props}><NonOperationalMentions>{children}</NonOperationalMentions></section>,
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <input type="checkbox" checked={Boolean(checked)} readOnly tabIndex={-1} className="mr-1.5 align-middle" />
    ) : null,
  };
}

export function markdownTextContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownTextContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return markdownTextContent((node as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return "";
}

export function markdownCodeLanguage(node: React.ReactNode): string {
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  const className = (node as { props?: { className?: unknown } }).props?.className;
  return typeof className === "string" ? /language-([A-Za-z0-9_-]+)/.exec(className)?.[1] || "" : "";
}

/** Pure clipboard helper (no shell reverse deps). */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

/** Compact number display for quota meters. */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function channelAttachmentKindForMimeType(
  mimeType: string,
  name = ""
): "image" | "video" | "markdown" | "file" {
  const normalized = mimeType.trim().toLowerCase();
  const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)
    ? normalized
    : "application/octet-stream";
  if (IMAGE_ATTACHMENT_TYPES.has(mime)) return "image";
  if (attachmentMediaType(mimeType, name) === "video") return "video";
  if (MARKDOWN_ATTACHMENT_TYPES.has(mime)) return "markdown";
  return "file";
}

export function busiestAgentInstance(
  instances: import("@xmatrix/protocol").SerializedAgentInstance[] | undefined
): import("@xmatrix/protocol").SerializedAgentInstance | undefined {
  if (!instances?.length) return undefined;
  return (
    instances.find((instance) => instance.status === "busy") ||
    instances.find((instance) => isOnlinePresence(instance.status)) ||
    instances[0]
  );
}

export function MarkdownPre({ children }: { children?: React.ReactNode }) {
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    if (!codeCopied) return;
    const timeout = window.setTimeout(() => setCodeCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [codeCopied]);

  async function copyCodeBlock() {
    await copyTextToClipboard(markdownTextContent(children).replace(/\n$/, ""));
    setCodeCopied(true);
  }

  const language = markdownCodeLanguage(children);
  return (
    <div className="message-code-block group/code relative mt-2 w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/70 first:mt-0">
      <div className="pointer-events-none sticky top-0 right-0 left-0 z-10 flex min-h-8 items-center justify-between gap-2 bg-muted px-3 py-1.5">
        <span className="min-w-0 truncate text-[11px] font-bold uppercase text-muted-foreground">
          {language || "code"}
        </span>
        <button
          type="button"
          title={codeCopied ? "Copied" : "Copy code"}
          aria-label={codeCopied ? "Copied" : "Copy code"}
          onClick={() => void copyCodeBlock()}
          className="pointer-events-auto inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-100 transition hover:bg-background/70 hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/code:opacity-100"
        >
          {codeCopied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre className="message-code-scroll max-w-full overflow-x-auto p-3 pt-2 text-xs leading-5">{children}</pre>
    </div>
  );
}

export function isSafeMessageImageSrc(src: string): boolean {
  if (src.startsWith("/") && !src.startsWith("//")) return true;
  if (src.startsWith("blob:") || src.startsWith("data:image/")) return true;
  return isSafeRichTextHref(src);
}

export function isSafeRichTextHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function spacePreferredLanguage(space: SerializedSpace | null): "zh" | "en" | undefined {
  const locale = space?.metadata?.locale;
  if (locale && typeof locale === "object" && !Array.isArray(locale)) {
    const defaultLocale = (locale as { defaultLocale?: unknown }).defaultLocale;
    if (typeof defaultLocale === "string") {
      if (defaultLocale.toLowerCase().startsWith("zh")) return "zh";
      if (defaultLocale.toLowerCase().startsWith("en")) return "en";
    }
  }
  // Read the earlier setting while existing Spaces migrate to `metadata.locale`.
  const value = space?.metadata?.preferredLanguage;
  return value === "zh" || value === "en" ? value : undefined;
}

/* Where the instance is working, said the way a summon says it — a repository
   when there is one, a path otherwise, and the two carry different marks because
   a repository is not a folder. The registered Workspace is the only record that
   knows the repository; an instance reports a cwd and nothing else, so its own
   fields are the fallback. Machine, branch and model are their own tags. */
export function channelAgentInstanceWorkspaceTag(
  instance: SerializedAgentInstance,
  workspaces: SerializedWorkspace[]
): StatusChip | undefined {
  const workspace = workspaceForInstance(workspaces, instance);
  const repo = workspace && repoReferenceForWorkspace(workspace);
  if (repo) return { id: "repo", label: "Repository", value: repo };

  const path = workspace
    ? compactWorkspacePathTail(workspace.canonicalCwd)
    : instance.workspaceName?.trim() || (instance.cwd ? compactWorkspacePathTail(instance.cwd) : undefined);
  return path ? { id: "workspace", label: "Workspace", value: path } : undefined;
}

export function latestChannelConnectorStateMessageId(history: ChannelMessage[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message.from.kind === "agent" &&
      message.from.email === "system@xmatrix.local" &&
      messageRichMetadata(message)?.xmatrixProvenance === "system_fact" &&
      /\b(?:subscribe|unsubscribe): completed(?:;|\.|$)/i.test(message.body)
    ) {
      return message.messageId;
    }
  }
  return undefined;
}

export function isLongMessageBody(body: string): boolean {
  if (body.length > COLLAPSIBLE_MESSAGE_LENGTH) return true;
  return body.replace(/\r\n?/g, "\n").split("\n").length > COLLAPSIBLE_MESSAGE_LINES;
}

export function traceFieldValue(fields: AgentTraceTimelineField[], label: string): string {
  return fields.find((field) => field.label === label)?.value || "";
}

export function traceBlockText(blocks: AgentTraceTimelineBlock[], label: string): string {
  return blocks.find((block) => block.label === label)?.text || "";
}

export function traceToolPreviewText(value: string): string {
  const parsed = parseTracePreviewJson(value);
  if (parsed !== null) return tracePreviewText(formatTracePreviewValue(parsed));
  return tracePreviewText(value);
}

export function tracePreviewText(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const lines = text.split("\n").slice(0, 4);
  const preview = lines.join("\n").trim();
  return text.length > preview.length || text.split("\n").length > lines.length ? `${preview}\n...` : preview;
}

export function parseTracePreviewJson(value: string): unknown | null {
  const text = value.trim();
  if (!text || !["{", "["].includes(text[0] || "")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function formatTracePreviewValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => formatTracePreviewArrayItem(item));
    return value.length > items.length ? [...items, `... ${value.length - items.length} more`].join("\n") : items.join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, itemValue]) => itemValue !== undefined && itemValue !== null && itemValue !== "")
      .slice(0, 4)
      .map(([key, itemValue]) => `${key}: ${formatTracePreviewScalar(itemValue)}`);
    return entries.join("\n");
  }
  return formatTracePreviewScalar(value);
}

export function formatTracePreviewArrayItem(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return formatTracePreviewScalar(value);
  const record = value as Record<string, unknown>;
  const label = formatTracePreviewScalar(record.tool_name || record.name || record.type || record.id || "item");
  const detail = Object.entries(record)
    .filter(([key, itemValue]) => !["tool_name", "name", "id"].includes(key) && itemValue !== undefined && itemValue !== null && itemValue !== "")
    .slice(0, 2)
    .map(([key, itemValue]) => `${key}: ${formatTracePreviewScalar(itemValue)}`)
    .join(" · ");
  return detail ? `${label} · ${detail}` : label;
}

export function formatTracePreviewScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

/**
 * One tag. `percent` turns it into a meter; `resetLabel` is the window it
 * resets at. Nothing here says where the value came from.
 */
export type Tag = {
  key: string;
  label: string;
  title: string;
  percent?: number;
  resetLabel?: string;
  /** The limit verdict's word on this window: when it resets, or the credits paying past it. */
  note?: string;
  /** Overrides the percentage's tone: a used-up window paid by credits reads as a warning. */
  noteTone?: "yellow" | "red";
};

/**
 * Read the wire usage payload into tags — one per attribute it actually
 * reports. An attribute the payload omits produces no tag; no tag ever stands
 * in for a missing one.
 */
export function tagsFromUsage(usage: LlmUsage): Tag[] {
  const tags: Tag[] = providerQuotaUsages(usage).map((quota) => ({
    key: quotaTagKey(quota),
    label: quotaLabel(quota),
    title: quotaTitle(quota),
    percent: quotaPercent(quota),
    resetLabel: quotaResetLabel(quota),
  }));
  if (usage.quotaState === "exhausted") {
    tags.push({ key: "quota:exhausted", label: "Quota exhausted", title: "Provider quota exhausted", percent: 100 });
  }

  const contextPercent = usageContextPercent(usage);
  if (contextPercent !== undefined) {
    tags.push({ key: "ctx", label: "ctx", title: "Context usage", percent: contextPercent });
  }

  for (const [key, label] of [
    ["input", usage.inputTokens !== undefined ? `in ${formatCompactNumber(usage.inputTokens)}` : undefined],
    ["output", usage.outputTokens !== undefined ? `out ${formatCompactNumber(usage.outputTokens)}` : undefined],
    ["total", usage.totalTokens !== undefined ? `total ${formatCompactNumber(usage.totalTokens)}` : undefined],
    [
      "context-tokens",
      usage.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined
        ? `${formatCompactNumber(usage.contextUsedTokens)}/${formatCompactNumber(usage.contextWindowTokens)}`
        : undefined,
    ],
    ["cached", usage.cachedInputTokens !== undefined ? `cached ${formatCompactNumber(usage.cachedInputTokens)}` : undefined],
    [
      "cache-write",
      usage.cacheCreationInputTokens !== undefined
        ? `cache write ${formatCompactNumber(usage.cacheCreationInputTokens)}`
        : undefined,
    ],
    [
      "cache-read",
      usage.cacheReadInputTokens !== undefined
        ? `cache read ${formatCompactNumber(usage.cacheReadInputTokens)}`
        : undefined,
    ],
    ["reasoning", usage.reasoningTokens !== undefined ? `reasoning ${formatCompactNumber(usage.reasoningTokens)}` : undefined],
    ["tools", usage.toolCallCount !== undefined ? `tools ${formatCompactNumber(usage.toolCallCount)}` : undefined],
    ["cost", usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : undefined],
  ] as Array<[string, string | undefined]>) {
    if (label !== undefined) tags.push({ key, label, title: label });
  }

  return tags;
}

/** React identity follows the quota window, not its rolling reset clock. */
export function quotaTagKey(quota: LlmQuotaUsage): string {
  return `quota:${quotaLabel(quota).toLowerCase()}`;
}

/** 0-100, on the same terms as {@link quotaPercent}: every producer of this
 * field computes it as `used / window * 100`. */
export function usageContextPercent(usage: LlmUsage): number | undefined {
  if (
    usage.contextUsedTokens !== undefined &&
    usage.contextWindowTokens !== undefined &&
    usage.contextWindowTokens > 0
  ) {
    return (usage.contextUsedTokens / usage.contextWindowTokens) * 100;
  }
  if (usage.contextUsagePercent !== undefined) return usage.contextUsagePercent;
  if (
    usage.contextUsedTokens !== undefined &&
    usage.contextWindowTokens !== undefined &&
    usage.contextWindowTokens > 0
  ) {
    return (usage.contextUsedTokens / usage.contextWindowTokens) * 100;
  }
  return undefined;
}

export function normalizeQuotaUsageList(value: LlmQuotaUsage[] | undefined): LlmQuotaUsage[] {
  if (!value) return [];
  const quotaUsages = value
    .map((quota) => ({ ...quota, percent: quotaPercent(quota) }))
    .filter((quota) => !quotaResetHasPassed(quota))
    // A percentage on its own does not identify a window. Keeping those meant an
    // unnamed quota reached the renderers, which then had to invent a name for
    // it — so an unrelated model's limit could surface as this agent's.
    .filter((quota) => quota.label || quota.window);
  const exactCodexQuotas = quotaUsages.filter((quota) => quota.window?.toLowerCase() === "codex");
  const codexQuotas = quotaUsages.filter((quota) => isCodexQuotaUsage(quota));
  const selected = (exactCodexQuotas.length > 0
    ? exactCodexQuotas
    : codexQuotas.length > 0
      ? codexQuotas
      : quotaUsages).filter((quota) => {
      const label = quotaLabel(quota).toLowerCase();
      // Codex/Claude/ZCode: 5h + weekly. Grok Build billing: monthly credits (1mo).
      // Grok consumer-style short windows are often 2h.
      return label === "5h" || label === "1w" || label === "2h" || label === "1mo";
    });
  return dedupeQuotaUsagesByLabel(selected.sort(compareQuotaUsageForDisplay))
    .slice(0, 3);
}

/** A provider may report the same semantic window through label and window forms. */
export function dedupeQuotaUsagesByLabel(value: LlmQuotaUsage[]): LlmQuotaUsage[] {
  const seen = new Set<string>();
  return value.filter((quota) => {
    const key = quotaLabel(quota).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const QUOTA_DISPLAY_ORDER = ["5h", "1w", "2h", "1mo"] as const;

/** Provider array order is transport detail; the visible three are deterministic. */
export function compareQuotaUsageForDisplay(left: LlmQuotaUsage, right: LlmQuotaUsage): number {
  const leftLabel = quotaLabel(left).toLowerCase();
  const rightLabel = quotaLabel(right).toLowerCase();
  const leftRank = QUOTA_DISPLAY_ORDER.indexOf(leftLabel as typeof QUOTA_DISPLAY_ORDER[number]);
  const rightRank = QUOTA_DISPLAY_ORDER.indexOf(rightLabel as typeof QUOTA_DISPLAY_ORDER[number]);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftLabel !== rightLabel) return leftLabel.localeCompare(rightLabel);
  // Duplicate provider records for one window must resolve independently of
  // array order. Prefer the window that remains current longer; if both reset
  // together, conservatively show the higher reported usage.
  const resetOrder = (right.resetAt || "").localeCompare(left.resetAt || "");
  if (resetOrder !== 0) return resetOrder;
  return (right.percent ?? -1) - (left.percent ?? -1);
}

export function quotaResetHasPassed(quota: LlmQuotaUsage, now = Date.now()): boolean {
  if (!quota.resetAt) return false;
  const resetAt = parseQuotaResetAt(quota.resetAt);
  return resetAt !== null && resetAt.getTime() <= now;
}

/**
 * The one limit verdict for a live agent instance. Every surface that marks an
 * instance as limited reads it from here, so a compact badge and the detail row
 * beside it can never disagree about whether the agent is out of quota.
 *
 * Quota windows are account-level, so this merges the instance's own report with
 * the account quota any live instance of the agent reported. Being at the limit
 * is the fact; which window ran out is detail that belongs in the hover title,
 * not in whether the mark appears.
 */
export function agentInstanceUsageLimit(
  presence: ChannelMemberPresence,
  instance: SerializedAgentInstance
): UsageLimitSummary | undefined {
  return usageLimitSummary(
    mergeUsageAttributes(usageWithoutQuota(instance.usage), accountQuotaUsage(agentMemberUsage(presence)))
  );
}

export function usageLimitSummary(usage?: LlmUsage): UsageLimitSummary | undefined {
  if (usage?.quotaState === "exhausted") return { label: "limit", severity: "limit", title: "Provider quota exhausted" };
  // The provider's verdict on the account outranks its windows: it may refuse
  // an account whose windows look fine, or keep serving one past a used-up
  // window on credits. Whether to spend them is the account's own setting.
  const allowed = usage?.quotaAccount?.allowed;
  if (allowed === false) return { label: "limit", severity: "limit", title: "Usage limit reached: provider refuses requests" };
  const quota = providerQuotaUsages(usage)
    .map((candidate) => ({ quota: candidate, percent: quotaPercent(candidate) }))
    // A limit warning is time-sensitive: keep this guard at the verdict boundary
    // even though providerQuotaUsages normalizes its display list as well.
    .filter(({ quota }) => !quotaResetHasPassed(quota))
    .filter(({ quota, percent }) =>
      (quota.remaining !== undefined && quota.remaining <= 0) ||
      (quota.used !== undefined && quota.limit !== undefined && quota.limit > 0 && quota.used >= quota.limit) ||
      (percent !== undefined && percent >= 90)
    )
    .sort((left, right) => {
      const leftSeverity = quotaAtLimit(left.quota, left.percent) ? 0 : 1;
      const rightSeverity = quotaAtLimit(right.quota, right.percent) ? 0 : 1;
      if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
      return (right.percent || 0) - (left.percent || 0);
    })[0];
  if (!quota) return undefined;

  const atLimit = quotaAtLimit(quota.quota, quota.percent);
  // The window's own usage tag carries the verdict, so it names that window
  // and says what the tag adds: what pays for requests now, or when they come back.
  const window = quotaLabel(quota.quota);
  const percent = quota.percent;
  if (atLimit && allowed === true) {
    return {
      label: "credits",
      severity: "warning",
      title: `On credits: ${quotaTitle(quota.quota)}${creditsTitle(usage)}`,
      window,
      percent,
      note: creditsNote(usage),
      credits: true,
    };
  }
  if (atLimit) {
    const resetLabel = quotaResetLabel(quota.quota);
    return {
      label: "limit",
      severity: "limit",
      title: `Usage limit reached: ${quotaTitle(quota.quota)}`,
      window,
      percent,
      ...(resetLabel ? { note: resetLabel } : {}),
    };
  }
  return {
    label: `${formatPercent(quota.percent || 0)}+`,
    severity: "warning",
    title: `Usage near limit: ${quotaTitle(quota.quota)}`,
    window,
    percent,
  };
}

function creditsNote(usage?: LlmUsage): string {
  const balance = usage?.quotaAccount?.credits?.balance;
  return balance !== undefined && !usage?.quotaAccount?.credits?.unlimited
    ? `${formatCompactNumber(balance)} credits`
    : "credits";
}

function creditsTitle(usage?: LlmUsage): string {
  const credits = usage?.quotaAccount?.credits;
  if (credits?.unlimited) return " - unlimited credits";
  return credits?.balance !== undefined ? ` - ${formatCompactNumber(credits.balance)} credits left` : "";
}

export function quotaAtLimit(quota: LlmQuotaUsage, percent?: number): boolean {
  if (quota.remaining !== undefined && quota.remaining <= 0) return true;
  if (quota.used !== undefined && quota.limit !== undefined && quota.limit > 0 && quota.used >= quota.limit) return true;
  return percent !== undefined && percent >= 100;
}

export function isCodexQuotaUsage(quota: LlmQuotaUsage): boolean {
  return `${quota.label || ""} ${quota.window || ""}`.toLowerCase().includes("codex");
}

export function hasQuotaMeterUsage(usage?: LlmUsage): boolean {
  return providerQuotaUsages(usage).length > 0;
}

/**
 * Quota windows are an account-level fact, so any live instance of the agent may
 * report them — unlike tokens and context, which belong to one instance.
 */
export function accountQuotaUsage(usage?: LlmUsage): LlmUsage | undefined {
  if (usage?.quotaState === "exhausted") return { quotaState: "exhausted", quotaObservedAt: usage.quotaObservedAt };
  const quotaUsages = providerQuotaUsages(usage);
  if (quotaUsages.length === 0) return undefined;
  const quotaObservedAt = usage?.quotaObservedAt;
  return {
    quotaSource: "provider_api",
    quotaUsages,
    ...(quotaObservedAt ? { quotaObservedAt } : {}),
    ...(usage?.quotaAccount ? { quotaAccount: usage.quotaAccount } : {}),
  };
}

/** Provider API provenance is required before an account meter can render. */
export function providerQuotaUsages(usage?: LlmUsage): LlmQuotaUsage[] {
  return usage?.quotaSource === "provider_api"
    ? normalizeQuotaUsageList(usage.quotaUsages)
    : [];
}

function usageWithoutQuota(usage?: LlmUsage): LlmUsage | undefined {
  if (!usage) return undefined;
  const {
    quotaSource: _quotaSource,
    quotaState: _quotaState,
    quotaUsages: _quotaUsages,
    quotaObservedAt: _quotaObservedAt,
    quotaAccount: _quotaAccount,
    ...localUsage
  } = usage;
  return Object.keys(localUsage).length > 0 ? localUsage : undefined;
}

/**
 * Take each usage attribute from the first candidate that reports it. Quota,
 * context, and token counts are independent facts: a source that lacks one of
 * them must not hide the others.
 */
export function mergeUsageAttributes(...candidates: Array<LlmUsage | undefined>): LlmUsage | undefined {
  const merged: Record<string, unknown> = {};
  for (const usage of candidates) {
    if (!usage) continue;
    for (const [key, value] of Object.entries(usage)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? (merged as LlmUsage) : undefined;
}

/** Prefer any usage that still has displayable 5h/1w/2h/1mo meters. */
function preferredQuotaUsage(...candidates: Array<LlmUsage | undefined>): LlmUsage | undefined {
  for (const usage of candidates) {
    if (hasQuotaMeterUsage(usage)) return usage;
  }
  return candidates.find((usage) => Boolean(usage));
}

/** The server supplies whole pool readings; select by observation time, never by usage magnitude. */
function accountQuotaUsageFromCandidates(...candidates: Array<LlmUsage | undefined>): LlmUsage | undefined {
  let latest: LlmUsage | undefined;
  for (const usage of candidates) {
    if (usage?.quotaState !== "unknown" && (usage?.quotaSource !== "provider_api" || !usage.quotaUsages?.length)) continue;
    const time = Date.parse(usage.quotaObservedAt ?? "");
    if (usage.quotaState !== "unknown" && !Number.isFinite(time)) continue;
    const previous = Date.parse(latest?.quotaObservedAt ?? "");
    if (!latest || time > previous || (!Number.isFinite(previous) && Number.isFinite(time)) ||
        (time === previous && usage.quotaState === "unknown")) latest = usage;
  }
  if (!latest) return undefined;
  return { quotaState: latest.quotaState ?? "observed", quotaObservedAt: latest.quotaObservedAt,
    ...(latest.quotaState !== "unknown" ? { quotaSource: "provider_api", quotaUsages: latest.quotaUsages,
      ...(latest.quotaAccount ? { quotaAccount: latest.quotaAccount } : {}) } : {}) };
}

/** Apply a canonical snapshot. Delayed frames cannot regress the pool observation. */
export function mergeAccountLevelLlmUsage(current?: LlmUsage, update?: LlmUsage): LlmUsage | undefined {
  if (!update) return current;
  const quota = accountQuotaUsageFromCandidates(update, current);
  return mergeUsageAttributes(usageWithoutQuota(update), usageWithoutQuota(current), quota);
}

export function agentMemberUsage(presence: ChannelMemberPresence): LlmUsage | undefined {
  const instances = presence.instances || [];
  const busy = busiestAgentInstance(instances);
  const quota = accountQuotaUsageFromCandidates(...instances.map(instance => instance.usage), presence.usage);
  return mergeUsageAttributes(
    usageWithoutQuota(busy?.usage),
    quota,
    ...instances.map(instance => usageWithoutQuota(instance.usage)),
    usageWithoutQuota(presence.usage),
    quota ? undefined : preferredQuotaUsage(busy?.usage, ...instances.map(instance => instance.usage), presence.usage)
  );
}

export function quotaLabel(quota: LlmQuotaUsage): string {
  // Unnamed windows have no label to normalise; they are filtered out upstream
  // rather than given a generic one here.
  const raw = quota.label || quota.window || "";
  const normalized = raw.trim().toLowerCase().replace(/[_\s-]+/g, "");
  if (
    normalized === "week" ||
    normalized === "weekly" ||
    normalized === "1week" ||
    normalized === "7d" ||
    normalized === "1w" ||
    normalized === "sevenday"
  ) {
    return "1w";
  }
  if (
    normalized === "5h" ||
    normalized === "5hour" ||
    normalized === "5hours" ||
    normalized === "fivehour" ||
    normalized === "fivehours"
  ) {
    return "5h";
  }
  if (
    normalized === "2h" ||
    normalized === "2hour" ||
    normalized === "2hours" ||
    normalized === "twohour" ||
    normalized === "twohours"
  ) {
    return "2h";
  }
  if (
    normalized === "1mo" ||
    normalized === "mo" ||
    normalized === "month" ||
    normalized === "monthly" ||
    normalized === "1month"
  ) {
    return "1mo";
  }
  if (normalized === "day" || normalized === "daily" || normalized === "1day") return "1d";
  if (normalized === "hour" || normalized === "hourly" || normalized === "1hour") return "1h";
  return raw.replace(/\s+/g, "");
}

/**
 * `percent` arrives as 0-100; the runtime settled the scale where it still knew
 * the provider. Reading it any other way here is what let this disagree with the
 * runtime's own status chips, which pass the same number through unscaled: a
 * reported 1% became 100% on this path alone, and the agent was marked at its
 * limit while the meter beside it read 1%.
 *
 * `used`/`limit` come first because a ratio needs no convention at all.
 */
export function quotaPercent(quota: LlmQuotaUsage): number | undefined {
  if (quota.used !== undefined && quota.limit !== undefined && quota.limit > 0) return (quota.used / quota.limit) * 100;
  if (quota.percent !== undefined) return quota.percent;
  if (quota.remaining !== undefined && quota.limit !== undefined && quota.limit > 0) {
    return ((quota.limit - quota.remaining) / quota.limit) * 100;
  }
  return undefined;
}

export function quotaTitle(quota: LlmQuotaUsage): string {
  // No `"Quota"` stand-in: naming an unnamed window is how a foreign limit got
  // presented as this agent's. Unnamed quotas are dropped before they get here.
  const parts = [quota.label || quota.window].filter((part): part is string => Boolean(part));
  const percent = quotaPercent(quota);
  if (percent !== undefined) parts.push(formatPercent(percent));
  if (quota.used !== undefined && quota.limit !== undefined) {
    parts.push(`${formatCompactNumber(quota.used)} / ${formatCompactNumber(quota.limit)}`);
  } else if (quota.remaining !== undefined && quota.limit !== undefined) {
    parts.push(`${formatCompactNumber(quota.remaining)} remaining of ${formatCompactNumber(quota.limit)}`);
  }
  if (quota.resetAt) parts.push(`resets at ${formatQuotaResetAt(quota.resetAt, "long") || quota.resetAt}`);
  return parts.join(" - ");
}

export function quotaResetLabel(quota: LlmQuotaUsage): string | undefined {
  return quota.resetAt ? formatQuotaResetAt(quota.resetAt, "short") : undefined;
}

export function formatQuotaResetAt(value: string, length: "short" | "long"): string | undefined {
  const date = parseQuotaResetAt(value);
  if (!date) return undefined;

  /* The parsed `date` is passed on rather than the raw value: a quota reset
     may arrive as an epoch number, which only parseQuotaResetAt understands.
     The long form is read on its own — "quota resets at ..." — so it names its
     zone. The short form sits in a chip beside other local times and stays
     bare. */
  if (length === "long") {
    return formatZonedDateTime(date, undefined, undefined, { month: "short" });
  }

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return formatInstant(date, undefined, {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function parseQuotaResetAt(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatPercent(value: number): string {
  const clamped = Math.max(0, Math.min(999, value));
  return `${clamped < 10 ? clamped.toFixed(1) : Math.round(clamped).toString()}%`;
}

export function optimisticDesktopUpdateInstallStatus(status: DesktopUpdateStatus | null): DesktopUpdateStatus | null {
  if (!status) return status;
  if (status.state === "available") {
    return {
      ...status,
      state: "downloading",
      message: "Downloading update.",
      updatedAt: new Date().toISOString(),
    };
  }
  if (status.state === "downloaded") {
    return {
      ...status,
      state: "installing",
      percent: 100,
      message: "Restarting xMatrix to install the downloaded update.",
      updatedAt: new Date().toISOString(),
    };
  }
  return status;
}

/* mirror of the hub's channelReplyPreview, for live local updates */
export function channelLastMessagePreviewFromEntry(
  entry: ChannelMessage
): SerializedChannel["lastMessage"] {
  const body = entry.recalledAt
    ? "Message recalled"
    : (entry.body || "").trim().replace(/\s+/g, " ");
  const bodyPreview = body
    ? body.length > 240
      ? `${body.slice(0, 237)}...`
      : body
    : entry.attachments && entry.attachments.length > 0
      ? "Attachment"
      : "";
  return {
    messageId: entry.messageId,
    from: entry.from,
    bodyPreview,
    sentAt: entry.sentAt,
    recalledAt: entry.recalledAt,
  };
}

export function parseConfigList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function agentPresetOrCustom(id: string | undefined | null): AgentPreset {
  return AGENT_PRESETS.find((preset) => preset.id === id) ||
    AGENT_PRESETS.find((preset) => preset.id === "custom") ||
    AGENT_PRESETS[0];
}

export function agentAvatarUrl(agent: {
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
  type?: string;
}): string | undefined {
  return agent.avatarUrl || agentAvatarUrlFromMetadata(agent.metadata, agent.type);
}

/** Its harness preset's avatar. */
export function localManagedAgentAvatarUrl(agent: LocalManagedAgent): string | undefined {
  return agentAvatarUrlFromMetadata({ presetId: agent.harness }, agent.harness);
}

export function defaultAgentName(preset: AgentPreset): string {
  const runtimeLabel = sanitizeAgentNamePart(preset.id === "custom" ? preset.runtime || "agent" : preset.id);
  return runtimeLabel.slice(0, 64);
}

export function sanitizeAgentNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+/g, "-");
  return sanitized || "local";
}

export function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

export function attentionSummaryFromEvent(event: ObservabilityEvent): SerializedChannel["attention"] | undefined {
  const value = event.metadata?.attention;
  return isChannelAttentionSummary(value) ? value : undefined;
}

export function validChannelReadSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function isChannelAttentionSummary(value: unknown): value is NonNullable<SerializedChannel["attention"]> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.channelId === "string" &&
    typeof record.unreadAttentionCount === "number" &&
    Number.isFinite(record.unreadAttentionCount) &&
    typeof record.updatedAt === "string"
  );
}

export function releaseVersionStatus(version: string | undefined): "current" | "outdated" | "unknown" {
  if (!version) return "unknown";
  return compareReleaseVersions(version, XMATRIX_RELEASE_VERSION) < 0 ? "outdated" : "current";
}

export function formatVersion(version: string): string {
  return version.trim().startsWith("v") ? version.trim() : `v${version.trim()}`;
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function parseReleaseVersion(version: string): number[] | undefined {
  const authority = version.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
  const parts = authority.split(".").map((part) => Number.parseInt(part, 10));
  if (!parts.length || parts.some((part) => Number.isNaN(part))) return undefined;
  return parts;
}
