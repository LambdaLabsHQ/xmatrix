"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";

interface SignedInSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  userAgent: string | null;
  current: boolean;
}

const QUERY_KEY = ["auth", "sessions"] as const;

/**
 * Where this person is signed in: browsers and apps by what they are, and the
 * sessions the Hub issued to terminals and daemons. Any one can be ended, or
 * all the others at once.
 */
export function SignedInSessions({ token }: { token?: string }) {
  const queryClient = useQueryClient();
  const [confirmEverything, setConfirmEverything] = useState(false);
  const sessions = useQuery({
    queryKey: QUERY_KEY,
    enabled: Boolean(token),
    queryFn: () => xmatrixApiRequest<{ sessions: SignedInSession[]; total: number }>({
      url: WEB_PROXY_ROUTES.me_sessions, token,
    }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const revoke = useMutation({
    mutationFn: (sessionId: string) => xmatrixApiRequest({
      url: WEB_PROXY_ROUTES.me_session_revoke, token, method: "POST", body: { sessionId },
    }),
    onSettled: refresh,
  });
  const revokeOthers = useMutation({
    mutationFn: (scope: "browsers" | "everything") => xmatrixApiRequest({
      url: WEB_PROXY_ROUTES.me_sessions_revoke_others, token, method: "POST", body: { scope },
    }),
    onSettled: () => { setConfirmEverything(false); return refresh(); },
  });
  const busy = revoke.isPending || revokeOthers.isPending;
  const failure = revoke.error ?? revokeOthers.error ?? sessions.error;
  const listed = sessions.data?.sessions ?? [];
  const hidden = Math.max(0, (sessions.data?.total ?? 0) - listed.length);

  return (
    <div className="flex items-start gap-3" data-testid="signed-in-sessions">
      <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-foreground">Where you&apos;re signed in</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Signing one out stops it at once. Computers and agents need <code>xmatrix login</code> again.
        </p>
        <ul className="mt-2 divide-y divide-border/60">
          {listed.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-foreground">
                  {describeSession(session.userAgent)}
                  {session.current ? <span className="font-normal text-muted-foreground"> · This browser</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">Signed in {formatDay(session.createdAt)}</p>
              </div>
              {session.current ? null : (
                <button type="button" disabled={busy} onClick={() => revoke.mutate(session.id)}
                  className={actionClass({ variant: "secondary", size: "sm" })}>Sign out</button>
              )}
            </li>
          ))}
        </ul>
        {hidden ? <p className="text-xs text-muted-foreground">and {hidden} older</p> : null}
        {failure ? <p className="mt-2 text-xs text-destructive">{userErrorMessage(failure, "That didn't work")}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy || listed.length < 2} onClick={() => revokeOthers.mutate("browsers")}
            className={actionClass({ variant: "secondary", size: "sm" })}>Sign out other browsers and apps</button>
          {confirmEverything ? (
            <>
              <button type="button" disabled={busy} onClick={() => revokeOthers.mutate("everything")}
                className={actionClass({ variant: "danger", size: "sm" })}>Also sign out computers and agents</button>
              <button type="button" disabled={busy} onClick={() => setConfirmEverything(false)}
                className={actionClass({ variant: "secondary", size: "sm" })}>Cancel</button>
            </>
          ) : (
            <button type="button" disabled={busy || listed.length < 2} onClick={() => setConfirmEverything(true)}
              className={actionClass({ variant: "secondary", size: "sm" })}>Sign out everywhere else</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Chrome on macOS", "xMatrix CLI", … from what the session's client said it was. */
export function describeSession(userAgent: string | null): string {
  if (!userAgent) return "Computer or terminal";
  if (userAgent.startsWith("xMatrix ")) return userAgent.split(" · ")[0]!;
  const platform = /iPhone|iPad/u.test(userAgent) ? "iPhone or iPad"
    : /Android/u.test(userAgent) ? "Android"
    : /Macintosh|Mac OS X/u.test(userAgent) ? "macOS"
    : /Windows/u.test(userAgent) ? "Windows"
    : /Linux/u.test(userAgent) ? "Linux" : "";
  const browser = /Electron\//u.test(userAgent) ? "xMatrix desktop app"
    : /Edg\//u.test(userAgent) ? "Edge"
    : /Firefox\//u.test(userAgent) ? "Firefox"
    : /Chrome\//u.test(userAgent) ? "Chrome"
    : /Safari\//u.test(userAgent) ? "Safari"
    : /AppleWebKit/u.test(userAgent) ? "xMatrix app" : "Browser";
  return platform ? `${browser} on ${platform}` : browser;
}

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
