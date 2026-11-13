import { PACKAGE_NAME, play, playApps, playRequest } from "../google-play-api";
import { record, text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionStatement } from "../provider";
import { jsonFields } from "./app-store-connect";
import { GOOGLE_PLAY_OPERATION_ACTIONS, playOutput } from "./google-play-operations";

/*
 * The release loop that fastlane supply and Gradle Play Publisher run, as two
 * actions: read every track, and put version codes on a track and commit.
 * Bytes reach Google through api_upload; everything else stays in the catalog.
 */

const EDIT_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const RELEASE_FIELDS = ["track", "versionCodes", "status", "userFraction", "name", "releaseNotes", "inAppUpdatePriority", "changesNotSentForReview"];

function app(statement: ConnectorActionStatement): { packageName: string; editId?: string } | undefined {
  const [packageName = "", editId, extra] = statement.target.split("/");
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 150 || extra !== undefined || (editId !== undefined && !EDIT_ID.test(editId))) return undefined;
  return { packageName, ...(editId ? { editId } : {}) };
}

const STANDARD_TRACKS = ["production", "beta", "alpha", "internal"];
const TRACK = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/u;

function releaseRequest(statement: ConnectorActionStatement): Record<string, string> | string {
  const target = app(statement);
  const fields = jsonFields(statement.text.trim());
  if (!target || !fields) return 'use <package>[/<editId>] {"track":"internal","versionCodes":["42"],"status":"completed"}';
  if (Object.keys(fields).some(key => !RELEASE_FIELDS.includes(key))) return `options are ${RELEASE_FIELDS.join(", ")}`;
  if (typeof fields.track !== "string" || !Array.isArray(fields.versionCodes) ||
    fields.versionCodes.some(code => !/^[1-9]\d{0,9}$/u.test(String(code)))) return "track and versionCodes (positive integers) are required";
  if (fields.changesNotSentForReview !== undefined && typeof fields.changesNotSentForReview !== "boolean") return "changesNotSentForReview must be true or false";
  const { track, changesNotSentForReview, ...release } = fields;
  const body = { track, releases: [{ status: "completed", ...release, versionCodes: (fields.versionCodes as unknown[]).map(String) }] };
  try { playRequest("edits.tracks.update", { path: { packageName: target.packageName, editId: "e", track }, body }); }
  catch (error) { return error instanceof Error ? error.message : "invalid release"; }
  return { ...target, track, body: JSON.stringify(body), ...(changesNotSentForReview ? { changesNotSentForReview: "true" } : {}) };
}

const PRODUCT_ID = /^[a-z0-9][a-z0-9_.]{0,39}$/u;
const BASE_PLAN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** `<package>/<subscription>/<base plan> {"period":"P1M","region":"US","price":{"currencyCode":"USD","units":"10"},"activate":true}` */
function basePlanRequest(statement: ConnectorActionStatement): Record<string, string> | string {
  const [packageName = "", productId = "", basePlanId = "", extra] = statement.target.split("/");
  const fields = jsonFields(statement.text.trim());
  if (!PACKAGE_NAME.test(packageName) || !PRODUCT_ID.test(productId) || !BASE_PLAN_ID.test(basePlanId) || extra !== undefined || !fields) {
    return 'use <package>/<subscription id>/<base plan id> {"period":"P1M","region":"US","price":{"currencyCode":"USD","units":"10"}}';
  }
  if (Object.keys(fields).some(key => !["period", "region", "price", "activate"].includes(key))) return "options are period, region, price, activate";
  if (typeof fields.region !== "string" || !/^[A-Z]{2}$/u.test(fields.region)) return "region is the two-letter region the price is for, such as US; it keeps exactly that price";
  if (typeof fields.period !== "string" || !/^P(?:1W|[1-9]\d?M|1Y)$/u.test(fields.period)) return "period is an ISO 8601 billing period such as P1W, P1M, P3M or P1Y";
  if (fields.activate !== undefined && typeof fields.activate !== "boolean") return "activate must be true or false";
  try { playRequest("monetization.convertRegionPrices", { path: { packageName }, body: { price: fields.price } }); }
  catch (error) { return error instanceof Error ? error.message : "invalid price"; }
  const price = record(fields.price);
  if (!/^[A-Z]{3}$/u.test(text(price.currencyCode)) || !/^[1-9]\d{0,8}$|^0$/u.test(text(price.units))) return "price needs currencyCode and units (whole currency units as text), with optional nanos";
  return { packageName, productId, basePlanId, period: fields.period, region: fields.region, price: JSON.stringify(fields.price), ...(fields.activate ? { activate: "true" } : {}) };
}

