"use client";

import { actionClass } from "@/components/ui/action-tone";
import { WEB_PROXY_ROUTES, type HumanProfile, type HumanProfileEdit, type SpaceMember } from "@xmatrix/protocol";
import { AtSign, Pencil } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { GitHubAccountLink } from "@/components/dashboard/github-account-link";
import { HumanProfileEditor, humanProfileRefusal } from "@/components/dashboard/human-profile-editor";
import {
  humanProfileFromSpaceMember,
  type CurrentHumanProfileSource,
} from "@/components/dashboard/human-profile-summary";
import { HumanAvatarPicker } from "@/components/dashboard/human-avatar-picker";
import { HumanLocalTime } from "@/components/dashboard/human-local-time";
import { useHumanTimeZoneSync } from "@/components/dashboard/use-human-time-zone-sync";
import { userErrorMessage } from "@/lib/user-facing-error";
import { xmatrixApiRequest, XMatrixApiError, unexpectedResponse } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { PrivateSignInEmail } from "./private-sign-in-email";
import { ToolDetailEmpty, ToolDetailSection, ToolPaperScroll } from "./tool-split";

/* Not memoized: this is a handful of object literals, and a stale memo would
   be a worse bug than the work it saves. */
function projectedProfile(
  user: CurrentHumanProfileSource,
  member: SpaceMember | undefined,
  self: boolean,
): HumanProfile {
  if (self) return humanProfileFromSpaceMember(user, member);
  const source: CurrentHumanProfileSource = {
    id: member?.userId ?? "",
    // Not a fallback to `user.name`: that would label a colleague's profile
    // with the viewer's own identity.
    ...(member?.name ? { name: member.name } : {}),
    ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
  };
  const profile = humanProfileFromSpaceMember(source, member);
  // "Your profile" is the self-fallback inside humanProfileFromSpaceMember.
  return profile.displayName === "Your profile"
    ? { ...profile, displayName: "Unnamed member" }
    : profile;
}

/**
 * The Profile view. One screen serves both cases Slack serves: your own
 * profile, which you can edit in place, and a colleague's, which you can only
 * read. Which one it is comes from `self`, not from guessing at the data.
 */
