"use client";

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BellOff, Check, Hash } from "lucide-react";
import { Face } from "@/components/dashboard/face";
import { FleetMatrix, type FleetMatrixCell, type FleetMatrixColumn } from "@/components/dashboard/fleet-matrix";
import { MobileAvatarMatrix } from "@/components/dashboard/fleet-mobile";
import { buildSampleFleetView, type SampleFleetMachine } from "@/components/landing/fleet-preview";
import { useMedia } from "@/components/landing/use-media";
import type { PresentPerson } from "@/components/pages/page-chrome";
import { renderPageDocument } from "@/components/pages/page-document-render";
import { CardPen } from "@/components/pages/page-pen";
import { pageMentions, type PageReferenceTargets } from "@/components/pages/page-reference-chips";
import { WoodPanel } from "@/components/ui/material-surfaces";

/* Real xMatrix interfaces for each of the six comparison topics.
   Matches the homepage's live stages (#live-page, #conversations, #agents)
   directly: pure warm paper sheets with `.site-live-page-window` shadow (no
   invented chrome bars), CardPen positioned beside the active edited block,
   real walnut rail on the desktop conversation window, and real FleetMatrix. */

interface WriterSpec {
  name: string;
  harness: string | null;
  color: string;
}

const WRITER = {
  claude: { name: "claude", harness: "claude", color: "#b85a3b" },
  codex: { name: "codex", harness: "codex", color: "#2f6f5e" },
  cursor: { name: "cursor", harness: "cursor", color: "#7a5389" },
  gemini: { name: "gemini", harness: "gemini", color: "#4e6b9c" },
  alex: { name: "Alex", harness: null, color: "#4b6382" },
} as const satisfies Record<string, WriterSpec>;

type WriterKey = keyof typeof WRITER;

const REFERENCES: PageReferenceTargets = {
  pageTitle: () => null,
  channelName: () => null,
  openPage: () => {},
  openChannel: () => {},
  mentions: pageMentions([{ name: "Alex", handle: "alex" }], ["claude", "codex", "cursor", "gemini"]),
};

/** Same calm warm-paper sheet elevation as `.site-live-page-window` above. */
const LIVE_SHEET_CLASS =
  "xmatrix-app relative flex h-full w-full flex-col overflow-hidden rounded-[12px] bg-[var(--background)] text-[var(--site-ink)] shadow-[0_0_0_0.5px_oklch(0_0_0/0.14),0_22px_60px_-8px_oklch(0.25_0.03_60/0.22),0_6px_16px_oklch(0.25_0.03_60/0.09)]";

function makePerson(
  key: WriterKey,
  options: { editing?: boolean; doing?: string; thinking?: boolean } = {},
): PresentPerson {
  const writer = WRITER[key];
  const { editing = true, doing, thinking = false } = options;
  return {
    key: writer.name,
    name: writer.name,
    color: writer.color,
    agent: Boolean(writer.harness),
    detail: doing ?? (editing ? "writing" : "watching"),
    blockId: "",
    anchor: "",
    editing,
    thinking,
    ...(doing ? { doing } : {}),
    face: writer.harness
      ? { kind: "agent", name: writer.name, harness: writer.harness }
      : { kind: "external", name: writer.name },
  };
}

/**
 * Pure warm-paper xMatrix document rendered by `renderPageDocument`, with the
 * writer's `CardPen` pill aligned directly to the edited block (as in the real app).
 */
