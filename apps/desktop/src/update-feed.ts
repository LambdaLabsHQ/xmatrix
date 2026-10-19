const DESKTOP_RELEASE_FEEDS = "https://xmatrix.sh/api/desktop/releases";

/**
 * The update feed a desktop build follows, by its own version: a beta
 * `X.Y.Z-beta.N` follows the dev channel and a stable `X.Y.Z` the stable one,
 * so each build moves only along the channel it was published to.
 */
export function desktopUpdateFeedUrl(version: string): string {
  const prerelease = (version.split("+", 1)[0] ?? "").includes("-");
  return `${DESKTOP_RELEASE_FEEDS}/${prerelease ? "dev" : "stable"}`;
}
