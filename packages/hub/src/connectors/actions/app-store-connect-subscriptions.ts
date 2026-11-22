import { canonicalJsonStringify, sha256Hex } from "@xmatrix/protocol";
import { base64UrlDecode } from "../../index-shared";
import { appleResource, relatedId, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { base64UrlEncodeValue } from "../../relay-v2-primitives";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, appCursorStatement, bundleId, openSubmissions } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * Auto-renewable subscriptions and their App Review. Apple reviews a
 * subscription through a subscription version (API 4.4.1): each one, and its
 * group's, joins the app's draft review submission as an item, and `submit`
 * then sends the draft with the app version. An app's first subscriptions can
 * only be reviewed that way.
 */

const PRODUCT_ID = /^[A-Za-z0-9._-]{1,100}$/u;
const MAX_NAMED = 20;
/* The state Apple must report before a subscription can be submitted. */
const READY = "READY_TO_SUBMIT";
/* Only a version Apple has finished with needs a new one; any other is still in flight and is reused. */
const FINISHED: ReadonlySet<string> = new Set(["APPROVED", "ACCEPTED", "REPLACED_WITH_NEW_VERSION"]);
/* Apple names the version in flight when it refuses another, which the version list may not show. */
const IN_FLIGHT = /already an inflight version with id '([A-Za-z0-9-]{1,64})'/u;

/**
 * What Apple reviews through a version (API 4.4.1): where its versions are
 * listed, the version's type, how a new one names its parent, and the review
 * submission item that carries it.
 */
const VERSIONED = {
  subscriptions: { list: "/v1/subscriptions", versionType: "subscriptionVersions", parent: "subscription", item: "subscriptionVersion" },
  subscriptionGroups: { list: "/v1/subscriptionGroups", versionType: "subscriptionGroupVersions", parent: "subscriptionGroup", item: "subscriptionGroupVersion" },
  inAppPurchases: { list: "/v2/inAppPurchases", versionType: "inAppPurchaseVersions", parent: "inAppPurchase", item: "inAppPurchaseVersion" },
} as const;
export type VersionedKind = keyof typeof VERSIONED;

/**
 * The version of a product still in flight, created when there is none. A group Apple
 * already approved has nothing to review unless it was changed, which leaves a version of its own.
 */
async function pendingVersion(api: AppStoreConnectApi, kind: VersionedKind, id: string): Promise<AppleResource | undefined> {
  const { list, versionType, parent } = VERSIONED[kind];
  const { rows } = await api.listComplete(`${list}/${encodeURIComponent(id)}/versions`, { [`fields[${versionType}]`]: "state", limit: "50" });
  const pending = rows.find(row => !FINISHED.has(text(row.attributes.state)));
  if (pending) return pending;
  if (kind === "subscriptionGroups" && rows.some(row => text(row.attributes.state) === "APPROVED")) return undefined;
  const created = await api.request(`/v1/${versionType}`, { method: "POST", data: { type: versionType,
    relationships: { [parent]: relation(kind, id) } } })
    .then(response => appleResource(response.data), (error: unknown) => {
      const inFlight = error instanceof ProviderRequestError && error.status === 409 ? IN_FLIGHT.exec(error.message)?.[1] : undefined;
      if (!inFlight) throw error;
      return { type: versionType, id: inFlight, attributes: {} } as AppleResource;
    });
  if (!created) throw new ProviderRequestError(502, "App Store Connect did not return the new version");
  return created;
}

/**
 * Puts each product's pending version in the app's draft review submission once; the next
 * `submit` of an app version sends them to App Review with it.
 */
