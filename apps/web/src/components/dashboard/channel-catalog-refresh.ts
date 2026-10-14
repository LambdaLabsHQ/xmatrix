import { replaceEqualDeep, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type {
  ChannelCatalogPage, ChannelCatalogPageRow, ChannelCatalogResolveResult, SerializedChannel,
} from "@xmatrix/protocol";

/** Flatten an infinite catalog query's pages into one row per channel, last write winning. */
export function rowsFromData(
  data: InfiniteData<ChannelCatalogPage, unknown> | undefined,
): ChannelCatalogPageRow[] {
  const rows = new Map<string, ChannelCatalogPageRow>();
  for (const page of data?.pages ?? []) {
    for (const row of page.rows) rows.set(row.channel.id, row);
  }
  return [...rows.values()];
}

const NO_ROWS: ChannelCatalogPageRow[] = [];

/**
 * What a catalog query holds after `next` is written to it: `next`, with each
 * row the query already held for the same Channel, saying the same, kept as
 * the object it was.
 *
 * Rows are matched by their Channel, never by their place, and never copied.
 * The query library's own sharing compares a list place by place: one row
 * moving to the top makes every row below it a fresh copy of itself, which the
 * entity table then takes for a new read and applies over what live reports
 * have said since, and which re-renders every row of the list.
 */
export function shareCatalogRows<Data extends InfiniteData<ChannelCatalogPage, unknown>>(
  held: Data | undefined,
  next: Data,
): Data {
  if (!held || held === next) return next;
  const heldRows = new Map<string, ChannelCatalogPageRow>();
  for (const page of held.pages) for (const row of page.rows) heldRows.set(row.channel.id, row);
  const pages = next.pages.map((page) => {
    const rows = page.rows.map((row) => {
      const prior = heldRows.get(row.channel.id);
      return prior && replaceEqualDeep(prior, row) === prior ? prior : row;
    });
    return rows.every((row, index) => row === page.rows[index]) ? page : { ...page, rows };
  });
  // An answer that says what the query held is the held data: its readers are not told again.
  const samePage = (before: ChannelCatalogPage | undefined, after: ChannelCatalogPage) => before !== undefined && (
    before === after || (before.rows.length === after.rows.length &&
      after.rows.every((row, index) => row === before.rows[index]) &&
      sameValue({ ...before, rows: NO_ROWS }, { ...after, rows: NO_ROWS })));
  if (held.pages.length === pages.length && pages.every((page, index) => samePage(held.pages[index], page)) &&
      sameValue(held.pageParams, next.pageParams)) {
    return held;
  }
  return pages.every((page, index) => page === next.pages[index]) ? next : { ...next, pages };
}

function sameValue(before: unknown, after: unknown): boolean {
  return replaceEqualDeep(before, after) === before;
}

/** The authorization each loaded Space's reads stand on: one lease a Space, for one account on one Hub. */
export interface CatalogLeases {
  key: string;
  session: string;
  bySpace: Map<string, object>;
}

export const NO_CATALOG_LEASES: CatalogLeases = { key: "", session: "", bySpace: new Map() };

/**
 * The leases after the authorization became `session` over `spaceIds` (none
 * when signed out). A Space that stays loaded for the same account keeps its
 * lease, so a token renewed without a gap keeps its reads. A Space that was
 * dropped, or any Space once the account, the Hub or the sign-in went away,
 * gets a new lease when it comes back: reads asked under the old one never
 * match again, even when everything returns to the values it had.
 */
export function nextCatalogLeases(held: CatalogLeases, session: string, spaceIds: readonly string[]): CatalogLeases {
  const key = spaceIds.length ? `${session}\u0000${spaceIds.join("\u0000")}` : "";
  if (held.key === key) return held;
  const kept = held.session === session ? held.bySpace : NO_CATALOG_LEASES.bySpace;
  return { key, session, bySpace: new Map(spaceIds.map((id) => [id, kept.get(id) ?? {}])) };
}

export interface ChannelCatalogChangeDetail {
  kind?: string;
  channelId?: string;
  spaceId?: string;
  revision?: number;
  /** Message `sentAt`, used to reorder a row the sidebar already holds. */
  at?: string;
}

const revisionWatermarks = new WeakMap<QueryClient, Map<string, number>>();
const staleRefetchWatermarks = new WeakMap<QueryClient, Map<string, number>>();

function watermarkMap(client: QueryClient): Map<string, number> {
  let watermarks = revisionWatermarks.get(client);
  if (!watermarks) {
    watermarks = new Map();
    revisionWatermarks.set(client, watermarks);
  }
  return watermarks;
}

function queryCatalogRevision(data: unknown): number {
  const pages = (data as InfiniteData<ChannelCatalogPage, unknown> | undefined)?.pages;
  if (!Array.isArray(pages) || pages.length === 0) return 0;
  const revisions = pages.map((page) => Number.isSafeInteger(page.catalogRevision)
    ? page.catalogRevision : 0);
  return Math.min(...revisions);
}

/**
 * Observe one authoritative Space watermark from either HTTP or WebSocket.
 * Revision zero is the explicit legacy/unknown sentinel and never advances it.
 */
export function observeSpaceCatalogRevision(input: {
  client: QueryClient;
  spaceId: string;
  prefix: QueryKey;
  countsKey: QueryKey;
  revision: number;
  sourceQueryKey?: QueryKey;
  sourceQueryHash?: string;
}): boolean {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) return false;
  const watermarks = watermarkMap(input.client);
  const current = watermarks.get(input.spaceId) ?? 0;
  if (input.revision < current && input.sourceQueryKey && input.sourceQueryHash) {
    let stale = staleRefetchWatermarks.get(input.client);
    if (!stale) {
      stale = new Map();
      staleRefetchWatermarks.set(input.client, stale);
    }
    if ((stale.get(input.sourceQueryHash) ?? 0) < current) {
      stale.set(input.sourceQueryHash, current);
      void input.client.invalidateQueries({
        queryKey: input.sourceQueryKey, exact: true, refetchType: "all",
      });
    }
    return false;
  }
  if (input.revision <= current) return false;
  watermarks.set(input.spaceId, input.revision);
  // Speculation is never a visible/authoritative index. Drop it on a newer
  // catalog revision rather than refetching every unopened branch.
  input.client.removeQueries({ queryKey: input.prefix,
    predicate: (query) => query.queryKey[5] === "child-prefetch" &&
      queryCatalogRevision(query.state.data) < input.revision });
  void input.client.invalidateQueries({
    queryKey: input.prefix,
    predicate: (query) => query.queryKey[5] === "catalog" &&
      query.queryKey.length === 10 &&
      queryCatalogRevision(query.state.data) < input.revision,
    refetchType: "all",
  });
  void input.client.invalidateQueries({ queryKey: input.countsKey, exact: true });
  return true;
}

