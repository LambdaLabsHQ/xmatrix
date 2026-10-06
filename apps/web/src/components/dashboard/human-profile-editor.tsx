"use client";

import { actionClass } from "@/components/ui/action-tone";
import {
  HUMAN_DISPLAY_NAME_MAX_LENGTH,
  HUMAN_HANDLE_MAX_LENGTH,
  canonicalHumanHandle,
  humanDisplayNameRefusal,
  humanHandleRefusal,
  type HumanProfile,
  type HumanProfileEdit,
} from "@xmatrix/protocol";
import { useState, type FormEvent, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const HUMAN_BIO_UI_MAX_LENGTH = 160;

type ProfileFieldErrors = Partial<Record<"displayName" | "handle" | "bio", string>>;

const refusalMessages: Record<string, string> = {
  display_name_required: "Enter a display name.",
  display_name_too_long: `Keep the display name within ${HUMAN_DISPLAY_NAME_MAX_LENGTH} characters.`,
  display_name_control_characters: "Remove control characters from the display name.",
  handle_required: "Enter a handle.",
  handle_too_short: "Use at least 3 characters.",
  handle_too_long: `Keep the handle within ${HUMAN_HANDLE_MAX_LENGTH} characters.`,
  handle_charset: "Use letters, numbers, and hyphens only.",
  handle_boundary: "Start and end with a letter or number, without consecutive hyphens.",
  handle_reserved: "That handle is reserved.",
  handle_taken: "That handle is already taken.",
  handle_retired_by_other: "That handle cannot be reassigned.",
  handle_change_rate_limited: "You have changed your handle too recently. Try again later.",
};

export function humanProfileErrorMessage(code: string): string {
  return refusalMessages[code] ?? "Could not update your profile. Try again.";
}

/**
 * The fields this form edits.
 *
 * `timeZone` is excluded deliberately. It is detected from the browser and
 * reported, never typed: a zone someone picked from a list is right until they
 * travel and then silently wrong, and nobody thinks to come back and fix it.
 */
type HumanProfileDraft = Required<Omit<HumanProfileEdit, "timeZone">>;

function initialDraft(profile: HumanProfile): HumanProfileDraft {
  return {
    displayName: profile.displayName,
    handle: profile.handle ?? "",
    avatarUrl: profile.avatarUrl ?? "",
    bio: profile.bio ?? "",
  };
}

export function HumanProfileEditor({
  profile,
  saving,
  serverError,
  onCancel,
  onSave,
}: {
  profile: HumanProfile;
  saving?: boolean;
  serverError?: { code?: string; message?: string } | null;
  onCancel: () => void;
  onSave: (edit: HumanProfileEdit) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(profile));
  const [errors, setErrors] = useState<ProfileFieldErrors>({});

  function update<K extends keyof HumanProfileDraft>(field: K, value: HumanProfileDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = draft.displayName.trim();
    const handle = canonicalHumanHandle(draft.handle);
    const nextErrors: ProfileFieldErrors = {};
    const displayNameRefusal = humanDisplayNameRefusal(displayName);
    const handleRefusal = humanHandleRefusal(handle);
    if (displayNameRefusal) nextErrors.displayName = humanProfileErrorMessage(displayNameRefusal);
    if (handleRefusal) nextErrors.handle = humanProfileErrorMessage(handleRefusal);
    if (draft.bio.length > HUMAN_BIO_UI_MAX_LENGTH) {
      nextErrors.bio = `Keep the bio within ${HUMAN_BIO_UI_MAX_LENGTH} characters.`;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setDraft((current) => ({ ...current, displayName, handle }));
    /* avatarUrl is carried through unchanged: the photo is set by the picker
       above this form, and omitting the field would clear it on every save. */
    await onSave({
      displayName,
      handle,
      avatarUrl: draft.avatarUrl.trim(),
      bio: draft.bio.trim(),
    });
  }

  const serverMessage = serverError
    ? serverError.code
      ? humanProfileErrorMessage(serverError.code)
      : serverError.message || humanProfileErrorMessage("")
    : null;

  return (
    <form className="mt-5 space-y-4 border-t border-border/60 pt-5" onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <ProfileField
          label="Display name"
          count={`${draft.displayName.length}/${HUMAN_DISPLAY_NAME_MAX_LENGTH}`}
          error={errors.displayName}
        >
          <Input
            value={draft.displayName}
            onChange={(event) => update("displayName", event.target.value)}
            maxLength={HUMAN_DISPLAY_NAME_MAX_LENGTH}
            aria-invalid={Boolean(errors.displayName)}
            autoComplete="name"
          />
        </ProfileField>
        <ProfileField
          label="Handle"
          description="Your public @address. Letters, numbers, and hyphens."
          count={`${draft.handle.length}/${HUMAN_HANDLE_MAX_LENGTH}`}
          error={errors.handle}
        >
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">@</span>
            <Input
              className="pl-7"
              value={draft.handle}
              onChange={(event) => update("handle", event.target.value)}
              onBlur={() => update("handle", canonicalHumanHandle(draft.handle))}
              maxLength={HUMAN_HANDLE_MAX_LENGTH}
              aria-invalid={Boolean(errors.handle)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </ProfileField>
      </div>
      <ProfileField
        label="Bio"
        description="A short public introduction."
        count={`${draft.bio.length}/${HUMAN_BIO_UI_MAX_LENGTH}`}
        error={errors.bio}
      >
        <Textarea
          value={draft.bio}
          onChange={(event) => update("bio", event.target.value)}
          maxLength={HUMAN_BIO_UI_MAX_LENGTH}
          rows={3}
          aria-invalid={Boolean(errors.bio)}
        />
      </ProfileField>
      {serverMessage ? (
        <p role="alert" className="text-sm font-semibold text-destructive">{serverMessage}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <button type="button" onClick={onCancel} disabled={saving} className={actionClass({ variant: "secondary", size: "lg" }, "min-w-0 sm:px-4 sm:py-2")}>
          Cancel
        </button>
        <button type="submit" disabled={saving} className={actionClass({ variant: "primary", size: "lg" }, "min-w-0 sm:px-4 sm:py-2")}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

function ProfileField({
  label,
  description,
  count,
  error,
  children,
}: {
  label: string;
  description?: string;
  count?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between gap-3 text-xs font-bold text-foreground">
        <span>{label}</span>
        {count ? <span className="font-medium text-muted-foreground">{count}</span> : null}
      </span>
      {children}
      {error ? <span className="block text-xs font-semibold text-destructive">{error}</span> : null}
      {!error && description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
    </label>
  );
}
