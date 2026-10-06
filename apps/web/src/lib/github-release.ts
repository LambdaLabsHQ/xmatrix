import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import canonicalVersion from "../../../../version.json";

type GitHubReleaseAsset = {
  name: string;
  url: string;
  size: number;
  content_type: string;
  r2Key?: string;
  sha256?: string;
};

type GitHubRelease = {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: GitHubReleaseAsset[];
  commitSha?: string;
  runId?: string;
  publishedAt?: string;
};

export type ReleaseAssetRouteContext = {
  params: Promise<{
    asset: string;
  }>;
};

type ReleaseResolver = () => Promise<GitHubRelease>;
type ReleaseAssetAlias = (release: GitHubRelease, assetName: string) => GitHubReleaseAsset | undefined;
type ReleasePredicate = (release: GitHubRelease) => boolean;
type ReleaseComponent = "cli" | "desktop" | "android";
type ReleaseChannel = "stable" | "dev";
type ReleaseBucket = {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{
    body: ReadableStream;
    size: number;
    httpEtag: string;
    writeHttpMetadata(headers: Headers): void;
  } | null>;
};

type R2ChannelPointer = {
  schemaVersion: number;
  component: string;
  channel: string;
  releaseTag: string;
  prefix: string;
  files: Array<{
    name: string;
    key: string;
    size: number;
    contentType: string;
    sha256: string;
  }>;
  commitSha?: string;
  runId?: string;
  publishedAt?: string;
};

const DEFAULT_RELEASE_REPO = "madebyrobot/xmatrix";
const XMATRIX_VERSION = canonicalVersion.version;

function getReleaseRepo() {
  return getRuntimeEnv("XMATRIX_RELEASE_REPO") || DEFAULT_RELEASE_REPO;
}

function getGitHubHeaders(extraHeaders?: Record<string, string>) {
  const token = getRuntimeEnv("GITHUB_TOKEN")?.trim();

  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "xmatrix-web",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
}

async function fetchGitHubReleaseJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub releases API returned ${response.status}`);
  }

  return (await response.json()) as T;
}

function getRuntimeEnv(name: string) {
  try {
    const env = getCloudflareContext().env as Record<string, unknown>;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  } catch {
    // Fall back to process.env outside the Cloudflare worker runtime.
  }

  return process.env[name];
}

function getReleaseBucket() {
  try {
    const env = getCloudflareContext().env as Record<string, unknown>;
    const bucket = env.RELEASE_ASSETS as ReleaseBucket | undefined;
    if (bucket && typeof bucket.get === "function") return bucket;
  } catch {
    // GitHub Releases remain the historical fallback outside Cloudflare.
  }
  return undefined;
}

// Build machines upload into `<prefix>/parts/<part>/<run>-<attempt>/`; older
// releases kept every file directly under the prefix.
const RELEASE_PART_PATTERN = /^parts\/[a-z0-9][a-z0-9-]*\/\d+-\d+$/u;

function isReleaseObjectKey(key: string | undefined, prefix: string, name: string) {
  if (key === `${prefix}/${name}`) return true;
  if (typeof key !== "string" || !key.startsWith(`${prefix}/`) || !key.endsWith(`/${name}`)) return false;
  return RELEASE_PART_PATTERN.test(key.slice(prefix.length + 1, key.length - name.length - 1));
}

export function releaseFromR2ChannelPointer(
  pointer: R2ChannelPointer,
  component: ReleaseComponent,
  channel: ReleaseChannel = "stable"
): GitHubRelease {
  if (
    pointer?.schemaVersion !== 1 ||
    pointer.component !== component ||
    pointer.channel !== channel ||
    !pointer.releaseTag?.startsWith(`${component}-v`) ||
    !pointer.prefix?.startsWith("releases/") ||
    !Array.isArray(pointer.files) ||
    pointer.files.length === 0
  ) {
    throw new Error(`Invalid R2 ${component} ${channel} channel pointer`);
  }
  const names = new Set<string>();
  const assets = pointer.files.map((file) => {
    if (
      !file?.name ||
      file.name.includes("/") ||
      file.name.includes("\\") ||
      names.has(file.name) ||
      !isReleaseObjectKey(file.key, pointer.prefix, file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new Error(`Invalid R2 ${component} release asset`);
    }
    names.add(file.name);
    return {
      name: file.name,
      url: "",
      size: file.size,
      content_type: file.contentType || "application/octet-stream",
      r2Key: file.key,
      sha256: file.sha256,
    };
  });
  return {
    tag_name: pointer.releaseTag,
    draft: false,
    prerelease: false,
    assets,
    commitSha: pointer.commitSha,
    runId: pointer.runId,
    publishedAt: pointer.publishedAt,
  };
}

async function fetchR2ChannelRelease(component: ReleaseComponent, channel: ReleaseChannel) {
  const bucket = getReleaseBucket();
  if (!bucket) throw new Error("R2 release binding is unavailable");
  const object = await bucket.get(`channels/${component}/${channel}.json`);
  if (!object) throw new Error(`No R2 ${channel} release exists for ${component}`);
  const pointer = JSON.parse(await new Response(object.body).text()) as R2ChannelPointer;
  return releaseFromR2ChannelPointer(pointer, component, channel);
}

/** The release a train published to the dev channel, before anyone promoted it to stable. */
export function fetchDevRelease(component: ReleaseComponent) {
  return fetchR2ChannelRelease(component, "dev");
}

async function fetchLatestStableRelease(component: ReleaseComponent, githubFallback: ReleaseResolver) {
  try {
    return await fetchR2ChannelRelease(component, "stable");
  } catch {
    return githubFallback();
  }
}

export async function fetchLatestPublishedGitHubReleaseByTagPrefix(
  tagPrefix: string,
  isEligibleRelease: ReleasePredicate = () => true
) {
  const releases = await fetchGitHubReleaseJson<GitHubRelease[]>(
    `https://api.github.com/repos/${getReleaseRepo()}/releases?per_page=100`
  );
  const release = selectLatestPublishedGitHubReleaseByTagPrefix(releases, tagPrefix, isEligibleRelease);
  if (!release) throw new Error(`No published GitHub release found for ${tagPrefix}`);

  return release;
}

