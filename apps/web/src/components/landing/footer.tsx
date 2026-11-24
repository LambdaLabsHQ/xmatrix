import { BrandMark } from "@/components/shared/brand-mark";
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

/* The stores ask for this credit wherever their badges or names are shown. */
const STORE_MARKS = "Apple, the Apple logo, iPhone, iPad and Mac are trademarks of Apple Inc. App Store is a service mark of Apple Inc. "
  + "Google Play and the Google Play logo are trademarks of Google LLC.";

function footerColumns(copy: LandingCopy, locale: Locale) {
  const { links, legalLinks } = copy.footer;
  return [
    [copy.footer.product, [
      { label: links.app, href: appHref("/app") },
      { label: links.pricing, href: `${copy.home}#pricing` },
      { label: links.docs, href: localizedPath(locale, "/docs") },
      { label: links.support, href: localizedPath(locale, "/support") },
      { label: links.signIn, href: appHref("/login") },
      { label: links.console, href: appHref("/console") },
    ]],
    [copy.footer.getApp, [
      { label: links.download, href: localizedPath(locale, "/download") },
      { label: "App Store", href: APP_STORE_URL },
      { label: "Google Play", href: GOOGLE_PLAY_URL },
    ]],
    [copy.footer.legal, [
      { label: legalLinks.privacy, href: "/privacy" },
      { label: legalLinks.terms, href: "/terms" },
      { label: legalLinks.cookies, href: "/cookies" },
      { label: legalLinks.subprocessors, href: "/subprocessors" },
    ]],
  ] as const;
}

/* Quiet ink that darkens under the pointer; a heading over each group of links. */
const LINK = "transition-colors hover:text-[var(--site-ink)]";
const HEADING = "text-[0.8125rem] font-[650] text-[var(--site-ink)]";
const INLINE = "flex flex-wrap gap-x-5 gap-y-1.5";
/* Below the top block each part is a row: its heading in a narrow column, its links beside it. */
const ROW = "mt-11 grid gap-3 md:grid-cols-[7rem_minmax(0,1fr)] md:gap-x-8";

/**
 * The foot of every public page, on the page's own paper: where things are,
 * how xMatrix compares, what an AI agent can read, and the page's languages.
 * Spacing sets its parts apart; it draws no rules and no slab.
 */
export function Footer({ locale = "en", basePath = "/" }: { locale?: Locale; basePath?: string }) {
  const copy = landingCopy[locale];
  const altChrome = sitePagesCopy[locale].alternatives;
  return (
    <footer className="site-footer pt-[clamp(1.5rem,3vw,2.5rem)] pb-10 text-sm leading-[1.6] text-[var(--site-ink-muted)]">
      <div className="x-container">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-[minmax(0,5fr)_repeat(3,minmax(0,2fr))] md:gap-x-8">
          <div className="col-span-full grid content-start gap-4 md:col-auto">
            <BrandMark iconSrc="/brand/xmatrix-icon-transparent-128.png" iconClassName="overflow-visible" wordmarkClassName="text-xl" />
            <p className="max-w-[22rem]">{copy.footer.tagline}</p>
          </div>
          {footerColumns(copy, locale).map(([title, items]) => (
            <div key={title}>
              <h4 className={HEADING}>{title}</h4>
              <ul className="mt-3.5 grid gap-2.5">
                {items.map((item) => <li key={item.label}><a href={item.href} className={LINK}>{item.label}</a></li>)}
              </ul>
            </div>
          ))}
        </div>

        <div className={ROW}>
          <h4 className={HEADING}>{copy.footer.compare}</h4>
          <ul className={INLINE}>
            {footerAlternativePages.map((page) => (
              <li key={page.slug}><a href={localizedPath(locale, page.basePath)} className={LINK}>{altChrome.linkLabel(page.name)}</a></li>
            ))}
          </ul>
        </div>

        <div className={ROW}>
          <h4 className={HEADING}>{copy.footer.agents}</h4>
          <ul className={`${INLINE} font-mono`}>
            {agentDocFiles.map((file) => <li key={file}><a href={`/${file}`} className={LINK}>{file}</a></li>)}
          </ul>
          <p className={`${INLINE} md:col-start-2`}>
            <span>{copy.footer.askAi}</span>
            {aiAskLinks.map((link) => (
              <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer"
                className="text-[var(--site-ink)] underline decoration-[color-mix(in_oklch,var(--site-ink),transparent_72%)] underline-offset-4 hover:decoration-current">
                {link.label}
              </a>
            ))}
          </p>
        </div>

        <div className="mt-14 grid gap-3 text-[0.8125rem] md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-baseline md:gap-x-10">
          <p>&copy; {new Date().getFullYear()} MadeByRobot, LLC. {copy.footer.rights}</p>
          <ul className={INLINE}>
            <li><a href={REPOSITORY_URL} className={LINK}>GitHub</a></li>
            <li><a href={X_ACCOUNT_URL} className={LINK}>X</a></li>
          </ul>
          <nav aria-label={copy.footer.language}>
            <ul className={INLINE}>
              {SITE_LOCALE_IDS.map((id) => (
                <li key={id}>
                  <a href={localizedPath(id, basePath)} hrefLang={SITE_LOCALES[id].hrefLang} aria-current={id === locale ? "page" : undefined}
                    className={`${LINK} aria-[current=page]:text-[var(--site-ink)]`}>
                    {SITE_LOCALES[id].nativeLabel}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <p className="col-span-full max-w-[46rem] text-[0.6875rem] opacity-80">{STORE_MARKS}</p>
        </div>
      </div>
    </footer>
  );
}
