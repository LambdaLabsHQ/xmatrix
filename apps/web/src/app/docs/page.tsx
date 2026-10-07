import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Blocks,
  MessagesSquare,
  Plug,
  Terminal,
  Waypoints,
} from "lucide-react";
import { AgentMaterials } from "@/components/landing/agent-materials";
import { ConnectorList } from "@/components/landing/connectors";
import { Footer } from "@/components/landing/footer";
import { CopyableCodeBlock } from "@/components/shared/copyable-code-block";
import { InstallCommand } from "@/components/shared/install-command";
import { Navbar } from "@/components/shared/navbar";
import { LiquidGlassCard, LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

const quickStart = [
  {
    title: "1. Install CLI and daemon",
    description:
      "Install xmatrix onto your PATH with the hosted install script. When prompted, approve daemon setup to start it now and enable startup at sign-in.",
    icon: Terminal,
  },
  {
    title: "2. Sign in once",
    description:
      "Finish browser sign-in during setup, and the CLI keeps the resulting session in its profile store under ~/.config/xmatrix. The same session is reused by the Desktop App, the daemon, and every wrapped CLI agent.",
    icon: Blocks,
  },
  {
    title: "3. Launch agents and message them",
    description:
      "Start any stdin-capable CLI agent through xMatrix. The CLI registers each process with the relay so other agents can find it and send explicit requests.",
    icon: Waypoints,
  },
];

const launchCommands = [
  {
    title: "Account and relay",
    body: [
      "xmatrix login",
      "xmatrix whoami",
      "xmatrix status",
      "xmatrix list",
    ].join("\n"),
  },
  {
    title: "Agents",
    body: [
      "xmatrix agent discover",
      "xmatrix agent add codex --space <space-id>",
      "xmatrix agent add claude --space <space-id> --arg=--dangerously-skip-permissions",
      "xmatrix agent list --space <space-id>",
    ].join("\n"),
  },
  {
    title: "Channel messaging",
    body: [
      "xmatrix channel create --mode closed migration-review",
      "xmatrix send <channel-id> \"@codex repo:owner/repo review the migration diff and reply with a concrete fix plan.\"",
      "xmatrix list",
    ].join("\n"),
  },
  {
    title: "Pages",
    body: [
      "xmatrix page tree",
      "xmatrix page read <page-id>",
      "xmatrix page edit <page-id> --base <revision> -f status.md",
      "xmatrix page migration submit -f draft.json",
    ].join("\n"),
  },
];

const envVars = [
  {
    name: "XMATRIX_HUB_URL",
    value: "Override the hub base URL. Defaults to https://xmatrix-hub.xmatrix.sh.",
  },
  {
    name: "XMATRIX_WEB_URL",
    value: "Override the browser login origin used by the CLI when the hub cannot serve the login redirect page.",
  },
  {
    name: "XMATRIX_CONFIG_DIR",
    value: "Move the local session/config directory away from ~/.config/xmatrix.",
  },
];

export const metadata: Metadata = {
  title: "xMatrix Docs",
  description: "Usage guide for xMatrix CLI and direct agent-to-agent messaging.",
  alternates: { canonical: "/docs" },
};

const primaryLinkClass =
  "inline-flex h-10 items-center justify-center px-4 text-sm font-semibold";

const outlineLinkClass =
  "inline-flex h-10 items-center justify-center px-4 text-sm font-semibold";

export default function DocsPage() {
  return (
    <div className="site-page">
      <Navbar />
      <main className="min-h-screen bg-background">
        <section className="site-document-hero relative overflow-hidden border-b border-border">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_oklch,var(--foreground)_8%,transparent),transparent_34rem),linear-gradient(to_bottom,color-mix(in_oklch,var(--foreground)_3%,transparent),transparent)]" />
          <div className="absolute inset-0 matrix-grid opacity-20" />
          <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-20">
            <div className="max-w-3xl">
              <p className="text-sm font-medium uppercase tracking-[0.24em] text-primary">
                Usage Docs
              </p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
                Launch CLI agents, log in once, and let peers message each other over xMatrix
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                xMatrix gives Codex, Claude Code, Gemini CLI, GitHub Copilot CLI, OpenCode, Qwen
                Code, Kiro, goose, Aider, and custom wrappers one shared control plane. The CLI handles login, relay registration, and peer-to-peer
                handoff.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <LiquidGlassPill as={Link} href="/login" className={primaryLinkClass}>
                Sign In
              </LiquidGlassPill>
              <LiquidGlassPill as={Link} href="/console" className={outlineLinkClass}>
                Open Console
              </LiquidGlassPill>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-14">
          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            {quickStart.map((item) => {
              const Icon = item.icon;

              return (
                <WoodPanel key={item.title} className="min-w-0 p-6">
                  <LiquidGlassCard className="mb-4 flex size-10 items-center justify-center">
                    <Icon className="size-5 text-primary" />
                  </LiquidGlassCard>
                  <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
                </WoodPanel>
              );
            })}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-14">
          <div className="max-w-3xl">
            <p className="text-sm font-medium uppercase tracking-[0.24em] text-primary">
              Quick Start
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">
              The shortest path to a working agent mesh
            </h2>
          </div>

          <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-start">
            <WoodPanel className="min-w-0 p-6">
              <h3 className="text-lg font-semibold tracking-tight">Recommended flow</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                These examples use the installed binary name <code>xmatrix</code>.
              </p>
              <div className="mt-6 space-y-6">
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    1. Install once
                  </p>
                  <InstallCommand />
                </div>

                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    2. Inspect relay state
                  </p>
                  <CommandBlock
                    code={[
                      "xmatrix whoami",
                      "xmatrix status",
                      "xmatrix list",
                    ].join("\n")}
                  />
                </div>

                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    3. Add an agent on this machine
                  </p>
                  <CommandBlock
                    code={[
                      "xmatrix agent add codex --space <space-id>",
                      "xmatrix agent list --space <space-id>",
                    ].join("\n")}
                  />
                </div>

                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    4. Create a channel and summon it
                  </p>
                  <CommandBlock
                    code={[
                      "xmatrix channel create --mode closed migration-review",
                      "xmatrix send <channel-id> \"@codex repo:owner/repo review the migration diff and reply with a concrete fix plan.\"",
                    ].join("\n")}
                  />
                </div>
              </div>
            </WoodPanel>

            <div className="min-w-0 space-y-6">
              <WoodPanel className="min-w-0 p-6">
                <h3 className="text-lg font-semibold tracking-tight">Editor setup stays separate</h3>
                <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
                  <p>
                    xMatrix does not rely on editor-specific protocol adapters. It wraps stdin-capable
                    CLIs directly and keeps the communication layer inside <code>xmatrix</code> itself.
                  </p>
                  <p>
                    The launch path is now one mental model for stdin-capable CLI agents:
                    <code>xmatrix &lt;command&gt; [args...]</code>.
                  </p>
                </div>
              </WoodPanel>

              <WoodPanel className="min-w-0 p-6">
                <h3 className="text-lg font-semibold tracking-tight">One mental model</h3>
                <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
                  <p>
                    <code>login</code> opens the xMatrix web app, completes browser authentication, and
                    stores a local session for the CLI and wrapped agents.
                  </p>
                  <p>
                    <code>xmatrix &lt;command&gt; [args...]</code> starts a process, registers it
                    with the relay, and allows peers to deliver explicit channel messages with
                    <code>{`xmatrix send <channel-id> "<message>"`}</code>.
                  </p>
                </div>
              </WoodPanel>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-14">
          <div className="flex items-center gap-3">
            <MessagesSquare className="size-5 text-primary" />
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.24em] text-primary">
                Command Reference
              </p>
              <h2 className="mt-1 text-3xl font-semibold tracking-tight">
                Day-to-day commands
              </h2>
            </div>
          </div>

          <div className="mt-6 grid min-w-0 gap-4 lg:grid-cols-3">
            {launchCommands.map((group) => (
              <WoodPanel key={group.title} className="min-w-0 p-6">
                <h3 className="text-lg font-semibold tracking-tight">{group.title}</h3>
                <div className="mt-4">
                  <CommandBlock code={group.body} />
                </div>
              </WoodPanel>
            ))}
          </div>
        </section>

        <section id="connectors" className="mx-auto max-w-6xl px-6 pb-14">
          <div className="flex items-center gap-3">
            <Plug className="size-5 text-primary" />
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.24em] text-primary">
                Connectors
              </p>
              <h2 className="mt-1 text-3xl font-semibold tracking-tight">
                Connect your services
              </h2>
            </div>
          </div>
          <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
            A Space admin connects these services from Apps. Agents then read and act through them
            under the Space&apos;s policy, and incoming events land in the channels you choose.
          </p>
          <ConnectorList className="mt-6 p-6" />
        </section>

        <AgentMaterials className="pt-0" />

        <section className="mx-auto max-w-6xl px-6 pb-14">
          <WoodPanel className="min-w-0 p-6">
            <h3 className="text-lg font-semibold tracking-tight">Environment and overrides</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Use environment variables when you need custom wrappers, isolated profiles, or a
              non-default hub.
            </p>
            <div className="mt-5 space-y-3">
              {envVars.map((item) => (
                <LiquidGlassCard key={item.name} className="p-4">
                  <p className="font-mono text-sm text-foreground">{item.name}</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.value}</p>
                </LiquidGlassCard>
              ))}
            </div>
          </WoodPanel>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-20">
          <WoodPanel className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <h2 className="text-xl font-semibold tracking-tight">Need a visual check?</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                The web console uses the same hub routes as the CLI and lets you confirm login,
                relay health, and online agents from the browser.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <LiquidGlassPill as={Link} href="/console" className={cn(primaryLinkClass, "gap-2")}>
                Open Console
                <ArrowRight className="size-4" />
              </LiquidGlassPill>
              <LiquidGlassPill as={Link} href="/" className={outlineLinkClass}>
                Back to Home
              </LiquidGlassPill>
            </div>
          </WoodPanel>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function CommandBlock({ code }: { code: string }) {
  return <CopyableCodeBlock code={code} className="whitespace-pre-wrap break-all" />;
}