/**
 * Bring one Space's cached catalog indexes back in line after a realtime change.
 *
 * Extracted from the hook so the guarantee is testable against a real
 * QueryClient rather than by scraping an effect closure, and so a shell holding
 * several Spaces refreshes each of them through the same path.
 */
export function refreshSpaceCatalogForEvent(input: {
  client: QueryClient;
  spaceId: string;
  /** This Space's channel query prefix; the caller owns key derivation. */
  prefix: QueryKey;
  /** This Space's catalog-counts key. */
  countsKey: QueryKey;
  detail?: ChannelCatalogChangeDetail;
  /** Whether the entity table holds this channel as a read for this reader brought it. */
  hasChannel: (channelId: string) => boolean;
  /** The entity table's Channel, as live as it has it. */
  channel?: (channelId: string) => SerializedChannel | undefined;
  /** The reader, whose own intake conversations are among their conversations. */
  viewerId?: string;
  /** Pull a channel into the entity table; `fresh` bypasses the cached read. */
  resolveChannel: (spaceId: string, channelId: string, fresh?: boolean) => void;
  /** Ask the Hub for the Channels of a window's messages that nobody here knows. */
  resolveMessageChannels?: (spaceId: string, details: ChannelCatalogChangeDetail[]) => void;
}): void {
  const { client, spaceId, prefix, countsKey, detail } = input;
  client.removeQueries({ queryKey: prefix,
    predicate: (query) => query.queryKey[5] === "child-prefetch" });

  if (detail?.kind === "revision" && detail.revision !== undefined) {
    observeSpaceCatalogRevision({
      client, spaceId, prefix, countsKey, revision: detail.revision,
    });
    return;
  }

  if (detail?.kind === "message" && detail.channelId) {
    refreshSpaceCatalogForMessages({ ...input, details: [detail] });
    return;
  }

  // `presence`: an Instance left or changed its rest, so the channel's member
  // presence must be read again even though the channel is already known.
  if (detail?.kind === "presence" && detail.channelId) {
    const channelId = detail.channelId;
    const affected = client.getQueryCache().findAll({ queryKey: prefix }).filter((query) => {
      if (query.queryKey[5] !== "catalog") return false;
      if (query.queryKey[6] === "flat") return true;
      const data = query.state.data as InfiniteData<ChannelCatalogPage, string | null> | undefined;
      return rowsFromData(data).some((row) => row.channel.id === channelId);
    });
    for (const query of affected) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "all" });
    }
    void client.invalidateQueries({ queryKey: countsKey, exact: true });
    input.resolveChannel(spaceId, channelId, true);
    return;
  }

  // Flat and expanded child pages are fetched imperatively, so they have no
  // active QueryObserver. Structural changes must refresh those cached indexes
  // too, otherwise new channels remain absent from their rows.
  void client.invalidateQueries({
    queryKey: prefix,
    predicate: (query) => query.queryKey[5] === "catalog" && query.queryKey.length === 10,
    refetchType: "all",
  });
  void client.invalidateQueries({
    queryKey: prefix,
    predicate: (query) => query.queryKey[5] !== "catalog" || query.queryKey.length !== 10,
  });
}

