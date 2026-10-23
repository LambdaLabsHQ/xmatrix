import { appStoreConnect, appleResource, relatedId, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, appVersion, appVersionBuild, appVersionFields, appVersions, bundleId, compareVersions, EDITABLE_STATES, LOCALE, namedBuild,
  openSubmissions, platformRef, reviewDetail, textFieldProblem, versionAction, versionRef, versionState } from "./app-store-connect";
import { requireText } from "./common";
import { keyedOptions } from "./google-report";

/*
 * App Store Connect writes: the path from an uploaded build to the App Store.
 * `create_version` → `set_metadata` → `set_build` → `submit` → (App Review) →
 * `release`. Each step reads Apple's state first and is safe to repeat: a
 * version that exists is reported, an open draft submission is reused, and a
 * version already with App Review is left alone. Uploading the build itself
 * needs Xcode and stays on the machine that built it.
 *
 * App Review contact and sign-in details never pass through a Channel: a new
 * version takes them from the app's previous version, Apple to Apple.
 */

const REVIEW = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_METADATA_TEXT = 16_000;
const RELEASE_TYPES: Readonly<Record<string, string>> = { manual: "MANUAL", after_approval: "AFTER_APPROVAL" };
const METADATA_LIMITS: Readonly<Record<string, number>> = { description: 4_000, keywords: 100, promotionalText: 170, whatsNew: 4_000,
  supportUrl: 1_000, marketingUrl: 1_000, copyright: 200 };
const REVIEW_FIELDS = ["contactFirstName", "contactLastName", "contactEmail", "contactPhone", "demoAccountRequired", "demoAccountName",
  "demoAccountPassword", "notes"];

const versionPath = (version: AppleResource) => `/v1/appStoreVersions/${encodeURIComponent(version.id)}`;

/**
 * A version's phased release, if one was enabled. Apple has none until it is created, and the first
 * version of an app cannot have one. Creating it as INACTIVE makes the following release a 7-day rollout.
 */
async function phasedRelease(api: AppStoreConnectApi, version: AppleResource): Promise<AppleResource | undefined> {
  try {
    return appleResource((await api.request(`${versionPath(version)}/appStoreVersionPhasedRelease`)).data);
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return undefined;
    throw error;
  }
}

/** `day 3 of 7` when Apple reports a day of the rollout; anything else is left out. */
function phasedDay(row: AppleResource): string {
  const day = text(row.attributes.currentDayNumber);
  return /^[1-7]$/u.test(day) ? `, day ${day} of 7` : "";
}

const PHASED_MOVES: Readonly<Record<string, { from: ReadonlySet<string>; done: string; same: string; blocked: string }>> = {
  PAUSED: { from: new Set(["ACTIVE"]), done: "Paused", same: "already paused", blocked: "only an active phased release can be paused" },
  ACTIVE: { from: new Set(["PAUSED"]), done: "Resumed", same: "already rolling out", blocked: "only a paused phased release can be resumed" },
  COMPLETE: { from: new Set(["ACTIVE", "PAUSED"]), done: "Published", same: "already published to everyone",
    blocked: "only a phased release that has started can be published to everyone" },
};

/** Move a phased release that has started. Repeating the state it already has changes nothing. */
async function movePhasedRelease(api: AppStoreConnectApi, input: Record<string, string>, version: AppleResource, target: string): Promise<string> {
  const move = PHASED_MOVES[target]!;
  const current = await phasedRelease(api, version);
  if (!current) {
    throw new ProviderRequestError(404, `Version ${input.version} has no phased release. Release it with phased; the first version of an app cannot use one`);
  }
  const state = text(current.attributes.phasedReleaseState);
  if (state === target) return `The phased release of ${input.app} ${input.version} is ${move.same}${phasedDay(current)}.`;
  if (state === "INACTIVE") {
    throw new ProviderRequestError(409, `The phased release of ${input.version} has not started; it starts when the version is released`);
  }
  if (!move.from.has(state)) {
    throw new ProviderRequestError(409, `The phased release of ${input.version} is ${state || "unknown"}; ${move.blocked}`);
  }
  const updated = appleResource((await api.request(`/v1/appStoreVersionPhasedReleases/${encodeURIComponent(current.id)}`, { method: "PATCH",
    data: { type: "appStoreVersionPhasedReleases", id: current.id, attributes: { phasedReleaseState: target } } })).data) ?? current;
  const ending = target === "COMPLETE" ? " This cannot be undone." : "";
  return `${move.done} the phased release of ${input.app} ${input.version}; it is ${text(updated.attributes.phasedReleaseState) || target}${phasedDay(updated)}.${ending}`;
}

