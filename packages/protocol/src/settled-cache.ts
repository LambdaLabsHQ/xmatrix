/**
 * Values this isolate keeps for later requests: bounded, least recently used
 * first out, each until its own expiry.
 *
 * Only settled values are kept, never a promise. A Cloudflare Worker request
 * cannot await a promise another request created: once that request ends, its
 * unsettled read is dropped and every waiter fails ("can never settle",
 * HUB-DJ). So concurrent first reads of one key each read it, and the first to
 * finish fills the cache. A read that fails, or finds nothing, is not kept.
 * Work one request shares among its own tasks may still share a promise; it is
 * gone when that request is.
 */
export class SettledCache<K, V> {
  readonly #entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("SettledCache needs at least one entry");
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The value while it has not expired; reading it makes it the most recently used. */
  get(key: K, now = Date.now()): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Keeps a settled value until `expiresAt` (epoch ms), dropping the least recently used past the bound. */
  set(key: K, value: V, expiresAt: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.maxEntries) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  /**
   * The kept value, or what `load` reads now in the calling request, kept for
   * `ttlMs` once it settles. A failed read propagates; `null` is returned and
   * not kept, so something that appears later is found on the next read.
   */
  read(key: K, ttlMs: number, load: () => Promise<V>): Promise<V>;
  read(key: K, ttlMs: number, load: () => Promise<V | null>): Promise<V | null>;
  async read(key: K, ttlMs: number, load: () => Promise<V | null>): Promise<V | null> {
    const kept = this.get(key);
    if (kept !== undefined) return kept;
    const value = await load();
    if (value !== null) this.set(key, value, Date.now() + ttlMs);
    return value;
  }
}