export async function addVersionsToDraft(api: AppStoreConnectApi, appId: string, products: ReadonlyArray<{ kind: VersionedKind; id: string }>) {
  const draft = await draftSubmission(api, appId);
  const keys = Object.values(VERSIONED).map(entry => entry.item);
  const items = (await api.listComplete(`/v1/reviewSubmissions/${encodeURIComponent(draft.id)}/items`,
    { "fields[reviewSubmissionItems]": keys.join(","), limit: "200" })).rows;
  const present = new Set(items.flatMap(item => keys.map(key => relatedId(item, key))).filter((id): id is string => Boolean(id)));
  const versions = await Promise.all(products.map(async ({ kind, id }) => ({ ...VERSIONED[kind], version: await pendingVersion(api, kind, id) })));
  for (const { item, versionType, version } of versions) {
    if (!version || present.has(version.id)) continue;
    await api.request("/v1/reviewSubmissionItems", { method: "POST", data: { type: "reviewSubmissionItems", relationships: {
      reviewSubmission: relation("reviewSubmissions", draft.id), [item]: relation(versionType, version.id) } } });
  }
}

/** The app's draft review submission on iOS, opened when there is none; one already sent is not changed. */
async function draftSubmission(api: AppStoreConnectApi, appId: string): Promise<AppleResource> {
  const existing = await inspectOpenDraft(api, appId);
  if (existing) return existing;
  const draft = appleResource((await api.request("/v1/reviewSubmissions", { method: "POST", data: { type: "reviewSubmissions",
    attributes: { platform: "IOS" }, relationships: { app: relation("apps", appId) } } })).data);
  if (!draft) throw new ProviderRequestError(502, "App Store Connect did not return the review submission");
  return draft;
}

/** An app and, optionally, the product ids to submit: what each submit_* action takes. */
export function productsStatement(statement: { target: string; text: string }): Record<string, string> | string {
  const app = bundleId(statement.target), named = statement.text.trim().split(/\s+/u).filter(Boolean);
  return app && named.length <= MAX_NAMED && named.every(id => PRODUCT_ID.test(id)) ? { app, products: named.join(" ") }
    : "name an app and, optionally, the product ids to submit (default: every one ready to submit): <com.example.app> [<product id> …]";
}

export interface CatalogProduct { id: string; productId: string; state: string }

interface FrozenProduct { id: string; productId: string; state: string }
interface FrozenDraftItem { kind: VersionedKind; id: string; versionId?: string }

interface SubmitReadyOptions<T extends CatalogProduct> {
  singular: string;
  plural: string;
  listAction: string;
  load: () => Promise<T[]>;
  draftItems: (chosen: T[]) => ReadonlyArray<{ kind: VersionedKind; id: string }>;
}

/** Read-only check of existing pending version for `kind`/`id` (no creation). */
async function existingPendingVersion(api: AppStoreConnectApi, kind: VersionedKind, id: string): Promise<AppleResource | undefined> {
  const { list, versionType } = VERSIONED[kind];
  const { rows } = await api.listComplete(`${list}/${encodeURIComponent(id)}/versions`, { [`fields[${versionType}]`]: "state", limit: "50" });
  return rows.find(row => !FINISHED.has(text(row.attributes.state)));
}

/** Check open review submissions without creating a draft; returns existing draft if present. */
async function inspectOpenDraft(api: AppStoreConnectApi, appId: string): Promise<AppleResource | undefined> {
  const open = await openSubmissions(api, appId, "IOS");
  if (open.length > 1) throw new ProviderRequestError(409, "More than one review submission is open; settle them in App Store Connect first");
  const state = text(open[0]?.attributes.state);
  if (open[0] && state !== "READY_FOR_REVIEW") throw new ProviderRequestError(409, `The open review submission is ${state}; wait for it or cancel it first`);
  return open[0];
}

