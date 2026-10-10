"use client";

import { useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { actionClass } from "@/components/ui/action-tone";
import { userErrorMessage } from "@/lib/user-facing-error";
import { disableBrowserPush, enableBrowserPush, type BrowserPushState } from "@/lib/push-subscription";
import { ToolDetailSection, ToolSettingRow } from "./tool-split";

const DESCRIPTION: Record<BrowserPushState, string> = {
  on: "This browser is told when something is addressed to you, even when xMatrix is not open.",
  off: "Be told in this browser when something is addressed to you, even when xMatrix is not open.",
  blocked: "Notifications are blocked for this site. Allow them in the browser's site settings, then turn this on.",
  unsupported: "This browser cannot receive push notifications.",
  unavailable: "This xMatrix does not push to browsers.",
};

/** What Settings says about this browser's push in its list. */
export function browserPushSummary(state: BrowserPushState | null): string {
  return state === "on" ? "On in this browser" : state === "blocked" ? "Blocked in this browser" : "Off in this browser";
}

/** Settings' control for push in this browser: one row that says where it stands and turns it on or off. */
export function BrowserPushSetting({ token, state, onState }: {
  token: string;
  state: BrowserPushState | null;
  onState: (state: BrowserPushState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: () => Promise<BrowserPushState>) {
    setBusy(true);
    setError(null);
    try {
      onState(await next());
    } catch (changeError) {
      setError(userErrorMessage(changeError, "Couldn't change notifications"));
    } finally {
      setBusy(false);
    }
  }

  const canChange = state === "on" || state === "off";
  return (
    <ToolDetailSection title="This browser">
      <ToolSettingRow
        title="Push notifications"
        description={error ?? (state ? DESCRIPTION[state] : "Checking this browser…")}
        control={canChange ? (
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary" })}
            onClick={() => void change(() => state === "on" ? disableBrowserPush(token) : enableBrowserPush(token))}>
            {state === "on" ? <BellOff className="size-4" /> : <Bell className="size-4" />}
            {state === "on" ? "Turn off" : "Turn on"}
          </button>
        ) : null}
      />
    </ToolDetailSection>
  );
}
