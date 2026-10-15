import Image from "next/image";

const AGENTS = [
  ["Claude Code", "claude.svg"], ["Codex", "openai.svg"], ["Cursor", "cursor.png"], ["Gemini", "gemini.svg"],
  ["Grok", "grok.svg"], ["Kimi", "kimi.svg"], ["Copilot", "copilot.svg"], ["OpenCode", "opencode.svg"],
  ["Qwen", "qwen.svg"], ["Devin", "devin.svg"], ["Amp", "amp.svg"], ["Droid", "droid.svg"],
] as const;

/** The agents people already use, passing by under the hero. */
export function AgentStrip() {
  const row = (hidden: boolean) => (
    <ul className="site-agent-strip-row" aria-hidden={hidden || undefined}>
      {AGENTS.map(([name, logo]) => (
        <li key={name} className="site-agent-chip">
          <Image src={`/agent-vendors/${logo}`} alt="" width={18} height={18} className="size-[18px] object-contain" />
          {name}
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Works with the agents you already use" className="site-agent-strip">
      <p className="site-agent-strip-label">Works with the agents you already use</p>
      <div className="site-agent-strip-track">{row(false)}{row(true)}</div>
    </section>
  );
}
