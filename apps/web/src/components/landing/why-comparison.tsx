"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useNear } from "@/components/landing/use-media";
import { SegmentedTabs, type SegmentedTabItem } from "@/components/ui/segmented-tabs";
import { WoodPanel } from "@/components/ui/material-surfaces";

const WhyXMatrixDemo = dynamic(
  () => import("@/components/landing/why-xmatrix-demos").then((m) => m.WhyXMatrixDemo),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full rounded-[14px] bg-[var(--site-paper)] shadow-[0_18px_44px_-18px_oklch(0.24_0.03_58/0.2)]" />
    ),
  },
);

const WhyCompetitorDemo = dynamic(
  () => import("@/components/landing/why-competitor-demos").then((m) => m.WhyCompetitorDemo),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full rounded-[14px] bg-[color-mix(in_oklch,var(--site-ink)_4.2%,var(--background))]" />
    ),
  },
);

const STEP_MS = 2300;
const STEPS_PER_TOPIC = 4;

type Row = readonly [string, string, string];

/**
 * Interactive 6-topic comparison stage: borderless warm-paper layout with
 * subtle walnut wood accents (a compact xMatrix plaque pill and slender
 * sheet spine) — never heavy borders or a large wood slab.
 */
export function WhyComparison({
  title,
  others,
  rows,
}: {
  title: string;
  others: string;
  rows: readonly Row[];
}) {
  const [active, setActive] = useState(0);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [manual, setManual] = useState(false);
  const [inView, setInView] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [nearRef, near] = useNear<HTMLDivElement>();

  const tabItems = useMemo<SegmentedTabItem<string>[]>(
    () => rows.map(([rowTopic], index) => ({ key: String(index), label: rowTopic })),
    [rows],
  );

  useEffect(() => {
    if (!host) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(STEPS_PER_TOPIC - 1);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { threshold: 0.25 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  useEffect(() => {
    if (!inView || paused) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = window.setInterval(() => {
      setStep((current) => {
        if (current + 1 < STEPS_PER_TOPIC) return current + 1;
        if (!manual) setActive((topic) => (topic + 1) % rows.length);
        return 0;
      });
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [inView, paused, manual, rows.length]);

  const selectTopic = (index: number) => {
    const next = (index + rows.length) % rows.length;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setActive(next);
    setStep(reduced ? STEPS_PER_TOPIC - 1 : 0);
    setManual(true);
  };

  const [topic, ours, theirs] = rows[active]!;

  return (
    <div
      ref={(node) => {
        nearRef(node);
        setHost(node);
      }}
      className="mt-8 md:mt-11"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Borderless shared SegmentedTabs on warm paper */}
      <div className="flex items-center justify-between gap-3">
        <SegmentedTabs
          items={tabItems}
          value={String(active)}
          onChange={(key) => selectTopic(Number(key))}
          label={title}
          className="min-w-0 [--app-action-edge:none] [--app-action-fill:color-mix(in_oklch,var(--site-ink)_4%,var(--background))] [--app-action-fill-hover:color-mix(in_oklch,var(--site-ink)_2.5%,var(--site-paper))] [--app-action-fill-primary:var(--site-paper)] md:flex-wrap"
          tabClassName="cursor-pointer font-semibold max-md:px-3.5 max-md:text-[13px] aria-selected:shadow-[0_2px_6px_-2px_oklch(0.25_0.03_60/0.14)]"
        />

        {/* Quiet borderless prev/next stepper */}
        <div className="hidden shrink-0 items-center gap-1.5 sm:inline-flex">
          <button
            type="button"
            aria-label="Previous comparison"
            onClick={() => selectTopic(active - 1)}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--site-ink)_4%,var(--background))] text-[var(--site-ink-muted)] transition-colors hover:bg-[color-mix(in_oklch,var(--site-ink)_8%,var(--background))] hover:text-[var(--site-ink)]"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-[2.5rem] text-center font-mono text-xs text-[var(--site-ink-muted)] tabular-nums">
            {active + 1}/{rows.length}
          </span>
          <button
            type="button"
            aria-label="Next comparison"
            onClick={() => selectTopic(active + 1)}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--site-ink)_4%,var(--background))] text-[var(--site-ink-muted)] transition-colors hover:bg-[color-mix(in_oklch,var(--site-ink)_8%,var(--background))] hover:text-[var(--site-ink)]"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Borderless side-by-side comparison resting directly on the homepage's warm paper */}
      <div
        id={`why-panel-${active}`}
        role="tabpanel"
        aria-label={topic}
        className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-8"
      >
        {/* Left column: xMatrix accented by a compact walnut plaque + slender walnut sheet spine */}
        <figure className="m-0 flex min-w-0 flex-col gap-4">
          <div className="flex h-8 items-center justify-between gap-2">
            <WoodPanel
              as="span"
              className="site-wood-pill inline-flex h-8 items-center gap-2 px-3 text-[13.5px] leading-none shadow-[inset_0_1px_0_oklch(1_0.02_90/0.42),0_4px_12px_-6px_oklch(0.18_0.04_55/0.42)]!"
            >
              <span className="inline-flex size-[18px] items-center justify-center rounded-full bg-[oklch(0.99_0.008_88/0.78)]">
                <Image
                  src="/brand/xmatrix-icon-transparent-128.png"
                  alt=""
                  width={13}
                  height={13}
                  className="size-[13px] shrink-0"
                />
              </span>
              <span>xMatrix</span>
            </WoodPanel>
            <span className="text-xs font-medium text-[var(--site-ink-muted)] lg:hidden">{topic}</span>
          </div>

          <div
            className="h-[332px] w-full min-w-0 sm:h-[344px]"
            role="img"
            aria-label={`xMatrix: ${topic}`}
          >
            {near ? (
              <WhyXMatrixDemo topic={active} step={step} />
            ) : (
              <div className="h-full w-full rounded-[14px] bg-[var(--site-paper)] shadow-[0_18px_44px_-18px_oklch(0.24_0.03_58/0.2)]" />
            )}
          </div>

          <figcaption className="min-h-[2.75rem] text-[15.5px] leading-[1.55] font-medium text-[var(--site-ink)]">
            {ours}
          </figcaption>
        </figure>

        {/* Right column: Juggling tabs & terminals, quiet and borderless */}
        <figure className="m-0 flex min-w-0 flex-col gap-4">
          <div className="flex h-8 items-center justify-between gap-2">
            <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-[var(--site-ink-muted)]">
              {others}
            </span>
            <span className="font-mono text-[11px] text-[var(--site-ink-muted)]/80 sm:hidden tabular-nums">
              {active + 1}/{rows.length}
            </span>
          </div>

          <div
            className="h-[332px] w-full min-w-0 sm:h-[344px]"
            role="img"
            aria-label={`${others}: ${topic}`}
          >
            {near ? (
              <WhyCompetitorDemo topic={active} step={step} />
            ) : (
              <div className="h-full w-full rounded-[14px] bg-[color-mix(in_oklch,var(--site-ink)_4.2%,var(--background))]" />
            )}
          </div>

          <figcaption className="min-h-[2.75rem] text-[15.5px] leading-[1.55] text-[var(--site-ink-muted)]">
            {theirs}
          </figcaption>
        </figure>
      </div>

      {/* Inactive tabpanels stay semantically attached for assistive tech */}
      {rows.map(([rowTopic, rowOurs, rowTheirs], index) =>
        index === active ? null : (
          <div key={rowTopic} id={`why-panel-${index}`} role="tabpanel" aria-label={rowTopic} hidden>
            <p>{rowOurs}</p>
            <p>{rowTheirs}</p>
          </div>
        ),
      )}
    </div>
  );
}
