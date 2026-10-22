/*
 * What a desktop build's own version decides: a beta `X.Y.Z-beta.N` is on the
 * beta channel and a stable `X.Y.Z` on the stable one. A build follows only its
 * channel's update feed, and loads and trusts only its channel's Web.
 */

const DESKTOP_RELEASE_FEEDS = "https://xmatrix.sh/api/desktop/releases";
// Each channel's Web: a build opens the first origin and trusts all of them.
const BETA_WEB_ORIGINS = ["https://beta.xmatrix.sh"];
/** The stable Web keeps its `www` name, which it was always trusted under. */
const STABLE_WEB_ORIGINS = ["https://xmatrix.sh", "https://www.xmatrix.sh"];

function isBetaBuild(version: string): boolean {
  return (version.split("+", 1)[0] ?? "").includes("-");
}

/**
 * The update feed a desktop build follows: a beta follows the dev channel and
 * a stable the stable one, so each build moves only along the channel it was
 * published to.
 */
export function desktopUpdateFeedUrl(version: string): string {
  return `${DESKTOP_RELEASE_FEEDS}/${isBetaBuild(version) ? "dev" : "stable"}`;
}

function channelWebOrigins(version: string): string[] {
  return isBetaBuild(version) ? BETA_WEB_ORIGINS : STABLE_WEB_ORIGINS;
}

/** The page a build opens: its own channel's Web app. */
export function desktopWebUrl(version: string): string {
  return `${channelWebOrigins(version)[0]}/app`;
}

/**
 * Whether a page belongs to this build's own Web, the only remote pages that
 * may navigate its windows and call its bridge: an exact https origin of its
 * channel's Web. The other channel's Web, sibling hosts and lookalikes are not.
 */
export function isDesktopWebOrigin(url: URL, version: string): boolean {
  return channelWebOrigins(version).includes(url.origin);
}
