"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useNear } from "@/components/landing/use-media";
import { SegmentedTabs, type SegmentedTabItem } from "@/components/ui/segmented-tabs";
import { WoodPanel } from "@/components/ui/material-surfaces";

const WhyXMatrixDemo = dynamic(
  () => import("@/components/landing/why-xmatrix-demos").then((m) => m.WhyXMatrixDemo),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full rounded-[12px] bg-[var(--background)] shadow-[0_0_0_0.5px_oklch(0_0_0/0.14),0_22px_60px_-8px_oklch(0.25_0.03_60/0.22)]" />
    ),
  },
);

const WhyCompetitorDemo = dynamic(
  () => import("@/components/landing/why-competitor-demos").then((m) => m.WhyCompetitorDemo),
  {
    ssr: false,
    loading: () => <div className="h-full w-full rounded-[12px] bg-transparent" />,
  },
);

const STEP_MS = 2300;
const STEPS_PER_TOPIC = 4;

type Row = readonly [string, string, string];

/**
 * Interactive 6-topic comparison matching the homepage's exact material grammar:
 * a single compact rounded-rectangle walnut wood bar (with authentic bevel &
 * downward shadow) holds the shared SegmentedTabs whose active item lights up
 * as frosted glass on wood; below, xMatrix's real product interfaces and the
 * everyday desk of terminals/windows float directly on warm paper — zero outer
 * boxes, zero fake borders.
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
      className="mt-7 md:mt-9"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* One compact rounded-rectangle walnut wood control bar (filter on wood, frosted glass on wood) */}
      <WoodPanel
        as="div"
        className="inline-flex max-w-full rounded-[14px]! p-[4px] shadow-[inset_0_1px_0_oklch(1_0.02_90/0.52),inset_1px_0_0_oklch(1_0.02_90/0.26),inset_0_-1px_0_oklch(0.32_0.06_58/0.28),inset_-1px_0_0_oklch(0.32_0.06_58/0.18),0_14px_26px_-12px_oklch(0.16_0.04_55/0.58),0_3px_8px_-3px_oklch(0.18_0.04_55/0.24)]!"
      >
        <SegmentedTabs
          items={tabItems}
          value={String(active)}
          onChange={(key) => selectTopic(Number(key))}
          label={title}
          className="min-w-0 rounded-[10px]! border-0! bg-transparent! p-0! shadow-none! max-md:h-auto! max-md:rounded-[10px]! md:flex-wrap"
          tabClassName="h-9 cursor-pointer rounded-[10px]! px-3.5 text-[13.5px] opacity-75 transition-all hover:bg-[oklch(1_0.02_90/0.22)] hover:opacity-100 aria-selected:bg-[oklch(1_0.015_92/0.58)]! aria-selected:opacity-100 aria-selected:[backdrop-filter:blur(6px)_saturate(1.25)] aria-selected:shadow-[inset_0_1px_0_oklch(1_0.02_90/0.78),0_2px_8px_-2px_oklch(0.18_0.04_55/0.28)]! max-md:h-9 max-md:rounded-[10px]! max-md:px-3.5 max-md:text-[13px] md:px-4 md:text-sm"
        />
      </WoodPanel>

      {/* Borderless side-by-side comparison directly on warm paper: clear statement first, live UI right under */}
      <div
        id={`why-panel-${active}`}
        role="tabpanel"
        aria-label={topic}
        className="mt-10 grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-10"
      >
        {/* Left: xMatrix */}
        <figure className="m-0 flex min-w-0 flex-col gap-5">
          <figcaption className="min-h-[4.25rem]">
            <p className="inline-flex items-center gap-2 text-sm font-semibold tracking-[-0.01em] text-[var(--site-ink)]">
              <Image
                src="/brand/xmatrix-icon-transparent-128.png"
                alt=""
                width={18}
                height={18}
                className="size-[18px] shrink-0"
              />
              xMatrix
            </p>
            <p className="mt-1.5 text-[16.5px] leading-[1.5] font-medium text-[var(--site-ink)]">{ours}</p>
          </figcaption>

          <div
            className="h-[328px] w-full min-w-0 sm:h-[344px]"
            role="img"
            aria-label={`xMatrix: ${topic}`}
          >
            {near ? (
              <WhyXMatrixDemo topic={active} step={step} />
            ) : (
              <div className="h-full w-full rounded-[12px] bg-[var(--background)] shadow-[0_0_0_0.5px_oklch(0_0_0/0.14),0_22px_60px_-8px_oklch(0.25_0.03_60/0.22)]" />
            )}
          </div>
        </figure>

        {/* Right: Juggling tabs & terminals */}
        <figure className="m-0 flex min-w-0 flex-col gap-5">
          <figcaption className="min-h-[4.25rem]">
            <p className="text-sm font-medium tracking-[-0.01em] text-[var(--site-ink-muted)]">{others}</p>
            <p className="mt-1.5 text-[16.5px] leading-[1.5] text-[var(--site-ink-muted)]">{theirs}</p>
          </figcaption>

          <div
            className="h-[328px] w-full min-w-0 sm:h-[344px]"
            role="img"
            aria-label={`${others}: ${topic}`}
          >
            {near ? (
              <WhyCompetitorDemo topic={active} step={step} />
            ) : (
              <div className="h-full w-full rounded-[12px] bg-transparent" />
            )}
          </div>
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
