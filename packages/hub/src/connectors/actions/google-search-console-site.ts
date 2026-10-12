const MAX_URL = 2_048;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u;

/** A public http(s) page or sitemap address without credentials or fragments. */
export function pageUrl(value: string): URL | undefined {
  if (!value || value.length > MAX_URL || /\s/u.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !DOMAIN.test(url.hostname)) return undefined;
  return url;
}

/** `sc-domain:example.com` or a URL-prefix property such as `https://www.example.com/`. */
export function searchConsoleSite(target: string): string | undefined {
  if (target.startsWith("sc-domain:")) {
    const domain = target.slice("sc-domain:".length);
    return DOMAIN.test(domain) ? target : undefined;
  }
  const url = pageUrl(target);
  return url && !url.search && url.pathname.endsWith("/") && url.href === target ? target : undefined;
}

/** Whether a page belongs to the property, so Google is never asked about another site. */
export function searchConsoleSiteContains(site: string, page: URL): boolean {
  if (site.startsWith("sc-domain:")) {
    const domain = site.slice("sc-domain:".length);
    return page.hostname === domain || page.hostname.endsWith(`.${domain}`);
  }
  return page.href.startsWith(site);
}

