/** How long a loaded index answers before reading again: a backstop to the forget every widening write sends. */
const INDEX_TTL_MS = 10 * 60_000;
/** An installation with more subscribed sources than this is not indexed: its deliveries always read routes. */
const MAX_INDEXED_SOURCES = 2_000;

const sourceKey = (kind: string, ref: string, feature: string) => `${kind}\u0000${ref}\u0000${feature}`;

/** Whether any of a delivery's sources is subscribed to for its feature. */
function deliveryMayRoute(subscribed: ReadonlySet<string>, sourceRefs: readonly string[], feature: string): boolean {
  return sourceRefs.some((ref) => (["repository", "issue"] as const).some((kind) =>
    subscribed.has(sourceKey(kind, ref.toLowerCase(), feature))));
}

interface HeldIndex { loadedAt: number; keys: string[] | null }

interface SubscribedSource { sourceKind: string; sourceRef: string; feature: string }

/**
 * One installation's subscribed sources, kept in its Durable Object's storage
 * and read again from PostgreSQL when forgotten or ten minutes old. A read
 * that a forget overtook is not kept: it may predate the widening write.
 */
export class SubscribedSourcesIndex {
  private held: HeldIndex | undefined;
  private generation = 0;

  constructor(
    private readonly storage: Pick<DurableObjectStorage, "get" | "put" | "delete">,
    private readonly read: (installationId: string, limit: number) => Promise<readonly SubscribedSource[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async mayRoute(installationId: string, sourceRefs: readonly string[], feature: string): Promise<boolean> {
    const keys = await this.subscribed(installationId);
    return keys === null || deliveryMayRoute(new Set(keys), sourceRefs, feature);
  }

  async forget(): Promise<void> {
    this.generation += 1;
    this.held = undefined;
    await this.storage.delete("index");
  }

  private async subscribed(installationId: string): Promise<string[] | null> {
    const now = this.now();
    this.held ??= await this.storage.get<HeldIndex>("index");
    if (this.held && now - this.held.loadedAt < INDEX_TTL_MS) return this.held.keys;
    const generation = this.generation;
    const rows = await this.read(installationId, MAX_INDEXED_SOURCES + 1);
    const keys = rows.length > MAX_INDEXED_SOURCES ? null
      : rows.map((row) => sourceKey(row.sourceKind, row.sourceRef, row.feature));
    if (generation === this.generation) {
      this.held = { loadedAt: now, keys };
      await this.storage.put("index", this.held);
    }
    return keys;
  }
}
