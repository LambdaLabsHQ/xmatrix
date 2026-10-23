import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { releaseNotesPath } from "@xmatrix/protocol";

import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import { fetchPublishedReleaseNotes } from "@/lib/github-release";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";
import { REPOSITORY_URL } from "@/lib/star-prompt";

type Props = { params: Promise<{ version: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { version } = await params;
  if (!releaseNotesPath(version)) return {};
  return { title: `xMatrix ${version} release notes`, alternates: { canonical: releaseNotesPath(version) } };
}

export default async function ReleaseNotesPage({ params }: Props) {
  const { version } = await params;
  if (!releaseNotesPath(version)) notFound();
  let notes: string | undefined;
  let unavailable = false;
  try {
    notes = await fetchPublishedReleaseNotes(version);
  } catch {
    unavailable = true;
  }
  return (
    <div className="site-page docs-page">
      <Navbar />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-32">
        <article className="page-document docs-article" data-editable="false">
          <p>Release notes</p>
          <h1>xMatrix {version}</h1>
          {notes ? <Markdown remarkPlugins={markdownRemarkPlugins} disallowedElements={["img"]}>{notes}</Markdown> : (
            <p>{unavailable ? "Release notes could not be loaded. Please try again." : "Release notes are not available for this version yet."}</p>
          )}
          <p><a href={`${REPOSITORY_URL}/releases/tag/xmatrix-v${version}`} rel="noreferrer">View release on GitHub</a></p>
        </article>
      </main>
      <Footer />
    </div>
  );
}