export const CATALOG_REFRESH_WINDOW_MS = 500;

/**
 * The refreshes a burst of catalog changes needs, merged: a structural change
 * re-reads everything once, so it absorbs the per-Channel ones; otherwise each
 * Channel's change is kept once (a presence change, which re-reads the Channel,
 * absorbs a message change) and only the highest revision watermark matters.
 */
export function coalesceCatalogChanges(
  details: readonly ChannelCatalogChangeDetail[],
): ChannelCatalogChangeDetail[] {
  let revision: ChannelCatalogChangeDetail | undefined;
  let structure: ChannelCatalogChangeDetail | undefined;
  const perChannel = new Map<string, ChannelCatalogChangeDetail>();
  for (const detail of details) {
    if (detail.kind === "revision" && detail.revision !== undefined) {
      if (!revision || detail.revision > revision.revision!) revision = detail;
    } else if ((detail.kind === "message" || detail.kind === "presence") && detail.channelId) {
      const known = perChannel.get(detail.channelId);
      // A later message keeps its sentAt. Presence still absorbs a message,
      // because presence has to re-read the Channel.
      if (!known || detail.kind === "presence" || known.kind === "message") {
        perChannel.set(detail.channelId, detail);
      }
    } else {
      structure ??= detail;
    }
  }
  return [
    ...(revision ? [revision] : []),
    ...(structure ? [structure] : [...perChannel.values()]),
  ];
}

type CatalogData = InfiniteData<ChannelCatalogPage, unknown>;

/**
 * `data` with the Channel's row first and no later than `at`; `data` itself
 * when the row already stands there; undefined when no loaded page holds it.
 * Pages keep their cursors and are not refilled.
 */
function withChannelPromoted(data: CatalogData, channelId: string, at: string | undefined): CatalogData | undefined {
  let found: ChannelCatalogPageRow | undefined;
  for (const page of data.pages) {
    const row = page.rows.find((item) => item.channel.id === channelId);
    if (row) found = row;
  }
  if (!found || data.pages.length === 0) return undefined;
  if (at && found.ownActivityAt && at < found.ownActivityAt) return data;
  const nextRow = at && at !== found.ownActivityAt ? { ...found, ownActivityAt: at } : found;
  if (data.pages[0]?.rows[0]?.channel.id === channelId && nextRow === found) return data;
  return withRowFirst(data, nextRow);
}

