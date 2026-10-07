"use client";

import { type MouseEvent } from "react";
import { AlertTriangle, Boxes, Bot, Moon, Server, UserRound } from "lucide-react";
import { LoadingImage } from "@/components/dashboard/content-skeleton";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

type IdentityKind = "agent" | "app" | "human" | "machine" | "system";
type IdentityAvatarSize = "xs" | "sm" | "md" | "lg";
type IdentityAvatarShape = "rounded" | "circle";

const sizeClasses: Record<IdentityAvatarSize, string> = {
  // `xs` fits inside a sidebar row, whose height is 32px: `sm` would fill the
  // row edge to edge and leave the list no rhythm.
  xs: "size-5 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-9 text-sm",
  lg: "size-14 text-lg",
};

const iconSizeClasses: Record<IdentityAvatarSize, string> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-6",
};

// A 10px dot would cover half of an `xs` face; its ring is thinner so the
// waiting dot still reads as hollow at that size.
const statusSizeClasses: Record<IdentityAvatarSize, string> = {
  xs: "size-1.5 [--app-status-dot-ring:1px]",
  sm: "size-2.5",
  md: "size-2.5",
  lg: "size-2.5",
};

const kindBadgeClasses: Record<IdentityKind, string> = {
  agent: "bg-foreground text-background",
  app: "bg-foreground text-background",
  human: "bg-primary text-primary-foreground",
  machine: "bg-secondary text-secondary-foreground",
  system: "bg-muted-foreground text-background",
};

const toneClasses: Record<IdentityKind, string> = {
  agent: "bg-muted text-foreground",
  app: "bg-white text-slate-950",
  human: "bg-primary text-primary-foreground",
  machine: "bg-secondary text-secondary-foreground",
  system: "bg-muted text-muted-foreground",
};

interface IdentityAvatarProps {
  kind: IdentityKind;
  label: string;
  status?: string;
  initials?: string;
  imageUrl?: string;
  size?: IdentityAvatarSize;
  shape?: IdentityAvatarShape;
  showKindBadge?: boolean;
  /** False where the avatar already sits inside a glass surface: glass never nests. */
  glass?: boolean;
  className?: string;
  /** Replaces the default hover text, where the avatar says what its holder is doing. */
  title?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

export function IdentityAvatar({
  kind,
  label,
  status,
  initials,
  imageUrl,
  size = "md",
  shape = "rounded",
  showKindBadge = false,
  glass = true,
  className,
  title: titleOverride,
  onClick,
}: IdentityAvatarProps) {
  const kindLabel = identityKindLabel(kind);
  const Icon = kind === "agent" ? Bot : kind === "app" ? Boxes : kind === "machine" ? Server : UserRound;
  const statusLabel = identityStatusLabel(status);
  const title = titleOverride ?? `${label} - ${kindLabel}${statusLabel ? ` - ${statusLabel}` : ""}`;
  const ariaLabel = `${label} ${kindLabel}${statusLabel ? ` ${statusLabel}` : ""}`;
  const AvatarRoot = onClick ? "button" : "div";
  const imageSrc = avatarImageSrc(imageUrl);
  const tone = avatarTone(label);
  const rest = identityRestStatus(status);
  const imageFallback = initials
    ? initials
    : <Icon className={iconSizeClasses[size]} />;

  return (
    <AvatarRoot
      type={onClick ? "button" : undefined}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        "identity-avatar relative inline-flex shrink-0",
        onClick && "cursor-pointer rounded-lg outline-none transition hover:ring-2 hover:ring-ring/40 focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      title={title}
      aria-label={ariaLabel}
      data-rest={rest}
    >
      {/* The disc is the composer's glass, small: the same pill primitive, lens included. */}
      <LiquidGlassPill
        enabled={glass}
        data-avatar-tone={tone}
        className={cn(
          "identity-avatar-face aspect-square shrink-0 flex items-center justify-center overflow-hidden font-black",
          shape === "circle" ? "rounded-full" : "rounded-lg",
          sizeClasses[size],
          toneClasses[kind],
          // A resting Instance is still the Channel's, greyed until a message wakes it.
          rest && "opacity-55 grayscale",
          rest === "waking" && "animate-pulse"
        )}
      >
        {imageSrc ? (
          <LoadingImage
            src={imageSrc}
            alt=""
            announce={false}
            referrerPolicy="no-referrer"
            draggable={false}
            className={cn(
              "aspect-square size-full",
              // App marks are full logos and stay inside the disc.
              kind === "app" ? "object-contain" : "object-cover"
            )}
            fallback={imageFallback}
            onContextMenu={(event) => event.preventDefault()}
          />
        ) : (
          imageFallback
        )}
      </LiquidGlassPill>
      {rest === "sleeping" || rest === "interrupted" || rest === "wake_failed" ? (
        <span
          className={cn(
            "identity-avatar-rest absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-background bg-background",
            rest === "wake_failed" ? "text-destructive" : rest === "interrupted" ? "text-amber-500" : "text-muted-foreground"
          )}
        >
          {rest === "interrupted" || rest === "wake_failed"
            ? <AlertTriangle className="size-2.5" aria-hidden="true" />
            : <Moon className="size-2.5" aria-hidden="true" />}
        </span>
      ) : status && status !== "offline" && (
        <span
          className={cn(
            "identity-avatar-status absolute -right-0.5 -top-0.5 rounded-full border border-background",
            statusSizeClasses[size],
            identityStatusDotClass(status)
          )}
        />
      )}
      {showKindBadge && (
        <span
          className={cn(
            "identity-avatar-badge absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-background px-1 text-[8px] font-black leading-3 shadow-sm",
            kindBadgeClasses[kind]
          )}
        >
          {kindLabel}
        </span>
      )}
    </AvatarRoot>
  );
}

function avatarTone(label: string): number {
  return Array.from(label || "xmatrix").reduce(
    (total, char) => total + char.charCodeAt(0),
    0
  ) % 6;
}

export function avatarImageSrc(imageUrl: string | undefined): string | undefined {
  const value = imageUrl?.trim();
  if (!value) return undefined;
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "lh3.googleusercontent.com") {
      return `/api/xmatrix/avatar?url=${encodeURIComponent(url.toString())}`;
    }
  } catch {
    return value;
  }
  return value;
}

