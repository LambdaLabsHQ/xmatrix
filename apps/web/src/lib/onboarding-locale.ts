"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { WEB_PROXY_ROUTES, onboardingLocale, type OnboardingLocale } from "@xmatrix/protocol";
import { ONBOARDING_COPY, type OnboardingCopy } from "./onboarding-copy";

/* The language of the path a new person walks in their first ten minutes
   (onboarding-copy.ts). The Web has no translation framework; only these
   screens follow the person's language. A display locale they saved for the
   Space wins; otherwise the browser's first language does. */

function subscribe(onChange: () => void): () => void {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

function browserLanguage(): string {
  return navigator.languages?.[0] ?? navigator.language ?? "";
}

/** The browser's language; English while rendering on the server. */
export function useBrowserOnboardingLocale(): OnboardingLocale {
  return onboardingLocale(useSyncExternalStore(subscribe, browserLanguage, () => ""));
}

export function useOnboardingLocale(spaceId: string | null | undefined, token: string | null | undefined,
  userId: string | undefined): OnboardingLocale {
  const browser = useBrowserOnboardingLocale();
  const saved = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "locale-preference", [spaceId]),
    queryFn: ({ signal }) => xmatrixApiRequest<{ displayLocale: string | null }>({
      url: WEB_PROXY_ROUTES.space_locale_preference(spaceId!), token: token!, signal,
    }),
    enabled: Boolean(spaceId && token && userId), staleTime: 5 * 60_000, retry: false,
  });
  return saved.data?.displayLocale ? onboardingLocale(saved.data.displayLocale) : browser;
}

export function useOnboardingCopy(spaceId: string | null | undefined, token: string | null | undefined,
  userId: string | undefined): OnboardingCopy {
  return ONBOARDING_COPY[useOnboardingLocale(spaceId, token, userId)];
}