function RealPaperSheet({
  markdown,
  highlightBlockIndex,
  highlightColor,
  pen,
  topRight,
  footer,
}: {
  markdown: string;
  highlightBlockIndex?: number | null;
  highlightColor?: string;
  pen?: PresentPerson | null;
  topRight?: ReactNode;
  footer?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [penTop, setPenTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = hostRef.current;
    const container = containerRef.current;
    if (!target || !container) return;
    renderPageDocument(markdown, target, REFERENCES);
    const blocks = [...target.querySelectorAll<HTMLElement>("blockquote, li, p")].filter(
      (el) => !el.querySelector("li, p"),
    );
    let activeEl: HTMLElement | null = null;
    blocks.forEach((el, idx) => {
      el.style.borderRadius = "6px";
      el.style.paddingInline = "4px";
      el.style.marginInline = "-4px";
      el.style.transition = "background-color 280ms ease";
      if (highlightBlockIndex !== null && highlightBlockIndex !== undefined && idx === highlightBlockIndex && highlightColor) {
        el.style.backgroundColor = `color-mix(in oklch, ${highlightColor} 13%, transparent)`;
        activeEl = el;
      } else {
        el.style.backgroundColor = "transparent";
      }
    });
    if (activeEl) {
      const box = (activeEl as HTMLElement).getBoundingClientRect();
      const parentBox = container.getBoundingClientRect();
      setPenTop(Math.max(8, Math.round(box.top - parentBox.top + (box.height - 26) / 2)));
    } else {
      setPenTop(null);
    }
  }, [markdown, highlightBlockIndex, highlightColor]);

  return (
    <div className={LIVE_SHEET_CLASS} inert>
      <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 sm:px-7 sm:py-6">
        {topRight && <div className="mb-1.5 flex justify-end sm:mb-3">{topRight}</div>}
        <div
          ref={hostRef}
          className={`ProseMirror page-document text-[12px]! leading-[1.45]! sm:text-[14px]! sm:leading-[1.6]! [&_blockquote]:my-1.5! [&_blockquote]:py-1! sm:[&_blockquote]:my-2.5! sm:[&_blockquote]:py-1.5! [&_h2]:mt-0! [&_h2]:mb-1.5! [&_h2]:text-[14px]! [&_h2]:font-semibold! sm:[&_h2]:mb-3! sm:[&_h2]:text-[17px]! [&_li]:my-0! [&_li+li]:mt-1.5! sm:[&_li+li]:mt-2.5! [&_li_p]:my-0! [&_li.page-task]:gap-[0.65em]! [&_li.page-task>input]:mt-[0.18em]! sm:[&_li.page-task>input]:mt-[0.22em]! [&_li.page-task>input]:shadow-none! [&>p]:my-1! sm:[&>p]:my-1.5! [&_ul]:my-1! sm:[&_ul]:my-1.5! ${
            pen ? "pr-8 sm:pr-44" : ""
          }`}
          data-editable="false"
          translate="no"
        />
        {pen && penTop !== null && (
          <>
            {/* Desktop: full colored Agent pen pill standing in the reserved right margin */}
            <div
              className="pointer-events-none absolute right-4 z-10 hidden transition-[top] duration-300 sm:block"
              style={{ top: `${penTop}px` }}
            >
              <CardPen person={pen} />
            </div>
            {/* Phone: compact face-only pen at the right edge, matching the real mobile app */}
            <div
              className="pointer-events-none absolute right-2.5 z-10 inline-flex items-center justify-center rounded-full p-[2px] shadow-[0_3px_10px_-3px_rgba(0,0,0,0.28)] transition-[top] duration-300 sm:hidden"
              style={{ top: `${penTop}px`, backgroundColor: pen.color }}
            >
              <Face of={pen.face} size="xs" shape="circle" className="rounded-full bg-white" />
            </div>
          </>
        )}
      </div>
      {footer}
    </div>
  );
}

/* ── Topic 0: Where things stand ─────────────────────────────────────────── */

const STANDS_FRAMES = [
  {
    writer: null as WriterKey | null,
    highlight: null as number | null,
    md: [
      "## Launch: live docs",
      "",
      "> Three tracks running in parallel.",
      "",
      "- [ ] **Web** · @claude — auth fix (3/5)",
      "- [ ] **Mobile** · @codex — build 2.4",
      "- [ ] **Docs** · @cursor — drafting",
    ].join("\n"),
  },
  {
    writer: "claude" as WriterKey,
    highlight: 1,
    md: [
      "## Launch: live docs",
      "",
      "> Web merged. Mobile and docs running.",
      "",
      "- [x] **Web** · @claude — `v1.0.464`",
      "- [ ] **Mobile** · @codex — build 2.4",
      "- [ ] **Docs** · @cursor — drafting",
    ].join("\n"),
  },
  {
    writer: "codex" as WriterKey,
    highlight: 2,
    md: [
      "## Launch: live docs",
      "",
      "> Web and mobile ready. Waiting on docs.",
      "",
      "- [x] **Web** · @claude — `v1.0.464`",
      "- [x] **Mobile** · @codex — `TestFlight 2.4`",
      "- [ ] **Docs** · @cursor — drafting",
    ].join("\n"),
  },
  {
    writer: "cursor" as WriterKey,
    highlight: 3,
    md: [
      "## Launch: live docs",
      "",
      "> All three tracks shipped. Ready for Friday.",
      "",
      "- [x] **Web** · @claude — `v1.0.464`",
      "- [x] **Mobile** · @codex — `TestFlight 2.4`",
      "- [x] **Docs** · @cursor — 5/5 live",
    ].join("\n"),
  },
];

