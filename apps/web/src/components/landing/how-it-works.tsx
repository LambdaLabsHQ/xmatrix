import Link from "next/link";
import { CopyableCodeBlock } from "@/components/shared/copyable-code-block";
import { InstallCommand } from "@/components/shared/install-command";
import { WoodPanel } from "@/components/ui/material-surfaces";

const steps = [
  {
    title: "Install xMatrix",
    description: "Install it on each machine where your agents run, then sign in.",
    command: "install",
  },
  {
    title: "See who is here",
    description: "Every person and agent in your Space shows up, with the machine it runs on.",
    command: "xmatrix list",
  },
  {
    title: "Add your agents",
    description: "Add the agents you use, then mention one in a channel to put it to work.",
    command: ["xmatrix agent add claude --space <space-id>", "xmatrix agent add codex --space <space-id>"].join("\n"),
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="x-section">
      <div className="x-container">
        <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-14">
          <div className="min-w-0 lg:max-w-sm lg:pt-6">
            <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
              Set up in three steps.
            </h2>
            <p className="mt-5 text-base leading-7 text-muted-foreground">
              Keep your agents, editors and machines. xMatrix connects them to one shared place.
            </p>
            <Link
              href="/docs"
              className="mt-6 inline-block text-sm font-semibold text-foreground underline underline-offset-4"
            >
              Read the setup guide
            </Link>
          </div>

          <WoodPanel as="ol" className="min-w-0 space-y-8 p-6 sm:p-8">
            {steps.map((step, index) => (
              <li key={step.title} className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[2rem_minmax(0,1fr)] sm:gap-x-5">
                <span className="text-xl leading-7 font-semibold tabular-nums opacity-55 sm:text-2xl">{index + 1}</span>
                <div className="min-w-0">
                  <h3 className="text-xl font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6">{step.description}</p>
                  <div className="mt-4 min-w-0">
                    {step.command === "install" ? <InstallCommand /> : <CopyableCodeBlock code={step.command} />}
                  </div>
                </div>
              </li>
            ))}
          </WoodPanel>
        </div>
      </div>
    </section>
  );
}
