import { AlternativesIndex } from "@/components/alternatives/alternatives-index";
import { sitePageMetadata } from "@/lib/site-metadata";

export const metadata = sitePageMetadata(
  "/alternatives",
  "xMatrix Alternatives & Comparisons — Compare Coding Agent Workspaces",
  "Compare xMatrix against Raft, Lody, Multica, Paradev (Superset), Conductor, Orca, LobeHub, Cumora, T3 Code, herdr, Seedmux, Claude Code Desktop, Linear, Notion, Slack Code, Nowledge Mem, EverOS, YouMind, and Google Jules.",
);

export default function AlternativesPage() {
  return <AlternativesIndex />;
}
