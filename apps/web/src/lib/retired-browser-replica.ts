/** IndexedDB databases and OPFS directories the retired browser Local Replica wrote. */
const RETIRED_DATABASE_PREFIX = "xmatrix-relay-v2-";
const RETIRED_DIRECTORIES = [
  "xmatrix-relay-v2-storage", "xmatrix-relay-v2-segment-temp", "xmatrix-relay-v2-media",
];

/** Frees the storage of the retired browser Local Replica; history is read from the Hub. */
export async function removeRetiredBrowserReplica(): Promise<void> {
  if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases().catch(() => []);
    for (const { name } of databases) {
      if (name?.startsWith(RETIRED_DATABASE_PREFIX)) indexedDB.deleteDatabase(name);
    }
  }
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return;
  const root = await navigator.storage.getDirectory().catch(() => undefined);
  for (const directory of RETIRED_DIRECTORIES) {
    await root?.removeEntry(directory, { recursive: true }).catch(() => undefined);
  }
}