function selectReadyProducts<T extends CatalogProduct>(rows: T[], input: Record<string, string>,
  options: Pick<SubmitReadyOptions<T>, "singular" | "plural" | "listAction">): T[] {
  const named = input.products ? input.products.split(" ") : [];
  const missing = named.filter(id => !rows.some(row => row.productId === id));
  if (missing.length) throw new ProviderRequestError(404, `${input.app} has no ${options.singular} ${missing.join(", ")}; ${options.listAction} lists them`);
  const chosen = named.length ? rows.filter(row => named.includes(row.productId)) : rows.filter(row => row.state === READY);
  const blocked = chosen.filter(row => row.state !== READY);
  if (blocked.length) {
    throw new ProviderRequestError(409, `Only ${READY} ${options.plural} can be submitted; ` +
      blocked.map(row => `${row.productId} is ${row.state}`).join(", "));
  }
  return chosen;
}

/**
 * Freeze exact chosen product and existing pending version identities before asking a Human
 * for approval. Prevents post-approval selection widening and enables idempotent replay
 * across partial writes.
 */
export async function prepareReadyProducts<T extends CatalogProduct>(api: AppStoreConnectApi, appId: string,
  input: Record<string, string>, options: SubmitReadyOptions<T>): Promise<Record<string, string>> {
  const rows = await options.load();
  const chosen = selectReadyProducts(rows, input, options);
  if (!chosen.length) {
    throw new ProviderRequestError(409, `No ${options.singular} of ${input.app} is ${READY}; nothing to approve.`);
  }
  await inspectOpenDraft(api, appId);
  const items = options.draftItems(chosen);
  const frozenItems: FrozenDraftItem[] = await Promise.all(items.map(async item => {
    const existing = await existingPendingVersion(api, item.kind, item.id);
    return existing ? { ...item, versionId: existing.id } : { ...item };
  }));
  const frozenProducts: FrozenProduct[] = chosen.map(row => ({ id: row.id, productId: row.productId, state: row.state }));
  const digest = await sha256Hex(canonicalJsonStringify({ appId, products: frozenProducts, items: frozenItems }));
  const preview: Record<string, string> = {
    app: `${input.app} (${appId})`,
    products: frozenProducts.map(row => `${row.productId} (${row.id})`).join(", "),
    versions: frozenItems.map(item => `${item.kind}:${item.id}${item.versionId ? `@${item.versionId}` : "@new"}`).join(", "),
    digest: digest.slice(0, 12),
  };
  return {
    ...input,
    appId,
    preparedProducts: canonicalJsonStringify(frozenProducts),
    preparedItems: canonicalJsonStringify(frozenItems),
    preparedDigest: digest,
    preview: JSON.stringify(preview),
  };
}