/** Give a new version the App Review contact and sign-in details of the newest earlier version that has them. */
async function inheritReviewDetail(api: AppStoreConnectApi, version: AppleResource, earlier: AppleResource[]): Promise<string> {
  if (await reviewDetail(api, version)) return "";
  const sources = earlier.filter(row => row.id !== version.id)
    .sort((a, b) => compareVersions(text(b.attributes.versionString), text(a.attributes.versionString))).slice(0, 5);
  for (const source of sources) {
    const detail = await reviewDetail(api, source);
    if (!detail || !text(detail.attributes.contactEmail)) continue;
    const attributes = Object.fromEntries(REVIEW_FIELDS.flatMap(field => detail.attributes[field] === undefined || detail.attributes[field] === null
      ? [] : [[field, detail.attributes[field]]]));
    try {
      await api.request("/v1/appStoreReviewDetails", { method: "POST", quiet: true, data: { type: "appStoreReviewDetails", attributes,
        relationships: { appStoreVersion: relation("appStoreVersions", version.id) } } });
    } catch (error) {
      /* The version exists either way; a refused copy must not read as a failed create. */
      if (!(error instanceof ProviderRequestError)) throw error;
      return " Its App Review contact details could not be copied; enter them in App Store Connect before submitting.";
    }
    return ` App Review contact and sign-in details were copied from ${text(source.attributes.versionString)}.`;
  }
  return " No earlier version has App Review contact details; enter them once in App Store Connect before submitting.";
}

/** Submit or cancel a review submission; answers the state Apple reports afterwards. */
async function patchSubmission(api: AppStoreConnectApi, submission: AppleResource, attributes: { submitted: true } | { canceled: true }): Promise<string> {
  return text(appleResource((await api.request(`/v1/reviewSubmissions/${encodeURIComponent(submission.id)}`, { method: "PATCH",
    data: { type: "reviewSubmissions", id: submission.id, attributes } })).data)?.attributes.state);
}

/**
 * A submission App Review rejected: its rejected items are marked resolved and it goes back to review, which is
 * what "Resubmit to App Review" does once the version has been edited. Apple takes no new items on such a
 * submission, and replying to the reviewer has no API.
 */
async function resubmit(api: AppStoreConnectApi, submission: AppleResource, items: AppleResource[], what: string): Promise<string> {
  const rejected = items.filter(item => text(item.attributes.state) === "REJECTED");
  try {
    for (const item of rejected) {
      await api.request(`/v1/reviewSubmissionItems/${encodeURIComponent(item.id)}`, { method: "PATCH",
        data: { type: "reviewSubmissionItems", id: item.id, attributes: { resolved: true } } });
    }
    const sent = await patchSubmission(api, submission, { submitted: true });
    return `Resubmitted ${what} to App Review with ${rejected.length} rejected item(s) marked resolved; the submission is ${sent || "accepted"}. ` +
      "If App Review asked a question, answer it in App Store Connect: replies have no API.";
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    throw new ProviderRequestError(error.status, `${error.message}. To start over instead, run cancel_submission and then submit`);
  }
}

/** `<version> {json}`: the listing fields to change, validated to Apple's limits before any call. */
function metadata(statement: { target: string; text: string }): Record<string, string> | string {
  const parsed = appVersionFields(statement,
    'name an app, a version and the fields to change: <com.example.app> <1.2.0> {"locale":"en-US","description":"…","keywords":"…","whatsNew":"…"}', MAX_METADATA_TEXT);
  if (typeof parsed === "string") return parsed;
  const { locale, ...fields } = parsed.fields;
  const names = Object.keys(fields);
  if (!names.length || names.some(name => !Object.hasOwn(METADATA_LIMITS, name))) {
    return `set at least one of ${Object.keys(METADATA_LIMITS).join(", ")}; locale names the language`;
  }
  const problem = names.map(name => textFieldProblem(name, fields[name], METADATA_LIMITS[name]!)).find(Boolean);
  if (problem) return problem;
  if (names.some(name => name !== "copyright") && (typeof locale !== "string" || !LOCALE.test(locale))) {
    return 'name the language of the listing text: "locale":"en-US"';
  }
  return { app: parsed.app, platform: parsed.platform, version: parsed.version, locale: typeof locale === "string" ? locale : "", fields: JSON.stringify(fields) };
}

