"use client";

import { agentFaceUrl } from "@xmatrix/protocol";
import { AlertCircle, GitPullRequest, Lock, Terminal, Unplug } from "lucide-react";

/* Authentic developer-desk interfaces for the "Juggling tabs & terminals" side
   of Why xMatrix: warm charcoal macOS terminals, browser PR views, and macOS
   notification banners tuned to sit naturally beside the homepage's warm paper. */

function TrafficLights({ active = true }: { active?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[5px]" aria-hidden>
      <span className={`size-[9px] rounded-full ${active ? "bg-[#ff5f57]" : "bg-current opacity-15"}`} />
      <span className={`size-[9px] rounded-full ${active ? "bg-[#febc2e]" : "bg-current opacity-15"}`} />
      <span className={`size-[9px] rounded-full ${active ? "bg-[#28c840]" : "bg-current opacity-15"}`} />
    </span>
  );
}

function VendorMark({ harness, className = "size-4" }: { harness: string; className?: string }) {
  const url = agentFaceUrl(harness);
  if (!url) return <Terminal className={className} />;
  // eslint-disable-next-line @next/next/no-img-element -- static vendor mark
  return <img src={url} alt="" className={`${className} shrink-0 rounded-[4px] object-contain`} />;
}

/** Shared borderless soft-paper desk surface holding the competitor's window(s). */
function DeskMat({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-[color-mix(in_oklch,var(--site-ink)_4.2%,var(--background))] ${className}`}
      inert
    >
      {children}
    </div>
  );
}

/* ── Topic 0: Where things stand — juggling terminal, chat, and GitHub PR ── */

function ScatteredToolsDemo({ step }: { step: number }) {
  const front = step % 3; // 0 = terminal, 1 = chat, 2 = PR
  return (
    <DeskMat className="justify-between gap-2 p-3 sm:p-3.5">
      {/* Window 1: Terminal */}
      <div
        className={`w-full overflow-hidden rounded-[10px] bg-[#1e1d1b] text-[#ebe7df] transition-all duration-300 sm:w-[92%] ${
          front === 0
            ? "z-20 shadow-[0_12px_26px_-10px_rgba(0,0,0,0.42),0_0_0_0.5px_rgba(255,255,255,0.14)]"
            : "opacity-80 shadow-[0_4px_12px_-8px_rgba(0,0,0,0.22)]"
        }`}
      >
        <div className="flex h-6 items-center gap-2 border-b border-white/[0.08] bg-[#282724] px-2.5 text-[10.5px] text-[#a8a298]">
          <TrafficLights active={front === 0} />
          <span className="truncate font-mono">zsh — claude (web-editor)</span>
        </div>
        <div className="px-3 py-2 font-mono text-[11px] leading-[1.45]">
          <p className="truncate">
            <span className="text-[#d97757]">●</span> Fixing auth redirect · checks 3/5
          </p>
          <p className="truncate text-[#9e988e]">branch fix/auth-v2 · ~/acme/web</p>
        </div>
      </div>

      {/* Window 2: Team chat */}
      <div
        className={`ml-auto w-full overflow-hidden rounded-[10px] bg-[#fcfbf9] text-[#262320] transition-all duration-300 sm:w-[92%] ${
          front === 1
            ? "z-20 shadow-[0_12px_26px_-10px_rgba(30,24,18,0.22),0_0_0_0.5px_rgba(0,0,0,0.12)]"
            : "opacity-85 shadow-[0_4px_12px_-8px_rgba(30,24,18,0.12),0_0_0_0.5px_rgba(0,0,0,0.08)]"
        }`}
      >
        <div className="flex h-6 items-center gap-2 border-b border-black/[0.07] bg-[#f4f2ee] px-2.5 text-[10.5px] text-[#6e685f]">
          <TrafficLights active={front === 1} />
          <span className="truncate font-medium">#eng-launch — Chat</span>
        </div>
        <div className="px-3 py-2 text-[11.5px] leading-[1.4]">
          <p className="truncate text-[#4a453f]">
            <span className="font-semibold text-[#262320]">Maya:</span> Did iOS 2.4 land or still on Codex’s branch?
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-[#8a837a]">3 replies · check PR #566 and terminal tab 2</p>
        </div>
      </div>

      {/* Window 3: GitHub PR in Browser */}
      <div
        className={`mx-auto w-full overflow-hidden rounded-[10px] bg-[#ffffff] text-[#262320] transition-all duration-300 sm:w-[94%] ${
          front === 2
            ? "z-20 shadow-[0_12px_26px_-10px_rgba(30,24,18,0.22),0_0_0_0.5px_rgba(0,0,0,0.12)]"
            : "opacity-85 shadow-[0_4px_12px_-8px_rgba(30,24,18,0.12),0_0_0_0.5px_rgba(0,0,0,0.08)]"
        }`}
      >
        <div className="flex h-6 items-center gap-2 border-b border-black/[0.07] bg-[#f4f2ee] px-2.5 text-[10.5px] text-[#6e685f]">
          <TrafficLights active={front === 2} />
          <span className="flex-1 truncate rounded bg-white/80 px-2 py-0.5 text-center font-mono text-[10px]">
            github.com/acme/app/pull/566
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[11.5px] font-semibold">
              <GitPullRequest className="size-3.5 shrink-0 text-[#b45309]" />
              <span className="truncate">Build 2.4 auth handoff #566</span>
            </p>
            <p className="mt-0.5 truncate text-[10.5px] text-[#6e685f]">2 unresolved · CI stale</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-[#92400e]">
            Changes requested
          </span>
        </div>
      </div>
    </DeskMat>
  );
}

/* ── Topic 1: Your attention — macOS notification banners piling up ──────── */

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
    <DeskMat className="p-3 sm:p-3.5">
      {/* Recessed dim editor behind notifications */}
      <div className="pointer-events-none absolute inset-3 overflow-hidden rounded-[10px] bg-[#1e1d1b]/92 p-3 font-mono text-[11px] leading-[1.6] text-[#ebe7df]/30 sm:inset-3.5">
        <div className="mb-2 flex items-center gap-2">
          <TrafficLights active={false} />
          <span className="truncate">editor — launch-notes.md</span>
        </div>
        <p># Friday launch checklist</p>
        <p>- Finalize pricing copy before noon</p>
        <p>- Verify TestFlight build 2.4 notes</p>
        <p>- Review web redirect middleware</p>
      </div>

      {/* Authentic stacked macOS notification banners */}
      <div className="relative z-10 ml-auto flex w-full max-w-[330px] flex-col gap-1.5 pt-1">
        {NOTIFICATIONS.slice(0, visibleCount).map((note) => (
          <div
            key={note.app}
            className="flex items-start gap-2.5 rounded-[11px] bg-[oklch(0.99_0.004_86/0.95)] px-3 py-2 text-[#221f1c] shadow-[0_8px_20px_-8px_rgba(20,16,12,0.3),0_0_0_0.5px_rgba(0,0,0,0.09)] transition-all duration-300"
          >
            <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f3efe8] ring-1 ring-black/[0.06]">
              <VendorMark harness={note.harness} className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11.5px] font-semibold">{note.app}</span>
                <span className="shrink-0 text-[10px] text-[#7a736a]">{note.time}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] leading-snug text-[#4e4841]">{note.body}</p>
            </div>
            <span className="mt-0.5 shrink-0 rounded-md bg-[#ece7de] px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-[#3a352f]">
              {note.action}
            </span>
          </div>
        ))}
      </div>
    </DeskMat>
  );
}

/* ── Topic 2: Parallel work — 3-tab terminal copy-paste loop ─────────────── */

function TerminalCopyPasteDemo({ step }: { step: number }) {
  const activeTab = step <= 1 ? "claude" : "codex";
  const selected = step === 1;
  const pasted = step >= 3;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_18px_42px_-16px_rgba(20,16,12,0.34)]"
      inert
    >
      {/* macOS Terminal Tab Bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.08] bg-[#282724] px-3">
        <TrafficLights active />
        <div className="ml-1 grid min-w-0 flex-1 grid-cols-3 gap-1">
          {(["claude", "codex", "gemini"] as const).map((tab) => {
            const isActive = activeTab === tab;
            return (
              <div
                key={tab}
                className={`flex items-center justify-center gap-1.5 rounded-[6px] px-2 py-1 text-[11.5px] font-medium transition-colors ${
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

      {/* Terminal Body */}
      <div className="relative flex min-h-0 flex-1 flex-col justify-between p-4 font-mono text-[12px] leading-[1.6]">
        {activeTab === "claude" ? (
          <div className="space-y-2.5">
            <p className="text-[#9e988e]">
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
          <div className="space-y-2.5">
            <p className="text-[#9e988e]">
              <span className="text-[#74b49b]">›</span> wire the mobile app’s login to the new API
            </p>
            <p className="text-[#e5e0d7]">
              <span className="text-[#e0a458]">●</span> Which endpoint does it call? I can’t see the web repo from this tab.
            </p>
            {pasted ? (
              <div className="rounded-[6px] border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[#f5f1e8]">
                <p className="text-[#74b49b]">› POST /v2/auth/session</p>
                <p className="text-[#c5bfb4]">{"  body    { email, code }"}</p>
                <p className="text-[#c5bfb4]">{"  returns { token, expiresAt }"}</p>
              </div>
            ) : (
              <p className="text-[#8f897f]">
                <span className="text-[#74b49b]">›</span>{" "}
                <span className="inline-block h-3.5 w-1.5 translate-y-0.5 bg-[#ebe7df]/75" />
              </p>
            )}
          </div>
        )}

        {/* Crisp keyboard shortcut HUD showing manual copy-paste */}
        <div className="flex items-center justify-between border-t border-white/[0.08] pt-2.5 text-[11px] text-[#8f897f]">
          <span>{activeTab === "claude" ? "~/acme/web" : "~/acme/ios"}</span>
          {selected && (
            <span className="rounded-md bg-white/12 px-2 py-0.5 font-sans text-[11px] font-semibold text-[#f5f1e8]">
              ⌘C Copied
            </span>
          )}
          {step === 2 && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 font-sans text-[11px] font-medium text-[#d8d2c7]">
              Switching tab…
            </span>
          )}
          {pasted && (
            <span className="rounded-md bg-white/12 px-2 py-0.5 font-sans text-[11px] font-semibold text-[#f5f1e8]">
              ⌘V Pasted manually
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Topic 3: Across machines — 3 isolated machine terminals ─────────────── */

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
    <DeskMat className="justify-between gap-2 p-3 sm:p-3.5">
      {machines.map((m) => (
        <div
          key={m.title}
          className="flex flex-col overflow-hidden rounded-[9px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_6px_16px_-10px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(255,255,255,0.08)]"
        >
          <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 text-[10.5px]">
            <div className="flex min-w-0 items-center gap-2">
              <TrafficLights active={m.warn} />
              <span className="truncate font-mono text-[#c9c3b8]">{m.title}</span>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] whitespace-nowrap text-[#9b958a]">
              {m.tag === "Disconnected" ? <Unplug className="size-2.5" /> : <Lock className="size-2.5" />}
              {m.tag}
            </span>
          </div>
          <div className="space-y-0.5 px-3 py-2 font-mono text-[11px] leading-snug">
            <div className="flex items-center gap-2">
              <VendorMark harness={m.harness} className="size-3.5" />
              <span className={`truncate ${m.warn ? "text-[#e5a853]" : "text-[#dcd6cb]"}`}>{m.line1}</span>
            </div>
            <p className="truncate pl-5 text-[10.5px] text-[#8f897f]">{m.line2}</p>
          </div>
        </div>
      ))}
    </DeskMat>
  );
}

/* ── Topic 4: Shared decisions — re-explain & forget in new session ──────── */

function RepeatedPromptsDemo({ step }: { step: number }) {
  const showSecond = step >= 1;
  const showForgot = step >= 2;
  return (
    <DeskMat className="justify-between gap-2 p-3 sm:p-3.5">
      {/* Session 1 */}
      <div className="overflow-hidden rounded-[9px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_0_0_0.5px_rgba(255,255,255,0.08)]">
        <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 font-mono text-[10.5px] text-[#9e988e]">
          <span className="flex min-w-0 items-center gap-2">
            <TrafficLights active={false} />
            <span className="truncate">claude — session #1</span>
          </span>
          <span className="shrink-0">10:12</span>
        </div>
        <div className="px-3 py-2 font-mono text-[11.5px] leading-snug">
          <p className="truncate text-[#ebe7df]">› remember: people pay, agents stay free</p>
          <p className="mt-0.5 text-[#8f897f]">● Got it, I’ll keep agents free.</p>
        </div>
      </div>

      {/* Session 2 */}
      <div
        className={`overflow-hidden rounded-[9px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_0_0_0.5px_rgba(255,255,255,0.08)] transition-opacity duration-300 ${
          showSecond ? "opacity-100" : "opacity-35"
        }`}
      >
        <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 font-mono text-[10.5px] text-[#9e988e]">
          <span className="flex min-w-0 items-center gap-2">
            <TrafficLights active={false} />
            <span className="truncate">codex — session #1</span>
          </span>
          <span className="shrink-0">10:14</span>
        </div>
        <div className="px-3 py-2 font-mono text-[11.5px] leading-snug">
          <p className="truncate text-[#ebe7df]">› remember: people pay, agents stay free</p>
          <p className="mt-0.5 text-[#8f897f]">● Understood.</p>
        </div>
      </div>

      {/* Session 3: Next day / new session forgets */}
      <div
        className={`overflow-hidden rounded-[9px] bg-[#1e1d1b] text-[#ebe7df] transition-all duration-300 ${
          showForgot
            ? "opacity-100 shadow-[0_10px_24px_-10px_rgba(0,0,0,0.45),0_0_0_1px_rgba(229,168,83,0.4)]"
            : "opacity-35 shadow-[0_0_0_0.5px_rgba(255,255,255,0.08)]"
        }`}
      >
        <div className="flex h-6 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#282724] px-2.5 font-mono text-[10.5px]">
          <span className="flex min-w-0 items-center gap-2">
            <TrafficLights active={showForgot} />
            <span className="truncate text-[#e5a853]">claude — new session</span>
          </span>
          <span className="shrink-0 text-[#9e988e]">next day</span>
        </div>
        <div className="px-3 py-2 font-mono text-[11.5px] leading-snug">
          <p className="truncate text-[#ebe7df]">› update the pricing table</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[#e5a853]">
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">Should I charge $10 per agent seat?</span>
          </p>
        </div>
      </div>
    </DeskMat>
  );
}

/* ── Topic 5: Human in the loop — Ctrl+C interrupt & start over ──────────── */

function InterruptAndRedoDemo({ step }: { step: number }) {
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-[#1e1d1b] text-[#ebe7df] shadow-[0_18px_42px_-16px_rgba(20,16,12,0.34)]"
      inert
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/[0.08] bg-[#282724] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <TrafficLights active />
          <span className="truncate font-mono text-[11.5px] text-[#a8a298]">zsh — claude</span>
        </div>
        {step >= 1 && (
          <span className="shrink-0 rounded bg-[#ef4444]/18 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold whitespace-nowrap text-[#fca5a5]">
            ^C Interrupted
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3.5 font-mono text-[11.5px] leading-[1.55] sm:gap-2.5 sm:p-4 sm:text-[12px]">
        <p className="truncate text-[#9e988e]">› draft the Friday launch announcement</p>

        <div className={step >= 1 ? "text-[#9e988e] line-through decoration-[#ef4444]/60" : "text-[#e5e0d7]"}>
          <p className="truncate">● Writing invite-only waitlist across 6 files…</p>
          <p className="truncate pl-3 text-[#a8a298]">+ src/app/waitlist/page.tsx</p>
          <p className="truncate pl-3 text-[#a8a298]">+ src/lib/invite-codes.ts</p>
        </div>

        {step >= 1 && <p className="text-[#fca5a5]">^C Operation cancelled by user</p>}

        {step >= 2 && (
          <p className="rounded-[6px] border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[#f5f1e8]">
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
