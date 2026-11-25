import { sitePageMetadata } from "@/lib/site-metadata";

import { LegalDocument } from "@/components/legal/legal-document";
import { TermsOfServiceContent } from "@/content/legal/terms-of-service";

export const metadata = sitePageMetadata(
  "/terms",
  "Terms of Service — xMatrix",
  "The terms that govern access to and use of xMatrix services from MadeByRobot, LLC.",
);

export default function TermsOfServicePage() {
  return (
    <LegalDocument
      title="Terms of Service"
      description="The rights, responsibilities, and Agent authority that apply when a Customer uses xMatrix."
      version="2026-11-25"
      effectiveDate="25 November 2026"
    >
      <TermsOfServiceContent />
    </LegalDocument>
  );
}
