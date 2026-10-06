import Link from "next/link";
import { Bot, FileCode2 } from "lucide-react";
import {
  agentOnboardingCurlCommand,
  agentOnboardingPrompt,
  agentOnboardingPromptUrl,
  xmatrixSkill,
  xmatrixSkillCurlCommand,
  xmatrixSkillInstallCommand,
  xmatrixSkillMetadataUrl,
  xmatrixSkillUrl,
} from "@/lib/agent-materials";
import { CopyableCodeBlock } from "@/components/shared/copyable-code-block";
import { LiquidGlassCard, WoodPanel } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

const compactCodeClass = "whitespace-pre-wrap break-all";
const codePreviewClass = "max-h-[28rem] overflow-y-auto";

type MaterialCard = {
  title: string;
  eyebrow: string;
  icon: typeof Bot;
  description: string;
  fetchLabel: string;
  fetchCommand: string;
  installLabel?: string;
  installCommand?: string;
  directLinks: Array<{ href: string; label: string }>;
  contentLabel: string;
  content: string;
};

const materialCards: MaterialCard[] = [
  {
    title: "Agent onboarding prompt",
    eyebrow: "Prompt",
    icon: Bot,
    description:
      "Paste this into a running coding agent to guide setup and connect it to your xMatrix workspace.",
    fetchLabel: "Fetch prompt",
    fetchCommand: agentOnboardingCurlCommand,
    directLinks: [{ href: agentOnboardingPromptUrl, label: agentOnboardingPromptUrl }],
    contentLabel: "Prompt",
    content: agentOnboardingPrompt,
  },
  {
    title: "Universal xMatrix skill",
    eyebrow: "Skill",
    icon: FileCode2,
    description:
      "Install this as `$xmatrix` so supported agents understand xMatrix workflows and safe operating boundaries.",
    fetchLabel: "Fetch skill",
    fetchCommand: xmatrixSkillCurlCommand,
    installLabel: "Install for Codex",
    installCommand: xmatrixSkillInstallCommand,
    directLinks: [
      { href: xmatrixSkillUrl, label: xmatrixSkillUrl },
      { href: xmatrixSkillMetadataUrl, label: xmatrixSkillMetadataUrl },
    ],
    contentLabel: "SKILL.md",
    content: xmatrixSkill,
  },
];

export function AgentMaterials({ className }: { className?: string }) {
  return (
    <section id="agent-materials" className={cn("x-section", className)}>
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <p className="x-eyebrow">Agent setup</p>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            Give your agent the xMatrix playbook.
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            Use one verified prompt or install the xMatrix skill so your agent can join the right
            space, understand the available workflows, and ask for your approval when needed.
          </p>
        </div>

        <div className="mt-8 grid min-w-0 gap-5 lg:grid-cols-2">
          {materialCards.map((item) => {
            const Icon = item.icon;

            return (
              <WoodPanel key={item.title} className="min-w-0 p-6">
                <div className="flex items-start gap-4">
                  <LiquidGlassCard className="flex size-10 shrink-0 items-center justify-center">
                    <Icon className="size-5 text-primary" />
                  </LiquidGlassCard>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                      {item.eyebrow}
                    </p>
                    <h3 className="mt-1 text-xl font-semibold tracking-tight">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </div>
                <div className="mt-5 space-y-5">
                  <div>
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      {item.fetchLabel}
                    </p>
                    <CopyableCodeBlock code={item.fetchCommand} className={compactCodeClass} />
                  </div>

                  {item.installCommand && (
                    <div>
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                        {item.installLabel}
                      </p>
                      <CopyableCodeBlock code={item.installCommand} className={compactCodeClass} />
                    </div>
                  )}

                  <div className="space-y-1.5 text-sm text-muted-foreground">
                    {item.directLinks.map((link) => (
                      <p key={link.href} className="min-w-0 truncate">
                        Direct path:{" "}
                        <Link
                          href={link.href}
                          className="font-mono text-foreground underline-offset-4 hover:underline"
                        >
                          {link.label}
                        </Link>
                      </p>
                    ))}
                  </div>

                  <div>
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      {item.contentLabel}
                    </p>
                    <CopyableCodeBlock code={item.content} className={codePreviewClass} />
                  </div>
                </div>
              </WoodPanel>
            );
          })}
        </div>
      </div>
    </section>
  );
}