function withRowFirst(data: CatalogData, row: ChannelCatalogPageRow): CatalogData {
  const pages = data.pages.map((page) => ({
    ...page,
    rows: page.rows.filter((item) => item.channel.id !== row.channel.id),
  }));
  const first = pages[0]!;
  pages[0] = { ...first, rows: [row, ...first.rows] };
  return { ...data, pages };
}

/** The one list every conversation of the reader's is in: flat, unfiltered, unscoped, unsearched. */
function isConversationList(queryKey: QueryKey): boolean {
  return queryKey[6] === "flat" && queryKey[7] === "all" && (queryKey[8] ?? null) === null && (queryKey[9] ?? "") === "";
}

/**
 * Whether `channel` is in the Space's conversation list as the Hub selects it
 * (packages/db channel-catalog `viewSql`): every Channel the reader may read,
 * except an intake conversation somebody else started. The entity table holds
 * only Channels the Hub has shown this reader.
 */
function inConversationList(channel: SerializedChannel, spaceId: string, viewerId: string | undefined): boolean {
  if (channel.spaceId !== spaceId) return false;
  const intakeOf = channel.metadata?.intakeOf;
  if (intakeOf === undefined || intakeOf === null) return true;
  return typeof intakeOf === "string" && viewerId !== undefined && intakeOf === viewerId;
}

/**
 * Brings one Space's cached lists in line with a window's messages.
 *
 * The socket already delivered each message, so a list that holds its
 * Channel's row only moves that row. The conversation list also takes the row
 * of a Channel it has not paged in yet: the reader may read it, it has just
 * become the most recently active, and that is where the Hub would list it.
 * A Channel nobody here knows is first resolved for this reader by the Hub,
 * all of a window's in one request, and joins the conversation list with the
 * answer (`known`). Every other list that lacks a Channel is read again, once
 * however many of the window's messages it lacks.
 */
export function refreshSpaceCatalogForMessages(input: {
  client: QueryClient;
  spaceId: string;
  prefix: QueryKey;
  countsKey: QueryKey;
  details: readonly ChannelCatalogChangeDetail[];
  hasChannel: (channelId: string) => boolean;
  channel?: (channelId: string) => SerializedChannel | undefined;
  viewerId?: string;
  resolveChannel: (spaceId: string, channelId: string, fresh?: boolean) => void;
  resolveMessageChannels?: (spaceId: string, details: ChannelCatalogChangeDetail[]) => void;
}): void {
  const { client, spaceId, prefix, countsKey } = input;
  const messages = input.details.filter((detail) => detail.kind === "message" && detail.channelId);
  if (messages.length === 0) return;
  const unknown = messages.filter((detail) => !input.hasChannel(detail.channelId!));
  // With no batch reader, an unknown Channel's lists are read again as before.
  const awaited = new Set(input.resolveMessageChannels ? unknown.map((detail) => detail.channelId!) : []);
  client.removeQueries({ queryKey: prefix,
    predicate: (query) => query.queryKey[5] === "child-prefetch" });
  const catalogQueries = client.getQueryCache().findAll({ queryKey: prefix })
    .filter((query) => query.queryKey[5] === "catalog");
  let refetch = false;
  for (const query of catalogQueries) {
    const held = query.state.data as CatalogData | undefined;
    const flat = query.queryKey[6] === "flat";
    const conversations = isConversationList(query.queryKey);
    let data = held;
    let lacking = false;
    for (const detail of messages) {
      const channelId = detail.channelId!;
      const promoted = data && withChannelPromoted(data, channelId, detail.at);
      if (promoted) {
        data = promoted;
        continue;
      }
      // Only a Channel a read for this reader has brought: one a shared
      // presence frame showed first has none of their read state yet.
      const channel = conversations && data?.pages.length && input.hasChannel(channelId)
        ? input.channel?.(channelId) : undefined;
      if (data && channel && inConversationList(channel, spaceId, input.viewerId)) {
        data = withRowFirst(data, {
          channel,
          ownActivityAt: detail.at ?? channel.lastMessage?.sentAt ?? channel.updatedAt,
        });
      } else if (flat && !(conversations && data?.pages.length && awaited.has(channelId))) lacking = true;
    }
    if (data && data !== held) client.setQueryData(query.queryKey, data);
    if (lacking) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "all" });
      refetch = true;
    }
  }
  if (refetch) void client.invalidateQueries({ queryKey: countsKey, exact: true });
  if (unknown.length === 0) return;
  if (input.resolveMessageChannels) input.resolveMessageChannels(spaceId, unknown);
  else for (const detail of unknown) input.resolveChannel(spaceId, detail.channelId!);
}

