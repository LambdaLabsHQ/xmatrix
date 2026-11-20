import type { ReactNode } from "react";
import { Globe, Smartphone } from "lucide-react";
import Link from "next/link";

import { MachineGlyph } from "@/components/dashboard/machine-glyph";

import { DownloadRecommendation } from "./download-recommendation";

type Build = { label: string; href: string };
type PlatformRow = { name: string; icon: ReactNode; note: string; notes?: string; builds: Build[] };

const desktop = (channel: "stable" | "dev", file: string) => `/api/desktop/releases/${channel}/latest-${file}`;
const notes = (component: "desktop" | "android", channel: "stable" | "dev") => `/releases?component=${component}&channel=${channel}`;

const platforms: PlatformRow[] = [
  {
    name: "macOS", icon: <MachineGlyph os="macos" />, note: "Desktop app", notes: notes("desktop", "stable"),
    builds: [{ label: "Apple Silicon", href: desktop("stable", "arm64.dmg") }, { label: "Intel", href: desktop("stable", "x64.dmg") }],
  },
  {
    name: "Windows", icon: <MachineGlyph os="windows" className="size-[18px]" />, note: "Desktop app, x64", notes: notes("desktop", "stable"),
    builds: [{ label: "Installer", href: desktop("stable", "x64.exe") }],
  },
  {
    name: "Android", icon: <Smartphone className="size-5" strokeWidth={1.75} aria-hidden />, note: "Phone app", notes: notes("android", "stable"),
    builds: [{ label: "APK", href: "/api/android/releases/stable/latest.apk" }],
  },
  {
    name: "Web", icon: <Globe className="size-5" strokeWidth={1.75} aria-hidden />, note: "iPhone, iPad, Linux and any browser",
    builds: [{ label: "Open", href: "/app" }],
  },
];

/** Everything that is not the tested installer, as plain links under the list. */
const more: { title: string; links: Build[] }[] = [
  {
    title: "Preview builds",
    links: [
      { label: "macOS Apple Silicon", href: desktop("dev", "arm64.dmg") },
      { label: "macOS Intel", href: desktop("dev", "x64.dmg") },
      { label: "Windows", href: desktop("dev", "x64.exe") },
      { label: "Release notes", href: notes("desktop", "dev") },
    ],
  },
  {
    title: "macOS as ZIP",
    links: [
      { label: "Apple Silicon", href: desktop("stable", "arm64.zip") },
      { label: "Intel", href: desktop("stable", "x64.zip") },
      { label: "Preview Apple Silicon", href: desktop("dev", "arm64.zip") },
      { label: "Preview Intel", href: desktop("dev", "x64.zip") },
    ],
  },
];

export function DesktopDownload() {
  return (
    <section id="download" className="x-section download-page">
      <div className="x-container">
        <DownloadRecommendation />

        <div id="all-downloads" className="mx-auto mt-24 max-w-2xl scroll-mt-24 sm:mt-32">
          <h2 className="download-list-heading">All platforms</h2>
          <ul className="download-list">
            {platforms.map(({ name, icon, note, notes: releaseNotes, builds }) => (
              <li key={name} className="download-row">
                <span className="download-row-icon">{icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-foreground">{name}</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="block sm:inline">{note}</span>
                    {releaseNotes && <><span className="hidden sm:inline"> · </span><Link href={releaseNotes} className="download-quiet-link" aria-label={`${name} release notes`}>Release notes</Link></>}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {builds.map((build) => (
                    <a key={build.href} href={build.href} className="download-build" aria-label={`${name} ${build.label}`}>{build.label}</a>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <dl className="mt-8 space-y-3 text-sm text-muted-foreground">
            {more.map(({ title, links }) => (
              <div key={title} className="flex flex-col gap-x-4 gap-y-1 sm:flex-row">
                <dt className="shrink-0 font-semibold text-foreground sm:w-32">{title}</dt>
                <dd className="flex flex-wrap gap-x-4 gap-y-1">
                  {links.map((link) => (
                    <a key={link.href} href={link.href} className="download-quiet-link" aria-label={`${title}: ${link.label}`}>{link.label}</a>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