/** Validates named, ready, or frozen approved products from a complete catalog and adds their pending versions to the draft review submission. */
export async function submitReadyProducts<T extends CatalogProduct>(api: AppStoreConnectApi, appId: string, input: Record<string, string>,
  options: SubmitReadyOptions<T>): Promise<string> {
  if (input.preparedProducts) {
    let frozenProducts: FrozenProduct[];
    let frozenItems: FrozenDraftItem[];
    try {
      frozenProducts = JSON.parse(input.preparedProducts) as FrozenProduct[];
      frozenItems = JSON.parse(input.preparedItems ?? "[]") as FrozenDraftItem[];
    } catch {
      throw new ProviderRequestError(409, "The approved product snapshot is malformed; ask again");
    }
    const expectedDigest = await sha256Hex(canonicalJsonStringify({ appId: input.appId, products: frozenProducts, items: frozenItems }));
    if (input.appId !== appId || expectedDigest !== input.preparedDigest || !Array.isArray(frozenProducts) || !frozenProducts.length) {
      throw new ProviderRequestError(409, "The approved product snapshot no longer matches this app; ask again");
    }
    const rows = await options.load();
    const byId = new Map(rows.map(row => [row.id, row]));
    const openDraft = await inspectOpenDraft(api, appId);
    const keys = Object.values(VERSIONED).map(entry => entry.item);
    const present = openDraft
      ? new Set((await api.listComplete(`/v1/reviewSubmissions/${encodeURIComponent(openDraft.id)}/items`,
          { "fields[reviewSubmissionItems]": keys.join(","), limit: "200" })).rows
          .flatMap(item => keys.map(key => relatedId(item, key))).filter((id): id is string => Boolean(id)))
      : new Set<string>();
    for (const frozen of frozenProducts) {
      const live = byId.get(frozen.id);
      if (!live || live.productId !== frozen.productId) {
        throw new ProviderRequestError(409, `Approved ${options.singular} ${frozen.productId} (${frozen.id}) no longer matches the catalog; ask again`);
      }
      if (live.state !== READY) {
        // On partial-write replay a product whose version is already attached to the open draft is safe to skip;
        // any other state change after approval refuses before writing.
        const item = frozenItems.find(candidate => candidate.id === frozen.id);
        const pending = item ? await existingPendingVersion(api, item.kind, item.id) : undefined;
        if (!pending || !present.has(pending.id)) {
          throw new ProviderRequestError(409, `Approved ${options.singular} ${frozen.productId} is now ${live.state}; ask again`);
        }
      }
    }
    await addVersionsToDraft(api, appId, frozenItems.map(({ kind, id }) => ({ kind, id })));
    return `Added ${frozenProducts.map(row => row.productId).join(", ")} of ${input.app} to the draft review submission. ` +
      "Run submit for the app version to send them to App Review with it.";
  }
  const rows = await options.load();
  const chosen = selectReadyProducts(rows, input, options);
  if (!chosen.length) return `No ${options.singular} of ${input.app} is ${READY}; nothing was submitted.`;
  await addVersionsToDraft(api, appId, options.draftItems(chosen));
  return `Added ${chosen.map(row => row.productId).join(", ")} of ${input.app} to the draft review submission. ` +
    "Run submit for the app version to send them to App Review with it.";
}

interface SubscriptionReadCursor {
  groupCursor?: string;
  groupId?: string;
  groupName?: string;
  subCursor?: string;
}

function encodeSubCursor(state: SubscriptionReadCursor): string | undefined {
  const json = JSON.stringify(state);
  return json.length <= 900 ? base64UrlEncodeValue(json) : undefined;
}

