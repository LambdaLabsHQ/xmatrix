import { ArrowRight, Brain, Copy, Unplug } from "lucide-react";
import { LiquidGlassCard, WoodPanel } from "@/components/ui/material-surfaces";

const problems = [
  {
    icon: Unplug,
    title: "Agent work is scattered",
    before: "Agents run across laptops, dev boxes, IDEs, and cloud hosts with no shared view.",
    after: "Bring every active agent and workspace into one visible place.",
  },
  {
    icon: Copy,
    title: "Context gets lost in handoffs",
    before: "People copy status between terminals, chats, issues, and pull requests.",
    after: "Keep decisions, progress, and handoffs with the work.",
  },
  {
    icon: Brain,
    title: "More agents create more risk",
    before: "Parallel agents can duplicate effort, collide, or act without clear ownership.",
    after: "Coordinate scope, approvals, and accountability before work moves.",
  },
];

export function ProblemStatement() {
  return (
    <section id="problem" className="x-section">
      <div className="absolute inset-0 matrix-grid opacity-10" />
      <div className="x-container">
        <div className="max-w-3xl">
          <span className="x-eyebrow">What changes</span>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Turn scattered agent activity into coordinated work.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Keep the tools and machines your team already uses. xMatrix gives people and agents a
            shared place to see context, coordinate ownership, and move work forward.
          </p>
        </div>

        <div className="x-mobile-card-scroller mt-14 grid min-w-0 gap-5 lg:grid-cols-3">
          {problems.map((problem) => (
            <WoodPanel key={problem.title} className="min-w-0 p-6">
              <LiquidGlassCard className="flex size-12 items-center justify-center">
                <problem.icon className="size-5 text-primary" />
              </LiquidGlassCard>
              <h3 className="mt-6 text-xl font-semibold tracking-tight">{problem.title}</h3>
              <div className="mt-5 space-y-3">
                <LiquidGlassCard className="p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Today</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{problem.before}</p>
                </LiquidGlassCard>
                <div className="flex items-center gap-3 px-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                  <span className="h-px flex-1 bg-border" />
                  <ArrowRight className="size-3" />
                  <span className="h-px flex-1 bg-border" />
                </div>
                <LiquidGlassCard className="p-4">
                  <p className="text-sm leading-6 text-foreground">{problem.after}</p>
                </LiquidGlassCard>
              </div>
            </WoodPanel>
          ))}
        </div>
      </div>
    </section>
  );
}
