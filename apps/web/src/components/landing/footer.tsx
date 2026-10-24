import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { agentDocFiles, aiAskLinks } from "@/lib/agent-docs";
import { landingCopy, type LandingCopy, type Locale } from "@/lib/landing-copy";
import { REPOSITORY_URL } from "@/lib/star-prompt";

// X verifies the organization by this link back to its account.
export const X_ACCOUNT_URL = "https://x.com/xMatrix_hq";

function footerLinks(copy: LandingCopy) {
  const { links, legalLinks } = copy.footer;
  return {
    [copy.footer.product]: [
      { label: links.app, href: "/app" },
      { label: links.download, href: "/download" },
      { label: links.pricing, href: `${copy.home}#pricing` },
      { label: links.docs, href: "/docs" },
      { label: "GitHub", href: REPOSITORY_URL },
      { label: "X", href: X_ACCOUNT_URL },
      { label: links.console, href: "/console" },
      { label: links.signIn, href: "/login" },
    ],
    [copy.footer.legal]: [
      { label: legalLinks.privacy, href: "/privacy" },
      { label: legalLinks.terms, href: "/terms" },
      { label: legalLinks.cookies, href: "/cookies" },
      { label: legalLinks.subprocessors, href: "/subprocessors" },
    ],
  };
}

export function Footer({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale];
  return (
    <WoodPanel as="footer" className="site-footer pt-16 pb-8">

      <div className="relative z-10 mx-auto max-w-6xl px-6">
        <div className="grid gap-12 border-b border-border pb-16 md:grid-cols-[1.5fr_1fr]">
          <div className="space-y-4">
            <BrandMark iconClassName="size-10" wordmarkClassName="text-xl" />
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground/80">
              {copy.footer.tagline}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {Object.entries(footerLinks(copy)).map(([category, items]) => (
              <div key={category} className="space-y-4">
                <h4 className="text-sm font-bold text-foreground">{category}</h4>
                <ul className="space-y-3">
                  {items.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4 border-b border-border py-8">
          <h4 className="text-sm font-bold text-foreground">{copy.footer.agents}</h4>
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {agentDocFiles.map((file) => (
              <li key={file}>
                <a
                  href={`/${file}`}
                  className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {file}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {copy.footer.askAi}
            </p>
            <ul className="flex flex-wrap gap-2">
              {aiAskLinks.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-xs text-muted-foreground/60">
            &copy; {new Date().getFullYear()} MadeByRobot, LLC. {copy.footer.rights}
          </p>
          <div className="flex items-center gap-4">
            <a href={copy.otherLanguage.href} hrefLang={copy.otherLanguage.hrefLang}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              {copy.otherLanguage.label}
            </a>
            <div className="size-1.5 rounded-full bg-primary/50 shadow-[0_0_18px_rgba(255,255,255,0.35)]" />
            <span className="text-xs font-medium text-muted-foreground/40">{copy.footer.motto}</span>
          </div>
        </div>
      </div>
    </WoodPanel>
  );
}