export const GOOGLE_PLAY_ACTIONS: Record<string, ConnectorAction> = {
  ...GOOGLE_PLAY_OPERATION_ACTIONS,
  list_apps: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.target === "*" && /^[A-Za-z0-9_=-]{0,2000}$/u.test(statement.text.trim())
      ? { pageToken: statement.text.trim() } : "use @googleplay:list_apps:* [pageToken]",
    async execute({ credentials }, input) {
      const { apps, nextPageToken } = await playApps(credentials, input.pageToken || undefined);
      return { summary: `${apps.length} app${apps.length === 1 ? "" : "s"} this sign-in can see${nextPageToken ? ` (more: pass pageToken ${nextPageToken})` : ""}:\n${playOutput(apps)}` };
    },
  },
  tracks: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => {
      const target = app(statement), named = statement.text.trim().split(/\s+/u).filter(Boolean);
      if (!target || named.length > 10 || named.some(track => !TRACK.test(track)) || (target.editId && named.length)) {
        return "use @googleplay:tracks:<package name> [custom track…], or <package name>/<editId> to read inside your own edit";
      }
      return { ...target, tracks: JSON.stringify([...new Set([...STANDARD_TRACKS, ...named])]) };
    },
    /*
     * A Google account has one open edit: opening another deletes the one somebody is uploading into. So a read
     * never opens an edit. It reads each track's releases directly, or the edit the caller names.
     */
    async execute({ credentials }, input) {
      const packageName = input.packageName!;
      if (input.editId) {
        const listed = await play(credentials, "edits.tracks.list", { path: { packageName, editId: input.editId } });
        const rows = (Array.isArray(listed.tracks) ? listed.tracks : []).map(record).map(track => ({ track: track.track,
          releases: (Array.isArray(track.releases) ? track.releases : []).map(record).map(release => ({ name: release.name, status: release.status,
            versionCodes: release.versionCodes, ...(release.userFraction === undefined ? {} : { userFraction: release.userFraction }) })) }));
        return { summary: `${packageName} tracks as edit ${input.editId} holds them:\n${playOutput(rows)}` };
      }
      const rows = await Promise.all((JSON.parse(input.tracks!) as string[]).map(async track => {
        const listed = await play(credentials, "applications.tracks.releases.list", { path: { parent: `applications/${packageName}/tracks/${track}` } });
        return { track, releases: (Array.isArray(listed.releases) ? listed.releases : []).map(record).map(release => ({ name: release.releaseName,
          state: text(release.releaseLifecycleState).replace("RELEASE_LIFECYCLE_STATE_", ""),
          versionCodes: (Array.isArray(release.activeArtifacts) ? release.activeArtifacts : []).map(artifact => record(artifact).versionCode) })) };
      }));
      return { summary: `${packageName} releases per track (no edit opened; name a custom track to include it):\n${playOutput(rows)}` };
    },
  },
  base_plans: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => {
      const [packageName = "", productId = "", extra] = statement.target.split("/"), region = statement.text.trim() || "US";
      return PACKAGE_NAME.test(packageName) && PRODUCT_ID.test(productId) && extra === undefined && /^[A-Z]{2}$/u.test(region)
        ? { packageName, productId, region } : "use <package>/<subscription id> [two-letter region, default US]";
    },
    async execute({ credentials }, input) {
      const subscription = await play(credentials, "monetization.subscriptions.get", { path: { packageName: input.packageName!, productId: input.productId! } });
      const plans = (Array.isArray(subscription.basePlans) ? subscription.basePlans : []).map(record).map(plan => {
        const regions = (Array.isArray(plan.regionalConfigs) ? plan.regionalConfigs : []).map(record);
        const kind = ["autoRenewingBasePlanType", "prepaidBasePlanType", "installmentsBasePlanType"].find(key => plan[key] !== undefined);
        return { basePlanId: plan.basePlanId, state: plan.state, ...(kind ? { type: kind.replace("BasePlanType", ""), period: record(plan[kind]).billingPeriodDuration } : {}),
          regions: regions.length, [input.region!]: regions.find(region => region.regionCode === input.region)?.price ?? "not sold in this region" };
      });
      return { summary: `${input.productId} has ${plans.length} base plan${plans.length === 1 ? "" : "s"}, as Google Play stores them (price shown for ${input.region}):\n${playOutput(plans)}` };
    },
  },
  base_plan: {
    effect: "write", requires: ["oauthToken"], parse: basePlanRequest,
    async execute(context, input) {
      const { credentials } = context, packageName = input.packageName!, productId = input.productId!, basePlanId = input.basePlanId!;
      const path = { packageName, productId };
      const subscription = await play(credentials, "monetization.subscriptions.get", { path });
      const existing = (Array.isArray(subscription.basePlans) ? subscription.basePlans : []).map(record);
      if (existing.some(plan => plan.basePlanId === basePlanId)) {
        throw new ProviderRequestError(409, `${productId} already has base plan ${basePlanId}; change it with api_plan and api_write`);
      }
      // Google converts the one price to every region it sells in, at its current rates and local price patterns.
      // That pattern also rounds the price's own region (10.00 becomes 9.99), so that region keeps the stated price.
      const price = JSON.parse(input.price!) as Record<string, unknown>;
      const converted = await play(credentials, "monetization.convertRegionPrices", { path: { packageName }, body: { price } });
      const regions = Object.values(record(converted.convertedRegionPrices)).map(record).filter(region => /^[A-Z]{2}$/u.test(text(region.regionCode)))
        .map(region => region.regionCode === input.region ? { ...region, price } : region);
      const home = regions.find(region => region.regionCode === input.region);
      if (!home || text(record(record(record(converted.convertedRegionPrices)[input.region!]).price).currencyCode) !== price.currencyCode) {
        throw new ProviderRequestError(400, `${input.region} is not a region Google Play sells in with ${text(price.currencyCode)}; name the region the price is for`);
      }
      const version = text(record(converted.regionVersion).version), other = record(converted.convertedOtherRegionsPrice);
      if (!regions.length || !version || !other.usdPrice || !other.eurPrice) throw new ProviderRequestError(502, "Google Play did not return converted region prices");
      const plan = { basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: input.period! },
        regionalConfigs: regions.map(region => ({ regionCode: region.regionCode, newSubscriberAvailability: true, price: region.price })),
        otherRegionsConfig: { usdPrice: other.usdPrice, eurPrice: other.eurPrice, newSubscriberAvailability: true } };
      await context.authorizeWrite?.();
      await play(credentials, "monetization.subscriptions.patch", { path, query: { updateMask: "basePlans", "regionsVersion.version": version },
        body: { packageName, productId, basePlans: [...existing.map(({ state: _state, ...kept }) => kept), plan] } });
      const activated = input.activate ? await play(credentials, "monetization.subscriptions.basePlans.activate",
        { path: { ...path, basePlanId }, body: { packageName, productId, basePlanId } }) : undefined;
      const state = activated ? text(record((Array.isArray(activated.basePlans) ? activated.basePlans : []).map(record).find(item => item.basePlanId === basePlanId)).state) : "DRAFT";
      return { summary: `Google Play saved base plan ${basePlanId} on ${productId}: ${input.period}, ${state || "saved"}, priced in ${regions.length} regions (regions version ${version}).\n` +
        playOutput({ [text(home.regionCode)]: home.price, otherRegions: plan.otherRegionsConfig }) +
        "\nRead monetization.subscriptions.get to see every regional price." };
    },
  },
  release: {
    effect: "write", requires: ["oauthToken"], parse: releaseRequest,
    async execute(context, input) {
      const { credentials } = context, packageName = input.packageName!;
      await context.authorizeWrite?.();
      const opened = !input.editId;
      const editId = input.editId ?? text((await play(credentials, "edits.insert", { path: { packageName }, body: {} })).id);
      if (!EDIT_ID.test(editId)) throw new ProviderRequestError(502, "Google Play did not open an edit");
      try {
        const track = await play(credentials, "edits.tracks.update", { path: { packageName, editId, track: input.track! }, body: JSON.parse(input.body!) });
        const committed = await play(credentials, "edits.commit", { path: { packageName, editId },
          ...(input.changesNotSentForReview ? { query: { changesNotSentForReview: true } } : {}) });
        return { summary: `Google Play committed edit ${text(committed.id) || editId}: ${input.track} now has\n${playOutput(track.releases)}\nRun tracks to see the published state.` };
      } catch (error) {
        // An edit this action opened is discarded on failure; a caller's edit stays for them to inspect.
        if (opened) await play(credentials, "edits.delete", { path: { packageName, editId } }).catch(() => undefined);
        throw error;
      }
    },
  },
};
