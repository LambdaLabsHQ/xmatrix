"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useNear } from "@/components/landing/use-media";
import { SegmentedTabs, type SegmentedTabItem } from "@/components/ui/segmented-tabs";

const WhyXMatrixDemo = dynamic(
  () => import("@/components/landing/why-xmatrix-demos").then((m) => m.WhyXMatrixDemo),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full rounded-[12px] bg-[var(--site-paper)]/85 shadow-[0_0_0_0.5px_oklch(0.25_0.03_60/0.12)]" />
    ),
  },
);

const WhyCompetitorDemo = dynamic(
  () => import("@/components/landing/why-competitor-demos").then((m) => m.WhyCompetitorDemo),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full rounded-[12px] bg-[color-mix(in_oklch,var(--site-ink)_6%,var(--background))]" />
    ),
  },
);

const STEP_MS = 2300;
const STEPS_PER_TOPIC = 4;

type Row = readonly [string, string, string];

/**
 * Interactive 6-topic comparison stage: one spacious topic at a time,
 * xMatrix's real product interface beside an authentic developer desk of
 * terminals, tabs, and notifications — both ticking on one synchronized clock.
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
      {/* Shared SegmentedTabs tuned for the site's warm paper: pill track on mobile, 10px/7px concentric on desktop */}
      <div className="flex items-center justify-between gap-3">
        <SegmentedTabs
          items={tabItems}
          value={String(active)}
          onChange={(key) => selectTopic(Number(key))}
          label={title}
          className="min-w-0 [--app-action-edge:inset_0_0_0_0.5px_oklch(0.32_0.02_58/0.1)] [--app-action-fill:color-mix(in_oklch,var(--site-ink)_4.5%,var(--background))] [--app-action-fill-hover:color-mix(in_oklch,var(--site-ink)_3%,var(--site-paper))] [--app-action-fill-primary:var(--site-paper)] md:flex-wrap"
          tabClassName="cursor-pointer font-semibold max-md:px-3.5 max-md:text-[13px] aria-selected:shadow-[0_1px_3px_oklch(0.25_0.03_60/0.1),0_0_0_0.5px_oklch(0.25_0.03_60/0.08)]"
        />

        {/* Quiet prev/next stepper on desktop & tablet */}
        <div className="hidden shrink-0 items-center gap-1.5 sm:inline-flex">
          <button
            type="button"
            aria-label="Previous comparison"
            onClick={() => selectTopic(active - 1)}
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--site-ink)_4.5%,var(--background))] text-[var(--site-ink-muted)] transition-colors hover:bg-[color-mix(in_oklch,var(--site-ink)_8%,var(--background))] hover:text-[var(--site-ink)]"
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
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--site-ink)_4.5%,var(--background))] text-[var(--site-ink-muted)] transition-colors hover:bg-[color-mix(in_oklch,var(--site-ink)_8%,var(--background))] hover:text-[var(--site-ink)]"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Active topic comparison stage: two generous archival paper trays side by side */}
      <div
        id={`why-panel-${active}`}
        role="tabpanel"
        aria-label={topic}
        className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5"
      >
        {/* Left tray: xMatrix on warm archival paper */}
        <figure className="m-0 flex min-w-0 flex-col gap-4 rounded-[20px] bg-[color-mix(in_oklch,var(--app-wood-panel-base)_18%,var(--background))] p-4 shadow-[inset_0_0_0_1px_oklch(0.55_0.055_66/0.16)] sm:p-5">
          <div className="flex h-6 items-center justify-between gap-2 px-0.5">
            <span className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-[var(--site-ink)]">
              <Image
                src="/brand/xmatrix-icon-transparent-128.png"
                alt=""
                width={20}
                height={20}
                className="size-5 shrink-0"
              />
              xMatrix
            </span>
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
              <div className="h-full w-full rounded-[12px] bg-[var(--site-paper)]/80 shadow-[0_0_0_0.5px_oklch(0.25_0.03_60/0.1)]" />
            )}
          </div>

          <figcaption className="min-h-[2.75rem] px-0.5 text-[15px] leading-[1.55] font-medium text-[var(--site-ink)]">
            {ours}
          </figcaption>
        </figure>

        {/* Right tray: Juggling tabs & terminals on cool muted paper */}
        <figure className="m-0 flex min-w-0 flex-col gap-4 rounded-[20px] bg-[color-mix(in_oklch,var(--site-ink)_3.8%,var(--background))] p-4 shadow-[inset_0_0_0_1px_oklch(0.28_0.015_60/0.08)] sm:p-5">
          <div className="flex h-6 items-center justify-between gap-2 px-0.5">
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
              <div className="h-full w-full rounded-[12px] bg-[color-mix(in_oklch,var(--site-ink)_6%,var(--background))]" />
            )}
          </div>

          <figcaption className="min-h-[2.75rem] px-0.5 text-[15px] leading-[1.55] text-[var(--site-ink-muted)]">
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
