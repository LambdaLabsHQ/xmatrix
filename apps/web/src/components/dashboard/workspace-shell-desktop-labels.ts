/**
 * Pure desktop status copy helpers (no workspace UI view module imports).
 */
import type { DesktopDaemonStatus, DesktopUpdateStatus } from "@/lib/desktop/bridge";
import { userErrorMessage } from "../../lib/user-facing-error";

export function desktopUpdateLabel(
  status: DesktopUpdateStatus | null,
  desktopAvailable: boolean,
  bridgeAvailable: boolean
) {
  if (!desktopAvailable) return "Desktop unavailable";
  if (!bridgeAvailable) return "Manual only";
  if (!status) return "Loading";

  switch (status.state) {
    case "checking":
      return "Checking";
    case "downloading":
      return status.percent === undefined ? "Downloading" : `${Math.round(status.percent)}%`;
    case "downloaded":
      return "Ready to install";
    case "installing":
      return "Restarting";
    case "not-available":
      return "Up to date";
    case "error":
      return "Check failed";
    case "disabled":
      return "Disabled";
    case "available":
      return "Available";
    default:
      return status.enabled ? "Automatic" : "Disabled";
  }
}


export function desktopUpdateErrorStatus(
  status: DesktopUpdateStatus | null,
  error: unknown
): DesktopUpdateStatus | null {
  if (!status) return status;
  return {
    ...status,
    state: "error",
    message: userErrorMessage(error, "Couldn't install xMatrix update") ?? "",
    updatedAt: new Date().toISOString(),
  };
}

export function desktopUpdateDescription(
  status: DesktopUpdateStatus | null,
  desktopAvailable: boolean,
  bridgeAvailable: boolean
) {
  if (!desktopAvailable) {
    return "Open this page in the xMatrix desktop app to use native notifications and automatic updates.";
  }
  if (!bridgeAvailable) {
    return "This desktop build can trigger update checks. Status streaming is available after the next app update.";
  }
  if (!status) {
    return "Loading desktop update status.";
  }
  if (status.message) {
    return status.message;
  }
  if (status.state === "idle") {
    return "xMatrix checks for updates automatically in the background.";
  }
  return "Desktop updates are managed by the desktop app.";
}

export function desktopDaemonLabel(status: DesktopDaemonStatus | null, desktopAvailable: boolean) {
  if (!desktopAvailable) return "Unavailable";
  if (!status) return "Loading";
  if (status.state === "running" && status.pid) return `Running (${status.pid})`;
  return status.state.charAt(0).toUpperCase() + status.state.slice(1);
}

export function daemonStatusNeedsSessionSync(status: DesktopDaemonStatus | null) {
  if (!status || status.state !== "error") return false;
  const message = (status.message || "").toLowerCase();
  return (
    message.includes("fresh cli session") ||
    message.includes("sign in") ||
    message.includes("not logged in") ||
    message.includes("session refresh failed") ||
    message.includes("invalid refresh token") ||
    message.includes("already used") ||
    message.includes("invalid or expired auth token") ||
    message.includes("saved session cannot be refreshed") ||
    message.includes("session expired") ||
    message.includes("login state lost") ||
    message.includes("waiting for browser login")
  );
}