function WhereThingsStandDemo({ step }: { step: number }) {
  const frame = STANDS_FRAMES[step] ?? STANDS_FRAMES[3]!;
  return (
    <RealPaperSheet
      markdown={frame.md}
      highlightBlockIndex={frame.highlight}
      highlightColor={frame.writer ? WRITER[frame.writer].color : undefined}
      pen={frame.writer ? makePerson(frame.writer, { editing: true }) : null}
    />
  );
}

/* ── Topic 1: Your attention ─────────────────────────────────────────────── */

const ATTENTION_FRAMES = [
  {
    note: "Quiet · 0 interruptions",
    writer: null as WriterKey | null,
    highlight: null as number | null,
    md: [
      "## Launch: live docs",
      "",
      "- [ ] **Web** · @claude — running tests",
      "- [ ] **Mobile** · @codex — verifying build",
      "- [ ] **Docs** · @cursor — checking locales",
    ].join("\n"),
  },
  {
    note: "Updated 1m ago · 0 pings",
    writer: "claude" as WriterKey,
    highlight: 0,
    md: [
      "## Launch: live docs",
      "",
      "- [x] **Web** · @claude — 148 tests passed",
      "- [ ] **Mobile** · @codex — verifying build",
      "- [ ] **Docs** · @cursor — checking locales",
    ].join("\n"),
  },
  {
    note: "Updated just now · 0 pings",
    writer: "codex" as WriterKey,
    highlight: 1,
    md: [
      "## Launch: live docs",
      "",
      "- [x] **Web** · @claude — 148 tests passed",
      "- [x] **Mobile** · @codex — TestFlight 2.4",
      "- [ ] **Docs** · @cursor — checking locales",
    ].join("\n"),
  },
  {
    note: "Ready when you are · 0 pings",
    writer: "cursor" as WriterKey,
    highlight: 2,
    md: [
      "## Launch: live docs",
      "",
      "- [x] **Web** · @claude — 148 tests passed",
      "- [x] **Mobile** · @codex — TestFlight 2.4",
      "- [x] **Docs** · @cursor — 6 locales live",
    ].join("\n"),
  },
];

function YourAttentionDemo({ step }: { step: number }) {
  const frame = ATTENTION_FRAMES[step] ?? ATTENTION_FRAMES[3]!;
  return (
    <RealPaperSheet
      markdown={frame.md}
      highlightBlockIndex={frame.highlight}
      highlightColor={frame.writer ? WRITER[frame.writer].color : undefined}
      pen={frame.writer ? makePerson(frame.writer, { editing: false, doing: "updated" }) : null}
      topRight={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--site-ink)_5%,transparent)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--site-ink-muted)]">
          <BellOff className="size-3 shrink-0" />
          <span>{frame.note}</span>
        </span>
      }
    />
  );
}

/* ── Topic 2: Parallel work — authentic desktop app window (rail + list + page) ── */

interface ParallelThread {
  id: string;
  name: string;
  agent: WriterKey;
  workingText: string;
  doneText: string;
  doneAtStep: number;
}

const PARALLEL_THREADS: readonly ParallelThread[] = [
  {
    id: "auth",
    name: "Login redirect fix",
    agent: "claude",
    workingText: "Updating middleware…",
    doneText: "Merged → Launch",
    doneAtStep: 1,
  },
  {
    id: "ios",
    name: "iOS 2.4 release",
    agent: "codex",
    workingText: "Archiving build 318…",
    doneText: "TestFlight → Launch",
    doneAtStep: 2,
  },
  {
    id: "billing",
    name: "Billing webhooks",
    agent: "cursor",
    workingText: "Adding backoff…",
    doneText: "Verified → Launch",
    doneAtStep: 3,
  },
  {
    id: "docs",
    name: "API docs for v2",
    agent: "gemini",
    workingText: "Syncing examples…",
    doneText: "Draft ready",
    doneAtStep: 99,
  },
];

