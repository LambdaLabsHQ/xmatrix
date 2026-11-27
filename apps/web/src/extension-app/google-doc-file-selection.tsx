"use client";

import { ExternalLink } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { appUrl } from "@/lib/site-url";

/**
 * Extension stand-in for `components/dashboard/google-doc-file-selection.tsx`.
 * Chrome Manifest V3 forbids loading Google's remote Picker scripts
 * (`apis.google.com/js/api.js`, `accounts.google.com/gsi/client`) inside an
 * extension package, so the side panel opens this Space's page on xMatrix Web
 * where Google Picker runs natively.
 */
export function GoogleDocFileSelection({ spaceId }: { spaceId: string; token: string }) {
  const openOnWeb = () => {
    const currentPath = `${window.location.pathname}${window.location.search}`;
    const target = new URL(
      currentPath.startsWith("/app") ? currentPath : `/app/${encodeURIComponent(spaceId)}`,
      appUrl,
    ).href;
    window.open(target, "_blank", "noopener,noreferrer");
  };

  return (
    <div>
      <button
        type="button"
        className={actionClass({ variant: "secondary", size: "sm" })}
        onClick={openOnWeb}
      >
        <ExternalLink className="size-3.5" /> Choose a Doc or Sheet on Web
      </button>
    </div>
  );
}
