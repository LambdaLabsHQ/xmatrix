import type { AlternativeSlug, AlternativeSource } from "./types";

export const ALTERNATIVE_VERIFIED_DATE_ISO = "2026-11-22";

/** Direct competitors linked from the site-wide footer: multi-agent coordination products, plus Notion for Pages. */
export const FOOTER_ALTERNATIVE_SLUGS: readonly AlternativeSlug[] = [
  "raft",
  "lody",
  "multica",
  "paradev",
  "conductor",
  "lobehub",
  "notion",
  "orca",
  "t3-code",
  "cumora",
];

/**
 * Verified official docs, pricing pages, changelogs, GitHub issues, and GitHub
 * Discussions backing each competitor's three pain points (checked 2026-11-22).
 */
export const alternativePainPointSources: Readonly<
  Record<AlternativeSlug, readonly (readonly AlternativeSource[])[]>
> = {
  raft: [
    [{ label: "Raft Docs", href: "https://docs.raft.build/welcome/" }],
    [{ label: "Raft Docs", href: "https://docs.raft.build/welcome/" }],
    [{ label: "Raft Pricing", href: "https://raft.build/pricing/" }],
  ],
  lody: [
    [{ label: "Lody Docs", href: "https://lody.ai/docs/" }],
    [{ label: "GitHub · LodyAI/Lody#507", href: "https://github.com/LodyAI/Lody/issues/507" }],
    [{ label: "Lody Docs", href: "https://lody.ai/docs/" }],
  ],
  multica: [
    [{ label: "GitHub · multica-ai/multica#9559", href: "https://github.com/multica-ai/multica/issues/9559" }],
    [{ label: "GitHub · multica-ai/multica", href: "https://github.com/multica-ai/multica" }],
    [{ label: "GitHub · multica-ai/multica#838", href: "https://github.com/multica-ai/multica/issues/838" }],
  ],
  paradev: [
    [{ label: "Paradev Pricing", href: "https://paradev.com/pricing" }],
    [{ label: "GitHub · ParadevAI/Paradev", href: "https://github.com/ParadevAI/Paradev" }],
    [{ label: "Paradev Pricing", href: "https://paradev.com/pricing" }],
  ],
  conductor: [
    [{ label: "Conductor", href: "https://www.conductor.build/" }],
    [{ label: "Conductor", href: "https://www.conductor.build/" }],
    [{ label: "Conductor", href: "https://www.conductor.build/" }],
  ],
  orca: [
    [{ label: "GitHub · stablyai/orca#26498", href: "https://github.com/stablyai/orca/issues/26498" }],
    [{ label: "Orca Docs", href: "https://www.onorca.dev/docs" }],
    [{ label: "Orca Docs", href: "https://www.onorca.dev/docs" }],
  ],
  lobehub: [
    [{ label: "GitHub · lobehub/lobehub", href: "https://github.com/lobehub/lobehub" }],
    [{ label: "GitHub · lobehub/lobehub", href: "https://github.com/lobehub/lobehub" }],
    [{ label: "GitHub · lobehub/lobehub", href: "https://github.com/lobehub/lobehub" }],
  ],
  cumora: [
    [{ label: "GitHub · yetone/cumora#350", href: "https://github.com/yetone/cumora/issues/350" }],
    [{ label: "GitHub · yetone/cumora", href: "https://github.com/yetone/cumora" }],
    [{ label: "GitHub · yetone/cumora", href: "https://github.com/yetone/cumora" }],
  ],
  "t3-code": [
    [
      { label: "GitHub Discussion · t3code#27974", href: "https://github.com/pingdotgg/t3code/discussions/27974" },
      { label: "t3code#12283", href: "https://github.com/pingdotgg/t3code/discussions/12283" },
      { label: "t3code#27708", href: "https://github.com/pingdotgg/t3code/discussions/27708" },
    ],
    [
      { label: "GitHub Discussion · t3code#15846", href: "https://github.com/pingdotgg/t3code/discussions/15846" },
      { label: "t3code#24453", href: "https://github.com/pingdotgg/t3code/discussions/24453" },
      { label: "t3code#18949", href: "https://github.com/pingdotgg/t3code/discussions/18949" },
    ],
    [
      { label: "GitHub Discussion · t3code#15858", href: "https://github.com/pingdotgg/t3code/discussions/15858" },
    ],
  ],
  herdr: [
    [{ label: "GitHub · herdrdev/herdr", href: "https://github.com/herdrdev/herdr" }],
    [{ label: "Herdr", href: "https://herdr.dev/" }],
    [{ label: "GitHub · herdrdev/herdr", href: "https://github.com/herdrdev/herdr" }],
  ],
  seedmux: [
    [{ label: "Seedmux", href: "https://seedmux.com/" }],
    [{ label: "Seedmux", href: "https://seedmux.com/" }],
    [{ label: "Seedmux", href: "https://seedmux.com/" }],
  ],
  linear: [
    [{ label: "Linear Agents Docs", href: "https://linear.app/docs/agents-in-linear" }],
    [{ label: "Linear Agents Docs", href: "https://linear.app/docs/agents-in-linear" }],
    [{ label: "Linear Agents Docs", href: "https://linear.app/docs/agents-in-linear" }],
  ],
  notion: [
    [{ label: "Notion Releases", href: "https://www.notion.com/releases" }],
    [{ label: "Notion Releases", href: "https://www.notion.com/releases" }],
    [{ label: "Notion Releases", href: "https://www.notion.com/releases" }],
  ],
  "slack-code": [
    [{ label: "Slack Code API", href: "https://slack.com/blog/developers/slack-code-api" }],
    [{ label: "Slack Code API", href: "https://slack.com/blog/developers/slack-code-api" }],
    [{ label: "Slack Code API", href: "https://slack.com/blog/developers/slack-code-api" }],
  ],
  "nowledge-mem": [
    [{ label: "Nowledge Mem Docs", href: "https://mem.nowledge.co/docs" }],
    [{ label: "Nowledge Mem Docs", href: "https://mem.nowledge.co/docs" }],
    [{ label: "Nowledge Mem Docs", href: "https://mem.nowledge.co/docs" }],
  ],
  everos: [
    [{ label: "GitHub · EverMind-AI/EverOS", href: "https://github.com/EverMind-AI/EverOS" }],
    [{ label: "GitHub · EverMind-AI/EverOS", href: "https://github.com/EverMind-AI/EverOS" }],
    [{ label: "GitHub · EverMind-AI/EverOS", href: "https://github.com/EverMind-AI/EverOS" }],
  ],
  youmind: [
    [{ label: "YouMind Pricing", href: "https://youmind.com/pricing" }],
    [{ label: "YouMind Pricing", href: "https://youmind.com/pricing" }],
    [{ label: "YouMind Pricing", href: "https://youmind.com/pricing" }],
  ],
  jules: [
    [{ label: "Google Jules Changelog", href: "https://jules.google/docs/changelog/#jules-turndown" }],
    [{ label: "Google Jules Changelog", href: "https://jules.google/docs/changelog/#jules-turndown" }],
    [{ label: "Google Jules Changelog", href: "https://jules.google/docs/changelog/#jules-turndown" }],
  ],
};