export function selectLatestPublishedGitHubReleaseByTagPrefix(
  releases: GitHubRelease[],
  tagPrefix: string,
  isEligibleRelease: ReleasePredicate = () => true
) {
  return releases
    .filter(
      (candidate) =>
        candidate.tag_name.startsWith(tagPrefix) &&
        !candidate.draft &&
        !candidate.prerelease &&
        isEligibleRelease(candidate)
    )
    .sort((left, right) =>
      compareReleaseVersions(releaseVersionFromTag(right.tag_name), releaseVersionFromTag(left.tag_name))
    )[0];
}

export function getLatestReleaseManifest(release: GitHubRelease, origin: string, downloadBasePath: string) {
  const releaseVersion = releaseVersionFromTag(release.tag_name);
  return {
    version: releaseVersion,
    trainVersion: XMATRIX_VERSION,
    releaseVersion,
    tag_name: release.tag_name,
    assets: release.assets.map((asset) => ({
      name: asset.name,
      browser_download_url: `${origin}${downloadBasePath}/${encodeURIComponent(asset.name)}`,
      size: asset.size,
      sha256: asset.sha256,
    })),
    provenance: release.commitSha && release.runId ? {
      workflow: "cli-release.yml",
      gitSha: release.commitSha,
      runId: release.runId,
      publishedAt: release.publishedAt,
    } : undefined,
  };
}

function releaseVersionFromTag(tagName: string) {
  return tagName.replace(/^(?:cli|desktop|android)-v/, "").replace(/^v/, "");
}

function compareReleaseVersions(left: string, right: string) {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);

  const length = Math.max(parsedLeft.parts.length, parsedRight.parts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.parts[index] || 0;
    const rightPart = parsedRight.parts[index] || 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }

  if (parsedLeft.prerelease && !parsedRight.prerelease) return -1;
  if (!parsedLeft.prerelease && parsedRight.prerelease) return 1;
  return (parsedLeft.prerelease || "").localeCompare(parsedRight.prerelease || "");
}

function parseReleaseVersion(version: string) {
  const [withoutBuild] = version.split("+", 1);
  const [authority, prerelease] = withoutBuild.split("-", 2);
  const parts = authority.split(".").map((part) => {
    if (!/^\d+$/.test(part)) return undefined;
    return Number(part);
  });
  if (parts.length === 0 || parts.some((part) => part === undefined)) return undefined;
  return { parts: parts as number[], prerelease };
}

function findReleaseAsset(release: GitHubRelease, assetName: string) {
  return release.assets.find((asset) => asset.name === assetName);
}

export function findAndroidReleaseAssetByAlias(release: GitHubRelease, assetName: string) {
  if (assetName === "latest.apk") return release.assets.find((asset) => asset.name.endsWith(".apk"));
  if (assetName === "latest.aab") return release.assets.find((asset) => asset.name.endsWith(".aab"));
  return undefined;
}

export function findDesktopReleaseAssetByAlias(release: GitHubRelease, assetName: string) {
  const macMatch = assetName.match(/^latest-arm64\.(dmg|zip)$/);
  if (macMatch) {
    const [, extension] = macMatch;
    return release.assets.find((asset) => {
      if (!asset.name.endsWith(`.${extension}`)) return false;
      if (asset.name.includes("universal")) return false;
      return asset.name.includes("-arm64.");
    });
  }

  if (assetName !== "latest-x64.exe") return undefined;
  return release.assets.find((asset) => asset.name.endsWith("-x64.exe"));
}

