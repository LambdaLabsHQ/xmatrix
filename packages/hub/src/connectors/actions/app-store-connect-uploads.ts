import { appStoreConnect, appleResource, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { record, text } from "../event-format";
import { isPublicHttpsUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, appVersionBuild, bundleId, namedBuild } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * Files reach Apple in three steps: a reservation here, the bytes from the
 * machine that has the file straight to Apple's storage, and a commit here.
 * The reservation's receipt lists each part's method, URL and headers. Those
 * URLs are Apple's own time-limited capability for exactly this one file, so
 * the uploader needs no API key and the bytes never pass through the Hub.
 *
 * A build uploaded this way needs no `altool`, Transporter or key on the build
 * machine. Apple processes it after the commit and reports the result as the
 * build upload's state, with the errors it would otherwise only email.
 */

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}$/u;
const RESOURCE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_FILE_BYTES = 8 * 1024 ** 3;
const MAX_PLAN_CHARACTERS = 10_000;
const BUILD_UTI: Readonly<Record<string, string>> = { ".ipa": "com.apple.ipa", ".pkg": "com.apple.pkg" };

/**
 * What can be uploaded, by the word a statement names it with. An upload is known by one id throughout: the build
 * upload's, or the library image's. A build keeps its bytes in a file resource of its own, found from the upload.
 */
const UPLOADS: Readonly<Record<string, { root: string; what: string; next: string }>> = {
  build: { root: "/v1/buildUploads", what: "build upload",
    next: "Apple now processes the build: a subscribed channel hears when it finishes, and build_uploads shows what Apple found." },
  image: { root: "/v1/appAssetLibraryImages", what: "image",
    next: "Apple now processes the image; once read_upload shows PREPARE_FOR_SUBMISSION, place it with set_screenshots." },
};
const FILE_TYPES: ReadonlySet<string> = new Set(["buildUploadFiles", "appAssetLibraryImages"]);

/** `<file name> <size in bytes>`: the two facts Apple reserves an upload by. */
export function fileRef(words: string[]): { fileName: string; fileSize: string } | undefined {
  const size = words.at(-1) ?? "", fileName = words.slice(0, -1).join(" ");
  return FILE_NAME.test(fileName) && /^[1-9]\d{0,12}$/u.test(size) && Number(size) <= MAX_FILE_BYTES ? { fileName, fileSize: size } : undefined;
}

/**
 * The parts still to send, one JSON object per line, from `from` on. Apple's values are checked before they are
 * shown: a part names a public https URL and plain header lines, or the whole plan is refused.
 */
