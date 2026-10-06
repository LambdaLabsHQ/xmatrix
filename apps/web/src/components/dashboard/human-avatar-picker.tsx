"use client";

import { humanAvatarMimeType } from "@xmatrix/protocol";
import { Camera, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { HumanAvatarCropDialog } from "@/components/dashboard/human-avatar-crop-dialog";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { HUMAN_AVATAR_ACCEPT, type PreparedAvatar } from "@/lib/human-avatar-image";
import { cn } from "@/lib/utils";

/**
 * Slack's affordance: the picture itself is the control. Hovering it offers to
 * change it, and picking a file opens the crop step — there is no URL to
 * paste, because a person choosing their own face is choosing a file.
 */
export function HumanAvatarPicker({
  displayName,
  avatarUrl,
  editable,
  busy,
  onSelect,
  onRemove,
  onError,
}: {
  displayName: string;
  avatarUrl?: string;
  editable: boolean;
  busy?: boolean;
  onSelect: (blob: Blob, mimeType: string) => Promise<void> | void;
  onRemove?: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);

  /* The preview is an object URL for the encoded blob, so it must outlive the
     upload but not the component. Revoking on replacement as well as unmount
     keeps a long editing session from leaking one URL per attempt. */
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // A confirmed server URL supersedes the local preview; without this the
  // optimistic image would sit on top of the real one forever.
  useEffect(() => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, [avatarUrl]);

  function pick(file: File | undefined) {
    if (!file) return;
    // The type gate the crop dialog would also apply, but failing before it
    // opens beats opening a dialog just to close it with an error.
    if (!humanAvatarMimeType(file.type)) {
      onError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    setCropFile(file);
  }

  async function apply(prepared: PreparedAvatar) {
    setCropFile(null);
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return prepared.previewUrl;
    });
    try {
      await onSelect(prepared.blob, prepared.mimeType);
    } catch {
      onError("Could not update your photo.");
    }
  }

  const shown = preview ?? avatarUrl;

  if (!editable) {
    return (
      <IdentityAvatar
        kind="human"
        label={displayName}
        imageUrl={shown}
        initials={displayName.slice(0, 2)}
        size="lg"
        shape="circle"
        showKindBadge={false}
        className="shrink-0"
      />
    );
  }

  return (
    <div className="shrink-0">
      <input
        ref={inputRef}
        type="file"
        accept={HUMAN_AVATAR_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first: picking the same file twice must still fire a change.
          event.target.value = "";
          pick(file);
        }}
      />
      <button
        type="button"
        aria-label="Change your photo"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "group relative block size-14 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2",
          busy && "cursor-progress",
        )}
      >
        <IdentityAvatar
          kind="human"
          label={displayName}
          imageUrl={shown}
          initials={displayName.slice(0, 2)}
          size="lg"
          shape="circle"
          showKindBadge={false}
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity",
            "group-hover:opacity-100 group-focus-visible:opacity-100",
            busy && "opacity-100",
          )}
        >
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Camera className="size-5" />}
        </span>
      </button>
      {shown && onRemove ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRemove()}
          className="mt-2 block w-14 text-center text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Remove
        </button>
      ) : null}
      {cropFile ? (
        <HumanAvatarCropDialog
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onSave={(prepared) => void apply(prepared)}
          onError={onError}
        />
      ) : null}
    </div>
  );
}
