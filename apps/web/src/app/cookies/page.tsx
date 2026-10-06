import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { CookieNoticeContent } from "@/content/legal/cookie-notice";

export const metadata: Metadata = {
  title: "Cookie and Local Storage Notice — xMatrix",
  description: "How xMatrix uses cookies, local storage, offline replicas, and device permissions.",
  alternates: { canonical: "/cookies" },
};

export default function CookieNoticePage() {
  return (
    <LegalDocument
      title="Cookie and Local Storage Notice"
      description="The required storage and device access used to authenticate, secure, and operate xMatrix."
    >
      <CookieNoticeContent />
    </LegalDocument>
  );
}
