"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, History as HistoryIcon, Plus, SquareArrowOutUpRight } from "lucide-react";
import type { ChannelSnapshot, SerializedSpace } from "@xmatrix/protocol";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";
import { channelTitle } from "./channel-links";
import { listenForOverlayDismissal } from "./use-overlay-dismiss";
import { SpaceAvatar, type CompanionBar } from "./workspace-shell-chrome";

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground";

function recentHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

/**
 * The Chrome side panel's single quiet bar: sits directly below Chrome's own
 * white title bar with no border or dividing rule, so the extension feels like
 * one continuous surface rather than a second framed header.
 */
export function CompanionHeader({
  channel,
  composing,
  spaces,
  currentSpaceId,
  onSelectSpace,
  companion,
}: {
  channel: ChannelSnapshot | null;
  composing: boolean;
  spaces: SerializedSpace[];
  currentSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
  companion: CompanionBar;
}) {
  const [openMenu, setOpenMenu] = useState<"space" | "recent" | null>(null);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    return listenForOverlayDismissal((event) => {
      if (event.target instanceof Node && headerRef.current?.contains(event.target)) return;
      setOpenMenu(null);
    }, () => setOpenMenu(null));
  }, [openMenu]);

  const currentSpace = currentSpaceId
    ? spaces.find((space) => space.id === currentSpaceId) ?? null
    : null;
  const spaceName = currentSpace?.name || "Workspace";
  const showConversationTitle = Boolean(channel && !composing);
  const title = channel ? channelTitle(channel) : "New conversation";

  return (
    <header
      ref={headerRef}
      data-testid="companion-header"
      className="relative z-20 flex h-10 shrink-0 items-center justify-between gap-2 bg-transparent px-4 text-foreground"
    >
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5">
        {showConversationTitle ? (
          <span
            className="min-w-0 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-foreground"
            title={title}
          >
            {title}
          </span>
        ) : (
          <>
            <span className="shrink-0 text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
              New conversation
            </span>
            {spaces.length > 1 ? (
              <>
                <button
                  type="button"
                  title="Switch workspace"
                  aria-label="Switch workspace"
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === "space"}
                  onClick={() => setOpenMenu((current) => (current === "space" ? null : "space"))}
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
                    openMenu === "space" && "bg-muted/70 text-foreground",
                  )}
                >
                  <span className="truncate">in {spaceName}</span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                </button>
                {openMenu === "space" && (
                  <PaperPopover
                    role="listbox"
                    aria-label="Workspaces"
                    className="absolute left-0 top-full z-30 mt-1.5 w-60 max-w-[calc(100vw-2rem)]"
                  >
                    {spaces.map((space) => {
                      const selected = space.id === currentSpaceId;
                      return (
                        <button
                          key={space.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setOpenMenu(null);
                            if (!selected) onSelectSpace(space.id);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors"
                        >
                          <SpaceAvatar space={space} />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                            {space.name}
                          </span>
                          {selected && <Check className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </PaperPopover>
                )}
              </>
            ) : currentSpace ? (
              <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                in {spaceName}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="relative flex shrink-0 items-center gap-0.5">
        {companion.recent.length > 0 && (
          <button
            type="button"
            title="Recent"
            aria-label="Recent"
            aria-haspopup="listbox"
            aria-expanded={openMenu === "recent"}
            onClick={() => setOpenMenu((current) => (current === "recent" ? null : "recent"))}
            className={cn(ICON_BUTTON, openMenu === "recent" && "bg-muted/70 text-foreground")}
          >
            <HistoryIcon className="size-[15px]" strokeWidth={1.8} />
          </button>
        )}
        {showConversationTitle && companion.onAskPage && (
          <button
            type="button"
            title="Ask about this page"
            aria-label="Ask about this page"
            onClick={() => {
              setOpenMenu(null);
              companion.onAskPage?.();
            }}
            className={ICON_BUTTON}
          >
            <Plus className="size-[15px]" strokeWidth={1.9} />
          </button>
        )}
        <button
          type="button"
          title="Open in xMatrix"
          aria-label="Open in xMatrix"
          onClick={() => {
            setOpenMenu(null);
            companion.onOpenInApp();
          }}
          className={ICON_BUTTON}
        >
          <SquareArrowOutUpRight className="size-[14px]" strokeWidth={1.8} />
        </button>

        {openMenu === "recent" && companion.recent.length > 0 && (
          <PaperPopover
            role="listbox"
            aria-label="Recent conversations"
            className="absolute right-0 top-full z-30 mt-1.5 w-64 max-w-[calc(100vw-2rem)]"
          >
            {companion.recent.map((item) => (
              <button
                key={item.path}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  setOpenMenu(null);
                  companion.onOpenRecent(item.path);
                }}
                className="flex w-full flex-col px-3 py-2 text-left transition-colors"
              >
                <span className="block w-full truncate text-[13px] font-semibold leading-5 text-foreground">
                  {item.title}
                </span>
                <span className="block w-full truncate text-[11px] leading-4 text-muted-foreground">
                  {recentHost(item.href)}
                </span>
              </button>
            ))}
          </PaperPopover>
        )}
      </div>
    </header>
  );
}
