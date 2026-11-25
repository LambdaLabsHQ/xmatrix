"use client";

import { agentFaceUrl } from "@xmatrix/protocol";
import { AlertCircle, GitPullRequest, Lock, Terminal, Unplug } from "lucide-react";

/* Authentic developer-desk interfaces for the "Juggling tabs & terminals" side
   of Why xMatrix: macOS terminals, browser PRs, chat windows, and OS notification
   banners floating directly on the homepage's warm paper — ZERO outer grey box,
   with compact vertical sizing on phones so both sides fit inside one sticky viewport. */

function TrafficLights({ active = true }: { active?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[5px]" aria-hidden>
      <span className={`size-[8px] rounded-full sm:size-[9px] ${active ? "bg-[#ff5f57]" : "bg-current opacity-15"}`} />
      <span className={`size-[8px] rounded-full sm:size-[9px] ${active ? "bg-[#febc2e]" : "bg-current opacity-15"}`} />
      <span className={`size-[8px] rounded-full sm:size-[9px] ${active ? "bg-[#28c840]" : "bg-current opacity-15"}`} />
    </span>
  );
}

function VendorMark({ harness, className = "size-4" }: { harness: string; className?: string }) {
  const url = agentFaceUrl(harness);
  if (!url) return <Terminal className={className} />;
  // eslint-disable-next-line @next/next/no-img-element -- static vendor mark
  return <img src={url} alt="" className={`${className} shrink-0 rounded-[4px] object-contain`} />;
}

/** Matches `.site-app-window`'s authentic macOS elevation directly on warm paper. */
const MAC_WINDOW_DARK_SHADOW =
  "shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_22px_56px_-10px_oklch(0.22_0.03_58/0.34),0_6px_16px_oklch(0.22_0.03_58/0.14)]";

/* ── Topic 0: Where things stand — terminal, chat, and PR floating directly on paper ── */

