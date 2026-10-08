import { appendFileSync, readFileSync } from "node:fs";
import { appleClientFromEnv, AppleApiError } from "./app-store-connect.mjs";
import { runCliMain } from "./cli-entrypoint.mjs";

const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "REJECTED", "METADATA_REJECTED", "DEVELOPER_REJECTED", "READY_FOR_REVIEW"]);
const SUBMITTED = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);
const relation = (type, id) => ({ data: { type, id } });
const state = (row) => row.attributes.appVersionState ?? row.attributes.appStoreState;
const query = (values) => new URLSearchParams(values).toString();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateMetadata(metadata) {
  const allowed = ["bundleId", "copyright", "localizations"];
  if (!metadata || Object.keys(metadata).some((key) => !allowed.includes(key)) || metadata.bundleId !== "sh.xmatrix.app") {
    throw new Error("Invalid public App Store metadata schema.");
  }
  if (typeof metadata.copyright !== "string" || !metadata.copyright || !Array.isArray(metadata.localizations) || !metadata.localizations.length) {
    throw new Error("Missing public App Store metadata.");
  }
  const limits = { description: 4000, keywords: 100, promotionalText: 170, supportUrl: 1000, marketingUrl: 1000 };
  const locales = new Set();
  for (const entry of metadata.localizations) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4}){0,2}$/.test(entry.locale) || locales.has(entry.locale)) throw new Error("Invalid metadata locale.");
    locales.add(entry.locale);
    if (Object.keys(entry).some((key) => key !== "locale" && !(key in limits))) throw new Error("Unrecognized public metadata field.");
    for (const [key, limit] of Object.entries(limits)) {
      if (typeof entry[key] !== "string" || !entry[key].length || [...entry[key]].length > limit) throw new Error(`Invalid metadata field: ${key}.`);
    }
    for (const key of ["supportUrl", "marketingUrl"]) {
      let url;
      try { url = new URL(entry[key]); } catch { throw new Error("Invalid public metadata URL."); }
      if (url.protocol !== "https:" || url.hostname !== "xmatrix.sh" || url.username || url.password || url.search) throw new Error("Invalid public metadata URL.");
    }
  }
  return metadata;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export async function findBuild(api, { appId, version, buildNumber }) {
  const builds = await api.list(`/v1/builds?${query({ "filter[app]": appId, "filter[version]": buildNumber,
    "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": "IOS", limit: "200" })}`);
  if (builds.length > 1) throw new Error("Ambiguous Apple build identity.");
  const build = builds[0];
  if (build && build.attributes.version !== buildNumber) throw new Error("Apple returned a mismatched release build.");
  if (build && (build.attributes.expired || ["INVALID", "FAILED"].includes(build.attributes.processingState))) throw new Error("The exact release build is expired or invalid.");
  return build;
}

export async function resolveApp(api, bundleId) {
  const apps = await api.list(`/v1/apps?${query({ "filter[bundleId]": bundleId, limit: "200" })}`);
  if (apps.length !== 1 || apps[0].attributes.bundleId !== bundleId) throw new Error("Unable to identify the exact App Store app.");
  return apps[0].id;
}

