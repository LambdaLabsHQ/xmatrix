/**
 * What the Web's document runs in its head before first paint
 * (components/site-document.tsx), for the packaged page. An extension page may
 * run no inline script, so the build writes this text to a file of its own.
 */
import { browserBackEntryScript } from "@/components/dashboard/browser-back-entry-script";
import { HIGHLIGHT_INHERITANCE_MODE_SCRIPT } from "@/components/ui/highlight-inheritance-mode";
import { OVERLAY_SCROLLBARS_MODE_SCRIPT } from "@/components/ui/overlay-scrollbars-mode";

export const DOCUMENT_HEAD_SCRIPT = [OVERLAY_SCROLLBARS_MODE_SCRIPT, HIGHLIGHT_INHERITANCE_MODE_SCRIPT, browserBackEntryScript]
  .join("\n");
