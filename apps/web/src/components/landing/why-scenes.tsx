import type { CSSProperties, ReactNode } from "react";
import { BellOff } from "lucide-react";
import { agentFaceUrl } from "@xmatrix/protocol";
import { ScenePage, type SceneWriter } from "@/components/landing/why-scene-page";
import type { WhyScenes } from "@/lib/landing-copy";

/* Why xMatrix's examples: one small scene per row and side, played on one
   8-second loop (site.css, "Why xMatrix scenes"). A page in them is real
   markdown drawn by the app's own renderer (why-scene-page.tsx); the rest is
   HTML. An
   element marked data-in="n" arrives at step n and stays until the loop
   restarts; data-out="n" leaves at step n; data-pulse="n" lights in its
   colour at step n; data-third="n" shows only in that third of the loop.
   Under reduced motion every scene rests on its last step. */

// The same writers and colours as the live page above (live-page-preview.tsx).
const AGENT = {
  claude: { name: "Claude", initial: "C", color: "#b85a3b", harness: "claude" },
  codex: { name: "Codex", initial: "X", color: "#2f6f5e", harness: "codex" },
  cursor: { name: "Cursor", initial: "U", color: "#7a5389", harness: "cursor" },
  daniel: { name: "Daniel", initial: "D", color: "#4b6382", harness: null },
} as const;
type Who = keyof typeof AGENT;
const AGENTS: readonly Who[] = ["claude", "codex", "cursor"];

const tint = (who: Who) => ({ "--why-c": AGENT[who].color }) as CSSProperties;

/** An Agent's face is the app's, its vendor's mark (agentFaceUrl); a person without a picture is their initial. */
function Face({ who }: { who: Who }) {
  const { harness, initial } = AGENT[who];
  const mark = agentFaceUrl(harness);
  if (!mark) return <span className="why-face" style={tint(who)}>{initial}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- a 16px static mark, as the app's own faces draw it
  return <img src={mark} alt="" className="why-face why-face-mark" />;
}

const writer = (who: Who): SceneWriter => ({ name: AGENT[who].name, harness: AGENT[who].harness, color: AGENT[who].color });

/** A workstream as a page holds it in markdown: a task, its name in bold, its owner by @, where it stands. */
function task(done: boolean, label: string, who: Who, text: string): string {
  return `- [${done ? "x" : " "}] **${label}** · @${who} — ${text}`;
}

const page = (title: string, ...lines: string[]) => [`## ${title}`, "", ...lines].join("\n");

/** The launch page's three workstreams, as they stand after `done` of them are finished. */
function workstreams(c: WhyScenes, done: number, count = 3): string[] {
  return ([["web", "claude"], ["mobile", "codex"], ["docs", "cursor"]] as const).slice(0, count)
    .map(([key, who], index) => task(index < done, c[key], who, index < done ? c.done[index]! : c.progress[index]!));
}

type Scene = (copy: WhyScenes) => ReactNode;

/** Each row's pair of scenes, xMatrix first, in the order of the copy's rows. */
export const WHY_SCENES: readonly (readonly [Scene, Scene])[] = [
  // Where things stand: one page whose lines move ↔ windows taking turns on top.
  [
    (c) => (
      <ScenePage frames={[0, 1, 2, 3].map((done) => page(c.page, ...workstreams(c, done)))}
        writers={[null, writer("claude"), writer("codex"), writer("cursor")]} />
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
        <ScenePage frames={[0, 1, 1, 2].map((done) => page(c.page, ...workstreams(c, done, 2)))}
          writers={[null, writer("claude"), null, writer("codex")]} />
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
        <ScenePage frames={[0, 1, 2, 3].map((count) => page(c.page, ...workstreams(c, 3, count)))}
          writers={[null, writer("claude"), writer("codex"), writer("cursor")]} />
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
        <ScenePage frames={[page(c.decided), page(c.decided, `> ${c.decision}`)]} writers={[null, writer("daniel")]} />
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
      <div className="why-split">
        <ScenePage frames={[
          page(c.page), page(c.page, c.draft[0]), page(c.page, c.draft[0] + c.draft[1]),
          page(c.page, `${c.draft[0]}**${c.edited}**`), page(c.page, `${c.draft[0]}**${c.edited}**`),
          page(c.page, `${c.draft[0]}**${c.edited}**${c.draft[2]}`),
        ]} writers={[null, writer("claude"), writer("claude"), writer("daniel"), null, writer("claude")]} />
        <p className="why-waits" data-out={5}><span data-in={3} className="why-waits-in"><Face who="claude" />{AGENT.claude.name} {c.agentWaits}</span></p>
      </div>
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
