"use client";

import type { FaceOf } from "@xmatrix/protocol";
import { LoadingImage } from "@/components/dashboard/content-skeleton";
import { useFace } from "./face";
import { avatarImageSrc } from "./identity-avatar";

/**
 * A face inside an `@` chip (protocol faces.ts): its picture, else the first of its letters, all the chip's disc has
 * room for. While its picture is still being read the disc stays bare rather than show a letter it may not need.
 * `contain` insets a mark that is artwork rather than a portrait, as an App's.
 */
export function MentionChipFace({ of, contain = false }: { of: FaceOf; contain?: boolean }) {
  const face = useFace(of);
  if (face.pending) return null;
  const src = avatarImageSrc(face.imageUrl);
  const letter = <span className="app-mention-chip-initial">{Array.from(face.initials)[0] ?? "@"}</span>;
  return src ? (
    <LoadingImage src={src} alt="" announce={false} retain referrerPolicy="no-referrer" draggable={false}
      className={contain ? "size-full object-contain" : "size-full object-cover"} fallback={letter} />
  ) : letter;
}
