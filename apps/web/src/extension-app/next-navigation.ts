/**
 * `next/navigation` for the app bundled into the Chrome extension, where no
 * Next router runs. The workspace shell keeps its own address in `history`;
 * what it asks of the router is a move to another address, which the page's
 * navigation rule (navigation.ts) then keeps inside the app or hands to a tab.
 */
import { useSyncExternalStore } from "react";

const router = {
  push: (href: string) => window.location.assign(href),
  replace: (href: string) => window.location.replace(href),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => undefined,
  prefetch: () => undefined,
};

export function useRouter() {
  return router;
}

function subscribeAddress(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribeAddress, () => window.location.pathname, () => "/app");
}
