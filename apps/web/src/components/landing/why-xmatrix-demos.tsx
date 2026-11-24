"use client";

import { useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
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

/* Real xMatrix interfaces for each of the six comparison topics.
   Borderless warm-paper sheets reusing renderPageDocument, CardPen, Face,
   FleetMatrix, and MobileAvatarMatrix. */

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

const SHEET_SHADOW =
  "shadow-[0_18px_44px_-18px_oklch(0.24_0.03_58/0.22),0_2px_10px_-3px_oklch(0.24_0.03_58/0.08)]";

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

/** Borderless warm-paper sheet matching the real xMatrix page header and sheet. */
function XMatrixSheetFrame({
  breadcrumb,
  revision,
  rightSlot,
  children,
}: {
  breadcrumb: string;
  revision?: string;
  rightSlot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`xmatrix-app flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-[var(--site-paper)] text-[var(--site-ink)] ${SHEET_SHADOW}`}
      inert
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 bg-[color-mix(in_oklch,var(--site-paper)_86%,var(--background))] px-4">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--site-ink-muted)]">
          <span className="truncate font-semibold text-[var(--site-ink)]">{breadcrumb}</span>
          {revision && (
            <span className="shrink-0 rounded-md bg-[color-mix(in_oklch,var(--site-ink)_5.5%,transparent)] px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-[var(--site-ink-muted)]">
              {revision}
            </span>
          )}
        </div>
        {rightSlot}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

/** Stacked presence avatars with colored page-cursor rings, as in the real page header. */
function PresenceFaces({ writers }: { writers: readonly WriterKey[] }) {
  return (
    <div className="flex shrink-0 items-center -space-x-1">
      {writers.map((key) => {
        const w = WRITER[key];
        return (
          <span
            key={key}
            className="inline-flex rounded-full bg-[var(--site-paper)] p-[1.5px] ring-[1.5px]"
            style={{ "--tw-ring-color": w.color } as CSSProperties}
          >
            <Face
              of={w.harness ? { kind: "agent", name: w.name, harness: w.harness } : { kind: "external", name: w.name }}
              size="xs"
              shape="circle"
              className="size-[18px]! rounded-full"
            />
          </span>
        );
      })}
    </div>
  );
}

/**
 * Renders real markdown via xMatrix's `renderPageDocument`, highlights the changed
 * block with the writer's subtle pen tint, and pins the real `CardPen` pill cleanly.
 */
function RealPageBody({
  markdown,
  highlightBlockIndex,
  highlightColor,
  pen,
  compact = false,
  footer,
}: {
  markdown: string;
  highlightBlockIndex?: number | null;
  highlightColor?: string;
  pen?: PresentPerson | null;
  compact?: boolean;
  footer?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const target = hostRef.current;
    if (!target) return;
    renderPageDocument(markdown, target, REFERENCES);
    const blocks = [...target.querySelectorAll<HTMLElement>("blockquote, li, p")].filter(
      (el) => !el.querySelector("li, p"),
    );
    blocks.forEach((el, idx) => {
      el.style.borderRadius = "6px";
      el.style.transition = "background-color 280ms ease";
      if (highlightBlockIndex !== null && highlightBlockIndex !== undefined && idx === highlightBlockIndex && highlightColor) {
        el.style.backgroundColor = `color-mix(in oklch, ${highlightColor} 14%, transparent)`;
        el.style.paddingInline = "6px";
        el.style.marginInline = "-6px";
      } else {
        el.style.backgroundColor = "transparent";
        el.style.paddingInline = "";
        el.style.marginInline = "";
      }
    });
  }, [markdown, highlightBlockIndex, highlightColor]);

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between overflow-hidden">
      <div className={compact ? "min-h-0 flex-1 overflow-hidden px-3.5 py-1.5" : "min-h-0 flex-1 overflow-hidden px-4 py-3 sm:px-5 sm:py-3.5"}>
        <div
          ref={hostRef}
          className={
            compact
              ? "ProseMirror page-document text-[12px]! leading-[1.45]! [&_blockquote]:my-1! [&_blockquote]:py-0.5! [&_h2]:mt-0! [&_h2]:mb-1.5! [&_h2]:text-[13px]! [&_li]:my-0.5! [&_p]:my-0.5! [&_ul]:my-0.5!"
              : "ProseMirror page-document text-[12.5px]! leading-[1.5]! sm:text-[13px]! [&_blockquote]:my-1.5! [&_blockquote]:py-1! [&_h2]:mt-0! [&_h2]:mb-2! [&_h2]:text-[14.5px]! [&_li]:my-1! [&_p]:my-1! [&_ul]:my-1!"
          }
          data-editable="false"
          translate="no"
        />
      </div>
      {pen && !footer && (
        <div className={compact ? "flex shrink-0 justify-end px-3 pb-2.5" : "flex shrink-0 justify-end px-4 pb-3 sm:px-5"}>
          <CardPen person={pen} />
        </div>
      )}
      {footer}
    </div>
  );
}

