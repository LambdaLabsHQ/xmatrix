"use client";

import { createContext, useContext, useEffect, useSyncExternalStore, type ComponentProps } from "react";
import { faceInitials, faceKey, staticFace, type FaceOf } from "@xmatrix/protocol";
import { useAuthToken } from "@/lib/auth-context";
import { faceDirectory } from "@/lib/faces/face-directory";
import { IdentityAvatar } from "./identity-avatar";

export type { FaceOf };

/** The Space the reader is in, where the faces they see are read. */
export const FaceSpaceContext = createContext<string | null>(null);

/** A face as drawn: its picture when it has one, its letters otherwise, and whether its picture is still being read. */
export interface DrawnFace {
  imageUrl: string | undefined;
  initials: string;
  pending: boolean;
}

const noEntry = () => undefined;

/**
 * The face of a person, an Agent, an App or xMatrix (protocol faces.ts). An Agent by its harness, an App and xMatrix
 * need no read; a person, and an Agent known only by its Instance, are read through the face directory. Letters
 * stand in only for a face that has no picture; one whose picture is still being read waits for it.
 */
export function useFace(of: FaceOf): DrawnFace {
  const fixed = staticFace(of);
  const key = !fixed && (of.kind === "user" || of.kind === "agent") ? faceKey(of) : null;
  // Drawn outside a signed-in app (a landing preview), a face needing a read shows its letters.
  const token = useAuthToken();
  const spaceId = useContext(FaceSpaceContext);
  const entry = useSyncExternalStore(faceDirectory.subscribe, key ? () => faceDirectory.get(key) : noEntry, noEntry);
  useEffect(() => {
    if (key && spaceId && token) faceDirectory.want(key, spaceId, token);
  }, [entry, key, spaceId, token]);
  if (fixed) return { imageUrl: fixed.imageUrl, initials: fixed.initials, pending: false };
  return { imageUrl: entry?.imageUrl ?? undefined, initials: faceInitials(of.name), pending: entry === undefined && Boolean(spaceId && token) };
}

const KIND: Record<FaceOf["kind"], ComponentProps<typeof IdentityAvatar>["kind"]> = {
  user: "human", external: "human", agent: "agent", app: "app", machine: "machine", system: "system",
};

/** The one way a person's or an Agent's face is drawn: whose it is, and how it sits where it is drawn. */
export function Face({ of, ...avatar }: { of: FaceOf }
  & Omit<ComponentProps<typeof IdentityAvatar>, "kind" | "label" | "imageUrl" | "initials" | "pending">) {
  const face = useFace(of);
  return (
    <IdentityAvatar kind={KIND[of.kind]} label={of.name} imageUrl={face.imageUrl} initials={face.initials}
      pending={face.pending} {...avatar} />
  );
}

/** Records the reader's own picture the moment they set or remove it, so every face of theirs shows it at once. */
export function rememberOwnFace(userId: string, imageUrl: string | null | undefined): void {
  faceDirectory.set(faceKey({ kind: "user", id: userId, name: "" }), imageUrl || null);
}
