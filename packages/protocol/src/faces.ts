import { agentPresetForLauncher } from "./agent-presets.js";
import type { MessageSender } from "./authority-runtime.js";
import type { PageAuthor } from "./pages.js";

/**
 * Whose face to draw. Every face in the product is named by one of these and drawn through one resolver
 * (`resolveFace` here and the Web's face directory), so a person shows the same picture everywhere and the
 * moment they change it, and an Agent shows its vendor's mark whatever alias its harness was written with.
 *
 * - `user`: a person with an xMatrix account. Their picture is their account's (`auth_users.image`), read by id;
 *   no copy of it carried in a message, a session or a member row stands in for it.
 * - `agent`: an Agent. By its harness when the caller knows it; otherwise by its Instance (`id`), whose harness
 *   the Hub reads. A name such as `claude:1` is never parsed for one.
 * - `external`: someone with no xMatrix account, such as an author imported from Slack: the picture their source
 *   gave is the only one there is.
 * - `app`, `machine`, `system`: a connected App, a Machine, xMatrix itself.
 */
export type FaceOf =
  | { kind: "user"; id: string; name: string }
  | { kind: "agent"; name: string; harness?: string | null; id?: string | null }
  | { kind: "external"; name: string; imageUrl?: string | null }
  | { kind: "app"; id: string; name: string }
  | { kind: "machine"; name: string }
  | { kind: "system"; name: string };

/** xMatrix's own face, on what it says itself. */
export const XMATRIX_FACE_URL = "/brand/xmatrix-management-icon.png";

/** An Agent's face: its harness's vendor mark, aliases resolved (`claude_code` → claude); none for a custom harness. */
export function agentFaceUrl(harness: string | null | undefined): string | undefined {
  return agentPresetForLauncher(harness)?.avatarUrl;
}

/** An App's face: its mark. */
export function appFaceUrl(appId: string): string {
  return `/app-connectors/${encodeURIComponent(appId)}.svg`;
}

/**
 * The letters drawn where a face has no picture: the first letter of each of the first two words of its name
 * (`Daniel Melody` → DM). Only a face with no picture at all shows them.
 */
export function faceInitials(name: string): string {
  const initials = Array.from(name.split(/[\s@._-]+/u).filter(Boolean), (part) => Array.from(part)[0] ?? "")
    .join("").toUpperCase();
  return Array.from(initials).slice(0, 2).join("") || "XM";
}

/** The most faces one read resolves; a caller asks again for the rest. */
export const MAX_FACES_PER_READ = 100;

/**
 * What `GET /api/spaces/:spaceId/faces?user=…&agent=…` answers: the picture of each person and Agent Instance
 * asked for, or null where there is none (a person without one, an id that names no one, an Agent on a custom
 * harness).
 */
export interface FacesRead {
  users: Array<{ id: string; imageUrl: string | null }>;
  agents: Array<{ id: string; imageUrl: string | null }>;
}

/** A face as it is drawn: its picture when it has one, and the letters to show when it has none. */
export interface ResolvedFace {
  imageUrl: string | undefined;
  initials: string;
}

/**
 * A face whose picture needs no read: an Agent by its harness, an external author, an App, a Machine, xMatrix.
 * A person, or an Agent known only by its Instance, is read through the face directory instead (null here).
 */
export function staticFace(of: FaceOf): ResolvedFace | null {
  const initials = faceInitials(of.name);
  switch (of.kind) {
    case "user": return null;
    case "agent": return of.harness || !of.id ? { imageUrl: agentFaceUrl(of.harness), initials } : null;
    case "external": return { imageUrl: of.imageUrl || undefined, initials };
    case "app": return { imageUrl: appFaceUrl(of.id), initials };
    case "machine": return { imageUrl: undefined, initials };
    case "system": return { imageUrl: XMATRIX_FACE_URL, initials };
  }
}

/** The directory key a person's or an Agent Instance's picture is kept under. */
export function faceKey(of: Extract<FaceOf, { kind: "user" | "agent" }>): string {
  return of.kind === "user" ? `user:${of.id}` : `agent:${of.id ?? ""}`;
}

/**
 * Whose face a message's sender is: a person by their account; an Agent by the harness its Run was registered with,
 * else by its Instance; an author imported from elsewhere (their id is `<source>:<id>`, as `slack:U123`) by the
 * picture their source gave; an App by its id; xMatrix itself. A sender that names no account or App is no one's
 * face: its letters, never a picture copied onto the message.
 */
export function faceOfSender(sender: Pick<MessageSender, "kind" | "label" | "userId" | "identityId" | "registration"
  | "instanceId" | "avatarUrl">): FaceOf {
  const name = sender.label || "Unknown";
  // A notice xMatrix writes under its owner's authority carries xMatrix's mark, which no one else's picture can be.
  if (sender.avatarUrl === XMATRIX_FACE_URL) return { kind: "system", name };
  switch (sender.kind) {
    case "system": return { kind: "system", name };
    case "app": {
      const id = sender.identityId?.replace(/^app:/u, "") || sender.userId;
      return id ? { kind: "app", id, name } : { kind: "external", name };
    }
    case "agent": return { kind: "agent", name, harness: sender.registration?.harness ?? null, id: sender.instanceId ?? null };
    case "user": return !sender.userId ? { kind: "external", name }
      : sender.userId.includes(":") ? { kind: "external", name, imageUrl: sender.avatarUrl ?? null }
      : { kind: "user", id: sender.userId, name };
  }
}

/** Whose face a page revision's author is: a person by their account, an Agent by its Instance. */
export function faceOfPageAuthor(author: Pick<PageAuthor, "kind" | "id" | "label">): FaceOf {
  return author.kind === "agent" ? { kind: "agent", name: author.label, id: author.id }
    : { kind: "user", id: author.id, name: author.label };
}
