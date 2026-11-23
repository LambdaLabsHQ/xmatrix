"use client";

import { Camera, Folder, Image as ImageIcon } from "lucide-react";
import { stopTouchPropagation } from "./completion-option-button";
import type { NativeAttachmentPickerSource } from "@/lib/desktop/bridge";
import { cn } from "@/lib/utils";

export type ComposerAttachmentChoice = {
  source: NativeAttachmentPickerSource;
  label: string;
  icon: typeof ImageIcon;
};

export const COMPOSER_ATTACHMENT_CHOICES: readonly ComposerAttachmentChoice[] = [
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
      className="app-composer-attach-menu border-b border-border/45"
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
              "app-composer-attach-option flex w-full items-center text-left text-[15px] font-medium text-foreground transition-colors",
              disabled && "pointer-events-none opacity-45"
            )}
          >
            <span className="app-composer-attach-option-icon flex shrink-0 items-center justify-center text-muted-foreground">
              <Icon className="size-[18px] stroke-[1.75]" />
            </span>
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}