export function fetchLatestCompleteDesktopMacGitHubRelease() {
  return fetchLatestPublishedGitHubReleaseByTagPrefix("desktop-v", hasCompleteDesktopMacReleaseAssets);
}

export function fetchLatestCompleteDesktopWindowsGitHubRelease() {
  return fetchLatestPublishedGitHubReleaseByTagPrefix("desktop-v", hasCompleteDesktopWindowsReleaseAssets);
}

export function fetchLatestStableCliRelease() {
  return fetchLatestStableRelease("cli", () => fetchLatestPublishedGitHubReleaseByTagPrefix("cli-v"));
}

export function fetchLatestStableAndroidRelease() {
  return fetchLatestStableRelease("android", () => fetchLatestPublishedGitHubReleaseByTagPrefix("android-v"));
}

export function fetchLatestStableDesktopMacRelease() {
  return fetchLatestStableRelease("desktop", fetchLatestCompleteDesktopMacGitHubRelease);
}

export function fetchLatestStableDesktopWindowsRelease() {
  return fetchLatestStableRelease("desktop", fetchLatestCompleteDesktopWindowsGitHubRelease);
}

export function hasCompleteDesktopMacReleaseAssets(release: GitHubRelease) {
  const version = release.tag_name.slice("desktop-v".length);
  if (!version) return false;

  return hasReleaseAssets(release, [
    "latest-mac.yml",
    `xMatrix-${version}-arm64.dmg`,
    `xMatrix-${version}-arm64.zip`,
    `xMatrix-${version}-arm64.dmg.blockmap`,
    `xMatrix-${version}-arm64.zip.blockmap`,
  ]);
}

export function hasCompleteDesktopWindowsReleaseAssets(release: GitHubRelease) {
  const version = release.tag_name.slice("desktop-v".length);
  if (!version) return false;

  return hasReleaseAssets(release, [`xMatrix-${version}-x64.exe`, `xMatrix-${version}-x64.exe.blockmap`, "latest.yml"]);
}

function hasReleaseAssets(release: GitHubRelease, expectedAssets: string[]) {
  const assetNames = new Set(release.assets.map((asset) => asset.name));
  return expectedAssets.every((assetName) => assetNames.has(assetName));
}

export async function releaseManifestResponse(
  request: Request,
  resolveReleaseOrTagPrefix: string | ReleaseResolver,
  downloadBasePath: string,
  unavailableMessage: string
) {
  try {
    const release =
      typeof resolveReleaseOrTagPrefix === "string"
        ? await resolveStableTagPrefix(resolveReleaseOrTagPrefix)
        : await resolveReleaseOrTagPrefix();
    return NextResponse.json(getLatestReleaseManifest(release, new URL(request.url).origin, downloadBasePath), {
      headers: noStoreHeaders(),
    });
  } catch {
    return releaseErrorResponse(unavailableMessage);
  }
}

export async function releaseRedirectResponse(
  request: Request,
  context: ReleaseAssetRouteContext,
  resolveRelease: ReleaseResolver,
  unavailableMessage: string,
  findAlias?: ReleaseAssetAlias
) {
  return releaseAssetResponse(request, context, resolveRelease, unavailableMessage, findAlias, "redirect");
}

/** Redirects to a desktop channel's asset, answering the `latest-*` aliases the updater asks for. */
export async function desktopChannelRedirectResponse(
  request: Request,
  context: ReleaseAssetRouteContext,
  channel: ReleaseChannel,
  resolveRelease: ReleaseResolver
) {
  return releaseRedirectResponse(
    request,
    context,
    resolveRelease,
    `xMatrix desktop ${channel} release download is unavailable right now.`,
    findDesktopReleaseAssetByAlias
  );
}

export async function releaseProxyResponse(
  request: Request,
  context: ReleaseAssetRouteContext,
  resolveRelease: ReleaseResolver,
  unavailableMessage: string,
  findAlias?: ReleaseAssetAlias
) {
  return releaseAssetResponse(request, context, resolveRelease, unavailableMessage, findAlias, "proxy");
}

function releaseAssetResponse(
  request: Request,
  context: ReleaseAssetRouteContext,
  resolveRelease: ReleaseResolver,
  unavailableMessage: string,
  findAlias: ReleaseAssetAlias | undefined,
  githubMode: "redirect" | "proxy"
) {
  return withReleaseAsset(context, resolveRelease, unavailableMessage, findAlias, async (asset) => {
    if (asset.r2Key) return fetchR2ReleaseAsset(asset, request);
    if (githubMode === "redirect") {
      const downloadUrl = await getGitHubReleaseAssetDownloadUrl(asset);
      return NextResponse.redirect(downloadUrl, { status: 302, headers: noStoreHeaders() });
    }
    const response = await fetchGitHubReleaseAsset(asset, request.headers.get("range"));
    const headers = new Headers({
      ...noStoreHeaders(),
      "content-disposition": `attachment; filename="${asset.name}"`,
      "content-type": response.headers.get("content-type") || asset.content_type || "application/octet-stream",
    });
    copyHeader(response.headers, headers, "content-length");
    copyHeader(response.headers, headers, "content-encoding");
    copyHeader(response.headers, headers, "accept-ranges");
    copyHeader(response.headers, headers, "content-range");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  });
}

