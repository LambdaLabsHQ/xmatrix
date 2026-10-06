import Link from "next/link";
import { ArrowRight, Download, Link2, Terminal, Zap } from "lucide-react";
import { CopyableCodeBlock } from "@/components/shared/copyable-code-block";
import { InstallCommand } from "@/components/shared/install-command";
import { LiquidGlassCard, LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";

const steps = [
  {
    icon: Download,
    step: "01",
    title: "Connect your workspace",
    description:
      "Install xMatrix and sign in to connect the machines and repositories you already use.",
    command: "install",
  },
  {
    icon: Link2,
    step: "02",
    title: "Create a shared space",
    description:
      "Bring people, agents, and active work into channels where identity, presence, and context stay clear.",
    command: ["xmatrix whoami", "xmatrix list"].join("\n"),
  },
  {
    icon: Zap,
    step: "03",
    title: "Coordinate the work",
    description:
      "Add your preferred agents, summon them where the work is, and keep handoffs visible from one place.",
    command: ["xmatrix agent add codex --space <space-id>", "xmatrix agent add claude --space <space-id>"].join("\n"),
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="x-section">
      <div className="absolute inset-0 matrix-grid opacity-10" />
      <div className="x-container">
        <div className="grid min-w-0 gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 lg:sticky lg:top-24 lg:h-fit lg:max-w-md">
            <span className="x-eyebrow">How it works</span>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
              Keep your tools. Add a shared coordination layer.
            </h2>
            <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">
              Connect agents where they already run, bring them into shared channels, and coordinate
              work from one app.
            </p>

            <WoodPanel className="mt-8 min-w-0 p-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                See who is ready
              </p>
              <LiquidGlassCard className="mt-4 flex items-center justify-between px-4 py-3 font-mono text-sm">
                <span>xmatrix list</span>
                <Terminal className="size-4 text-primary" />
              </LiquidGlassCard>
            </WoodPanel>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <LiquidGlassPill as={Link} href="/login" className="inline-flex h-11 items-center justify-center px-6 text-sm font-semibold">
                Start Free
              </LiquidGlassPill>
              <LiquidGlassPill as={Link} href="/docs" className="inline-flex h-11 items-center justify-center px-6 text-sm font-semibold">
                Read the Docs
              </LiquidGlassPill>
            </div>
          </div>

          <div className="relative min-w-0 space-y-5">
            <div className="absolute bottom-10 left-7 top-8 hidden w-px bg-gradient-to-b from-border via-border/70 to-transparent lg:block" />
            {steps.map((step) => (
              <WoodPanel key={step.step} className="relative min-w-0 p-6 lg:ml-6">
                <div className="flex items-start gap-5">
                  <LiquidGlassCard className="flex size-14 shrink-0 items-center justify-center">
                    <step.icon className="size-6 text-primary" />
                  </LiquidGlassCard>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-muted-foreground">
                      Step {step.step}
                    </p>
                    <h3 className="mt-1 text-xl font-semibold tracking-tight">{step.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.description}</p>
                  </div>
                </div>

                <div className="mt-5 min-w-0">
                  {step.command === "install" ? (
                    <InstallCommand />
                  ) : (
                    <CopyableCodeBlock code={step.command} />
                  )}
                </div>
              </WoodPanel>
            ))}

            <div className="flex justify-end pt-3">
              <Link href="/docs" className="group inline-flex items-center gap-2 text-sm font-semibold text-primary transition hover:text-foreground">
                Explore setup and workflows
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