export async function submitRelease(api, { appId, version, buildNumber, metadata, privateNotes = "", waitFor = wait, attempts = 60 }) {
  validateMetadata(metadata);
  let build;
  for (let attempt = 0; attempt < attempts; attempt++) {
    build = await findBuild(api, { appId, version, buildNumber });
    if (build?.attributes.processingState === "VALID") break;
    if (attempt + 1 < attempts) await waitFor(20_000);
  }
  if (build?.attributes.processingState !== "VALID") throw new Error("Apple build processing timed out; retry this release to reconcile.");

  const versions = await api.list(`/v1/apps/${appId}/appStoreVersions?${query({ "filter[platform]": "IOS", include: "build", limit: "200" })}`);
  let target = versions.find((row) => row.attributes.versionString === version);
  if (target && SUBMITTED.has(state(target))) {
    if (target.relationships?.build?.data?.id !== build.id) throw new Error("Submitted version has a different build; refusing replacement.");
    return { outcome: "already-submitted", version, buildNumber, state: state(target) };
  }
  if (versions.some((row) => row.id !== target?.id && ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE"].includes(state(row)))) {
    return { outcome: "deferred-existing-review", version, buildNumber };
  }
  const editable = versions.filter((row) => EDITABLE.has(state(row)));
  if (editable.length > 1 || (target && !EDITABLE.has(state(target)))) throw new Error("Ambiguous or non-editable App Store version.");
  target ??= editable[0];
  if (target && compareVersions(target.attributes.versionString, version) > 0) throw new Error("Refusing to downgrade an editable App Store version.");
  const submissions = await api.list(`/v1/reviewSubmissions?${query({ "filter[app]": appId, "filter[platform]": "IOS", limit: "200" })}`);
  const active = submissions.filter((row) => row.attributes.state !== "COMPLETE");
  if (active.length > 1) throw new Error("Multiple active review submissions require reconciliation.");
  let submission = active[0];
  if (submission && !["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"].includes(submission.attributes.state)) {
    return { outcome: "deferred-existing-review", version, buildNumber };
  }
  const items = submission ? await api.list(`/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=200`) : [];
  if (items.length > 1 || items.some((item) => !target || item.relationships?.appStoreVersion?.data?.id !== target.id)) {
    throw new Error("Review submission contains unrelated items; refusing changes.");
  }
  if (submission?.attributes.state === "UNRESOLVED_ISSUES") {
    return { outcome: "deferred-review-response-required", version, buildNumber };
  }
  // Contact/login facts stay at Apple. Never read them from public metadata.
  // New-version creation requires an existing review configuration to inherit.
  const source = target ?? versions.find((row) => SUBMITTED.has(state(row)));
  if (!source) throw new Error("Configure the first App Store version and private review details at Apple before enabling submission.");
  const review = (await api.request(`/v1/appStoreVersions/${source.id}/appStoreReviewDetail`)).data;
  const details = review.attributes;
  const notes = privateNotes ? `${privateNotes}\n\nRelease: ${version} (${buildNumber}).` : details.notes;
  if (typeof notes !== "string" || !notes.trim() || notes.length > 4000) throw new Error("Private App Review notes are missing or exceed Apple's limit.");
  for (const field of ["contactFirstName", "contactLastName", "contactEmail", "contactPhone"]) {
    if (!details[field]) throw new Error("Private App Review contact information is incomplete.");
  }
  if (details.demoAccountRequired && (!details.demoAccountName || !details.demoAccountPassword)) throw new Error("Private App Review sign-in information is incomplete.");

  if (!target) {
    target = (await api.request("/v1/appStoreVersions", "POST", {
      type: "appStoreVersions", attributes: { platform: "IOS", versionString: version, releaseType: "MANUAL", copyright: metadata.copyright },
      relationships: { app: relation("apps", appId), build: relation("builds", build.id) },
    })).data;
  } else {
    await api.request(`/v1/appStoreVersions/${target.id}`, "PATCH", {
      type: "appStoreVersions", id: target.id,
      attributes: { versionString: version, copyright: metadata.copyright },
      relationships: { build: relation("builds", build.id) },
    });
  }
  const localizations = await api.list(`/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=200`);
  for (const entry of metadata.localizations) {
    const existing = localizations.find((row) => row.attributes.locale === entry.locale);
    const attributes = { ...entry };
    if (existing) {
      delete attributes.locale;
      await api.request(`/v1/appStoreVersionLocalizations/${existing.id}`, "PATCH", { type: "appStoreVersionLocalizations", id: existing.id, attributes });
    } else {
      await api.request("/v1/appStoreVersionLocalizations", "POST", { type: "appStoreVersionLocalizations", attributes,
        relationships: { appStoreVersion: relation("appStoreVersions", target.id) } });
    }
  }
  let targetReview;
  try { targetReview = (await api.request(`/v1/appStoreVersions/${target.id}/appStoreReviewDetail`)).data; }
  catch (error) { if (!(error instanceof AppleApiError) || error.status !== 404) throw error; }
  if (targetReview) {
    await api.request(`/v1/appStoreReviewDetails/${targetReview.id}`, "PATCH", { type: "appStoreReviewDetails", id: targetReview.id, attributes: { notes } });
  } else {
    const attributes = { notes };
    for (const field of ["contactFirstName", "contactLastName", "contactEmail", "contactPhone", "demoAccountRequired", "demoAccountName", "demoAccountPassword"]) {
      if (details[field] !== undefined) attributes[field] = details[field];
    }
    await api.request("/v1/appStoreReviewDetails", "POST", { type: "appStoreReviewDetails", attributes,
      relationships: { appStoreVersion: relation("appStoreVersions", target.id) } });
  }
  // Read the relationship back before submitting; never use Apple's latest build.
  const bound = (await api.request(`/v1/appStoreVersions/${target.id}/relationships/build`)).data;
  if (bound?.id !== build.id) throw new Error("App Store build binding verification failed.");
  if (!submission) {
    submission = (await api.request("/v1/reviewSubmissions", "POST", { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: relation("apps", appId) } })).data;
  }
  if (!items.length) {
    await api.request("/v1/reviewSubmissionItems", "POST", { type: "reviewSubmissionItems", relationships: {
      reviewSubmission: relation("reviewSubmissions", submission.id), appStoreVersion: relation("appStoreVersions", target.id),
    } });
  }
  await api.request(`/v1/reviewSubmissions/${submission.id}`, "PATCH", { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } });
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = (await api.request(`/v1/reviewSubmissions/${submission.id}`)).data;
    if (["WAITING_FOR_REVIEW", "IN_REVIEW", "COMPLETE"].includes(current.attributes.state)) return { outcome: "submitted", version, buildNumber, state: current.attributes.state };
    if (attempt < 5) await waitFor(5000);
  }
  throw new Error("Apple submission receipt is not yet confirmed; rerun to reconcile.");
}