async function resolveStableTagPrefix(tagPrefix: string) {
  if (tagPrefix === "cli-v") return fetchLatestStableCliRelease();
  if (tagPrefix === "desktop-v") return fetchLatestStableDesktopMacRelease();
  if (tagPrefix === "android-v") return fetchLatestStableAndroidRelease();
  return fetchLatestPublishedGitHubReleaseByTagPrefix(tagPrefix);
}

class ReleaseRangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super("Release asset range is not satisfiable");
  }
}

export function parseReleaseAssetRange(value: string | null, size: number) {
  if (value === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) {
    throw new ReleaseRangeNotSatisfiableError(size);
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new ReleaseRangeNotSatisfiableError(size);
    }
    const offset = Math.max(0, size - suffixLength);
    return { offset, length: size - offset };
  }

  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(requestedEnd) ||
    offset < 0 ||
    offset >= size ||
    requestedEnd < offset
  ) {
    throw new ReleaseRangeNotSatisfiableError(size);
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

async function fetchR2ReleaseAsset(asset: GitHubReleaseAsset, request: Request) {
  const bucket = getReleaseBucket();
  if (!bucket || !asset.r2Key) throw new Error("R2 release asset binding is unavailable");
  const range = parseReleaseAssetRange(request.headers.get("range"), asset.size);
  const object = await bucket.get(asset.r2Key, range ? { range } : undefined);
  if (!object) throw new Error(`R2 release asset is missing: ${asset.r2Key}`);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  headers.set("content-disposition", `attachment; filename="${asset.name}"`);
  headers.set("content-length", String(range?.length ?? asset.size));
  headers.set("content-type", asset.content_type || "application/octet-stream");
  headers.set("etag", object.httpEtag);
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`);
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
}

async function withReleaseAsset(
  context: ReleaseAssetRouteContext,
  resolveRelease: ReleaseResolver,
  unavailableMessage: string,
  findAlias: ReleaseAssetAlias | undefined,
  handleAsset: (asset: GitHubReleaseAsset) => Promise<Response>
) {
  try {
    const { asset, assetName } = await resolveRouteAsset(context, resolveRelease, findAlias);
    if (!asset) return releaseErrorResponse(`Release asset not found: ${assetName}`, 404);
    return await handleAsset(asset);
  } catch (error) {
    if (error instanceof ReleaseRangeNotSatisfiableError) {
      return new Response(null, {
        status: 416,
        headers: {
          ...noStoreHeaders(),
          "accept-ranges": "bytes",
          "content-range": `bytes */${error.size}`,
        },
      });
    }
    return releaseErrorResponse(unavailableMessage);
  }
}

async function fetchGitHubReleaseAsset(asset: GitHubReleaseAsset, range?: string | null) {
  const response = await fetch(asset.url, {
    headers: getGitHubHeaders({
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
      ...(range ? { Range: range } : {}),
    }),
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    throw new Error(`GitHub release asset download returned ${response.status}`);
  }

  return response;
}

async function getGitHubReleaseAssetDownloadUrl(asset: GitHubReleaseAsset) {
  const response = await fetch(asset.url, {
    method: "HEAD",
    headers: getGitHubHeaders({
      Accept: "application/octet-stream",
    }),
    redirect: "manual",
    cache: "no-store",
  });

  const location = response.headers.get("location");
  if (!isRedirectStatus(response.status) || !location) {
    throw new Error(`GitHub release asset redirect returned ${response.status}`);
  }

  return location;
}

function isRedirectStatus(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function resolveRouteAsset(
  context: ReleaseAssetRouteContext,
  resolveRelease: ReleaseResolver,
  findAlias?: ReleaseAssetAlias
) {
  const { asset: assetName } = await context.params;
  const release = await resolveRelease();
  return {
    asset: findReleaseAsset(release, assetName) || findAlias?.(release, assetName),
    assetName,
  };
}

function copyHeader(from: Headers, to: Headers, name: string) {
  const value = from.get(name);
  if (value) to.set(name, value);
}

function noStoreHeaders() {
  return { "cache-control": "no-store" };
}

function releaseErrorResponse(error: string, status = 503) {
  return NextResponse.json({ error }, { status, headers: noStoreHeaders() });
}
