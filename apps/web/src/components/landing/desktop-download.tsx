"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Globe, Smartphone, Tablet } from "lucide-react";

import { MachineGlyph } from "@/components/dashboard/machine-glyph";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "@/lib/app-stores";
import type { SiteLocale } from "@/lib/site-locales";
import { sitePagesCopy, type DownloadPageCopy } from "@/lib/site-pages-copy";

import { DownloadRecommendation, webApp, type Channel } from "./download-recommendation";

// `store` builds are the same in every channel, so they carry no Preview suffix.
type Build = { label: string; href: string; store?: boolean };
type PlatformRow = { name: string; icon: ReactNode; note: string; builds: Build[] };

const desktop = (channel: Channel, file: string) => `/api/desktop/releases/${channel}/latest-${file}`;
const notes = (component: "desktop" | "android", channel: Channel) => `/releases?component=${component}&channel=${channel}`;

function channelOptions(copy: DownloadPageCopy): { id: Channel; label: string; detail: string }[] {
  return [
    { id: "stable", label: copy.stableLabel, detail: copy.stableDetail },
    { id: "dev", label: copy.previewLabel, detail: copy.previewDetail },
  ];
}

function platforms(channel: Channel, copy: DownloadPageCopy): PlatformRow[] {
  return [
    {
      name: "macOS", icon: <MachineGlyph os="macos" />, note: copy.macNote,
      builds: [{ label: "Apple Silicon", href: desktop(channel, "arm64.dmg") }, { label: "Intel", href: desktop(channel, "x64.dmg") }],
    },
    {
      name: "Windows", icon: <MachineGlyph os="windows" className="size-[18px]" />, note: copy.windowsNote,
      builds: [{ label: copy.windowsBuild, href: desktop(channel, "x64.exe") }],
    },
    {
      name: "iPhone & iPad", icon: <Tablet className="size-5" strokeWidth={1.75} aria-hidden />, note: copy.iosNote,
      builds: [{ label: "App Store", href: APP_STORE_URL, store: true }],
    },
    {
      name: "Android", icon: <Smartphone className="size-5" strokeWidth={1.75} aria-hidden />, note: copy.androidNote,
      builds: [
        ...(channel === "stable" ? [{ label: "Google Play", href: GOOGLE_PLAY_URL, store: true }] : []),
        { label: "APK", href: `/api/android/releases/${channel}/latest.apk` },
      ],
    },
    {
      name: "Web", icon: <Globe className="size-5" strokeWidth={1.75} aria-hidden />, note: copy.webNote,
      builds: [{ label: copy.webBuild, href: webApp(channel) }],
    },
  ];
}

function more(channel: Channel, copy: DownloadPageCopy): Build[] {
  return [
    { label: copy.desktopNotes, href: notes("desktop", channel) },
    { label: copy.androidNotes, href: notes("android", channel) },
    { label: copy.macZipArm, href: desktop(channel, "arm64.zip") },
    { label: copy.macZipIntel, href: desktop(channel, "x64.zip") },
  ];
}

function ChannelMenu({
  channel,
  onChoose,
  copy,
}: {
  channel: Channel;
  onChoose: (next: Channel) => void;
  copy: DownloadPageCopy;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const channels = channelOptions(copy);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") return close();
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    items[(items.indexOf(document.activeElement as HTMLElement) + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-11 items-center gap-1 rounded-md px-1 text-sm font-[550] text-[var(--site-ink-muted)] transition-colors hover:text-[var(--site-ink)] focus-visible:outline-2 focus-visible:outline-[var(--site-wood-deep)] aria-expanded:text-[var(--site-ink)]"
      >
        <span className="sr-only">{copy.releaseChannelSr}</span>
        {channels.find(({ id }) => id === channel)!.label}
        <ChevronDown className="size-4" strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <PaperPopover role="menu" aria-label={copy.releaseChannelMenu} onKeyDown={keys}
          className="absolute left-1/2 top-full z-20 mt-1 flex w-64 -translate-x-1/2 flex-col text-left sm:left-0 sm:translate-x-0">
          {channels.map(({ id, label, detail }) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={id === channel}
              onClick={() => { onChoose(id); close(); }}
              className="flex items-start gap-3 px-3.5 py-2.5 text-left hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">{label}</span>
                <span className="block text-[13px] leading-5 text-muted-foreground">{detail}</span>
              </span>
              <Check className={id === channel ? "mt-0.5 size-4 text-foreground" : "invisible size-4"} strokeWidth={2.25} aria-hidden />
            </button>
          ))}
        </PaperPopover>
      )}
    </div>
  );
}

export function DesktopDownload({ locale = "en" }: { locale?: SiteLocale }) {
  const [channel, setChannel] = useState<Channel>("stable");
  const copy = sitePagesCopy[locale].download;
  // `/download?channel=preview` opens the list on Preview, so the choice can be linked.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("channel") === "preview") setChannel("dev");
  }, []);
  const choose = (next: Channel) => {
    setChannel(next);
    const url = new URL(location.href);
    if (next === "dev") url.searchParams.set("channel", "preview");
    else url.searchParams.delete("channel");
    history.replaceState(history.state, "", url);
  };
  const channels = channelOptions(copy);
  const current = channels.find(({ id }) => id === channel)!;
  const suffix = channel === "dev" ? copy.previewSuffix : "";
  const channelSwitch = <ChannelMenu channel={channel} onChoose={choose} copy={copy} />;

  return (
    <section id="download" className="x-section download-page">
      <div className="x-container">
        <DownloadRecommendation channel={channel} channelSwitch={channelSwitch} locale={locale} />

        <div id="all-downloads" className="mx-auto mt-16 max-w-2xl scroll-mt-24 sm:mt-20">
          <h2 className="download-list-heading">{copy.allPlatforms(current.label)}</h2>
          <ul className="download-list" data-channel={channel}>
            {platforms(channel, copy).map(({ name, icon, note, builds }) => (
              <li key={name} className="download-row">
                <span className="download-row-icon">{icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-foreground">{name}</p>
                  <p className="text-sm text-muted-foreground">{note}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {builds.map((build) => (
                    <a key={build.href} href={build.href} className="download-build" aria-label={`${name} ${build.label}${build.store ? "" : suffix}`}>{build.label}</a>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {more(channel, copy).map((link) => (
              <a key={link.href} href={link.href} className="download-quiet-link" aria-label={`${link.label}${suffix}`}>{link.label}</a>
            ))}
          </p>
        </div>
      </div>
    </section>
  );
}