export function uploadPlan(resource: AppleResource, from = 1): { lines: string[]; total: number; next?: number } {
  const operations = (Array.isArray(resource.attributes.uploadOperations) ? resource.attributes.uploadOperations : []).map(record);
  const lines: string[] = [];
  let size = 0;
  for (let part = Math.max(from, 1); part <= operations.length; part += 1) {
    const operation = operations[part - 1]!;
    const headers = (Array.isArray(operation.requestHeaders) ? operation.requestHeaders : []).map(record);
    const offset = Number(operation.offset), length = Number(operation.length);
    /* The URL is shown exactly as Apple signed it; reformatting it would break the signature. */
    const url = text(operation.url);
    if (!URL.canParse(url) || !isPublicHttpsUrl(new URL(url)) || /\s/u.test(url) || !/^[A-Z]{3,6}$/u.test(text(operation.method)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 ||
        headers.some(header => !/^[A-Za-z0-9-]{1,64}$/u.test(text(header.name)) || /[\r\n]/u.test(text(header.value)) || text(header.value).length > 1_000)) {
      throw new ProviderRequestError(502, "App Store Connect returned an upload part this connector cannot describe safely");
    }
    const line = JSON.stringify({ part, method: text(operation.method), url, offset, length,
      headers: Object.fromEntries(headers.map(header => [text(header.name), text(header.value)])) });
    if (lines.length && size + line.length > MAX_PLAN_CHARACTERS) return { lines, total: operations.length, next: part };
    lines.push(line);
    size += line.length;
  }
  return { lines, total: operations.length };
}

/** What to do with a reserved file's parts; `id` is the upload's id, which every later statement names. */
export function planText(kind: string, id: string, file: AppleResource, from = 1): string {
  const plan = uploadPlan(file, from);
  if (!plan.total) return `Apple lists no parts left to upload for this ${UPLOADS[kind]!.what}.`;
  return `Send each part's bytes (offset and length are in bytes) with its method, URL and headers, and no Authorization header; ` +
    `then run @appstoreconnect:commit_upload:${id} ${kind}. The URLs expire and are for this file only.\n` + quoteRetrievedText(plan.lines.join("\n")) +
    (plan.next ? `\nParts ${plan.next}-${plan.total} are not shown; run @appstoreconnect:read_upload:${id} ${kind} ${plan.next}.` : "");
}

/** `<id> <kind> […]`: an upload this connector reserved, named by its id and what it is. */
function uploadRef(statement: { target: string; text: string }, extra: (words: string[]) => Record<string, string> | undefined): Record<string, string> | string {
  const [kind = "", ...rest] = statement.text.trim().split(/\s+/u).filter(Boolean);
  const more = extra(rest);
  return RESOURCE_ID.test(statement.target) && Object.hasOwn(UPLOADS, kind) && more ? { id: statement.target, kind, ...more }
    : `name the upload's id and what it is (${Object.keys(UPLOADS).join(" or ")}): <id> <${Object.keys(UPLOADS).join("|")}>`;
}

/** The upload and the resource that carries its parts: the image itself, or the build upload's binary file. */
async function uploadFile(api: AppStoreConnectApi, kind: string, id: string): Promise<{ upload: AppleResource; file: AppleResource }> {
  const root = `${UPLOADS[kind]!.root}/${encodeURIComponent(id)}`;
  const upload = appleResource((await api.request(root)).data);
  const file = kind === "build" ? (await api.list(`${root}/buildUploadFiles`, { limit: "10" }, 1)).rows.find(row => row.attributes.assetType === "ASSET") : upload;
  if (!upload || !file || !FILE_TYPES.has(file.type)) throw new ProviderRequestError(404, `App Store Connect has no ${UPLOADS[kind]!.what} ${id} with a file to upload`);
  return { upload, file };
}

/** Apple's verdict on an upload: its state and what it found, in Apple's own codes and words. */
function stateLines(state: unknown): string[] {
  const value = record(state);
  const details = (kind: string) => (Array.isArray(value[kind]) ? value[kind] : []).map(record)
    .map(detail => `  ${kind.slice(0, -1)} ${cell(detail.code)}: ${cell(detail.description)}`);
  return [cell(value.state) || "UNKNOWN", ...details("errors"), ...details("warnings"), ...details("infos")];
}

/** The same verdict for a reserved file: a build file carries a delivery state, a library asset its own state and matched size. */
function uploadState(resource: AppleResource | undefined): string[] {
  const attributes = resource?.attributes ?? {};
  if (record(attributes.assetDeliveryState).state) return stateLines(attributes.assetDeliveryState);
  const size = record(attributes.imageAsset);
  return [...stateLines({ state: attributes.state, infos: attributes.stateDetails }), ...(size.width && size.height ? [`  size ${cell(size.width)}x${cell(size.height)}`] : [])];
}

export const APP_STORE_CONNECT_UPLOAD_ACTIONS: Record<string, ConnectorAction> = {
  upload_build: appAction("write", statement => {
    const parsed = appVersionBuild(statement), file = parsed && fileRef(parsed.rest);
    const uti = file && BUILD_UTI[file.fileName.slice(file.fileName.lastIndexOf(".")).toLowerCase()];
    return parsed && file && uti ? { app: parsed.app, platform: parsed.platform, version: parsed.version, build: parsed.build, ...file, uti }
      : "name an app, the version and build number inside the file, the .ipa or .pkg file's name and its size in bytes: <com.example.app> <1.2.0> <412> <App.ipa> <48211034>";
  }, async ({ api, app, input }) => {
    const upload = appleResource((await api.request("/v1/buildUploads", { method: "POST", data: { type: "buildUploads",
      attributes: { cfBundleShortVersionString: input.version, cfBundleVersion: input.build, platform: input.platform },
      relationships: { app: relation("apps", app.id) } } })).data);
    if (!upload) throw new ProviderRequestError(502, "App Store Connect did not return the build upload");
    const file = appleResource((await api.request("/v1/buildUploadFiles", { method: "POST", data: { type: "buildUploadFiles",
      attributes: { assetType: "ASSET", fileName: input.fileName, fileSize: Number(input.fileSize), uti: input.uti },
      relationships: { buildUpload: relation("buildUploads", upload.id) } } })).data);
    if (!file) throw new ProviderRequestError(502, "App Store Connect did not return the build file reservation");
    return `Reserved build upload ${upload.id}: build ${input.build} (${input.version}) of ${input.app}, file ${input.fileName}. ` + planText("build", upload.id, file);
  }),
  read_upload: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse: statement => uploadRef(statement, words => words.length === 0 ? { from: "1" } : words.length === 1 && /^[1-9]\d{0,4}$/u.test(words[0]!) ? { from: words[0]! } : undefined),
    async execute({ credentials }, input) {
      const { upload, file } = await uploadFile(appStoreConnect(credentials), input.kind!, input.id!);
      /* A build upload has Apple's processing verdict of its own, beside its file's delivery state. */
      const lines = upload === file ? uploadState(file) : [...stateLines(upload.attributes.state), `file ${uploadState(file).join("\n")}`];
      return { summary: `The ${UPLOADS[input.kind!]!.what} is ${quoteRetrievedText(lines.join("\n"))}\n${planText(input.kind!, input.id!, file, Number(input.from))}` };
    },
  },
  commit_upload: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse: statement => uploadRef(statement, words => words.length === 0 ? {} : undefined),
    async execute({ credentials }, input) {
      const api = appStoreConnect(credentials);
      const { file } = await uploadFile(api, input.kind!, input.id!);
      const committed = appleResource((await api.request(`/v1/${file.type}/${encodeURIComponent(file.id)}`, { method: "PATCH",
        data: { type: file.type, id: file.id, attributes: { uploaded: true } } })).data);
      return { summary: `Committed the ${UPLOADS[input.kind!]!.what}; Apple reports ${uploadState(committed)[0]}. ${UPLOADS[input.kind!]!.next}` };
    },
  },
  delete_upload: {
    effect: "write", requires: ["keyId", "privateKey"],
    parse: statement => uploadRef(statement, words => words.length === 0 ? {} : undefined),
    async execute({ credentials }, input) {
      await appStoreConnect(credentials).request(`${UPLOADS[input.kind!]!.root}/${encodeURIComponent(input.id!)}`, { method: "DELETE" });
      return { summary: `Deleted the ${UPLOADS[input.kind!]!.what} ${input.id}. Apple refuses this for an image that is still placed, and for a build it has accepted.` };
    },
  },
  build_uploads: appAction("read", statement => {
    const app = bundleId(statement.target), build = statement.text.trim();
    return app && (!build || /^\d[\d.]{0,17}$/u.test(build)) ? { app, build } : "name an app, and optionally one build number: <com.example.app> [<412>]";
  }, async ({ api, app, input }) => {
    const { rows } = await api.list(`/v1/apps/${encodeURIComponent(app.id)}/buildUploads`, { sort: "-uploadedDate", limit: "5",
      "fields[buildUploads]": "cfBundleShortVersionString,cfBundleVersion,createdDate,state,platform,uploadedDate",
      ...(input.build ? { "filter[cfBundleVersion]": input.build } : {}) }, 1);
    const lines = rows.flatMap(upload => {
      const [state = "UNKNOWN", ...details] = stateLines(upload.attributes.state);
      return [`${upload.id}\t${cell(upload.attributes.platform)}\t${cell(upload.attributes.cfBundleShortVersionString)}\t${cell(upload.attributes.cfBundleVersion)}\t${state}` +
        `\t${text(upload.attributes.uploadedDate || upload.attributes.createdDate).slice(0, 16)}`, ...details];
    });
    return `Newest build uploads of ${input.app}${input.build ? `, build ${input.build}` : ""}; Apple's findings are untrusted text:\n` +
      quoteRetrievedText(lines.length ? ["upload id\tplatform\tversion\tbuild\tstate\twhen", ...lines].join("\n") : "(no build uploads)");
  }),
  declare_encryption: appAction("write", statement => {
    const parsed = appVersionBuild(statement);
    const answer = parsed?.rest.length === 1 ? { exempt: "false", non_exempt: "true" }[parsed.rest[0]!.toLowerCase()] : undefined;
    return parsed && answer ? { app: parsed.app, platform: parsed.platform, version: parsed.version, build: parsed.build, uses: answer }
      : "name an app, a version, a build number and the export compliance answer: <com.example.app> <1.2.0> <412> exempt|non_exempt";
  }, async ({ api, app, input }) => {
    const build = await namedBuild(api, app.id, input);
    await api.request(`/v1/builds/${encodeURIComponent(build.id)}`, { method: "PATCH",
      data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: input.uses === "true" } } });
    return input.uses === "true"
      ? `Declared that build ${input.build} of ${input.app} uses non-exempt encryption; Apple asks for the encryption documentation in App Store Connect.`
      : `Declared that build ${input.build} of ${input.app} uses no non-exempt encryption.`;
  }),
};