function decodeSubCursor(token: string): SubscriptionReadCursor {
  let parsed: unknown;
  try { parsed = JSON.parse(base64UrlDecode(token)); } catch {
    throw new ProviderRequestError(400, "Invalid subscription pagination cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderRequestError(400, "Invalid subscription pagination cursor");
  }
  const row = parsed as Record<string, unknown>;
  const str = (key: string) => {
    const value = row[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 1400) {
      throw new ProviderRequestError(400, "Invalid subscription pagination cursor");
    }
    return value;
  };
  return { groupCursor: str("groupCursor"), groupId: str("groupId"), groupName: str("groupName"), subCursor: str("subCursor") };
}

async function subscriptions(api: AppStoreConnectApi, appId: string, complete: boolean, cursorToken?: string) {
  const fetchList = (path: string, query: Record<string, string>, cursor?: string) => complete
    ? api.listComplete(path, query, { incompleteMessage: "Apple returned more subscriptions than this action can inspect; no subscriptions were submitted" })
      .then(result => ({ ...result, incomplete: false, cursor: undefined as string | undefined }))
    : api.listPreview(path, query, cursor ? { cursor } : undefined);
  const subQuery = { "fields[subscriptions]": "productId,name,state,groupLevel,subscriptionPeriod", limit: "200" };
  let groupCursor: string | undefined;
  if (!complete && cursorToken) {
    const state = decodeSubCursor(cursorToken);
    if (state.groupId && state.subCursor) {
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(state.groupId)) {
        throw new ProviderRequestError(400, "Invalid subscription pagination cursor");
      }
      const list = await fetchList(`/v1/subscriptionGroups/${encodeURIComponent(state.groupId)}/subscriptions`, subQuery, state.subCursor);
      const rows = list.rows.map(row => ({ id: row.id, groupId: state.groupId!, group: state.groupName ?? state.groupId!,
        productId: text(row.attributes.productId), name: text(row.attributes.name), state: text(row.attributes.state) || "UNKNOWN",
        level: text(row.attributes.groupLevel), period: text(row.attributes.subscriptionPeriod) }));
      const nextCursor = list.cursor
        ? encodeSubCursor({ groupId: state.groupId, ...(state.groupName ? { groupName: state.groupName } : {}), subCursor: list.cursor,
            ...(state.groupCursor ? { groupCursor: state.groupCursor } : {}) })
        : state.groupCursor ? encodeSubCursor({ groupCursor: state.groupCursor }) : undefined;
      return { rows, incomplete: Boolean(list.incomplete || state.groupCursor), cursor: nextCursor };
    }
    if (!state.groupCursor) throw new ProviderRequestError(400, "Invalid subscription pagination cursor");
    groupCursor = state.groupCursor;
  }
  const groupList = await fetchList(`/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups`,
    { "fields[subscriptionGroups]": "referenceName", limit: "50" }, groupCursor);
  const groups = groupList.rows;
  const lists = await Promise.all(groups.map(group => fetchList(`/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions`, subQuery)));
  const rows = groups.flatMap((group, index) => lists[index]!.rows.map(row => ({ id: row.id, groupId: group.id, group: text(group.attributes.referenceName),
    productId: text(row.attributes.productId), name: text(row.attributes.name), state: text(row.attributes.state) || "UNKNOWN",
    level: text(row.attributes.groupLevel), period: text(row.attributes.subscriptionPeriod) })));
  const truncatedIndex = lists.findIndex(list => list.incomplete && list.cursor);
  const nextCursor = truncatedIndex >= 0
    ? encodeSubCursor({ groupId: groups[truncatedIndex]!.id, groupName: text(groups[truncatedIndex]!.attributes.referenceName),
        subCursor: lists[truncatedIndex]!.cursor!, ...(groupList.cursor ? { groupCursor: groupList.cursor } : {}) })
    : groupList.cursor ? encodeSubCursor({ groupCursor: groupList.cursor }) : undefined;
  return { rows, incomplete: Boolean(groupList.incomplete || lists.some(list => list.incomplete)), cursor: nextCursor };
}

const subscriptionSubmitOptions = (api: AppStoreConnectApi, appId: string) => ({
  singular: "subscription",
  plural: "subscriptions",
  listAction: "subscriptions",
  load: async () => (await subscriptions(api, appId, true)).rows,
  draftItems: (chosen: Awaited<ReturnType<typeof subscriptions>>["rows"]) => [
    ...[...new Set(chosen.map(row => row.groupId))].map(id => ({ kind: "subscriptionGroups" as const, id })),
    ...chosen.map(row => ({ kind: "subscriptions" as const, id: row.id })),
  ],
});

export const APP_STORE_CONNECT_SUBSCRIPTION_ACTIONS: Record<string, ConnectorAction> = {
  subscriptions: appAction("read", appCursorStatement,
    async ({ api, app, input }) => {
      const { rows, incomplete, cursor } = await subscriptions(api, app.id, false, input.cursor);
      const lines = rows.map(row => [cell(row.group), cell(row.productId), cell(row.name), cell(row.period), cell(row.level), cell(row.state)].join("\t"));
      return `Subscriptions of ${input.app}:\n` + quoteRetrievedText(lines.length
        ? ["group\tproduct id\tname\tperiod\tlevel\tstate", ...lines].join("\n") : "(none)") +
        (incomplete ? `\nApple returned more subscription groups or products; this list is incomplete.${cursor ? ` Continue with cursor:${cursor}` : ""}` : "");
    }),
  submit_subscriptions: appAction("write", productsStatement,
    async ({ api, app, input }) => submitReadyProducts(api, app.id, input, subscriptionSubmitOptions(api, app.id)),
    async ({ api, app, input }) => prepareReadyProducts(api, app.id, input, subscriptionSubmitOptions(api, app.id))),
};
