import { Hono } from "hono";
import {
  HUB_ROUTES,
  canonicalHumanHandle,
  humanDisplayNameRefusal,
  humanHandleRefusal,
  humanTimeZoneRefusal,
  type HumanProfile,
  type HumanProfileEdit,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { requireAuth } from "./index-shared";
import { requireHumanAuth, requestErrorStatus } from "./index-shared";
import { readStoredProfile, updateStoredProfile } from "./human-profile-store";
import { syncHumanProfile } from "./human-profile-sync";

export function registerIndexRoutesHumanProfile(app: Hono<{ Bindings: Env }>): void {
  app.patch(HUB_ROUTES.me_profile, async (c) => {
    try {
      const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      let edit: HumanProfileEdit;
      try { edit = await c.req.json<HumanProfileEdit>(); }
      catch { return c.json({ code: "invalid_json", message: "Request body must be valid JSON" }, 400); }

      /* An omitted field means "unchanged"; an empty string means "clear it".
         Absent that distinction a caller had to resend the whole profile to
         touch one field, so any client that did not know about a field erased
         it — which is what a browser reporting only its detected time zone
         would have done to a display name. */
      const edited = (value: unknown): string | undefined =>
        typeof value === "string" ? value.trim() : undefined;
      const displayNameEdit = edited(edit.displayName);
      const handleEdit = edited(edit.handle);
      const avatarUrlEdit = edited(edit.avatarUrl);
      const bioEdit = edited(edit.bio);
      const timeZoneEdit = edited(edit.timeZone);
      if (avatarUrlEdit !== undefined) {
        if (avatarUrlEdit.length > 2048) return c.json({ code: "avatar_url_too_long", message: "Avatar URL is too long" }, 400);
        if (avatarUrlEdit && !/^https?:\/\//u.test(avatarUrlEdit)) return c.json({ code: "avatar_url_invalid", message: "Avatar URL must use HTTP or HTTPS" }, 400);
      }
      if (bioEdit !== undefined && bioEdit.length > 160) {
        return c.json({ code: "bio_too_long", message: "Bio is too long" }, 400);
      }
      if (timeZoneEdit && humanTimeZoneRefusal(timeZoneEdit)) {
        return c.json({ code: "time_zone_invalid", message: "Time zone is not a known IANA zone" }, 400);
      }

      const current = await readStoredProfile(c.env, authUser.id);
      if (!current) return c.json({ code: "profile_not_found", message: "Profile not found" }, 404);
      const displayName = displayNameEdit ?? current.name;
      const handle = canonicalHumanHandle(handleEdit ?? current.handle ?? "");
      const avatarUrl = avatarUrlEdit ?? current.image ?? "";
      const bio = bioEdit ?? current.bio ?? "";
      const timeZone = timeZoneEdit ?? current.timeZone ?? "";
      /* Validated after the merge, so a partial edit is judged on the profile
         it actually produces rather than on the fields it happened to send. */
      const displayNameRefusal = humanDisplayNameRefusal(displayName);
      if (displayNameRefusal) return c.json({ code: displayNameRefusal, message: "Display name is invalid" }, 400);
      const handleRefusal = humanHandleRefusal(handle);
      if (handleRefusal) return c.json({ code: handleRefusal, message: "Handle is invalid" }, 400);
      const now = new Date().toISOString();
      const nextVersion = current.profileVersion + 1;
      const result = await updateStoredProfile(c.env, {
        userId: authUser.id,
        currentHandle: current.handle,
        expectedVersion: current.profileVersion,
        displayName,
        avatarUrl: avatarUrl || null,
        handle,
        bio: bio || null,
        timeZone: timeZone || null,
        nextVersion,
        now,
        retiredSince: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      if (result === "handle_retired_by_other") return c.json({ code: result, message: "Handle cannot be reassigned" }, 409);
      if (result === "handle_change_rate_limited") return c.json({ code: result, message: "Handle change limit reached" }, 429);
      if (result === "profile_version_conflict") return c.json({ code: result, message: "Profile changed; retry" }, 409);
      if (result === "handle_taken") return c.json({ code: result, message: "Handle is already taken" }, 409);
      const profile: HumanProfile = {
        identityId: `user:${authUser.id}`, userId: authUser.id, displayName, handle,
        ...(avatarUrl ? { avatarUrl } : {}), ...(bio ? { bio } : {}),
        ...(timeZone ? { timeZone } : {}), profileVersion: nextVersion,
      };
      const synced = await syncHumanProfile(c.env, profile, now);
      return c.json({ profile, ...(!synced ? { syncPending: true } : {}) });
    } catch (error) {
      return c.json({ code: "profile_update_failed", message: (error as Error).message }, requestErrorStatus(error));
    }
  });

}