await runCliMain(import.meta.url, async () => {
  let metadata;
  try { metadata = JSON.parse(readFileSync(new URL("../apps/ios/app-store/metadata.json", import.meta.url), "utf8")); }
  catch { throw new Error("Unable to load public App Store metadata."); }
  validateMetadata(metadata);
  const mode = process.argv[2];
  if (mode === "validate") { console.log("Public App Store metadata is valid."); return; }
  const env = process.env;
  const version = JSON.parse(readFileSync(new URL("../version.json", import.meta.url), "utf8")).version;
  if (!["check-upload", "submit"].includes(mode) || env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== `refs/tags/xmatrix-v${version}` || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || !/^\d{1,18}$/.test(env.IOS_BUILD_NUMBER ?? "")) {
    throw new Error("App Store automation requires an immutable production release context.");
  }
  const api = appleClientFromEnv(env);
  const appId = await resolveApp(api, metadata.bundleId);
  const args = { appId, version, buildNumber: env.IOS_BUILD_NUMBER };
  if (mode === "check-upload") {
    const build = await findBuild(api, args);
    appendFileSync(env.GITHUB_OUTPUT, `upload_required=${!build}\n`);
    console.log(build ? "Exact release build already exists; upload will be reused." : "Exact release build requires upload.");
    return;
  }
  const result = await submitRelease(api, { ...args, metadata, privateNotes: env.ASC_REVIEW_NOTES ?? "" });
  // Only these allowlisted, non-secret fields are persisted publicly.
  console.log(JSON.stringify(result));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\nApp Store: **${result.outcome}** — ${version} (${env.IOS_BUILD_NUMBER})${result.state ? `, ${result.state}` : ""}.\n`);
});