function ParallelWorkDemo({ step }: { step: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mdLines = [
    "## Launch",
    "",
    step >= 1 ? "- [x] **Login** · @claude — live" : "- [ ] **Login** · @claude — working",
    step >= 2 ? "- [x] **iOS 2.4** · @codex — TestFlight" : "- [ ] **iOS 2.4** · @codex — building",
    step >= 3 ? "- [x] **Billing** · @cursor — verified" : "- [ ] **Billing** · @cursor — coding",
  ].join("\n");

  const activeWriter: WriterKey | null = step === 1 ? "claude" : step === 2 ? "codex" : step >= 3 ? "cursor" : null;
  const highlightIdx = step >= 1 ? Math.min(step - 1, 2) : null;

  useLayoutEffect(() => {
    const target = hostRef.current;
    if (!target) return;
    renderPageDocument(mdLines, target, REFERENCES);
    const blocks = [...target.querySelectorAll<HTMLElement>("li > div > p")];
    blocks.forEach((el, idx) => {
      el.style.borderRadius = "6px";
      el.style.paddingInline = "4px";
      el.style.marginInline = "-4px";
      if (highlightIdx !== null && idx === highlightIdx && activeWriter) {
        el.style.backgroundColor = `color-mix(in oklch, ${WRITER[activeWriter].color} 13%, transparent)`;
      } else {
        el.style.backgroundColor = "transparent";
      }
    });
  }, [mdLines, highlightIdx, activeWriter]);

  return (
    <div
      className="xmatrix-app relative flex h-full w-full overflow-hidden rounded-[12px] bg-[var(--background)] text-[var(--site-ink)] shadow-[0_0_0_0.5px_oklch(0_0_0/0.18),0_22px_60px_-8px_oklch(0.25_0.03_60/0.26),0_6px_16px_oklch(0.25_0.03_60/0.1)]"
      inert
    >
      {/* Real desktop walnut navigation rail (matches #conversations above) */}
      <WoodPanel
        as="div"
        className="hidden w-12 shrink-0 flex-col items-center gap-3 rounded-none! pt-3.5 shadow-none! sm:flex"
      >
        <span className="inline-flex items-center gap-[4px]" aria-hidden>
          <span className="size-[8px] rounded-full bg-[#ff5f57]" />
          <span className="size-[8px] rounded-full bg-[#febc2e]" />
          <span className="size-[8px] rounded-full bg-[#28c840]" />
        </span>
        <span className="mt-1 flex size-7 items-center justify-center rounded-full bg-[oklch(1_0.012_92/0.46)] text-[10px] font-bold">
          AR
        </span>
      </WoodPanel>

      {/* Main split: paper conversation list + live page */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden sm:flex-row">
        <div className="flex min-w-0 shrink-0 flex-col bg-[color-mix(in_oklch,var(--site-ink)_3.5%,var(--background))] sm:w-[48%]">
          <div className="flex h-7 shrink-0 items-center justify-between px-3 sm:h-10 sm:px-3.5">
            <span className="text-[11.5px] font-bold text-[var(--site-ink)] sm:text-[13px]">Acme</span>
            <span className="rounded-md bg-[color-mix(in_oklch,var(--site-ink)_6%,transparent)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--site-ink-muted)] sm:text-[10px]">
              4 active
            </span>
          </div>
          <div className="overflow-hidden">
            {PARALLEL_THREADS.map((thread, idx) => {
              const done = step >= thread.doneAtStep;
              const justFinished = step === thread.doneAtStep;
              const agent = WRITER[thread.agent];
              return (
                <div
                  key={thread.id}
                  className={`flex items-center gap-2 px-3 py-1 transition-colors sm:px-3.5 sm:py-2 ${
                    idx >= 2 ? "max-sm:hidden" : ""
                  } ${justFinished ? "bg-[var(--background)]" : ""}`}
                >
                  <Hash className="size-3 shrink-0 text-[var(--site-ink-muted)]/75 sm:size-3.5" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] leading-tight font-semibold text-[var(--site-ink)] sm:text-[12px]">
                      {thread.name}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] leading-tight text-[var(--site-ink-muted)] sm:text-[11px]">
                      {done ? thread.doneText : thread.workingText}
                    </p>
                  </div>
                  <div className="relative shrink-0">
                    <Face
                      of={{ kind: "agent", name: agent.name, harness: agent.harness }}
                      size="xs"
                      shape="circle"
                      className="size-4! rounded-full sm:size-5!"
                    />
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-[1.5px] ring-[var(--background)] sm:size-2 ${
                        done ? "bg-[#2f855a]" : "bg-[#d97706]"
                      }`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-between bg-[var(--background)] px-3.5 py-2 sm:px-4 sm:py-3.5">
          <div
            ref={hostRef}
            className="ProseMirror page-document text-[11.5px]! leading-[1.4]! sm:text-[12.5px]! sm:leading-[1.5]! [&_h2]:mt-0! [&_h2]:mb-1! [&_h2]:text-[12.5px]! sm:[&_h2]:mb-2! sm:[&_h2]:text-[14.5px]! [&_li]:my-0! [&_li+li]:mt-1! sm:[&_li+li]:mt-2! [&_li_p]:my-0! [&_li.page-task]:gap-[0.6em]! [&_li.page-task>input]:mt-[0.14em]! sm:[&_li.page-task>input]:mt-[0.16em]! [&_li.page-task>input]:shadow-none! [&_ul]:my-0.5! sm:[&_ul]:my-1!"
            data-editable="false"
            translate="no"
          />
          {activeWriter && (
            <div className="hidden justify-end pt-2 sm:flex">
              <CardPen person={makePerson(activeWriter, { editing: true })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Topic 3: Across machines — real FleetMatrix on pure warm paper ──────── */

const FLEET_HARNESSES = ["claude", "codex", "cursor", "gemini"] as const;
const noop = () => {};
const FLEET_COLUMNS: FleetMatrixColumn[] = FLEET_HARNESSES.map((harness) => ({
  harness,
  summary: "",
  onOpen: noop,
}));

const quota = (percent: number) => [{ key: "5h", label: "5h", percent, detail: `5h ${percent}%` }];
const cellReady: FleetMatrixCell = { kind: "agent", state: "running", label: "Ready", detail: "Ready", working: 0, usage: [] };
const cellWorking = (count: number, percent?: number): FleetMatrixCell => ({
  kind: "agent",
  state: "running",
  label: `${count} working`,
  detail: `${count} working`,
  working: count,
  usage: percent === undefined ? [] : quota(percent),
});
const cellLimit: FleetMatrixCell = {
  kind: "agent",
  state: "attention",
  label: "5h limit",
  detail: "5h limit reached",
  working: 0,
  usage: quota(100),
};
const cellAbsent: FleetMatrixCell = { kind: "absent" };

function fleetForStep(step: number): SampleFleetMachine[] {
  const hitLimit = step >= 1;
  const handedOff = step >= 2;
  return [
    {
      key: "studio",
      name: "Mac Studio",
      os: "macos",
      online: true,
      cells: {
        claude: hitLimit ? cellLimit : cellWorking(2, 94),
        codex: cellReady,
        cursor: cellReady,
        gemini: cellReady,
      },
    },
    {
      key: "linux",
      name: "Linux server",
      os: "linux",
      online: true,
      cells: {
        claude: cellWorking(1, 38),
        codex: handedOff ? cellWorking(2, 41) : cellReady,
        cursor: cellAbsent,
        gemini: cellReady,
      },
    },
    {
      key: "windows",
      name: "Windows build",
      os: "windows",
      online: true,
      cells: {
        claude: cellReady,
        codex: cellReady,
        cursor: step >= 3 ? cellReady : cellWorking(1),
        gemini: cellAbsent,
      },
    },
  ];
}

function AcrossMachinesDemo({ step }: { step: number }) {
  const wide = useMedia("(min-width: 560px)");
  const space = useMemo(() => fleetForStep(step), [step]);
  const { rows, mobileRows, attention, workingCount } = useMemo(() => buildSampleFleetView(space), [space]);

  return (
    <div
      className={`${LIVE_SHEET_CLASS} justify-center bg-[var(--site-paper)]! px-4 py-3.5 sm:px-5 sm:py-4`}
      style={{ "--app-panel-paper": "var(--site-paper)" } as CSSProperties}
      inert
    >
      <div className="site-matrix w-full min-w-0 [zoom:0.62] sm:[zoom:0.84]">
        {wide ? (
          <FleetMatrix columns={FLEET_COLUMNS} rows={rows} selected={null} onSelect={noop} editors={[]} />
        ) : (
          <MobileAvatarMatrix
            columns={FLEET_COLUMNS}
            rows={mobileRows}
            ownMachineCount={space.length}
            attentionCount={attention}
            workingCount={workingCount}
            selected={null}
            onSelect={noop}
            editors={[]}
          />
        )}
      </div>
    </div>
  );
}

/* ── Topic 4: Shared decisions ───────────────────────────────────────────── */

function SharedDecisionsDemo({ step }: { step: number }) {
  const hasNewDecision = step >= 1;
  const md = [
    "## Decided",
    "",
    "- Ship to every Space on Friday, behind one switch.",
    ...(hasNewDecision ? ["- **Docs**: plain words, one example per page."] : []),
  ].join("\n");

  const syncedCount = step <= 1 ? 0 : step === 2 ? 2 : 3;
  const readers: readonly WriterKey[] = ["claude", "codex", "cursor"];

  return (
    <RealPaperSheet
      markdown={md}
      highlightBlockIndex={hasNewDecision ? 1 : null}
      highlightColor={WRITER.alex.color}
      pen={step === 1 ? makePerson("alex", { editing: true }) : null}
      footer={
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-3 sm:gap-2 sm:px-7 sm:pb-5">
          <span className="text-[11.5px] font-medium text-[var(--site-ink-muted)]">
            {syncedCount === 0 ? "Waiting for edit…" : "Read by:"}
          </span>
          {readers.map((key, idx) => {
            const synced = idx < syncedCount;
            const agent = WRITER[key];
            return (
              <span
                key={key}
                className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-1 text-[11.5px] font-medium transition-all ${
                  synced
                    ? "bg-[color-mix(in_oklch,#2f6f5e_12%,var(--background))] text-[#235447]"
                    : "bg-[color-mix(in_oklch,var(--site-ink)_5%,transparent)] text-[var(--site-ink-muted)] opacity-55"
                }`}
              >
                <Face
                  of={{ kind: "agent", name: agent.name, harness: agent.harness }}
                  size="xs"
                  shape="circle"
                  className="size-4! shrink-0 rounded-full"
                />
                <span className="capitalize">{agent.name}</span>
                {synced && <Check className="size-3 shrink-0" />}
              </span>
            );
          })}
        </div>
      }
    />
  );
}

