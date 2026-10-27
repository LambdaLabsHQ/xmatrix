import type { CSSProperties, ReactNode } from "react";
import { BellOff } from "lucide-react";
import type { WhyScenes } from "@/lib/landing-copy";

/* Why xMatrix's examples: one small scene per row and side, drawn in HTML
   and played on one 8-second loop (site.css, "Why xMatrix scenes"). An
   element marked data-in="n" arrives at step n and stays until the loop
   restarts; data-out="n" leaves at step n; data-pulse="n" lights in its
   colour at step n; data-third="n" shows only in that third of the loop.
   Under reduced motion every scene rests on its last step. */

const AGENT = {
  claude: { name: "Claude", initial: "C", color: "#b85a3b" },
  codex: { name: "Codex", initial: "X", color: "#2f6f5e" },
  cursor: { name: "Cursor", initial: "U", color: "#7a5389" },
  daniel: { name: "Daniel", initial: "D", color: "#4b6382" },
} as const;
type Who = keyof typeof AGENT;
const AGENTS: readonly Who[] = ["claude", "codex", "cursor"];

const tint = (who: Who) => ({ "--why-c": AGENT[who].color }) as CSSProperties;

function Face({ who, className = "" }: { who: Who; className?: string }) {
  return <span className={`why-face ${className}`} style={tint(who)}>{AGENT[who].initial}</span>;
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="why-page">
      <p className="why-page-title">{title}</p>
      {children}
    </div>
  );
}

/** A page line whose status turns from one word to another at a step, lit in its owner's colour. */
function StatusLine({ label, who, step, from, to }: { label: string; who: Who; step: number; from: string; to: string }) {
  return (
    <p className="why-line" style={tint(who)} data-pulse={step}>
      <span className="why-dot" />
      <span>
        {label} ·{" "}
        <span className="why-swap">
          <span data-out={step}>{from}</span>
          <span data-in={step} className="why-strong">{to}</span>
        </span>
      </span>
    </p>
  );
}

type Scene = (copy: WhyScenes) => ReactNode;

