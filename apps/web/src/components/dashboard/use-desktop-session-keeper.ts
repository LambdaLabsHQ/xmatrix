"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { APP_CONNECTOR_PROVIDER_MANIFESTS, WEB_PROXY_ROUTES, type SerializedAppConnectorConnection } from "@xmatrix/protocol";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";

/*
 * Web sessions a connector keeps (App Store Connect's), renewed while the
 * desktop app runs. Apple ends such a session after a day to a month, sooner
 * when it is used from elsewhere than it was signed in from, and the Hub can
 * only report that it lapsed. The app's own sign-in profile usually still
 * holds a good session (or gets one back by itself), so now and then the page
 * asks the shell for it, without any window, and saves it to every connection
 * of the person's Spaces that keeps that field. The person is asked to sign in
 * only when the profile itself is signed out, as before.
 */

const EVERY_MS = 3 * 60 * 60_000;
/** At most this often when the app comes back (focus, network, wake). */
const AGAIN_MS = 30 * 60_000;

/** Credential fields the desktop app can fill by signing in, by provider. */
const SIGN_IN_FIELDS = new Map(APP_CONNECTOR_PROVIDER_MANIFESTS.flatMap((manifest) => {
  const fields = (manifest.credentials ?? []).filter((field) => field.signIn).map((field) => ({ id: field.id, service: field.signIn! }));
  return fields.length ? [[manifest.id, fields] as const] : [];
}));

export function useDesktopSessionKeeper({ token, spaceIds }: { token: string | undefined; spaceIds: readonly string[] }) {
  const queryClient = useQueryClient();
  const latest = useRef({ token, spaceIds });
  latest.current = { token, spaceIds };
  const spacesKey = [...spaceIds].sort().join(",");

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.serviceSession || !token || !spacesKey) return;
    let stopped = false;
    let running = false;
    let last = 0;

    const renew = async () => {
      const { token: current, spaceIds: spaces } = latest.current;
      if (!current) return;
      // One question to the shell per service, whatever the number of Spaces.
      const sessions = new Map<string, Promise<string | null>>();
      const held = (service: string) => {
        let pending = sessions.get(service);
        if (!pending) {
          pending = bridge.serviceSession!(service).then((outcome) => outcome.status === "signed-in" ? outcome.session : null, () => null);
          sessions.set(service, pending);
        }
        return pending;
      };
      for (const spaceId of spaces) {
        if (stopped) return;
        const connections = await xmatrixApiRequest<{ connections?: SerializedAppConnectorConnection[] }>({
          url: WEB_PROXY_ROUTES.space_app_connections(spaceId), token: current,
        }).then((payload) => payload.connections ?? [], () => []);
        for (const connection of connections) {
          const kept = (SIGN_IN_FIELDS.get(connection.providerId as never) ?? [])
            .filter((field) => connection.credentialFields?.includes(field.id));
          for (const field of kept) {
            const session = await held(field.service);
            if (!session || stopped) continue;
            // Only a Space admin may write it; anyone else is simply skipped.
            await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_app_connection_credentials(spaceId, connection.providerId),
              method: "PUT", token: current, body: { fields: { [field.id]: session } } }).catch(() => undefined);
          }
        }
      }
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) =>
        part === "app-connections" || part === "app-connection-credentials") });
    };

    const run = (force: boolean) => {
      if (stopped || running || (!force && Date.now() - last < AGAIN_MS)) return;
      running = true;
      last = Date.now();
      void renew().finally(() => { running = false; });
    };
    const onReturn = () => { if (document.visibilityState !== "hidden") run(false); };
    const first = setTimeout(() => run(true), 15_000);
    const timer = setInterval(() => run(true), EVERY_MS);
    window.addEventListener("online", onReturn);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("online", onReturn);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [queryClient, token, spacesKey]);
}
