"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ClientCompatibilityDecision,
  ClientCompatibilityIdentity,
} from "@xmatrix/protocol";
import { checkAppCompatibility } from "@/lib/app-client-compatibility";
import { getDesktopBridge, type DesktopUpdateStatus } from "@/lib/desktop/bridge";
import { userErrorMessage } from "@/lib/user-facing-error";

type ScreenState =
  | { state: "checking" }
  | { state: "required"; identity: ClientCompatibilityIdentity; decision: ClientCompatibilityDecision }
  | { state: "unavailable"; message: string };

export function UpgradeRequiredScreen() {
  const [screen, setScreen] = useState<ScreenState>({ state: "checking" });
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus>();
  const [updating, setUpdating] = useState(false);

  const check = useCallback(async () => {
    setScreen({ state: "checking" });
    try {
      const result = await checkAppCompatibility();
      if (result.decision.compatible) {
        window.location.replace("/app");
        return;
      }
      setScreen({ state: "required", ...result });
    } catch (error) {
      setScreen({
        state: "unavailable",
        message: userErrorMessage(error, "Couldn't check whether this app is up to date") ?? "",
      });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus(setUpdateStatus);
  }, []);

  async function updateNativeApp() {
    const bridge = getDesktopBridge();
    if (!bridge) {
      window.location.assign("/download");
      return;
    }
    setUpdating(true);
    try {
      let status = await bridge.checkForUpdates();
      if ((status?.state === "available" || status?.state === "downloaded") && bridge.installUpdate) {
        status = await bridge.installUpdate();
      }
      if (status) setUpdateStatus(status);
      if (!status || status.state === "disabled" || status.state === "error") {
        await bridge.openExternal("https://xmatrix.sh/download");
      }
    } catch {
      try {
        await bridge.openExternal("https://xmatrix.sh/download");
      } catch {
        window.location.assign("/download");
      }
    } finally {
      setUpdating(false);
    }
  }

  const required = screen.state === "required" ? screen : undefined;
  return (
    <main className="site-page site-login flex min-h-dvh items-center justify-center px-6 py-12 text-[#241f19]">
      <section className="site-login-panel w-full max-w-lg rounded-2xl border border-black/10 bg-white p-8 shadow-sm sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b3d]">Update required</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">This version can no longer connect</h1>
        <p className="mt-4 text-sm leading-6 text-[#675c50]">
          {required?.decision.error || (screen.state === "unavailable"
            ? screen.message
            : "Checking this app before opening your workspace.")}
        </p>
        {required ? (
          <dl className="mt-6 grid grid-cols-2 gap-3 rounded-xl bg-[#f7f3ed] p-4 text-sm">
            <div>
              <dt className="text-[#7a6b5b]">Installed</dt>
              <dd className="mt-1 font-mono font-semibold">{required.identity.version}</dd>
            </div>
            <div>
              <dt className="text-[#7a6b5b]">Minimum</dt>
              <dd className="mt-1 font-mono font-semibold">{required.decision.minimumVersion || "Latest"}</dd>
            </div>
          </dl>
        ) : null}
        {updateStatus?.message ? (
          <p className="mt-4 rounded-lg border border-black/10 px-3 py-2 text-sm text-[#675c50]">
            {updateStatus.message}
          </p>
        ) : null}
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => void updateNativeApp()}
            disabled={updating || screen.state === "checking"}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-[#241f19] px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {updating ? "Checking for update…" : "Update xMatrix"}
          </button>
          <button
            type="button"
            onClick={() => void check()}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-black/15 bg-white px-5 text-sm font-semibold"
          >
            Check again
          </button>
        </div>
        <a href="/download" className="mt-5 inline-block text-sm font-medium underline underline-offset-4">
          Download the latest version manually
        </a>
      </section>
    </main>
  );
}
