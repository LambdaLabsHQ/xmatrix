import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HUMAN_AVATAR_MAX_BYTES,
  humanAvatarBytesMatchMimeType,
  humanAvatarMimeType,
  humanAvatarMimeTypeForObjectKey,
  humanAvatarObjectKey,
  isHumanAvatarObjectPath,
} from "../../protocol/src/human-avatar.ts";

import {
  clientCompatibilityRequired,
} from "../src/client-compatibility-gate.ts";

/* An avatar object is read by an <img>, which can present neither a bearer
   token nor a compatibility header. Everything here protects that one fact
   from being quietly broken. */

test("an avatar read carries no Authorization, so the compatibility gate must not require headers", () => {
  const request = new Request("https://hub.test/api/avatars/user-1/" + "a".repeat(64) + ".webp");
  assert.equal(clientCompatibilityRequired(request), false);
});

test("the served content type comes from the key, never from the uploader's claim", () => {
  assert.equal(humanAvatarMimeTypeForObjectKey("avatars/user-1/abc.webp"), "image/webp");
  assert.equal(humanAvatarMimeTypeForObjectKey("avatars/user-1/abc.png"), "image/png");
  assert.equal(humanAvatarMimeTypeForObjectKey("avatars/user-1/abc.jpg"), "image/jpeg");
  assert.equal(humanAvatarMimeTypeForObjectKey("avatars/user-1/abc.svg"), null);
  assert.equal(humanAvatarMimeTypeForObjectKey("avatars/user-1/abc.html"), null);
});

test("only the three encodable image types are accepted, parameters and case included", () => {
  assert.equal(humanAvatarMimeType("image/webp"), "image/webp");
  assert.equal(humanAvatarMimeType("IMAGE/PNG"), "image/png");
  assert.equal(humanAvatarMimeType("image/jpeg; charset=binary"), "image/jpeg");
  assert.equal(humanAvatarMimeType("image/svg+xml"), null);
  assert.equal(humanAvatarMimeType("text/html"), null);
  assert.equal(humanAvatarMimeType(null), null);
});

test("the object path is validated before it can reach the bucket", () => {
  const hash = "b".repeat(64);
  assert.equal(isHumanAvatarObjectPath(`user-1/${hash}.webp`), true);
  // Traversal, wildcards, and a wrong-length hash must not become a bucket read.
  assert.equal(isHumanAvatarObjectPath(`../${hash}.webp`), false);
  assert.equal(isHumanAvatarObjectPath(`user-1/${hash}.svg`), false);
  assert.equal(isHumanAvatarObjectPath(`user-1/${"b".repeat(63)}.webp`), false);
  assert.equal(isHumanAvatarObjectPath(`user-1/nested/${hash}.webp`), false);
  assert.equal(isHumanAvatarObjectPath(""), false);
});

test("the key is content addressed and namespaced by owner", () => {
  const hash = "c".repeat(64);
  assert.equal(humanAvatarObjectKey("user-1", hash, "image/webp"), `avatars/user-1/${hash}.webp`);
  assert.equal(humanAvatarObjectKey("user-1", hash, "image/jpeg"), `avatars/user-1/${hash}.jpg`);
  // Same bytes, same key: re-uploading is idempotent rather than duplicating.
  assert.equal(
    humanAvatarObjectKey("user-1", hash, "image/png"),
    humanAvatarObjectKey("user-1", hash, "image/png"),
  );
});

test("declared type must be backed by the actual leading bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(humanAvatarBytesMatchMimeType(png, "image/png"), true);
  assert.equal(humanAvatarBytesMatchMimeType(jpeg, "image/jpeg"), true);
  assert.equal(humanAvatarBytesMatchMimeType(webp, "image/webp"), true);

  // An HTML payload labelled as an image is the attack this closes.
  const html = new TextEncoder().encode("<html><script>alert(1)</script>");
  assert.equal(humanAvatarBytesMatchMimeType(html, "image/png"), false);
  assert.equal(humanAvatarBytesMatchMimeType(html, "image/jpeg"), false);
  assert.equal(humanAvatarBytesMatchMimeType(html, "image/webp"), false);

  // Cross-labelled real images are refused too, so the key extension cannot
  // disagree with the stored bytes.
  assert.equal(humanAvatarBytesMatchMimeType(png, "image/jpeg"), false);
  assert.equal(humanAvatarBytesMatchMimeType(jpeg, "image/webp"), false);

  // A truncated signature must not pass by being a prefix.
  assert.equal(humanAvatarBytesMatchMimeType(new Uint8Array([0xff, 0xd8]), "image/jpeg"), false);
  assert.equal(humanAvatarBytesMatchMimeType(new Uint8Array(), "image/png"), false);
  // RIFF without the WEBP marker is some other RIFF container.
  assert.equal(
    humanAvatarBytesMatchMimeType(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]),
      "image/webp",
    ),
    false,
  );
});

test("the byte ceiling is stated once and is small enough to be a face", () => {
  assert.equal(HUMAN_AVATAR_MAX_BYTES, 1024 * 1024);
});
