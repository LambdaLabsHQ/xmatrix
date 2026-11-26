import {
  SIGNUP_SOURCE_HOST_PARAM,
  isOwnSignupSourceHost,
  signupSourceOfVisit,
  withSignupSource,
  type SignupSource,
} from "@xmatrix/protocol";

/*
 * Where this visit came from (packages/protocol/src/signup-source.ts), so a new
 * account can say which channel brought it. Held in page memory only: nothing
 * is written to the device. Read once, when the first page of the visit loads,
 * because the referrer and the landing URL are only true then; client-side
 * navigation keeps the module, and so the answer, for the rest of the visit.
 */
let visit: SignupSource | null = null;

/** This visit's source, read on first use from the page it started on. */
export function currentSignupSource(): SignupSource | null {
  if (visit) return visit;
  if (typeof window === "undefined") return null;
  visit = signupSourceOfVisit(window.location.href, document.referrer);
  return visit;
}

/** `url` carrying this visit's source, for a sign-in that returns to a new page. */
export function withCurrentSignupSource(url: string): string {
  const source = currentSignupSource();
  return source ? withSignupSource(url, source) : url;
}

/**
 * A full page load would read our own page as the referrer and lose where the
 * visit began, so a link from one of our pages to another (xmatrix.page to
 * xmatrix.sh, or a plain anchor to /login) carries it in the URL. The signed-in
 * app keeps no visit to carry, so its links are left as they are.
 */
export function carrySignupSourceAcrossOwnLinks(): void {
  if (typeof window === "undefined") return;
  currentSignupSource();
  document.addEventListener("click", (event) => {
    if (onAppRoute(window.location.pathname)) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    let target: URL;
    try { target = new URL(anchor.href); } catch { return; }
    if (!isOwnSignupSourceHost(target.hostname) || target.searchParams.has(SIGNUP_SOURCE_HOST_PARAM)) return;
    // Within a site only the way into an account needs it; other links stay clean.
    const intoAccount = target.pathname === "/login" || onAppRoute(target.pathname);
    if (target.origin === window.location.origin && !intoAccount) return;
    anchor.href = withCurrentSignupSource(anchor.href);
  }, { capture: true });
}

function onAppRoute(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}
