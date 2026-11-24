import Image from "next/image";
import { SectionIntro } from "@/components/landing/section-intro";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";
import { landingCopy, type Locale } from "@/lib/landing-copy";

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
  { id: "slack", name: "Slack" },
  { id: "google", name: "Google Docs, Sheets & Drive" },
  { id: "gmail", name: "Gmail" },
  { id: "googlecalendar", name: "Google Calendar" },
  { id: "sentry", name: "Sentry" },
  { id: "vercel", name: "Vercel" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "netlify", name: "Netlify" },
  { id: "gcp", name: "Google Cloud" },
  { id: "stripe", name: "Stripe" },
  { id: "appstoreconnect", name: "App Store Connect" },
  { id: "googleplay", name: "Google Play Console" },
  { id: "googleanalytics", name: "Google Analytics" },
  { id: "googlesearchconsole", name: "Google Search Console" },
  { id: "x", name: "X" },
  { id: "grafana", name: "Grafana" },
  { id: "buildkite", name: "Buildkite" },
  { id: "webhook", name: "Webhook" },
];

/** One wood panel holding a plain list of connector pills. */
export function ConnectorList({ className, label = "Connectors" }: { className?: string; label?: string }) {
  return (
    <WoodPanel className={cn("min-w-0", className)}>
      {/* Glass pills with each service's mark and name. A phone has room for the marks alone, as a grid of glass
          tiles; their names are still read out. */}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-2.5 sm:flex sm:flex-wrap sm:gap-3" aria-label={label}>
        {publicConnectors.map((connector) => (
          <LiquidGlassPill
            key={connector.id}
            as="li"
            data-connector={connector.id}
            className="flex aspect-square items-center justify-center sm:aspect-auto sm:h-10 sm:gap-2 sm:px-4 sm:text-sm sm:font-semibold"
          >
            <Image
              src={`/app-connectors/${connector.id}.svg`}
              alt=""
              width={18}
              height={18}
              unoptimized
              className="size-[18px] shrink-0 object-contain"
            />
            <span className="sr-only sm:not-sr-only">{connector.name}</span>
          </LiquidGlassPill>
        ))}
      </ul>
    </WoodPanel>
  );
}

export function Connectors({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].connectors;
  return (
    <section id="connectors" className="x-section">
      <div className="x-container">
        <SectionIntro title={copy.title} body={copy.body} />
        <ConnectorList className="mt-10 p-6 sm:p-8 md:mt-12" label={copy.label} />
      </div>
    </section>
  );
}