export const APP_STORE_CONNECT_RELEASE_ACTIONS: Record<string, ConnectorAction> = {
  create_version: appAction("write", statement => {
    const usage = "name an app and the new version: <com.example.app> <1.2.0> [release=manual|after_approval]";
    const app = bundleId(statement.target);
    const [word = "", ...rest] = statement.text.trim().split(/\s+/u);
    const ref = versionRef(word), options = keyedOptions(rest.join(" "), ["release"], usage);
    if (!app || !ref || typeof options === "string") return usage;
    const release = RELEASE_TYPES[options.get("release") ?? "manual"];
    return release ? { app, ...ref, release } : usage;
  }, async ({ api, app, input }) => {
    const { rows } = await appVersions(api, app.id, input.platform);
    const existing = rows.find(row => text(row.attributes.versionString) === input.version);
    if (existing) return `Version ${input.version} of ${input.app} already exists (${versionState(existing)}).`;
    const editable = rows.filter(row => EDITABLE_STATES.has(versionState(row)));
    if (editable.length > 1) throw new ProviderRequestError(409, "More than one version is open for editing; settle them in App Store Connect first");
    const open = editable[0];
    if (open) {
      const from = text(open.attributes.versionString);
      if (compareVersions(from, input.version!) > 0) {
        throw new ProviderRequestError(409, `Version ${from} is open for editing; ${input.version} would be lower. Submit or remove ${from} first`);
      }
      /* Apple keeps one editable version per platform: the open one becomes the new version. */
      await api.request(versionPath(open), { method: "PATCH", data: { type: "appStoreVersions", id: open.id,
        attributes: { versionString: input.version, releaseType: input.release } } });
      return `Version ${from} of ${input.app} was still open (${versionState(open)}); it is now ${input.version}, release ${input.release}.` +
        await inheritReviewDetail(api, open, rows);
    }
    const created = appleResource((await api.request("/v1/appStoreVersions", { method: "POST", data: { type: "appStoreVersions",
      attributes: { platform: input.platform, versionString: input.version, releaseType: input.release },
      relationships: { app: relation("apps", app.id) } } })).data);
    if (!created) throw new ProviderRequestError(502, "App Store Connect did not return the new version");
    return `Created version ${input.version} of ${input.app} (${input.platform}), release ${input.release}.` + await inheritReviewDetail(api, created, rows);
  }),
  set_metadata: versionAction("write", metadata, async ({ api, input, version }) => {
    const { copyright, ...attributes } = JSON.parse(input.fields!) as Record<string, string>;
    const changed = Object.keys(attributes);
    if (changed.length) {
      const { rows } = await api.list(`${versionPath(version)}/appStoreVersionLocalizations`, { "fields[appStoreVersionLocalizations]": "locale", limit: "200" }, 1);
      const existing = rows.find(row => text(row.attributes.locale).toLowerCase() === input.locale!.toLowerCase());
      if (existing) {
        await api.request(`/v1/appStoreVersionLocalizations/${encodeURIComponent(existing.id)}`, { method: "PATCH",
          data: { type: "appStoreVersionLocalizations", id: existing.id, attributes } });
      } else {
        await api.request("/v1/appStoreVersionLocalizations", { method: "POST", data: { type: "appStoreVersionLocalizations",
          attributes: { locale: input.locale, ...attributes }, relationships: { appStoreVersion: relation("appStoreVersions", version.id) } } });
      }
    }
    if (copyright) await api.request(versionPath(version), { method: "PATCH", data: { type: "appStoreVersions", id: version.id, attributes: { copyright } } });
    return `Updated ${[...(changed.length ? [`${input.locale} ${changed.join(", ")}`] : []), ...(copyright ? ["copyright"] : [])].join(" and ")} ` +
      `of ${input.app} ${input.version}.`;
  }),
  set_build: versionAction("write", statement => {
    const parsed = appVersionBuild(statement);
    return parsed && !parsed.rest.length ? { app: parsed.app, platform: parsed.platform, version: parsed.version, build: parsed.build }
      : "name an app, a version and the build number to ship: <com.example.app> <1.2.0> <build number>";
  }, async ({ api, app, input, version }) => {
    if (!EDITABLE_STATES.has(versionState(version))) {
      throw new ProviderRequestError(409, `Version ${input.version} is ${versionState(version)}; its build can no longer change`);
    }
    const build = await namedBuild(api, app.id, input), processing = text(build.attributes.processingState);
    if (build.attributes.expired === true) throw new ProviderRequestError(409, `Build ${input.build} has expired; upload a new one`);
    if (processing !== "VALID") {
      throw new ProviderRequestError(409, processing === "PROCESSING" ? `Build ${input.build} is still processing; try again in a few minutes`
        : `Apple marked build ${input.build} ${processing || "unusable"}; upload a new one`);
    }
    await api.request(versionPath(version), { method: "PATCH", data: { type: "appStoreVersions", id: version.id,
      relationships: { build: relation("builds", build.id) } } });
    /* Read the relationship back: the version must carry exactly the build that was named. */
    const bound = appleResource((await api.request(`${versionPath(version)}/relationships/build`)).data);
    if (bound?.id !== build.id) throw new ProviderRequestError(502, "App Store Connect did not attach the build");
    return `Attached build ${input.build} to ${input.app} ${input.version}.` + (build.attributes.usesNonExemptEncryption === null ||
      build.attributes.usesNonExemptEncryption === undefined
      ? " The build does not declare export compliance; run declare_encryption, or Apple will ask before review." : "");
  }),
  submit: versionAction("write", appVersion, async ({ api, app, input, version, buildNumber }) => {
    const state = versionState(version);
    if (!EDITABLE_STATES.has(state)) return `Version ${input.version} of ${input.app} is already ${state}; nothing was submitted.`;
    if (!relatedId(version, "build")) throw new ProviderRequestError(409, `Version ${input.version} has no build; run set_build first`);
    const open = await openSubmissions(api, app.id, input.platform);
    if (open.length > 1) throw new ProviderRequestError(409, "More than one review submission is open; settle them in App Store Connect first");
    let submission: AppleResource | undefined = open[0];
    const submissionState = text(submission?.attributes.state);
    const rejected = submissionState === "UNRESOLVED_ISSUES";
    if (submission && !rejected && submissionState !== "READY_FOR_REVIEW") throw new ProviderRequestError(409, `Another review submission is ${submissionState}`);
    const items = submission ? (await api.list(`/v1/reviewSubmissions/${encodeURIComponent(submission.id)}/items`,
      { include: "appStoreVersion", limit: "200" }, 1)).rows : [];
    const versions = items.flatMap(item => relatedId(item, "appStoreVersion") ?? []);
    if (versions.some(id => id !== version.id)) {
      throw new ProviderRequestError(409, "The open submission holds another version; finish or cancel it in App Store Connect first");
    }
    if (submission && rejected) return resubmit(api, submission, items, `${input.app} ${input.version}`);
    submission ??= appleResource((await api.request("/v1/reviewSubmissions", { method: "POST", data: { type: "reviewSubmissions",
      attributes: { platform: input.platform }, relationships: { app: relation("apps", app.id) } } })).data);
    if (!submission) throw new ProviderRequestError(502, "App Store Connect did not return the review submission");
    if (!versions.length) {
      await api.request("/v1/reviewSubmissionItems", { method: "POST", data: { type: "reviewSubmissionItems", relationships: {
        reviewSubmission: relation("reviewSubmissions", submission.id), appStoreVersion: relation("appStoreVersions", version.id) } } });
    }
    const sent = await patchSubmission(api, submission, { submitted: true });
    const others = items.length - versions.length;
    return `Submitted ${input.app} ${input.version} (build ${buildNumber(version) || "attached"}) for App Review` +
      `${others > 0 ? ` with ${others} other item(s) of the draft` : ""}; the submission is ${sent || "accepted"}. ` +
      "Approval is Apple's decision; subscribe the channel to the app to hear the outcome.";
  }),
  cancel_submission: appAction("write", statement => {
    const app = bundleId(statement.target), platform = platformRef(statement.text.trim());
    return app && platform ? { app, platform } : "name an app, and its platform unless it is iOS: <com.example.app> [ios|macos|tvos|visionos]";
  }, async ({ api, app, input }) => {
    const open = await openSubmissions(api, app.id, input.platform);
    if (open.length !== 1) {
      throw new ProviderRequestError(409, open.length ? "More than one review submission is open; cancel the right one in App Store Connect"
        : `${input.app} has no open review submission`);
    }
    const after = await patchSubmission(api, open[0]!, { canceled: true });
    return `Canceled the ${text(open[0]!.attributes.state)} review submission of ${input.app}; it is now ${after || "canceling"}. ` +
      "The version can be edited and submitted again.";
  }),
  release: versionAction("write", statement => {
    const usage = "name an app and a version: <com.example.app> <1.2.0> [phased]";
    const app = bundleId(statement.target);
    const [word = "", flag, ...rest] = statement.text.trim().split(/\s+/u);
    const ref = versionRef(word);
    if (!app || !ref || rest.length || (flag && flag !== "phased")) return usage;
    return { app, ...ref, ...(flag ? { phased: "yes" } : {}) };
  }, async ({ api, input, version }) => {
    const state = versionState(version);
    if (state !== "PENDING_DEVELOPER_RELEASE") {
      throw new ProviderRequestError(409, `Version ${input.version} is ${state}; only an approved version waiting for developer release can be released`);
    }
    /* Enable the rollout before the release request: Apple starts an INACTIVE one when the version goes out. */
    let rollout = await phasedRelease(api, version);
    if (input.phased) {
      if (!rollout) {
        try {
          rollout = appleResource((await api.request("/v1/appStoreVersionPhasedReleases", { method: "POST", data: {
            type: "appStoreVersionPhasedReleases", attributes: { phasedReleaseState: "INACTIVE" },
            relationships: { appStoreVersion: relation("appStoreVersions", version.id) } } })).data);
        } catch (error) {
          if (!(error instanceof ProviderRequestError)) throw error;
          throw new ProviderRequestError(error.status, /first version/iu.test(error.message)
            ? `${error.message}. Phased release is only for an update, not the first version of an app` : error.message);
        }
        if (!rollout) throw new ProviderRequestError(502, "App Store Connect did not return the phased release");
      } else if (text(rollout.attributes.phasedReleaseState) !== "INACTIVE") {
        throw new ProviderRequestError(409, `Version ${input.version} already has a phased release (${text(rollout.attributes.phasedReleaseState)}); it cannot be enabled again`);
      }
    }
    await api.request("/v1/appStoreVersionReleaseRequests", { method: "POST", data: { type: "appStoreVersionReleaseRequests",
      relationships: { appStoreVersion: relation("appStoreVersions", version.id) } } });
    return rollout
      ? `Released ${input.app} ${input.version} to the App Store as a 7-day phased release. Apple publishes it to more users each day. ` +
        "pause_phased_release holds it, resume_phased_release continues it, and complete_phased_release publishes it to everyone. The release itself cannot be undone."
      : `Released ${input.app} ${input.version} to the App Store; Apple is publishing it. This cannot be undone.`;
  }),
  pause_phased_release: versionAction("write", appVersion, ({ api, input, version }) => movePhasedRelease(api, input, version, "PAUSED")),
  resume_phased_release: versionAction("write", appVersion, ({ api, input, version }) => movePhasedRelease(api, input, version, "ACTIVE")),
  complete_phased_release: versionAction("write", appVersion, ({ api, input, version }) => movePhasedRelease(api, input, version, "COMPLETE")),
  reply_review: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse(statement) {
      const reply = requireText(statement);
      return REVIEW.test(statement.target) && reply ? { review: statement.target, reply } : "name a review id from reviews and write the reply: <review id> <text>";
    },
    async execute({ credentials }, input) {
      await appStoreConnect(credentials).request("/v1/customerReviewResponses", { method: "POST", data: { type: "customerReviewResponses",
        attributes: { responseBody: input.reply }, relationships: { review: relation("customerReviews", input.review!) } } });
      return { summary: `Replied to App Store review ${input.review}; Apple publishes the reply after its own check, replacing any earlier one.` };
    },
  },
};
