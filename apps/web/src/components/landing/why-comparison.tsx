"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
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

const STEP_MS = 1900;
const STEPS_PER_TOPIC = 4;

type Row = readonly [string, string, string];

/**
 * Scroll-driven sticky 6-topic comparison stage:
 * As the visitor scrolls vertically through `#why`, native CSS `position: sticky`
 * holds the walnut wood topic bar and both live interfaces in view, stepping
 * smoothly through all six topics while automatically sliding the active glass
 * tab into the center of the walnut bar. Clicking any tab scrolls smoothly to
 * that topic's stop so scrolling and clicking stay in sync.
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
  const [step, setStep] = useState(1);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [trackNode, setTrackNode] = useState<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const woodBarRef = useRef<HTMLDivElement | null>(null);
  const [nearRef, near] = useNear<HTMLDivElement>();

  const tabItems = useMemo<SegmentedTabItem<string>[]>(
    () => rows.map(([rowTopic], index) => ({ key: String(index), label: rowTopic })),
    [rows],
  );

  // Sync active topic with vertical scroll progress through the sticky runway.
  useEffect(() => {
    const track = trackNode;
    const sticky = stickyRef.current;
    if (!track || !sticky) return undefined;

    let raf = 0;
    const updateFromScroll = () => {
      raf = 0;
      const stickyTop = Number.parseFloat(window.getComputedStyle(sticky).top) || 0;
      const trackRect = track.getBoundingClientRect();
      const maxTravel = Math.max(1, track.offsetHeight - sticky.offsetHeight);
      const progress = Math.min(1, Math.max(0, (stickyTop - trackRect.top) / maxTravel));
      const next = Math.min(rows.length - 1, Math.floor(progress * rows.length));
      setActive((current) => (current === next ? current : next));
    };

    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(updateFromScroll);
    };

    updateFromScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [trackNode, rows.length]);

  // Automatically slide the walnut wood bar horizontally so the active tab stays centered on narrow screens.
  useEffect(() => {
    const bar = woodBarRef.current;
    if (!bar) return;
    const tablist = bar.querySelector<HTMLElement>(".app-segmented-track");
    const tab = tablist?.querySelectorAll<HTMLElement>(".app-segmented-tab")[active];
    if (!tablist || !tab) return;
    const maxScroll = tablist.scrollWidth - tablist.clientWidth;
    if (maxScroll <= 1) return;
    const targetLeft = tab.offsetLeft - (tablist.clientWidth - tab.offsetWidth) / 2;
    const clamped = Math.max(0, Math.min(targetLeft, maxScroll));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tablist.scrollTo({ left: clamped, behavior: reduced ? "auto" : "smooth" });
  }, [active]);

  // Track visibility & play the synchronized micro-story inside whichever topic is active.
  useEffect(() => {
    if (!trackNode) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(STEPS_PER_TOPIC - 1);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { threshold: 0.05 },
    );
    observer.observe(trackNode);
    return () => observer.disconnect();
  }, [trackNode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setStep(reduced ? STEPS_PER_TOPIC - 1 : 1);
  }, [active]);

  useEffect(() => {
    if (!inView || paused) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % STEPS_PER_TOPIC);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [inView, paused, active]);

  // Clicking a tab smoothly scrolls vertically to that topic's stop inside the runway.
  const selectTopic = (index: number) => {
    const next = (index + rows.length) % rows.length;
    setActive(next);
    const track = trackNode;
    const sticky = stickyRef.current;
    if (!track || !sticky) return;
    const stickyTop = Number.parseFloat(window.getComputedStyle(sticky).top) || 0;
    const trackDocTop = window.scrollY + track.getBoundingClientRect().top;
    const maxTravel = Math.max(1, track.offsetHeight - sticky.offsetHeight);
    const sliceCenter = next === 0 ? 0 : next === rows.length - 1 ? 1 : (next + 0.35) / rows.length;
    const targetY = Math.round(trackDocTop - stickyTop + sliceCenter * maxTravel);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: targetY, behavior: reduced ? "auto" : "smooth" });
  };

  const [topic, ours, theirs] = rows[active]!;

  return (
    <div
      ref={(node) => {
        nearRef(node);
        setTrackNode(node);
      }}
      className="relative mt-6 min-h-[calc(620px_+_1450px)] sm:mt-8 sm:min-h-[calc(760px_+_1600px)] lg:mt-9 lg:min-h-[calc(540px_+_1680px)]"
    >
      <div
        ref={stickyRef}
        className="sticky top-[4.75rem] sm:top-[5.25rem] lg:top-[5.75rem]"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {/* One compact rounded-rectangle walnut wood control bar (automatically slides horizontally on vertical scroll) */}
        <div ref={woodBarRef} className="max-w-full">
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
              tabClassName="h-[34px] cursor-pointer rounded-[10px]! px-3 text-[13px] opacity-75 transition-all hover:bg-[oklch(1_0.02_90/0.22)] hover:opacity-100 aria-selected:bg-[oklch(1_0.015_92/0.58)]! aria-selected:opacity-100 aria-selected:[backdrop-filter:blur(6px)_saturate(1.25)] aria-selected:shadow-[inset_0_1px_0_oklch(1_0.02_90/0.78),0_2px_8px_-2px_oklch(0.18_0.04_55/0.28)]! max-md:h-[34px] max-md:rounded-[10px]! max-md:px-3.5 max-md:text-[13px] sm:h-9 md:px-4 md:text-sm"
            />
          </WoodPanel>
        </div>

        {/* Borderless side-by-side comparison directly on warm paper */}
        <div
          id={`why-panel-${active}`}
          role="tabpanel"
          aria-label={topic}
          className="mt-4 grid grid-cols-1 gap-4 sm:mt-8 sm:gap-8 lg:mt-10 lg:grid-cols-2 lg:gap-10"
        >
          {/* Left: xMatrix */}
          <figure className="m-0 flex min-w-0 flex-col gap-2 sm:gap-4 lg:gap-5">
            <figcaption className="lg:min-h-[4.25rem]">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.01em] text-[var(--site-ink)] sm:gap-2 sm:text-sm">
                <Image
                  src="/brand/xmatrix-icon-transparent-128.png"
                  alt=""
                  width={18}
                  height={18}
                  className="size-4 shrink-0 sm:size-[18px]"
                />
                xMatrix
              </p>
              <p className="mt-0.5 text-[14px] leading-[1.4] font-medium text-[var(--site-ink)] sm:mt-1.5 sm:text-[16.5px] sm:leading-[1.5]">
                {ours}
              </p>
            </figcaption>

            <div
              className="h-[214px] w-full min-w-0 sm:h-[328px] lg:h-[344px]"
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
          <figure className="m-0 flex min-w-0 flex-col gap-2 sm:gap-4 lg:gap-5">
            <figcaption className="lg:min-h-[4.25rem]">
              <p className="text-[13px] font-medium tracking-[-0.01em] text-[var(--site-ink-muted)] sm:text-sm">
                {others}
              </p>
              <p className="mt-0.5 text-[14px] leading-[1.4] text-[var(--site-ink-muted)] sm:mt-1.5 sm:text-[16.5px] sm:leading-[1.5]">
                {theirs}
              </p>
            </figcaption>

            <div
              className="h-[214px] w-full min-w-0 sm:h-[328px] lg:h-[344px]"
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
    </div>
  );
}