export function ProfileView({
  user,
  member,
  self,
  token,
}: {
  user: CurrentHumanProfileSource & { email: string };
  /** The Space membership backing the profile; absent for a member not in this Space. */
  member?: SpaceMember;
  self: boolean;
  token?: string;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const profileMutation = useMutation({
    mutationKey: xmatrixQueryKeys.domain({ userId: user.id }, "human-profile"),
    mutationFn: async (request: {
      route: string;
      method: "POST" | "PATCH" | "DELETE";
      contentType?: string;
      body?: BodyInit;
    }) => {
      const payload = await xmatrixApiRequest<{ profile?: HumanProfile }>({
        url: request.route,
        method: request.method,
        token,
        rawBody: request.body,
        headers: request.contentType ? { "content-type": request.contentType } : undefined,
      });
      if (!payload.profile) throw unexpectedResponse("The profile");
      return payload.profile;
    },
  });
  const saved = profileMutation.data ?? null;
  const saving = profileMutation.isPending;
  const saveError = localError ? { message: localError } : null;

  const projected = projectedProfile(user, member, self);

  /* A save answers with the authoritative row, which the Space projection has
     not caught up to yet. Prefer whichever is newer rather than syncing state
     back and forth in an effect. */
  const profile =
    saved && saved.userId === projected.userId && saved.profileVersion >= projected.profileVersion
      ? saved
      : projected;

  /* Three writes, one shape: every profile mutation answers with the whole
     authoritative profile or a refusal code, so the request differs and the
     handling does not. */
  async function writeProfile(
    request: { route: string; method: "POST" | "PATCH" | "DELETE"; contentType?: string; body?: BodyInit },
    failureMessage: string,
  ) {
    setLocalError(null);
    try {
      await profileMutation.mutateAsync(request);
    } catch (error) {
      // A profile rule the Hub refused has its own sentence; anything else is described in general.
      const refusal = error instanceof XMatrixApiError ? humanProfileRefusal(error.code) : undefined;
      setLocalError(refusal ?? userErrorMessage(error, failureMessage));
    }
  }

  async function uploadAvatar(blob: Blob, mimeType: string) {
    await writeProfile(
      { route: WEB_PROXY_ROUTES.me_avatar, method: "POST", contentType: mimeType, body: blob },
      "Couldn't update your photo",
    );
  }

  async function removeAvatar() {
    await writeProfile(
      { route: WEB_PROXY_ROUTES.me_avatar, method: "DELETE" },
      "Couldn't remove your photo",
    );
  }

  async function saveProfile(edit: HumanProfileEdit) {
    await writeProfile(
      {
        route: WEB_PROXY_ROUTES.me_profile,
        method: "PATCH",
        contentType: "application/json",
        body: JSON.stringify(edit),
      },
      "Couldn't update your profile",
    );
  }

  /* Reported, not asked for: the browser knows the zone and is right every
     time, where a zone someone picked once goes stale the moment they travel.
     Only on your own profile — nobody else's zone is this browser's to state.
     Deliberately not through the mutation above: this is a background
     correction nobody asked for, so it must not show a saving state, and a
     failure must not raise a banner over a screen the person came here to
     read. It lands on the next load instead. */
  const reportTimeZone = useCallback(
    (timeZone: string) => xmatrixApiRequest({
      url: WEB_PROXY_ROUTES.me_profile,
      method: "PATCH",
      token,
      rawBody: JSON.stringify({ timeZone } satisfies HumanProfileEdit),
      headers: { "content-type": "application/json" },
    }),
    [token],
  );
  useHumanTimeZoneSync(profile.timeZone, reportTimeZone, self);

  if (!self && !member) {
    return (
      <ToolDetailEmpty title="This person is not a member of this Space." />
    );
  }

  /* No page banner above the card. Slack's profile opens straight into the
     person — a "Profile / How you appear to everyone you work with" header is
     a label for a screen that already says what it is. */
  return (
    <HumanProfileView
      profile={profile}
      self={self}
      email={self ? user.email : undefined}
      saving={saving}
      saveError={saveError}
      onSave={self ? saveProfile : undefined}
      onUploadAvatar={self ? uploadAvatar : undefined}
      onRemoveAvatar={self ? removeAvatar : undefined}
      onAvatarError={setLocalError}
    />
  );
}

/* Slack's profile is a destination, not a layer: clicking an avatar takes you
   to a screen that stays put while you read it, and editing happens on that
   same screen. This view replaces the popovers that used to open over the
   conversation — a card that floats above the message you were reading covers
   the thing you clicked from. */
export function HumanProfileView({
  profile,
  self,
  email,
  saving,
  saveError,
  onSave,
  onUploadAvatar,
  onRemoveAvatar,
  onAvatarError,
}: {
  profile: HumanProfile;
  /** The viewer's own profile: only then are the editor and email theirs to see. */
  self: boolean;
  /** Sign-in email, viewer's own only. Never shown for another member. */
  email?: string;
  saving?: boolean;
  saveError?: { message: string } | null;
  onSave?: (edit: HumanProfileEdit) => Promise<void> | void;
  onUploadAvatar?: (blob: Blob, mimeType: string) => Promise<void> | void;
  onRemoveAvatar?: () => Promise<void> | void;
  onAvatarError?: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const canEdit = self && Boolean(onSave);

  /* The paper, not a card: Settings' Account section reads the same way, and
     the person is the page's heading rather than a box placed on it. */
  return (
    <ToolPaperScroll>
      <header className="flex items-center gap-4 sm:gap-5">
        <HumanAvatarPicker
          displayName={profile.displayName}
          avatarUrl={profile.avatarUrl}
          editable={self && Boolean(onUploadAvatar)}
          busy={saving}
          onSelect={(blob, mimeType) => onUploadAvatar?.(blob, mimeType)}
          onRemove={profile.avatarUrl && onRemoveAvatar ? onRemoveAvatar : undefined}
          onError={(message) => onAvatarError?.(message)}
        />
        <div className="w-full min-w-0 flex-1">
          {/* Edit sits under the name, not at the header's far end: there the
              Windows caption buttons cover it, and on a phone there is no room. */}
          <div className="flex min-w-0 flex-col items-start gap-3">
            <div className="min-w-0 max-w-full">
              <h2 className="truncate text-2xl font-black text-foreground">{profile.displayName}</h2>
              {profile.handle ? (
                <p className="mt-0.5 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                  <AtSign className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{profile.handle}</span>
                </p>
              ) : canEdit ? (
                <p className="mt-0.5 text-sm text-muted-foreground">Set up your @handle</p>
              ) : null}
            </div>
            {canEdit && !editing ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={actionClass({ variant: "secondary", size: "sm" })}
              >
                <Pencil className="size-3.5" aria-hidden="true" />
                Edit profile
              </button>
            ) : null}
          </div>
          {profile.bio ? (
            <p className="mt-3 whitespace-pre-line text-sm leading-6 text-foreground/80">{profile.bio}</p>
          ) : null}
          <HumanLocalTime
            timeZone={profile.timeZone}
            className="mt-2"
          />
        </div>
      </header>

      {canEdit && editing && onSave ? (
        <HumanProfileEditor
          key={`${profile.userId}:${profile.profileVersion}`}
          profile={profile}
          saving={saving}
          serverError={saveError}
          onCancel={() => setEditing(false)}
          onSave={async (edit) => {
            await onSave(edit);
          }}
        />
      ) : null}

      {self ? (
        <div className="mt-9">
          <ToolDetailSection title="Account">
            <ul className="app-tool-lines">
              {email ? (
                <li className="py-3">
                  <PrivateSignInEmail
                    email={email}
                    className="flex items-start gap-3"
                    labelClassName="app-private-label"
                    emailClassName="mt-1 break-all text-sm text-foreground"
                  />
                </li>
              ) : null}
              <li className="py-3"><GitHubAccountLink /></li>
            </ul>
          </ToolDetailSection>
        </div>
      ) : null}
    </ToolPaperScroll>
  );
}
