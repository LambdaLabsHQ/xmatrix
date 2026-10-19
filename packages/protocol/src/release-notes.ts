/** Exact-version links work for both stable and beta update feeds. */
export function releaseNotesPath(version: string | undefined): string | undefined {
  return version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(version)
    ? `/releases/${version}`
    : undefined;
}

/** Receipt metadata is retained on GitHub, outside the user-facing document. */
export function publishedReleaseNotes(body: string | undefined): string | undefined {
  const marker = "<!-- xmatrix-release-notes:v1 -->";
  if (typeof body !== "string" || !body.startsWith(marker) || body.length > 120_000) return undefined;
  return body.slice(marker.length).split("\n\n## Deployment receipt\n")[0]?.trim() || undefined;
}