function ScatteredToolsDemo({ step }: { step: number }) {
  const front = step % 3;
  return (
    <div className="flex h-full w-full flex-col justify-between gap-1.5 sm:gap-2.5" inert>
      {/* Window 1: Terminal */}
      <div
        className={`w-full overflow-hidden rounded-[10px] bg-[#1e1d1b] text-[#ebe7df] transition-all duration-300 sm:w-[92%] sm:rounded-[11px] ${
          front === 0
            ? "z-20 shadow-[0_18px_38px_-12px_oklch(0.2_0.03_58/0.42),0_4px_10px_oklch(0.2_0.03_58/0.16)]"
            : "opacity-85 shadow-[0_10px_24px_-12px_oklch(0.22_0.03_58/0.24)]"
        }`}
      >
        <div className="flex h-6 items-center gap-2 border-b border-white/[0.08] bg-[#282724] px-2.5 text-[10.5px] text-[#a8a298] sm:h-7 sm:px-3 sm:text-[11px]">
          <TrafficLights active={front === 0} />
          <span className="truncate font-mono">zsh — claude (web-editor)</span>
        </div>
        <div className="px-3 py-1.5 font-mono text-[11px] leading-[1.4] sm:px-3.5 sm:py-2.5 sm:text-[11.5px] sm:leading-[1.45]">
          <p className="truncate">
            <span className="text-[#d97757]">●</span> Fixing auth redirect · checks 3/5
          </p>
          <p className="hidden truncate text-[#9e988e] sm:block">branch fix/auth-v2 · ~/acme/web</p>
        </div>
      </div>

      {/* Window 2: Team chat */}
      <div
        className={`ml-auto w-full overflow-hidden rounded-[10px] bg-[var(--background)] text-[#262320] transition-all duration-300 sm:w-[92%] sm:rounded-[11px] ${
          front === 1
            ? "z-20 shadow-[0_0_0_0.5px_oklch(0_0_0/0.14),0_18px_38px_-12px_oklch(0.25_0.03_60/0.24)]"
            : "opacity-90 shadow-[0_0_0_0.5px_oklch(0_0_0/0.1),0_10px_24px_-12px_oklch(0.25_0.03_60/0.14)]"
        }`}
      >
        <div className="flex h-6 items-center gap-2 border-b border-black/[0.06] bg-[#f4f1ea] px-2.5 text-[10.5px] text-[#6e685f] sm:h-7 sm:px-3 sm:text-[11px]">
          <TrafficLights active={front === 1} />
          <span className="truncate font-medium">#eng-launch — Chat</span>
        </div>
        <div className="px-3 py-1.5 text-[11.5px] leading-[1.35] sm:px-3.5 sm:py-2.5 sm:text-[12px] sm:leading-[1.4]">
          <p className="truncate text-[#4a453f]">
            <span className="font-semibold text-[#262320]">Maya:</span> Did iOS 2.4 land or still on Codex’s branch?
          </p>
          <p className="mt-0.5 hidden truncate text-[11px] text-[#8a837a] sm:block">
            3 replies · check PR #566 and terminal tab 2
          </p>
        </div>
      </div>

      {/* Window 3: GitHub PR in Browser */}
      <div
        className={`mx-auto w-full overflow-hidden rounded-[10px] bg-[#ffffff] text-[#262320] transition-all duration-300 sm:w-[94%] sm:rounded-[11px] ${
          front === 2
            ? "z-20 shadow-[0_0_0_0.5px_oklch(0_0_0/0.14),0_18px_38px_-12px_oklch(0.25_0.03_60/0.24)]"
            : "opacity-90 shadow-[0_0_0_0.5px_oklch(0_0_0/0.1),0_10px_24px_-12px_oklch(0.25_0.03_60/0.14)]"
        }`}
      >
        <div className="flex h-6 items-center gap-2 border-b border-black/[0.06] bg-[#f4f1ea] px-2.5 text-[10.5px] text-[#6e685f] sm:h-7 sm:px-3 sm:text-[11px]">
          <TrafficLights active={front === 2} />
          <span className="flex-1 truncate rounded bg-white/85 px-2 py-0.5 text-center font-mono text-[9.5px] sm:text-[10px]">
            github.com/acme/app/pull/566
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 sm:px-3.5 sm:py-2.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[11.5px] font-semibold sm:text-[12px]">
              <GitPullRequest className="size-3.5 shrink-0 text-[#b45309]" />
              <span className="truncate">Build 2.4 auth handoff #566</span>
            </p>
            <p className="mt-0.5 hidden truncate text-[11px] text-[#6e685f] sm:block">2 unresolved · CI stale</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-[#92400e] sm:text-[10.5px]">
            Changes requested
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Topic 1: Your attention — macOS notification banners over an open terminal ── */

const NOTIFICATIONS = [
  {
    harness: "claude",
    app: "Claude Code",
    time: "now",
    body: "Allow running `rm -rf .next && pnpm build`?",
    action: "Allow",
  },
  {
    harness: "codex",
    app: "Codex CLI",
    time: "1m ago",
    body: "Which branch should I rebase mobile-2.4 onto?",
    action: "Reply",
  },
  {
    harness: "cursor",
    app: "Cursor",
    time: "2m ago",
    body: "Blocked: missing staging token in .env.local",
    action: "Open",
  },
  {
    harness: "gemini",
    app: "Terminal · tab 4",
    time: "3m ago",
    body: "Tests failed (14 errors) — waiting for input",
    action: "Inspect",
  },
];

function PingsPilingUpDemo({ step }: { step: number }) {
  const visibleCount = Math.min(step + 1, NOTIFICATIONS.length);
  return (
    <div className="relative h-full w-full" inert>
      <div
        className={`absolute inset-0 overflow-hidden rounded-[12px] bg-[#1e1d1b] p-3 font-mono text-[11px] leading-[1.6] text-[#ebe7df]/32 sm:p-4 sm:text-[11.5px] sm:leading-[1.7] ${MAC_WINDOW_DARK_SHADOW}`}
      >
        <div className="mb-2 flex items-center gap-2 sm:mb-3">
          <TrafficLights active={false} />
          <span className="truncate">editor — launch-notes.md</span>
        </div>
        <p># Friday launch checklist</p>
        <p>- Finalize pricing copy before noon</p>
        <p>- Verify TestFlight build 2.4 notes</p>
        <p className="hidden sm:block">- Review web redirect middleware</p>
      </div>

      <div className="relative z-10 ml-auto flex w-full max-w-[348px] flex-col gap-1.5 p-2 sm:gap-2 sm:p-3">
        {NOTIFICATIONS.slice(0, visibleCount).map((note, idx) => (
          <div
            key={note.app}
            className={`flex items-start gap-2 rounded-[10px] bg-[oklch(0.99_0.004_86/0.96)] px-2.5 py-1.5 text-[#221f1c] shadow-[0_10px_24px_-8px_rgba(15,12,8,0.36),0_0_0_0.5px_rgba(0,0,0,0.08)] transition-all duration-300 sm:gap-2.5 sm:rounded-[12px] sm:px-3 sm:py-2 ${
              idx >= 3 ? "max-sm:hidden" : ""
            }`}
          >
            <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[#f3efe8] sm:size-6 sm:rounded-[6px]">
              <VendorMark harness={note.harness} className="size-3.5 sm:size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-semibold sm:text-[11.5px]">{note.app}</span>
                <span className="shrink-0 text-[9.5px] text-[#7a736a] sm:text-[10px]">{note.time}</span>
              </div>
              <p className="mt-0.5 truncate text-[10.5px] leading-snug text-[#4e4841] sm:text-[11.5px]">{note.body}</p>
            </div>
            <span className="mt-0.5 shrink-0 rounded-md bg-[#ece7de] px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-[#3a352f] sm:px-2 sm:text-[10.5px]">
              {note.action}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Topic 2: Parallel work — 3-tab terminal copy-paste loop ─────────────── */

function TerminalCopyPasteDemo({ step }: { step: number }) {
  const activeTab = step <= 1 ? "claude" : "codex";
  const selected = step === 1;
  const pasted = step >= 3;

  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden rounded-[12px] bg-[#1e1d1b] text-[#ebe7df] ${MAC_WINDOW_DARK_SHADOW}`}
      inert
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.08] bg-[#282724] px-2.5 sm:h-9 sm:px-3">
        <TrafficLights active />
        <div className="ml-1 grid min-w-0 flex-1 grid-cols-3 gap-1">
          {(["claude", "codex", "gemini"] as const).map((tab) => {
            const isActive = activeTab === tab;
            return (
              <div
                key={tab}
                className={`flex items-center justify-center gap-1.5 rounded-[6px] px-2 py-0.5 text-[11px] font-medium transition-colors sm:py-1 sm:text-[11.5px] ${
                  isActive ? "bg-[#1e1d1b] text-[#f5f1e8] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)]" : "text-[#8f897f]"
                }`}
              >
                <span className="truncate">{tab}</span>
                {tab === "gemini" && <span className="size-1.5 shrink-0 rounded-full bg-[#e0a458]" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col justify-between p-3 font-mono text-[11px] leading-[1.45] sm:p-4 sm:text-[12px] sm:leading-[1.6]">
        {activeTab === "claude" ? (
          <div className="space-y-1.5 sm:space-y-2.5">
            <p className="truncate text-[#9e988e]">
              <span className="text-[#d97757]">›</span> what does login call now?
            </p>
            <div className="flex items-start gap-2">
              <span className="text-[#ebe7df]">●</span>
              <div
                className={`rounded-[5px] px-2 py-1 transition-colors ${
                  selected ? "bg-[#3a6ea5]/55 text-white ring-1 ring-[#6ca0dc]/60" : "text-[#e5e0d7]"
                }`}
              >
                <p>POST /v2/auth/session</p>
                <p className="text-[#c5bfb4]">{"body    { email, code }"}</p>
                <p className="text-[#c5bfb4]">{"returns { token, expiresAt }"}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5 sm:space-y-2.5">
            <p className="truncate text-[#9e988e]">
              <span className="text-[#74b49b]">›</span> wire mobile login to new API
            </p>
            <p className="truncate text-[#e5e0d7] sm:whitespace-normal">
              <span className="text-[#e0a458]">●</span> Which endpoint? I can’t see the web repo from this tab.
            </p>
            {pasted ? (
              <div className="rounded-[6px] border border-white/10 bg-white/[0.04] px-2 py-1 text-[#f5f1e8] sm:px-2.5 sm:py-1.5">
                <p className="text-[#74b49b]">› POST /v2/auth/session</p>
                <p className="text-[#c5bfb4]">{"  body    { email, code }"}</p>
                <p className="hidden text-[#c5bfb4] sm:block">{"  returns { token, expiresAt }"}</p>
              </div>
            ) : (
              <p className="text-[#8f897f]">
                <span className="text-[#74b49b]">›</span>{" "}
                <span className="inline-block h-3.5 w-1.5 translate-y-0.5 bg-[#ebe7df]/75" />
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-white/[0.08] pt-2 text-[10.5px] text-[#8f897f] sm:pt-2.5 sm:text-[11px]">
          <span>{activeTab === "claude" ? "~/acme/web" : "~/acme/ios"}</span>
          {selected && (
            <span className="rounded-md bg-white/12 px-2 py-0.5 font-sans text-[10.5px] font-semibold text-[#f5f1e8] sm:text-[11px]">
              ⌘C Copied
            </span>
          )}
          {step === 2 && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-sans text-[10.5px] font-medium text-[#d8d2c7] sm:text-[11px]">
              Switching tab…
            </span>
          )}
          {pasted && (
            <span className="rounded-md bg-white/12 px-2 py-0.5 font-sans text-[10.5px] font-semibold text-[#f5f1e8] sm:text-[11px]">
              ⌘V Pasted manually
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Topic 3: Across machines — 3 isolated machine windows directly on paper ── */

function IsolatedMachinesDemo({ step }: { step: number }) {
  const hitLimit = step >= 1;
  const linuxBlocked = step >= 2;
  const machines = [
    {
      title: "Mac Studio",
      tag: "Local only",
      harness: "claude",
      line1: hitLimit ? "5h usage limit reached — paused" : "claude › running auth tests (94%)",
      line2: "~/acme/web · cannot hand off to other machines",
      warn: hitLimit,
    },
    {
      title: "ssh linux-box",
      tag: "Disconnected",
      harness: "codex",
      line1: linuxBlocked ? "Error: no access to Mac Studio state" : "codex › idle (separate SSH session)",
      line2: "/srv/acme · local context only",
      warn: linuxBlocked,
    },
    {
      title: "Windows · PowerShell",
      tag: "Local only",
      harness: "cursor",
      line1: "cursor › isolated local workspace",
      line2: "C:\\acme · no visibility into Mac or Linux",
      warn: false,
    },
  ];

  return (
    <div className="flex h-full w-full flex-col justify-between gap-1.5 sm:gap-3" inert>
      {machines.map((m) => (
        <div
          key={m.title}
          className="flex flex-col overflow-hidden rounded-[10px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_14px_30px_-14px_oklch(0.2_0.03_58/0.36),0_3px_8px_-2px_oklch(0.2_0.03_58/0.14)] sm:rounded-[11px]"
        >
          <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 text-[10.5px] sm:h-7 sm:px-3 sm:text-[11px]">
            <div className="flex min-w-0 items-center gap-2">
              <TrafficLights active={m.warn} />
              <span className="truncate font-mono text-[#c9c3b8]">{m.title}</span>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[9.5px] whitespace-nowrap text-[#9b958a] sm:text-[10px]">
              {m.tag === "Disconnected" ? <Unplug className="size-2.5" /> : <Lock className="size-2.5" />}
              {m.tag}
            </span>
          </div>
          <div className="space-y-0.5 px-3 py-1.5 font-mono text-[11px] leading-snug sm:px-3.5 sm:py-2.5 sm:text-[11.5px]">
            <div className="flex items-center gap-2">
              <VendorMark harness={m.harness} className="size-3.5" />
              <span className={`truncate ${m.warn ? "text-[#e5a853]" : "text-[#dcd6cb]"}`}>{m.line1}</span>
            </div>
            <p className="hidden truncate pl-5 text-[10.5px] text-[#8f897f] sm:block">{m.line2}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Topic 4: Shared decisions — 3 separate sessions directly on paper ──── */

function RepeatedPromptsDemo({ step }: { step: number }) {
  const showSecond = step >= 1;
  const showForgot = step >= 2;
  return (
    <div className="flex h-full w-full flex-col justify-between gap-1.5 sm:gap-3" inert>
      <div className="overflow-hidden rounded-[10px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_12px_26px_-12px_oklch(0.2_0.03_58/0.3)] sm:rounded-[11px]">
        <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 font-mono text-[10px] text-[#9e988e] sm:h-7 sm:px-3 sm:text-[10.5px]">
          <span className="flex min-w-0 items-center gap-2">
            <TrafficLights active={false} />
            <span className="truncate">claude — session #1</span>
          </span>
          <span className="shrink-0">10:12</span>
        </div>
        <div className="px-3 py-1.5 font-mono text-[11px] leading-snug sm:px-3.5 sm:py-2.5 sm:text-[11.5px]">
          <p className="truncate text-[#ebe7df]">› remember: launch is Friday, not Thursday</p>
          <p className="mt-0.5 hidden text-[#8f897f] sm:block">● Got it, launching Friday.</p>
        </div>
      </div>

      <div
        className={`overflow-hidden rounded-[10px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_12px_26px_-12px_oklch(0.2_0.03_58/0.3)] transition-opacity duration-300 sm:rounded-[11px] ${
          showSecond ? "opacity-100" : "opacity-40"
        }`}
      >
        <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 font-mono text-[10px] text-[#9e988e] sm:h-7 sm:px-3 sm:text-[10.5px]">
          <span className="flex min-w-0 items-center gap-2">
            <TrafficLights active={false} />
            <span className="truncate">codex — session #1</span>
          </span>
          <span className="shrink-0">10:14</span>
        </div>
        <div className="px-3 py-1.5 font-mono text-[11px] leading-snug sm:px-3.5 sm:py-2.5 sm:text-[11.5px]">
          <p className="truncate text-[#ebe7df]">› remember: launch is Friday, not Thursday</p>
          <p className="mt-0.5 hidden text-[#8f897f] sm:block">● Understood.</p>
        </div>
      </div>

      <div
        className={`overflow-hidden rounded-[10px] bg-[#1e1d1b] text-[#ebe7df] transition-all duration-300 sm:rounded-[11px] ${
          showForgot
            ? "opacity-100 shadow-[0_16px_34px_-12px_oklch(0.2_0.03_58/0.44),0_0_0_1px_rgba(229,168,83,0.45)]"
            : "opacity-40 shadow-[0_12px_26px_-12px_oklch(0.2_0.03_58/0.3)]"
        }`}
      >
        <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 font-mono text-[10px] sm:h-7 sm:px-3 sm:text-[10.5px]">
          <span className="flex min-w-0 items-center gap-2">
            <TrafficLights active={showForgot} />
            <span className="truncate text-[#e5a853]">claude — new session</span>
          </span>
          <span className="shrink-0 text-[#9e988e]">next day</span>
        </div>
        <div className="px-3 py-1.5 font-mono text-[11px] leading-snug sm:px-3.5 sm:py-2.5 sm:text-[11.5px]">
          <p className="hidden truncate text-[#ebe7df] sm:block">› draft the launch email</p>
          <p className="flex items-center gap-1.5 text-[#e5a853] sm:mt-0.5">
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">Should I say it ships Thursday?</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Topic 5: Human in the loop — Ctrl+C interrupt & start over ──────────── */

function InterruptAndRedoDemo({ step }: { step: number }) {
  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden rounded-[12px] bg-[#1e1d1b] text-[#ebe7df] ${MAC_WINDOW_DARK_SHADOW}`}
      inert
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-white/[0.08] bg-[#282724] px-2.5 sm:h-9 sm:px-3">
        <div className="flex min-w-0 items-center gap-2">
          <TrafficLights active />
          <span className="truncate font-mono text-[11px] text-[#a8a298] sm:text-[11.5px]">zsh — claude</span>
        </div>
        {step >= 1 && (
          <span className="shrink-0 rounded bg-[#ef4444]/18 px-1.5 py-0.5 font-mono text-[10px] font-semibold whitespace-nowrap text-[#fca5a5] sm:text-[10.5px]">
            ^C Interrupted
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-3 font-mono text-[11px] leading-[1.45] sm:gap-2.5 sm:p-4 sm:text-[12px] sm:leading-[1.6]">
        <p className="truncate text-[#9e988e]">› draft the Friday launch announcement</p>

        <div className={step >= 1 ? "text-[#9e988e] line-through decoration-[#ef4444]/60" : "text-[#e5e0d7]"}>
          <p className="truncate">● Writing invite-only waitlist across 6 files…</p>
          <p className="hidden truncate pl-3 text-[#a8a298] sm:block">+ src/app/waitlist/page.tsx</p>
          <p className="hidden truncate pl-3 text-[#a8a298] sm:block">+ src/lib/invite-codes.ts</p>
        </div>

        {step >= 1 && <p className="text-[#fca5a5]">^C Operation cancelled by user</p>}

        {step >= 2 && (
          <p className="rounded-[6px] border border-white/10 bg-white/[0.04] px-2 py-1 text-[#f5f1e8] sm:px-2.5 sm:py-1.5">
            › stop — switched to open signup. Revert and start over.
          </p>
        )}

        {step >= 3 && <p className="truncate text-[#e5a853]">● Reverting 6 files… regenerating from scratch…</p>}
      </div>
    </div>
  );
}

/** Dispatches to the authentic competitor-desk demo for comparison topic `topic` (0..5). */
export function WhyCompetitorDemo({ topic, step }: { topic: number; step: number }) {
  switch (topic) {
    case 0:
      return <ScatteredToolsDemo step={step} />;
    case 1:
      return <PingsPilingUpDemo step={step} />;
    case 2:
      return <TerminalCopyPasteDemo step={step} />;
    case 3:
      return <IsolatedMachinesDemo step={step} />;
    case 4:
      return <RepeatedPromptsDemo step={step} />;
    default:
      return <InterruptAndRedoDemo step={step} />;
  }
}
