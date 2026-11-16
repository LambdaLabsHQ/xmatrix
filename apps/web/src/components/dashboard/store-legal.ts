/**
 * The legal links and plan wording a store purchase shows next to its buttons.
 * App Review (Guideline 3.1.2) requires the subscription's title, length and
 * price, and working links to the privacy policy and Terms of Use (EULA). The
 * App Store listing uses Apple's standard EULA, so the App Store section links
 * that EULA; xMatrix's own Terms of Service still apply alongside it.
 */
export const APPLE_STANDARD_EULA_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

export type StoreLegalLink = { href: string; label: string; external: boolean };

export function storeLegalLinks(provider: "apple" | "google"): StoreLegalLink[] {
  return [
    ...(provider === "apple" ? [{ href: APPLE_STANDARD_EULA_URL, label: "Terms of Use (EULA)", external: true }] : []),
    { href: "/privacy", label: "Privacy Policy", external: false },
    { href: "/terms", label: "Terms of Service", external: false },
  ];
}

/** "xMatrix Pro Monthly · 1 month · $10.00/month": the title, length and price App Review asks for. */
export function storePlanLabel(product: { title: string; interval: "month" | "year"; displayPrice: string }): string {
  return `${product.title} · 1 ${product.interval} · ${product.displayPrice}/${product.interval}`;
}
