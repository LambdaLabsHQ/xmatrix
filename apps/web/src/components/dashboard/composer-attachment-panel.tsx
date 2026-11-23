"use client";

import { Camera, Folder, Image as ImageIcon } from "lucide-react";
import { stopTouchPropagation } from "./completion-option-button";
import type { NativeAttachmentPickerSource } from "@/lib/desktop/bridge";
import { cn } from "@/lib/utils";

type ComposerAttachmentChoice = {
  source: NativeAttachmentPickerSource;
  label: string;
  icon: typeof ImageIcon;
};

const COMPOSER_ATTACHMENT_CHOICES: readonly ComposerAttachmentChoice[] = [
  { source: "photos", label: "Photo Library", icon: ImageIcon },
  { source: "camera", label: "Take Photo or Video", icon: Camera },
  { source: "files", label: "Choose Files", icon: Folder },
];

/**
 * Attachment source choices rendered inside the composer's own morphed glass
 * surface (replacing WebKit's detached iOS file-input popover).
 */
export function ComposerAttachmentPanel({
  id,
  active,
  disabled,
  onSelect,
}: {
  id: string;
  active: number;
  disabled?: boolean;
  onSelect: (source: NativeAttachmentPickerSource) => void;
}) {
  return (
    <div
      id={id}
      role="menu"
      aria-label="Attach"
      data-testid="composer-attachment-panel"
      className="app-composer-attach-menu flex flex-col gap-0.5 border-b border-border/45 px-[var(--app-composer-pad,0.375rem)] pt-1.5 pb-1 [animation:app-composer-attach-in_180ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none"
      onTouchStart={stopTouchPropagation}
      onTouchMove={stopTouchPropagation}
    >
      {COMPOSER_ATTACHMENT_CHOICES.map((choice, index) => {
        const Icon = choice.icon;
        return (
          <button
            key={choice.source}
            type="button"
            role="menuitem"
            disabled={disabled}
            data-attach-source={choice.source}
            data-active={index === active ? "true" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              if (disabled) return;
              onSelect(choice.source);
            }}
            className={cn(
              "app-composer-attach-option [--app-composer-option-r:var(--app-composer-row-r,0.875rem)] flex min-h-[var(--app-composer-row-h,2.75rem)] w-full items-center gap-1.5 !bg-transparent pr-3 pl-0 text-left text-[length:var(--app-composer-row-fs,0.9375rem)] font-medium text-foreground transition-colors hover:!bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] active:!bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] data-[active=true]:!bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)]",
              disabled && "pointer-events-none opacity-45"
            )}
          >
            <span className="app-composer-attach-option-icon flex size-[var(--app-composer-icon-w,2.25rem)] shrink-0 items-center justify-center text-muted-foreground">
              <Icon className="size-[var(--app-composer-icon-glyph,1.125rem)] stroke-[1.75]" />
            </span>
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}
