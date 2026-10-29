import { preconnect } from "react-dom";
import { xmatrixHubOrigin } from "@/lib/query/api-client";

/**
 * Sign-in and the first reads go to the Hub as soon as the app's scripts run.
 * Open both of its connection pools (cookie and bearer) while they download.
 */
export function HubPreconnect() {
  const origin = xmatrixHubOrigin();
  if (!/^https?:\/\//u.test(origin)) return null;
  preconnect(origin, { crossOrigin: "use-credentials" });
  preconnect(origin, { crossOrigin: "anonymous" });
  return null;
}
