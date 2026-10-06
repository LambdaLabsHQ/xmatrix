"use client";

import {
  humanHandleShortCode,
  isUnusableHumanIdentitySource,
  neutralHumanIdentity,
  type HumanProfile,
  type SpaceMember,
} from "@xmatrix/protocol";
import { AtSign } from "lucide-react";

import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { HumanLocalTime } from "@/components/dashboard/human-local-time";
import { cn } from "@/lib/utils";
import { COUNT_CHIP_MATERIAL_CLASS } from "./workspace-shell-constants";

export type CurrentHumanProfileSource = {
  id: string;
  name?: string;
  avatarUrl?: string;
};

export function currentHumanDisplayName(
  source: CurrentHumanProfileSource,
  member?: SpaceMember,
): string {
  const supplied = member?.name?.trim() || source.name?.trim();
  if (supplied && !isUnusableHumanIdentitySource(supplied)) return supplied;
  const shortCode = humanHandleShortCode(source.id);
  return shortCode ? neutralHumanIdentity(shortCode).displayName : "Your profile";
}

export function humanProfileFromSpaceMember(
  source: CurrentHumanProfileSource,
  member?: SpaceMember,
): HumanProfile {
  return {
    identityId: `user:${source.id}`,
    userId: source.id,
    displayName: currentHumanDisplayName(source, member),
    ...(member?.handle ? { handle: member.handle } : {}),
    ...(member?.avatarUrl || source.avatarUrl
      ? { avatarUrl: member?.avatarUrl || source.avatarUrl }
      : {}),
    ...(member?.bio ? { bio: member.bio } : {}),
    ...(member?.timeZone ? { timeZone: member.timeZone } : {}),
    ...(member?.handleIsTemporary !== undefined
      ? { handleIsTemporary: member.handleIsTemporary }
      : {}),
    profileVersion: member?.profileVersion ?? 0,
  };
}

export function HumanProfileSummary({
  profile,
  compact = false,
  self = true,
  className,
}: {
  profile: HumanProfile;
  compact?: boolean;
  /* "Set up your @handle" is a call to action, and only the owner of the
     profile can answer it. On someone else's card it read as a statement about
     them, so a person with no handle yet gets no handle line at all. */
  self?: boolean;
  className?: string;
}) {
  const handleLabel = profile.handle ? profile.handle : self ? "Set up your @handle" : null;

  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <IdentityAvatar
        kind="human"
        label={profile.displayName}
        imageUrl={profile.avatarUrl}
        initials={profile.displayName.slice(0, 2)}
        size={compact ? "md" : "lg"}
        showKindBadge={false}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-black text-foreground">{profile.displayName}</p>
          {profile.handleIsTemporary ? (
            <span className={cn("shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground", COUNT_CHIP_MATERIAL_CLASS)}>
              Temporary
            </span>
          ) : null}
        </div>
        {handleLabel ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            <AtSign className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{handleLabel}</span>
          </p>
        ) : null}
        {!compact && profile.bio ? (
          <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{profile.bio}</p>
        ) : null}
        {!compact ? <HumanLocalTime timeZone={profile.timeZone} className="mt-1" /> : null}
      </div>
    </div>
  );
}