/**
 * Reads Channels for this reader and puts them into the entity table.
 *
 * `authorized` says whether the authorization the read was asked under still
 * stands. Once it has ended the answer is for nobody here: nothing is
 * committed, and the caller is told that nothing was found.
 */
export async function readChannelsIntoStore(input: {
  authorized: () => boolean;
  read: () => Promise<ChannelCatalogResolveResult>;
  commit: (channels: SerializedChannel[]) => void;
}): Promise<ChannelCatalogResolveResult> {
  const result = await input.read();
  if (!input.authorized()) return { protocolVersion: 1, channels: [], pathsByChannelId: {} };
  input.commit(result.channels);
  return result;
}

/**
 * Asks the Hub for a window's Channels nobody here knows, a read per `limit`
 * of them, and lists what it answers. A read that fails leaves the lists to
 * be read again. Both stand on the authorization that asked: once it has
 * ended, an answer lists nothing and a failure reads nothing.
 */
export function resolveWindowChannels(input: Omit<Parameters<typeof refreshSpaceCatalogForMessages>[0], "details" | "resolveMessageChannels"> & {
  unknown: readonly ChannelCatalogChangeDetail[];
  limit: number;
  authorized: () => boolean;
  /** Reads these Channels into the entity table and gives back those the Hub showed this reader. */
  resolve: (channelIds: string[]) => Promise<readonly SerializedChannel[]>;
}): Promise<void> {
  const { unknown, limit, authorized, resolve, ...lists } = input;
  const ids = [...new Set(unknown.map((detail) => detail.channelId!))];
  const reads = Array.from({ length: Math.ceil(ids.length / limit) }, (_, part) =>
    resolve(ids.slice(part * limit, (part + 1) * limit)));
  return Promise.all(reads).then((results) => {
    if (!authorized()) return;
    // What the Hub returned the reader may read: those join the conversation list as the rows they are.
    const resolved = new Map(results.flat().map((channel) => [channel.id, channel]));
    refreshSpaceCatalogForMessages({
      ...lists,
      details: unknown.filter((detail) => resolved.has(detail.channelId!)),
      hasChannel: () => true,
      channel: (channelId) => lists.channel?.(channelId) ?? resolved.get(channelId),
    });
  }, () => {
    if (!authorized()) return;
    refreshSpaceCatalogForMessages({ ...lists, details: [...unknown], hasChannel: () => true, channel: () => undefined });
  });
}

/**
 * Applies catalog changes at most once per window per Space: the first change
 * refreshes at once, the rest of the window is merged into one refresh at its
 * end. A Space with many working Agents would otherwise cancel and restart its
 * catalog read on every change and never finish one.
 */
export function createCatalogRefreshThrottle(
  apply: (spaceId: string, details: ChannelCatalogChangeDetail[]) => void,
  windowMs = CATALOG_REFRESH_WINDOW_MS,
) {
  const windows = new Map<string, { pending: ChannelCatalogChangeDetail[]; timer: ReturnType<typeof setTimeout> }>();
  const close = (spaceId: string) => {
    const open = windows.get(spaceId);
    windows.delete(spaceId);
    if (open?.pending.length) {
      apply(spaceId, coalesceCatalogChanges(open.pending));
      windows.set(spaceId, { pending: [], timer: setTimeout(() => close(spaceId), windowMs) });
    }
  };
  return {
    push(spaceId: string, detail: ChannelCatalogChangeDetail | undefined) {
      const open = windows.get(spaceId);
      if (open) {
        open.pending.push(detail ?? {});
        return;
      }
      apply(spaceId, [detail ?? {}]);
      windows.set(spaceId, { pending: [], timer: setTimeout(() => close(spaceId), windowMs) });
    },
    dispose() {
      for (const open of windows.values()) clearTimeout(open.timer);
      windows.clear();
    },
  };
}