/** Each row's pair of scenes, xMatrix first, in the order of the copy's rows. */
export const WHY_SCENES: readonly (readonly [Scene, Scene])[] = [
  // Where things stand: one page whose lines move ↔ windows taking turns on top.
  [
    (c) => (
      <Page title={c.page}>
        <StatusLine label={c.web} who="claude" step={1} from={c.progress[0]} to={c.merged} />
        <StatusLine label={c.mobile} who="codex" step={2} from={c.progress[1]} to={c.merged} />
        <StatusLine label={c.docs} who="daniel" step={3} from={c.progress[2]} to={c.merged} />
      </Page>
    ),
    (c) => (
      <div className="why-stack">
        {[[c.terminal, c.terminalLine], [c.thread, c.threadLine], ["PR #212", c.prLine]].map(([title, line], index) => (
          <div key={title} className="why-win" data-third={index + 1} style={{ "--i": index } as CSSProperties}>
            <p className="why-win-bar"><span className="why-lights" />{title}</p>
            <p className="why-win-body">{line}</p>
          </div>
        ))}
      </div>
    ),
  ],
  // Your attention: the page moves on its own, nobody pings ↔ pings pile up.
  [
    (c) => (
      <div className="why-split">
        <Page title={c.page}>
          <StatusLine label={c.web} who="claude" step={1} from={c.progress[0]} to={c.merged} />
          <StatusLine label={c.mobile} who="codex" step={3} from={c.progress[1]} to={c.merged} />
        </Page>
        <p className="why-quiet"><BellOff className="size-3" />{c.quiet}</p>
      </div>
    ),
    (c) => (
      <div className="why-toasts">
        {AGENTS.map((who, index) => (
          <p key={who} className="why-toast" data-in={index + 1} style={tint(who)}>
            <Face who={who} />{c.pings[index]}
          </p>
        ))}
      </div>
    ),
  ],
  // Parallel work: conversations write into the page ↔ you carry results between tabs.
  [
    (c) => (
      <div className="why-split">
        <div className="why-convos">
          {AGENTS.map((who, index) => (
            <p key={who} className="why-convo" style={tint(who)}>
              <Face who={who} />
              <span className="why-typing" data-pulse={index + 1} />
              <span className="why-fly" data-fly={index + 1} />
            </p>
          ))}
        </div>
        <Page title={c.page}>
          {[c.web, c.mobile, c.docs].map((label, index) => (
            <p key={label} className="why-line" data-in={index + 1} style={tint(AGENTS[index]!)}>
              <span className="why-dot" />{label.split(" · ")[0]} · <span className="why-strong">{c.merged}</span>
            </p>
          ))}
        </Page>
      </div>
    ),
    (c) => (
      <div className="why-tabs">
        <div className="why-tab-strip">
          {AGENTS.map((who, index) => (
            <span key={who} className="why-tab" data-third={index + 1} style={tint(who)}>{AGENT[who].name}</span>
          ))}
        </div>
        <div className="why-tab-body">
          {[c.copied, c.paste, c.waiting].map((line, index) => (
            <p key={line} className="why-tab-pane" data-third={index + 1}>
              <span className="why-kbd">{["⌘C", "⌘V", "…"][index]}</span>{line}
            </p>
          ))}
        </div>
      </div>
    ),
  ],
  // Across machines: every machine joins one Space ↔ each agent alone on its machine.
  [
    (c) => (
      <div className="why-net">
        <svg className="why-wires" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden>
          <path d="M50 78 C50 40 150 50 150 18" /><path d="M150 78 L150 18" /><path d="M250 78 C250 40 150 50 150 18" />
        </svg>
        <p className="why-space" data-pulse={2}>Space</p>
        <div className="why-machines">
          {AGENTS.map((who, index) => (
            <p key={who} className="why-machine" style={tint(who)}><Face who={who} />{c.machines[index]}</p>
          ))}
        </div>
      </div>
    ),
    (c) => (
      <div className="why-net">
        <div className="why-machines why-machines-apart">
          {AGENTS.map((who, index) => (
            <p key={who} className="why-machine why-machine-alone" data-pulse={index + 1} style={tint(who)}>
              <Face who={who} />{c.machines[index]}<span className="why-note">{c.thisMachineOnly}</span>
            </p>
          ))}
        </div>
      </div>
    ),
  ],
  // Decisions: written once, read by every agent ↔ said to each, then forgotten.
  [
    (c) => (
      <div className="why-split">
        <Page title={c.decided}>
          <p className="why-line" data-in={1} style={tint("daniel")}><span className="why-dot" />{c.decision}</p>
        </Page>
        <div className="why-readers">
          {AGENTS.map((who, index) => (
            <p key={who} className="why-reader" data-in={index + 2}><Face who={who} />{c.read} ✓</p>
          ))}
        </div>
      </div>
    ),
    (c) => (
      <div className="why-chat">
        <div data-out={5}>
          {AGENTS.map((who, index) => (
            <p key={who} className="why-said" data-in={index + 1}><Face who={who} /><span className="why-bubble">{c.decision}</span></p>
          ))}
        </div>
        <p className="why-forgot" data-in={5}><Face who="claude" /><span className="why-bubble">{c.forgot}</span></p>
      </div>
    ),
  ],
  // You in the loop: your edit lands, the agent waits ↔ stop, explain, start over.
  [
    (c) => (
      <Page title={c.page}>
        <p className="why-para">
          <span data-in={1}>{c.draft[0]}</span>
          <span className="why-swap">
            <span data-out={3}><span data-in={2}>{c.draft[1]}</span></span>
            <span data-in={3} className="why-mine" style={tint("daniel")}>{c.edited}</span>
          </span>
          <span data-in={5}>{c.draft[2]}</span>
        </p>
        <p className="why-waits" data-in={3}><Face who="claude" />{AGENT.claude.name} {c.agentWaits}</p>
      </Page>
    ),
    (c) => (
      <div className="why-chat">
        <p className="why-para why-para-plain" data-out={3}>
          <span data-in={1}>{c.draft[0]}</span><span data-in={2}>{c.draft[1]}</span>
        </p>
        <p className="why-stop" data-in={3}>■ {c.stop}</p>
        <p className="why-said" data-in={4}><Face who="daniel" /><span className="why-bubble">{c.again}</span></p>
      </div>
    ),
  ],
];