/* ── Topic 5: Human in the loop ──────────────────────────────────────────── */

const HITL_FRAMES = [
  {
    writer: "claude" as WriterKey,
    pen: makePerson("claude", { editing: true }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with invite-only access for early teams…",
    ].join("\n"),
    highlight: 0,
  },
  {
    writer: "alex" as WriterKey,
    pen: makePerson("claude", { editing: false, thinking: true, doing: "waiting for you" }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with **open signup for everyone**",
    ].join("\n"),
    highlight: 0,
  },
  {
    writer: "claude" as WriterKey,
    pen: makePerson("claude", { editing: true }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with **open signup for everyone** — pricing and docs updated to match.",
    ].join("\n"),
    highlight: 0,
  },
  {
    writer: "claude" as WriterKey,
    pen: makePerson("claude", { editing: false, doing: "done" }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with **open signup for everyone** — pricing and docs updated to match.",
      "",
      "> Your edit stayed intact; Claude picked up right after it.",
    ].join("\n"),
    highlight: 0,
  },
];

function HumanInTheLoopDemo({ step }: { step: number }) {
  const frame = HITL_FRAMES[step] ?? HITL_FRAMES[3]!;
  return (
    <RealPaperSheet
      markdown={frame.md}
      highlightBlockIndex={frame.highlight}
      highlightColor={WRITER[frame.writer].color}
      pen={frame.pen}
    />
  );
}

/** Dispatches to the real xMatrix interface demo for comparison topic `topic` (0..5). */
export function WhyXMatrixDemo({ topic, step }: { topic: number; step: number }) {
  switch (topic) {
    case 0:
      return <WhereThingsStandDemo step={step} />;
    case 1:
      return <YourAttentionDemo step={step} />;
    case 2:
      return <ParallelWorkDemo step={step} />;
    case 3:
      return <AcrossMachinesDemo step={step} />;
    case 4:
      return <SharedDecisionsDemo step={step} />;
    default:
      return <HumanInTheLoopDemo step={step} />;
  }
}