/* ── Topic 0: Where things stand ─────────────────────────────────────────── */

const STANDS_FRAMES = [
  {
    rev: "r11",
    writer: null as WriterKey | null,
    highlight: null as number | null,
    md: [
      "## Launch: live docs",
      "",
      "> Three tracks running in parallel.",
      "",
      "- [ ] **Web** · @claude — auth fix (3/5 checks)",
      "- [ ] **Mobile** · @codex — building 2.4",
      "- [ ] **Docs** · @cursor — drafting guide",
    ].join("\n"),
  },
  {
    rev: "r12",
    writer: "claude" as WriterKey,
    highlight: 1,
    md: [
      "## Launch: live docs",
      "",
      "> Web merged. Mobile and docs still running.",
      "",
      "- [x] **Web** · @claude — live in `v1.0.464`",
      "- [ ] **Mobile** · @codex — building 2.4",
      "- [ ] **Docs** · @cursor — drafting guide",
    ].join("\n"),
  },
  {
    rev: "r13",
    writer: "codex" as WriterKey,
    highlight: 2,
    md: [
      "## Launch: live docs",
      "",
      "> Web and mobile ready. Waiting on docs.",
      "",
      "- [x] **Web** · @claude — live in `v1.0.464`",
      "- [x] **Mobile** · @codex — `TestFlight 2.4`",
      "- [ ] **Docs** · @cursor — drafting guide",
    ].join("\n"),
  },
  {
    rev: "r14",
    writer: "cursor" as WriterKey,
    highlight: 0,
    md: [
      "## Launch: live docs",
      "",
      "> All three tracks shipped. Ready for Friday.",
      "",
      "- [x] **Web** · @claude — live in `v1.0.464`",
      "- [x] **Mobile** · @codex — `TestFlight 2.4`",
      "- [x] **Docs** · @cursor — 5/5 published",
    ].join("\n"),
  },
];

function WhereThingsStandDemo({ step }: { step: number }) {
  const frame = STANDS_FRAMES[step] ?? STANDS_FRAMES[3]!;
  const pen = frame.writer ? makePerson(frame.writer, { editing: true }) : null;
  return (
    <XMatrixSheetFrame
      breadcrumb="Acme / Launch"
      revision={frame.rev}
      rightSlot={<PresenceFaces writers={["alex", "claude", "codex", "cursor"]} />}
    >
      <RealPageBody
        markdown={frame.md}
        highlightBlockIndex={frame.highlight}
        highlightColor={frame.writer ? WRITER[frame.writer].color : undefined}
        pen={pen}
      />
    </XMatrixSheetFrame>
  );
}

/* ── Topic 1: Your attention ─────────────────────────────────────────────── */

const ATTENTION_FRAMES = [
  {
    rev: "r14",
    note: "Quiet · 0 pings",
    writer: null as WriterKey | null,
    highlight: null as number | null,
    md: [
      "## Launch: live docs",
      "",
      "- [ ] **Web** · @claude — running test suite",
      "- [ ] **Mobile** · @codex — verifying iOS build",
      "- [ ] **Docs** · @cursor — checking screenshots",
    ].join("\n"),
  },
  {
    rev: "r15",
    note: "Updated 1m ago · 0 pings",
    writer: "claude" as WriterKey,
    highlight: 0,
    md: [
      "## Launch: live docs",
      "",
      "- [x] **Web** · @claude — 148 tests passed",
      "- [ ] **Mobile** · @codex — verifying iOS build",
      "- [ ] **Docs** · @cursor — checking screenshots",
    ].join("\n"),
  },
  {
    rev: "r16",
    note: "Updated just now · 0 pings",
    writer: "codex" as WriterKey,
    highlight: 1,
    md: [
      "## Launch: live docs",
      "",
      "- [x] **Web** · @claude — 148 tests passed",
      "- [x] **Mobile** · @codex — TestFlight 2.4 up",
      "- [ ] **Docs** · @cursor — checking screenshots",
    ].join("\n"),
  },
  {
    rev: "r17",
    note: "Ready · 0 pings",
    writer: "cursor" as WriterKey,
    highlight: 2,
    md: [
      "## Launch: live docs",
      "",
      "- [x] **Web** · @claude — 148 tests passed",
      "- [x] **Mobile** · @codex — TestFlight 2.4 up",
      "- [x] **Docs** · @cursor — live in 6 locales",
    ].join("\n"),
  },
];

