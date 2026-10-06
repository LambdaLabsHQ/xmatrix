import {
  PRODUCT_TAIL_CACHE_SCHEMA_VERSION,
  planProductTailCacheEviction,
  type ProductTailCacheEntry,
} from "./product-tail-cache";
import type { SerializedChannel } from "@xmatrix/protocol";

const DB_NAME_PREFIX = "xmatrix-product-tail-cache";
const DB_VERSION = 2;
const CHANNELS_STORE = "channels";
const CATALOG_STORE = "catalog";
const CATALOG_KEY = "current";
const CATALOG_CHANNEL_LIMIT = 2_000;
const LAST_CATALOG_USER_STORAGE_KEY = "xmatrix-product-tail-cache:last-catalog-user";
const EVICTION_CHECK_EVERY_PUTS = 25;

export interface ProductTailCacheStoreNamespace {
  hubOrigin: string;
  userId: string;
  clientProfileId: string;
}

interface ProductChannelCatalogSnapshot {
  key: typeof CATALOG_KEY;
  userId: string;
  cachedAt: number;
  channels: SerializedChannel[];
}

function catalogChannelForDisk(channel: SerializedChannel): SerializedChannel {
  const display = { ...channel };
  delete display.memberPresence;
  delete display.visibleHumanMemberIds;
  delete display.metadata;
  return display;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/**
 * Durable storage for admitted tail-cache entries. All failures degrade to
 * "no cache" (open returns null, reads return empty) — the cache is an
 * optimization and must never block the network path. Purges are awaited by
 * callers that need durability barriers.
 */
export class ProductTailCacheStore {
  private putCount = 0;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly userId: string,
  ) {}

  static async open(
    namespace: ProductTailCacheStoreNamespace,
  ): Promise<ProductTailCacheStore | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      const name =
        `${DB_NAME_PREFIX}:${namespace.hubOrigin}|${namespace.userId}|${namespace.clientProfileId}`;
      const openRequest = indexedDB.open(name, DB_VERSION);
      openRequest.onupgradeneeded = () => {
        const db = openRequest.result;
        if (!db.objectStoreNames.contains(CHANNELS_STORE)) {
          db.createObjectStore(CHANNELS_STORE, { keyPath: "channelId" });
        }
        if (!db.objectStoreNames.contains(CATALOG_STORE)) {
          db.createObjectStore(CATALOG_STORE, { keyPath: "key" });
        }
      };
      const db = await request(openRequest);
      const store = new ProductTailCacheStore(db, namespace.userId);
      await store.enforceBudget();
      return store;
    } catch {
      return null;
    }
  }

  static lastCatalogUserId(): string | null {
    try {
      const userId = window.localStorage.getItem(LAST_CATALOG_USER_STORAGE_KEY)?.trim();
      return userId || null;
    } catch {
      return null;
    }
  }

  async readAll(): Promise<ProductTailCacheEntry[]> {
    try {
      const tx = this.db.transaction(CHANNELS_STORE, "readonly");
      const rows = await request(tx.objectStore(CHANNELS_STORE).getAll());
      const valid: ProductTailCacheEntry[] = [];
      for (const row of rows as ProductTailCacheEntry[]) {
        if (!row) continue;
        if (row.schemaVersion === PRODUCT_TAIL_CACHE_SCHEMA_VERSION && row.userId === this.userId) {
          valid.push(row);
        } else if (typeof row.channelId === "string" && row.channelId) {
          // Stale-schema bytes are invisible to admission AND to the byte
          // budget; reclaim them instead of letting them sit forever.
          void this.delete(row.channelId);
        }
      }
      return valid;
    } catch {
      return [];
    }
  }

  async put(entry: ProductTailCacheEntry): Promise<void> {
    try {
      const tx = this.db.transaction(CHANNELS_STORE, "readwrite");
      tx.objectStore(CHANNELS_STORE).put(entry);
      await awaitTransaction(tx);
      this.putCount += 1;
      if (this.putCount % EVICTION_CHECK_EVERY_PUTS === 0) await this.enforceBudget();
    } catch {
      // Storage pressure or a closed database: the in-memory path continues.
    }
  }

  async readCatalog(): Promise<SerializedChannel[]> {
    try {
      const tx = this.db.transaction(CATALOG_STORE, "readonly");
      const row = await request(tx.objectStore(CATALOG_STORE).get(CATALOG_KEY)) as
        ProductChannelCatalogSnapshot | undefined;
      if (!row || row.userId !== this.userId || !Array.isArray(row.channels)) return [];
      return row.channels.slice(0, CATALOG_CHANNEL_LIMIT);
    } catch {
      return [];
    }
  }

  async putCatalog(channels: SerializedChannel[]): Promise<void> {
    try {
      const snapshot: ProductChannelCatalogSnapshot = {
        key: CATALOG_KEY,
        userId: this.userId,
        cachedAt: Date.now(),
        channels: channels.slice(0, CATALOG_CHANNEL_LIMIT).map(catalogChannelForDisk),
      };
      const tx = this.db.transaction(CATALOG_STORE, "readwrite");
      tx.objectStore(CATALOG_STORE).put(snapshot);
      await awaitTransaction(tx);
      window.localStorage.setItem(LAST_CATALOG_USER_STORAGE_KEY, this.userId);
    } catch {
      // Catalog persistence is presentation-only; the network path continues.
    }
  }

  async delete(channelId: string): Promise<void> {
    try {
      const tx = this.db.transaction(CHANNELS_STORE, "readwrite");
      tx.objectStore(CHANNELS_STORE).delete(channelId);
      await awaitTransaction(tx);
    } catch {
      // A failed durable purge keeps the gate closed; admission re-purges.
    }
  }

  async clear(): Promise<void> {
    try {
      const tx = this.db.transaction(CHANNELS_STORE, "readwrite");
      tx.objectStore(CHANNELS_STORE).clear();
      await awaitTransaction(tx);
    } catch {
      // Same as delete: the render gate never opens from a failed purge.
    }
  }

  async clearAll(): Promise<void> {
    try {
      const tx = this.db.transaction([CHANNELS_STORE, CATALOG_STORE], "readwrite");
      tx.objectStore(CHANNELS_STORE).clear();
      tx.objectStore(CATALOG_STORE).clear();
      await awaitTransaction(tx);
      if (window.localStorage.getItem(LAST_CATALOG_USER_STORAGE_KEY) === this.userId) {
        window.localStorage.removeItem(LAST_CATALOG_USER_STORAGE_KEY);
      }
    } catch {
      // Logout/user-switch presentation is already closed in memory.
    }
  }

  private async enforceBudget(): Promise<void> {
    const entries = await this.readAll();
    for (const channelId of planProductTailCacheEviction(entries)) {
      await this.delete(channelId);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}
