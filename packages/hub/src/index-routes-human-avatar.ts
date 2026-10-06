import { Hono } from "hono";
import {
  HUB_ROUTES,
  HUMAN_AVATAR_MAX_BYTES,
  humanAvatarBytesMatchMimeType,
  humanAvatarMimeType,
  humanAvatarMimeTypeForObjectKey,
  humanAvatarObjectKey,
  isHumanAvatarObjectPath,
  sha256Hex,
} from "@xmatrix/protocol";
import type { Context } from "hono";
import type { Env } from "./types";
import { requireAuth } from "./index-shared";
import { requireHumanAuth, requestErrorStatus } from "./index-shared";
import {
  humanProfileFromStored,
  readStoredProfile,
  updateStoredAvatar,
} from "./human-profile-store";
import { syncHumanProfile } from "./human-profile-sync";

/* A stored avatar never changes: its key is the hash of its bytes. `immutable`
   is therefore a fact about the object rather than a hopeful hint, and a client
   that has one revalidates nothing for a year. Replacing a picture writes a new
   key and moves the profile pointer, so nothing has to be invalidated. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Moves the profile's photo pointer, whether a new upload set it or a removal
 * cleared it. One compare-and-set on `profileVersion`, one projection, one Authority
 * sync — the two callers differ only in the URL they pass.
 */
async function commitAvatarPointer(
  c: Context<{ Bindings: Env }>,
  userId: string,
  avatarUrl: string | null,
): Promise<Response> {
  const current = await readStoredProfile(c.env, userId);
  if (!current) return c.json({ code: "profile_not_found", message: "Profile not found" }, 404);

  const now = new Date().toISOString();
  const nextVersion = current.profileVersion + 1;
  const updated = await updateStoredAvatar(
    c.env, userId, avatarUrl, current.profileVersion, nextVersion, now,
  );
  if (!updated) {
    return c.json({ code: "profile_version_conflict", message: "Profile changed; retry" }, 409);
  }

  const profile = humanProfileFromStored(userId, current, { avatarUrl, profileVersion: nextVersion });
  const synced = await syncHumanProfile(c.env, profile, now);
  return c.json({ profile, ...(!synced ? { syncPending: true } : {}) });
}

export function registerIndexRoutesHumanAvatar(app: Hono<{ Bindings: Env }>): void {
  /* Read is deliberately unauthenticated. A face is rendered by <img> on every
     message its owner ever sent; there is no way to attach a bearer token to
     that, and no channel to scope the object to. The key is a SHA-256, so the
     URL is unguessable, and the response is pinned to a Content-Type derived
     from the key with `nosniff`, so a stored blob can never be served as an
     active document. */
  app.get("/api/avatars/:userId/:file", async (c) => {
    const objectPath = `${c.req.param("userId")}/${c.req.param("file")}`;
    if (!isHumanAvatarObjectPath(objectPath)) {
      return c.json({ code: "avatar_not_found", message: "Avatar not found" }, 404);
    }
    const bucket = c.env.ATTACHMENT_BUCKET;
    if (!bucket) {
      return c.json({ code: "avatar_storage_unavailable", message: "Avatar storage is unavailable" }, 503);
    }
    const key = `avatars/${objectPath}`;
    const mimeType = humanAvatarMimeTypeForObjectKey(key);
    if (!mimeType) {
      return c.json({ code: "avatar_not_found", message: "Avatar not found" }, 404);
    }
    const object = await bucket.get(key);
    if (!object) {
      return c.json({ code: "avatar_not_found", message: "Avatar not found" }, 404);
    }
    return new Response(object.body, {
      headers: {
        "content-type": mimeType,
        "cache-control": IMMUTABLE_CACHE_CONTROL,
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        etag: object.httpEtag,
      },
    });
  });

  app.post(HUB_ROUTES.me_avatar, async (c) => {
    try {
      const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const bucket = c.env.ATTACHMENT_BUCKET;
      if (!bucket) return c.json({ code: "avatar_storage_unavailable", message: "Avatar storage is unavailable" }, 503);

      const mimeType = humanAvatarMimeType(c.req.header("content-type"));
      if (!mimeType) {
        return c.json({ code: "avatar_type_unsupported", message: "Upload a PNG, JPEG, or WebP image" }, 415);
      }
      /* Read with a ceiling rather than trusting Content-Length: the header is
         a claim, and a streamed body can exceed whatever it declared. */
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > HUMAN_AVATAR_MAX_BYTES) {
        return c.json({ code: "avatar_too_large", message: "Image is too large" }, 413);
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) {
        return c.json({ code: "avatar_empty", message: "Image is empty" }, 400);
      }
      if (bytes.byteLength > HUMAN_AVATAR_MAX_BYTES) {
        return c.json({ code: "avatar_too_large", message: "Image is too large" }, 413);
      }
      if (!humanAvatarBytesMatchMimeType(bytes, mimeType)) {
        return c.json({ code: "avatar_bytes_mismatch", message: "Image does not match its declared type" }, 400);
      }

      const contentHash = await sha256Hex(bytes);
      const key = humanAvatarObjectKey(authUser.id, contentHash, mimeType);
      await bucket.put(key, bytes as unknown as ArrayBuffer, {
        httpMetadata: { contentType: mimeType, cacheControl: IMMUTABLE_CACHE_CONTROL },
      });

      /* Absolute, because this URL is read by the web app, the desktop shell and
         iOS alike. A path relative to one of them is not a profile field. */
      const objectPath = `${authUser.id}/${contentHash}.${key.split(".").pop()}`;
      const avatarUrl = `${new URL(c.req.url).origin}${HUB_ROUTES.human_avatar(objectPath)}`;
      return await commitAvatarPointer(c, authUser.id, avatarUrl);
    } catch (error) {
      return c.json({ code: "avatar_update_failed", message: (error as Error).message }, requestErrorStatus(error));
    }
  });

  /* Removing a photo clears the pointer only. The object stays: another
     profile version may still reference the same bytes, and an orphan in R2 is
     cheaper than a delete that races a reader. */
  app.delete(HUB_ROUTES.me_avatar, async (c) => {
    try {
      const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      return await commitAvatarPointer(c, authUser.id, null);
    } catch (error) {
      return c.json({ code: "avatar_update_failed", message: (error as Error).message }, requestErrorStatus(error));
    }
  });
}
