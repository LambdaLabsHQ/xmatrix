import Image from "next/image";

import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";

const AGENTS = [
  ["Claude Code", "claude.svg"], ["Codex", "openai.svg"], ["Cursor", "cursor.png"], ["Gemini", "gemini.svg"],
  ["Grok", "grok.svg"], ["Kimi", "kimi.svg"], ["Copilot", "copilot.svg"], ["OpenCode", "opencode.svg"],
  ["Qwen", "qwen.svg"], ["Devin", "devin.svg"], ["Amp", "amp.svg"], ["Droid", "droid.svg"],
] as const;

/** The agents people already use, passing by under the hero. */
export function AgentStrip({ locale = "en" }: { locale?: Locale }) {
  const label = landingCopy[locale].agentStrip;
  const row = (hidden: boolean) => (
    <ul className="site-agent-strip-row" aria-hidden={hidden || undefined}>
      {AGENTS.map(([name, logo]) => (
        <LiquidGlassPill as="li" key={name} className="site-agent-chip">
          <Image src={`/agent-vendors/${logo}`} alt="" width={18} height={18} className="size-[18px] object-contain" />
          {name}
        </LiquidGlassPill>
      ))}
    </ul>
  );
  return (
    <section aria-label={label} className="site-agent-strip">
      <p className="site-agent-strip-label">{label}</p>
      <div className="site-agent-strip-track">{row(false)}{row(true)}</div>
    </section>
  );
}
