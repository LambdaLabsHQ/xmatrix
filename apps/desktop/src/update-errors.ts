type DesktopUpdateErrorContext = {
  manualUpdateCheck: boolean;
  manualDownloadInProgress: boolean;
  state: string;
};

export function shouldShowUpdateRecovery(context: DesktopUpdateErrorContext) {
  return (
    context.manualUpdateCheck ||
    context.manualDownloadInProgress ||
    context.state === "installing"
  );
}

export function readableUpdateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown update error.");
  if (
    (message.includes("latest-mac.yml") || message.includes("latest.yml")) &&
    (message.includes("404") || message.includes("Release asset not found"))
  ) {
    return "The desktop update feed is missing its platform manifest. Re-publish the desktop release assets, then try again.";
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes("did not pass validation") ||
    normalized.includes("code signature") ||
    normalized.includes("specified code requirement") ||
    normalized.includes("cssmerr")
  ) {
    return "macOS could not verify this update against the installed app. Download the latest signed version and reinstall it once; automatic updates will resume afterwards.";
  }

  const trimmed = message.trim();
  if (!trimmed) return "Unknown update error.";
  if (trimmed.length > 240) {
    return "The update check failed. See the desktop logs for the full error.";
  }
  return trimmed;
}
