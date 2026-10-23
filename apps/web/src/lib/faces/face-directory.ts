import { HUB_ROUTES, MAX_FACES_PER_READ, WEB_PROXY_ROUTES, type FacesRead } from "@xmatrix/protocol";
import { xmatrixHubRead } from "@/lib/query/hub-read";

/**
 * Which picture each person and Agent Instance has, as the Hub last said (protocol faces.ts): the one place the
 * Web learns a face it cannot work out itself. Every face drawn asks it, never a copy of a picture a message, a
 * presence or a session happened to carry, so one person shows one picture everywhere.
 *
 * - The faces a render asks for are read together, in one request per Space.
 * - What was read is kept in this tab and in local storage, so a reload draws every face at once; a face read
 *   more than ten minutes ago is drawn as kept and read again in the background.
 * - A picture this reader sets for themselves is written here as it is set.
 * - The pictures themselves are cached below it: a stored picture's URL names its bytes and is kept a year, a
 *   Google picture goes through the avatar proxy, and a face this tab has drawn stays decoded.
 */

/** What is known of one face: its picture or none, and when that was read. */
export interface FaceEntry {
  imageUrl: string | null;
  at: number;
}

const STORAGE_KEY = "xmatrix.faces.v1";
/** A face read this recently is not read again. */
const FRESH_MS = 10 * 60_000;
/** A read that failed is tried again after this long. */
const RETRY_MS = 30_000;
/** The faces kept across reloads, the most recently read. */
const MAX_KEPT = 2_000;
/** Ids per request, so its address stays well under any proxy's limit. */
const READ_CHUNK = Math.min(50, MAX_FACES_PER_READ);

export class FaceDirectory {
  private readonly entries = new Map<string, FaceEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly wanted = new Map<string, { token: string; keys: Set<string> }>();
  private readonly reading = new Set<string>();
  private restored = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(key: string): FaceEntry | undefined {
    this.restore();
    return this.entries.get(key);
  }

  /** Asks for `key`'s picture in `spaceId`, unless it is fresh or already being read. */
  want(key: string, spaceId: string, token: string): void {
    const entry = this.get(key);
    if ((entry && Date.now() - entry.at < FRESH_MS) || this.reading.has(key)) return;
    const space = this.wanted.get(spaceId) ?? { token, keys: new Set<string>() };
    space.token = token;
    space.keys.add(key);
    this.wanted.set(spaceId, space);
    this.flushTimer ??= setTimeout(() => this.flush(), 0);
  }

  /** A picture known for certain, as the reader's own the moment they set it. */
  set(key: string, imageUrl: string | null): void {
    this.restore();
    this.entries.set(key, { imageUrl, at: Date.now() });
    this.changed();
  }

  private flush(): void {
    this.flushTimer = null;
    const wanted = [...this.wanted];
    this.wanted.clear();
    for (const [spaceId, { token, keys }] of wanted) {
      const all = [...keys];
      for (let start = 0; start < all.length; start += READ_CHUNK) void this.read(spaceId, token, all.slice(start, start + READ_CHUNK));
    }
  }

  private async read(spaceId: string, token: string, keys: string[]): Promise<void> {
    for (const key of keys) this.reading.add(key);
    const query = new URLSearchParams();
    for (const key of keys) {
      const [kind, ...id] = key.split(":");
      query.append(kind === "user" ? "user" : "agent", id.join(":"));
    }
    const search = `?${query.toString()}`;
    try {
      const read = await xmatrixHubRead<FacesRead>({ hubPath: `${HUB_ROUTES.space_faces(spaceId)}${search}`,
        webUrl: `${WEB_PROXY_ROUTES.space_faces(spaceId)}${search}`, token });
      const at = Date.now();
      // A face the answer does not name has no picture: the Hub names every id it can read.
      for (const key of keys) this.entries.set(key, { imageUrl: null, at });
      for (const face of read.users) this.entries.set(`user:${face.id}`, { imageUrl: face.imageUrl, at });
      for (const face of read.agents) this.entries.set(`agent:${face.id}`, { imageUrl: face.imageUrl, at });
    } catch {
      // Unread, a face keeps what it had, or shows its letters until it is tried again.
      const at = Date.now() - FRESH_MS + RETRY_MS;
      for (const key of keys) this.entries.set(key, { imageUrl: this.entries.get(key)?.imageUrl ?? null, at });
    } finally {
      for (const key of keys) this.reading.delete(key);
      this.changed();
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
    this.saveTimer ??= setTimeout(() => this.save(), 1_000);
  }

  private restore(): void {
    if (this.restored || typeof window === "undefined") return;
    this.restored = true;
    try {
      const kept = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, FaceEntry>;
      for (const [key, entry] of Object.entries(kept)) {
        if (entry && typeof entry.at === "number" && (typeof entry.imageUrl === "string" || entry.imageUrl === null)) {
          this.entries.set(key, entry);
        }
      }
    } catch {
      // A store that cannot be read starts empty.
    }
  }

  private save(): void {
    this.saveTimer = null;
    try {
      const newest = [...this.entries].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEPT);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
    } catch {
      // Full or unavailable storage only costs the next reload a read.
    }
  }
}

export const faceDirectory = new FaceDirectory();
