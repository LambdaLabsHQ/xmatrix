"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal } from "lucide-react";
import type { InteractionLaunchOption } from "@xmatrix/protocol";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { useFace } from "./face";
import { avatarImageSrc } from "./identity-avatar";
import { useAnchoredMenuDismiss } from "./use-overlay-dismiss";

/** The face of the harness the option starts (protocol faces.ts); blank for one with no mark. */
export function OptionMark({ option }: { option: InteractionLaunchOption }) {
  const icon = avatarImageSrc(useFace({ kind: "agent", name: option.displayName, harness: option.harness }).imageUrl);
  return icon
    // eslint-disable-next-line @next/next/no-img-element -- a small harness preset icon, as on summon chips.
    ? <img src={icon} alt="" aria-hidden="true" className="launch-line-mark" />
    : <span aria-hidden="true" className="launch-line-mark launch-line-mark-blank" />;
}

/** A row's height: a pointer's target on a desktop, a thumb's on a phone. */
const rowHeight = () => (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 44 : 36);

/**
 * Who answers a message, as the app's paper menu under the words that opened
 * it. One row per Agent the reader may start; picking one is the whole
 * action. The last row hands the summon to the composer, where the model,
 * effort, machine and repository are written with the composer's own
 * completion: launch parameters have one grammar and one editor.
 */
export function LaunchAgentMenu({ anchor, label, options, recommended, onPick, onCompose, onClose }: {
  anchor: HTMLElement;
  label: string;
  options: readonly InteractionLaunchOption[];
  /** xMatrix's reading, marked on its row. */
  recommended?: string | null;
  onPick: (option: InteractionLaunchOption) => void;
  /** Continue in the composer, starting from `@<harness>` when one is known. */
  onCompose?: () => void;
  onClose: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  // The timeline scrolling away from the line takes its menu with it.
  useAnchoredMenuDismiss(anchor, popup, onClose);
  useEffect(() => {
    popup.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }, []);
  const place = anchor.getBoundingClientRect();
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  const height = (options.length + (onCompose ? 1 : 0)) * rowHeight() + (onCompose ? 1 : 0);
  // Under the line, or above it when the window has no room below.
  const below = place.bottom + 6 + Math.min(height, 240) <= viewport - 12;
  const room = Math.max(160, below ? viewport - place.bottom - 18 : place.top - 18);
  return createPortal(
    <PaperPopover ref={popup} role="menu" aria-label={label}
      className="xmatrix-app launch-agent-menu fixed z-[var(--z-popover)] flex w-64 max-w-[calc(100vw-1.5rem)] flex-col"
      style={{ ...(below ? { top: place.bottom + 6 } : { bottom: window.innerHeight - place.top + 6 }),
        left: Math.max(12, Math.min(place.left - 12, window.innerWidth - 268)), maxHeight: room }}>
      {options.map(option => (
        <button key={option.optionId} type="button" role="menuitem" className="launch-agent-menu-row"
          onClick={() => { onClose(); onPick(option); }}>
          <OptionMark option={option} />
          <span className="launch-agent-menu-name">{option.displayName}</span>
          {recommended === option.optionId && <span className="launch-agent-menu-note">xMatrix&apos;s pick</span>}
        </button>
      ))}
      {onCompose && (
        <>
          {options.length > 0 && <span aria-hidden="true" className="launch-agent-menu-rule" />}
          <button type="button" role="menuitem" className="launch-agent-menu-row" onClick={() => { onClose(); onCompose(); }}>
            <SlidersHorizontal aria-hidden="true" className="launch-agent-menu-icon" />
            <span className="launch-agent-menu-name">Model, effort, machine…</span>
          </button>
        </>
      )}
    </PaperPopover>,
    anchor.ownerDocument.body,
  );
}
