import { Cloud, Clock, Keyboard, Monitor, Server, ShieldCheck } from "lucide-react";
import { LiquidGlassCard, MaterialChip, WoodPanel } from "@/components/ui/material-surfaces";

const layers = [
  ["Connect", "Your tools and machines", "Keep the workflows you trust", Monitor],
  ["Coordinate", "xMatrix shared workspace", "Channels, context, and ownership", Cloud],
  ["Deliver", "People and agents", "Visible progress and clear handoffs", Server],
] as const;

const features = [
  [Clock, "One clear identity", "People, agents, and workspaces stay easy to recognize across the product."],
  [Keyboard, "Work where you already work", "Keep using your preferred agent, editor, machine, and repository."],
  [ShieldCheck, "Governed by design", "Permissions, approvals, and traceable actions keep people in control."],
] as const;

export function Architecture() {
  return (
    <section id="architecture" className="x-section">
      <div className="absolute inset-0 matrix-grid opacity-10" />
      <div className="x-container">
        <div className="mx-auto max-w-3xl text-center">
          <span className="x-eyebrow">How xMatrix fits</span>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            A coordination layer, not another replacement.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            xMatrix connects the tools and environments you already use, then adds the shared
            context and control needed for reliable multi-agent work.
          </p>
        </div>

        <div className="x-mobile-card-scroller relative mt-16 grid min-w-0 gap-5 md:grid-cols-3">
          <div className="absolute left-[18%] right-[18%] top-1/2 hidden h-px bg-gradient-to-r from-transparent via-border to-transparent md:block" />
          {layers.map(([label, title, subtitle, Icon], index) => (
            <WoodPanel key={label} className="relative min-w-0 p-6 text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.26em] text-muted-foreground">{label}</p>
              <LiquidGlassCard className="mx-auto mt-5 flex size-20 items-center justify-center">
                <Icon className="size-8 text-primary" />
              </LiquidGlassCard>
              <h3 className="mt-5 text-xl font-semibold tracking-tight">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
              <MaterialChip className="mx-auto mt-5 size-7 px-0 text-xs">
                {index + 1}
              </MaterialChip>
            </WoodPanel>
          ))}
        </div>

        <div className="x-mobile-card-scroller mt-12 grid min-w-0 gap-5 md:grid-cols-3">
          {features.map(([Icon, title, description]) => (
            <WoodPanel key={title} className="min-w-0 p-5">
              <LiquidGlassCard className="flex size-10 items-center justify-center">
                <Icon className="size-5 text-primary" />
              </LiquidGlassCard>
              <h3 className="mt-4 text-lg font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            </WoodPanel>
          ))}
        </div>
      </div>
    </section>
  );
}
