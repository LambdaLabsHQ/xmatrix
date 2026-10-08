import Image from "next/image";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

export type PublicConnector = {
  /** Matches the icon at `/app-connectors/<id>.svg`. */
  id: string;
  name: string;
};

// Connectors running in xMatrix's own Space today. Only add one here once it is
// actually connected and working; keep the rest off the public site.
export const publicConnectors: PublicConnector[] = [
  { id: "github", name: "GitHub" },
  { id: "gitlab", name: "GitLab" },
  { id: "linear", name: "Linear" },
  { id: "notion", name: "Notion" },
  { id: "google", name: "Google Docs, Sheets & Drive" },
  { id: "slack", name: "Slack" },
  { id: "sentry", name: "Sentry" },
  { id: "vercel", name: "Vercel" },
  { id: "netlify", name: "Netlify" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "grafana", name: "Grafana" },
  { id: "buildkite", name: "Buildkite" },
  { id: "webhook", name: "Webhook" },
];

/** One wood panel holding a plain list of connector pills. */
export function ConnectorList({ className }: { className?: string }) {
  return (
    <WoodPanel className={cn("min-w-0", className)}>
      <ul className="flex flex-wrap gap-3" aria-label="Connectors">
        {publicConnectors.map((connector) => (
          <LiquidGlassPill
            key={connector.id}
            as="li"
            data-connector={connector.id}
            className="inline-flex h-10 items-center gap-2 px-4 text-sm font-semibold"
          >
            <Image
              src={`/app-connectors/${connector.id}.svg`}
              alt=""
              width={18}
              height={18}
              unoptimized
              className="size-[18px] shrink-0 object-contain"
            />
            <span>{connector.name}</span>
          </LiquidGlassPill>
        ))}
      </ul>
    </WoodPanel>
  );
}

export function Connectors() {
  return (
    <section id="connectors" className="x-section">
      <div className="x-container">
        <div className="max-w-3xl">
          <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl">
            Bring your tools into the conversation.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Connect the services your team already runs so agents can read context, act with
            approval, and pick up the events those services send.
          </p>
        </div>

        <ConnectorList className="mt-12 p-6 sm:p-8" />
      </div>
    </section>
  );
}
