import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "@/lib/app-stores";
import { agentDocFiles, aiAskLinks } from "@/lib/agent-docs";
import { footerAlternativePages } from "@/lib/alternatives";
import { landingCopy, type LandingCopy, type Locale } from "@/lib/landing-copy";
import { SITE_LOCALE_IDS, SITE_LOCALES, localizedPath } from "@/lib/site-locales";
import { sitePagesCopy } from "@/lib/site-pages-copy";
import { REPOSITORY_URL } from "@/lib/star-prompt";
import { appHref } from "@/lib/site-url";

// X verifies the organization by this link back to its account.
export const X_ACCOUNT_URL = "https://x.com/xMatrix_hq";

function footerLinks(copy: LandingCopy, locale: Locale) {
  const { links, legalLinks } = copy.footer;
  return {
    [copy.footer.product]: [
      { label: links.app, href: appHref("/app") },
      { label: links.download, href: localizedPath(locale, "/download") },
      { label: "App Store", href: APP_STORE_URL },
      { label: "Google Play", href: GOOGLE_PLAY_URL },
      { label: links.pricing, href: `${copy.home}#pricing` },
      { label: links.docs, href: localizedPath(locale, "/docs") },
      { label: links.support, href: localizedPath(locale, "/support") },
      { label: "GitHub", href: REPOSITORY_URL },
      { label: "X", href: X_ACCOUNT_URL },
      { label: links.console, href: appHref("/console") },
      { label: links.signIn, href: appHref("/login") },
    ],
    [copy.footer.legal]: [
      { label: legalLinks.privacy, href: "/privacy" },
      { label: legalLinks.terms, href: "/terms" },
      { label: legalLinks.cookies, href: "/cookies" },
      { label: legalLinks.subprocessors, href: "/subprocessors" },
    ],
  };
}

export function Footer({ locale = "en", basePath = "/" }: { locale?: Locale; basePath?: string }) {
  const copy = landingCopy[locale];
  const altChrome = sitePagesCopy[locale].alternatives;
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
            {Object.entries(footerLinks(copy, locale)).map(([category, items]) => (
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
          <h4 className="text-sm font-bold text-foreground">{copy.footer.compare}</h4>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {footerAlternativePages.map((page) => (
              <li key={page.slug}>
                <a
                  href={localizedPath(locale, page.basePath)}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {altChrome.linkLabel(page.name)}
                </a>
              </li>
            ))}
          </ul>
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
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <nav aria-label={copy.footer.language} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {SITE_LOCALE_IDS.map((id) => {
                const meta = SITE_LOCALES[id];
                const isCurrent = id === locale;
                return (
                  <a
                    key={id}
                    href={localizedPath(id, basePath)}
                    hrefLang={meta.hrefLang}
                    aria-current={isCurrent ? "page" : undefined}
                    className={`text-xs transition-colors hover:text-foreground ${isCurrent ? "underline underline-offset-4" : "text-muted-foreground"}`}
                  >
                    {meta.nativeLabel}
                  </a>
                );
              })}
            </nav>
            <div className="size-1.5 rounded-full bg-primary/50 shadow-[0_0_18px_rgba(255,255,255,0.35)]" />
            <span className="text-xs font-medium text-muted-foreground/40">{copy.footer.motto}</span>
          </div>
        </div>
      </div>
    </WoodPanel>
  );
}