function YourAttentionDemo({ step }: { step: number }) {
  const frame = ATTENTION_FRAMES[step] ?? ATTENTION_FRAMES[3]!;
  return (
    <XMatrixSheetFrame
      breadcrumb="Acme / Launch"
      revision={frame.rev}
      rightSlot={
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--site-ink)_5%,transparent)] px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-[var(--site-ink-muted)]">
          <BellOff className="size-3 shrink-0" />
          <span>{frame.note}</span>
        </span>
      }
    >
      <RealPageBody
        markdown={frame.md}
        highlightBlockIndex={frame.highlight}
        highlightColor={frame.writer ? WRITER[frame.writer].color : undefined}
        pen={frame.writer ? makePerson(frame.writer, { editing: false, doing: "updated page" }) : null}
      />
    </XMatrixSheetFrame>
  );
}

/* ── Topic 2: Parallel work ──────────────────────────────────────────────── */

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
  const mdLines = [
    "## Launch",
    "",
    step >= 1 ? "- [x] **Login** · @claude — live" : "- [ ] **Login** · @claude — working",
    step >= 2 ? "- [x] **iOS 2.4** · @codex — TestFlight" : "- [ ] **iOS 2.4** · @codex — building",
    step >= 3 ? "- [x] **Billing** · @cursor — verified" : "- [ ] **Billing** · @cursor — coding",
  ].join("\n");

  const activeWriter: WriterKey | null = step === 1 ? "claude" : step === 2 ? "codex" : step >= 3 ? "cursor" : null;
  const highlightIdx = step >= 1 ? Math.min(step - 1, 2) : null;

  return (
    <div
      className={`xmatrix-app flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-[var(--site-paper)] text-[var(--site-ink)] sm:flex-row ${SHEET_SHADOW}`}
      inert
    >
      {/* Left: real xMatrix paper channel list */}
      <div className="flex min-w-0 shrink-0 flex-col bg-[color-mix(in_oklch,var(--site-ink)_3%,var(--site-paper))] sm:w-[46%]">
          <div className="flex h-8 shrink-0 items-center justify-between px-3 sm:h-9">
            <span className="text-[11.5px] font-semibold text-[var(--site-ink)] sm:text-[12px]">Acme · Threads</span>
            <span className="rounded-full bg-[color-mix(in_oklch,var(--site-ink)_6%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--site-ink-muted)]">
              4 live
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
                  className={`flex items-center gap-2 px-3 py-1.5 transition-colors sm:gap-2.5 sm:py-2 ${
                    idx === 3 ? "max-sm:hidden" : ""
                  } ${justFinished ? "bg-[var(--site-paper)]" : ""}`}
                >
                  <Hash className="size-3 shrink-0 text-[var(--site-ink-muted)]/75 sm:size-3.5" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] leading-tight font-semibold text-[var(--site-ink)] sm:text-[12px]">
                      {thread.name}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] leading-tight text-[var(--site-ink-muted)] sm:text-[11px]">
                      {done ? thread.doneText : thread.workingText}
                    </p>
                  </div>
                  <div className="relative shrink-0">
                    <Face
                      of={{ kind: "agent", name: agent.name, harness: agent.harness }}
                      size="xs"
                      shape="circle"
                      className="size-5! rounded-full"
                    />
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-[1.5px] ring-[var(--site-paper)] ${
                        done ? "bg-[#2f855a]" : "bg-[#d97706]"
                      }`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: live Launch page receiving completed outcomes */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--site-paper)]">
          <div className="flex h-8 shrink-0 items-center justify-between px-3 sm:h-9">
            <span className="truncate text-[11.5px] font-semibold text-[var(--site-ink)]">Page · Launch</span>
            <span className="shrink-0 text-[10.5px] font-medium text-[var(--site-ink-muted)]">Auto-updated</span>
          </div>
        <RealPageBody
          markdown={mdLines}
          compact
          highlightBlockIndex={highlightIdx}
          highlightColor={activeWriter ? WRITER[activeWriter].color : undefined}
          pen={activeWriter ? makePerson(activeWriter, { editing: true }) : null}
        />
      </div>
    </div>
  );
}

/* ── Topic 3: Across machines ────────────────────────────────────────────── */

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

  const statusNote =
    step === 0
      ? "3 machines · 1 Space"
      : step === 1
        ? "Claude hit 5h limit"
        : "Linux Codex took over";

  return (
    <XMatrixSheetFrame
      breadcrumb="System Overview"
      rightSlot={
        <span className="shrink-0 rounded-full bg-[color-mix(in_oklch,var(--site-ink)_5%,transparent)] px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-[var(--site-ink-muted)]">
          {statusNote}
        </span>
      }
    >
      <div
        className="site-matrix flex min-h-0 flex-1 items-center overflow-hidden px-3 py-2"
        style={{ "--app-panel-paper": "var(--site-paper)", background: "transparent" } as CSSProperties}
      >
        <div className="w-full min-w-0 [zoom:0.86] sm:[zoom:0.82]">
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
    </XMatrixSheetFrame>
  );
}

/* ── Topic 4: Shared decisions ───────────────────────────────────────────── */

function SharedDecisionsDemo({ step }: { step: number }) {
  const hasNewDecision = step >= 1;
  const md = [
    "## Decided",
    "",
    "- Ship to every Space on Friday, behind one switch.",
    ...(hasNewDecision ? ["- **Pricing**: people pay — agents stay free on every plan."] : []),
  ].join("\n");

  const syncedCount = step <= 1 ? 0 : step === 2 ? 2 : 3;
  const readers: readonly WriterKey[] = ["claude", "codex", "cursor"];

  return (
    <XMatrixSheetFrame
      breadcrumb="Acme / Strategy"
      revision={hasNewDecision ? "r15" : "r14"}
      rightSlot={<PresenceFaces writers={["alex", "claude", "codex", "cursor"]} />}
    >
      <RealPageBody
        markdown={md}
        highlightBlockIndex={hasNewDecision ? 1 : null}
        highlightColor={WRITER.alex.color}
        pen={step === 1 ? makePerson("alex", { editing: true }) : null}
        footer={
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 bg-[color-mix(in_oklch,var(--site-paper)_86%,var(--background))] px-4 py-2.5 sm:gap-2">
            <span className="text-[11px] font-medium text-[var(--site-ink-muted)]">
              {syncedCount === 0 ? "Waiting for edit…" : "Synced on r15:"}
            </span>
            {readers.map((key, idx) => {
              const synced = idx < syncedCount;
              const agent = WRITER[key];
              return (
                <span
                  key={key}
                  className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 text-[11px] font-medium transition-all ${
                    synced
                      ? "bg-[color-mix(in_oklch,#2f6f5e_12%,var(--site-paper))] text-[#235447]"
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
    </XMatrixSheetFrame>
  );
}

/* ── Topic 5: Human in the loop ──────────────────────────────────────────── */

const HITL_FRAMES = [
  {
    rev: "r18",
    writer: "claude" as WriterKey,
    pen: makePerson("claude", { editing: true }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with invite-only access for early teams…",
    ].join("\n"),
    status: "Claude writing",
  },
  {
    rev: "r19",
    writer: "alex" as WriterKey,
    pen: makePerson("claude", { editing: false, thinking: true, doing: "waiting for you" }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with **open signup for everyone**",
    ].join("\n"),
    status: "Claude paused for you",
  },
  {
    rev: "r20",
    writer: "claude" as WriterKey,
    pen: makePerson("claude", { editing: true }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with **open signup for everyone** — pricing and docs updated to match.",
    ].join("\n"),
    status: "Claude continued",
  },
  {
    rev: "r20",
    writer: "claude" as WriterKey,
    pen: makePerson("claude", { editing: false, doing: "done" }),
    md: [
      "## Release announcement",
      "",
      "xMatrix opens Friday with **open signup for everyone** — pricing and docs updated to match.",
      "",
      "> Your wording kept intact; downstream tasks updated.",
    ].join("\n"),
    status: "Your words preserved",
  },
];

function HumanInTheLoopDemo({ step }: { step: number }) {
  const frame = HITL_FRAMES[step] ?? HITL_FRAMES[3]!;
  return (
    <XMatrixSheetFrame
      breadcrumb="Acme / Launch"
      revision={frame.rev}
      rightSlot={
        <span className="shrink-0 rounded-full bg-[color-mix(in_oklch,var(--site-ink)_5%,transparent)] px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-[var(--site-ink-muted)]">
          {frame.status}
        </span>
      }
    >
      <RealPageBody
        markdown={frame.md}
        highlightBlockIndex={0}
        highlightColor={WRITER[frame.writer].color}
        pen={frame.pen}
      />
    </XMatrixSheetFrame>
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