function identityKindLabel(kind: IdentityKind): string {
  if (kind === "agent") return "Agent";
  if (kind === "app") return "App";
  if (kind === "human") return "Human";
  if (kind === "machine") return "Machine";
  return "System";
}

/** A resting Instance's status says what brings it back. */
function identityStatusLabel(status: string | undefined): string | undefined {
  if (status === "sleeping") return "sleeping, wakes on the next message";
  if (status === "interrupted") return "interrupted, resumes on the next message";
  if (status === "wake_failed") return "wake failed, Reborn resumes it";
  if (status === "machine offline") return "machine offline, cannot act on messages until it reconnects";
  if (status === "waiting") return "waiting on a tool or a background task";
  return status;
}

/** The rest states a presence status can carry (docs/instance-sleep.md §5). */
export function identityRestStatus(
  status: string | undefined
): "sleeping" | "interrupted" | "waking" | "wake_failed" | undefined {
  return status === "sleeping" || status === "interrupted" || status === "waking" || status === "wake_failed"
    ? status : undefined;
}

/**
 * A presence dot: the one place the vivid status colours live (see
 * status-vocabulary.test). Yellow means work in hand: solid and breathing
 * while the Agent itself is working, a still ring while it waits on CI, the
 * network or its background tasks. Green is free to take work; online and
 * idle say the same thing to a reader, so they look the same
 * (docs/design/agent-status.md).
 */
export function identityStatusDotClass(status: string): string {
  if (status === "busy") return "bg-amber-500 text-amber-500 motion-safe:animate-pulse";
  if (status === "waiting") return "bg-amber-500 text-amber-500 app-status-dot-ring";
  if (status === "online" || status === "idle") return "bg-emerald-500 text-emerald-500";
  if (status === "waking") return "bg-muted-foreground text-muted-foreground app-status-dot-ring motion-safe:animate-pulse";
  if (status === "machine offline") return "bg-red-500 text-red-500";
  return "bg-muted-foreground text-muted-foreground";
}
