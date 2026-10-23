"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { actionClass } from "@/components/ui/action-tone";
import { addAccountPasskey, deleteAccountPasskey, listAccountPasskeys } from "@/lib/auth-client";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { isAbort, userErrorMessage } from "@/lib/user-facing-error";

const QUERY_KEY = ["auth", "passkeys"] as const;

/**
 * Passkeys: sign in with Face ID, a fingerprint or the device PIN instead of a
 * code. Each one is kept by the device or password manager that made it.
 */
export function PasskeySettings() {
  const queryClient = useQueryClient();
  const [supported, setSupported] = useState(false);
  // The app shells don't offer passkeys to the page yet; a browser does.
  useEffect(() => setSupported("PublicKeyCredential" in window && !getDesktopBridge()), []);
  const passkeys = useQuery({ queryKey: QUERY_KEY, queryFn: listAccountPasskeys, enabled: supported });
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const add = useMutation({ mutationFn: () => addAccountPasskey(deviceName()), onSettled: refresh });
  const remove = useMutation({ mutationFn: deleteAccountPasskey, onSettled: refresh });
  const failure = [add.error, remove.error, passkeys.error].find((error) => error && !isAbort(error));
  if (!supported) return null;

  return (
    <div className="flex items-start gap-3" data-testid="passkey-settings">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-foreground">Passkeys</p>
          <button type="button" disabled={add.isPending} onClick={() => add.mutate()}
            className={actionClass({ variant: "secondary", size: "sm" })}>
            {add.isPending ? "Waiting…" : "Add a passkey"}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Sign in with Face ID, a fingerprint or this device&apos;s PIN instead of an email code.
        </p>
        {passkeys.data?.length ? (
          <ul className="mt-2 divide-y divide-border/60">
            {passkeys.data.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-3 py-2">
                <p className="truncate text-xs font-semibold text-foreground">{passkey.name || "Passkey"}</p>
                <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(passkey.id)}
                  className={actionClass({ variant: "secondary", size: "sm" })}>Remove</button>
              </li>
            ))}
          </ul>
        ) : null}
        {failure ? <p className="mt-2 text-xs text-destructive">{userErrorMessage(failure, "That didn't work")}</p> : null}
      </div>
    </div>
  );
}

/** A name to tell this passkey from others later: the kind of device it was made on. */
function deviceName(): string {
  const agent = navigator.userAgent;
  return /iPhone|iPad/u.test(agent) ? "iPhone or iPad"
    : /Android/u.test(agent) ? "Android"
    : /Macintosh/u.test(agent) ? "Mac"
    : /Windows/u.test(agent) ? "Windows"
    : "This device";
}
