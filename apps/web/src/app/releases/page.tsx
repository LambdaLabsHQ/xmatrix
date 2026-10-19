import { notFound, redirect } from "next/navigation";
import { releaseNotesPath } from "@xmatrix/protocol";

import { fetchDevRelease, fetchLatestStableAndroidRelease, fetchLatestStableCliRelease, fetchLatestStableDesktopMacRelease } from "@/lib/github-release";

const stableReleases = { cli: fetchLatestStableCliRelease, desktop: fetchLatestStableDesktopMacRelease, android: fetchLatestStableAndroidRelease };

/** Download cards resolve their own component/channel, then keep an exact-version URL. */
export default async function DownloadReleaseNotes({ searchParams }: { searchParams: Promise<{ component?: string; channel?: string }> }) {
  const { component = "desktop", channel = "stable" } = await searchParams;
  if (!Object.hasOwn(stableReleases, component) || !["stable", "dev"].includes(channel)) notFound();
  const target = component as keyof typeof stableReleases;
  let href: string | undefined;
  try {
    const release = await (channel === "dev" ? fetchDevRelease(target) : stableReleases[target]());
    href = releaseNotesPath(release.tag_name.replace(/^(?:cli|desktop|android)-v/u, ""));
  } catch {
    // A missing feed must not send someone to a different component's notes.
  }
  if (href) redirect(href);
  return <main className="mx-auto max-w-3xl px-6 py-32"><h1>Release notes</h1><p>Release notes are unavailable right now. Please try again.</p><a href="/download">Back to downloads</a></main>;
}
