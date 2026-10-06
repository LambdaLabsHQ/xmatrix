import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { TermsOfServiceContent } from "@/content/legal/terms-of-service";

export const metadata: Metadata = {
  title: "Terms of Service — xMatrix",
  description: "The terms that govern access to and use of xMatrix services from MadeByRobot, LLC.",
  alternates: { canonical: "/terms" },
};

export default function TermsOfServicePage() {
  return (
    <LegalDocument
      title="Terms of Service"
      description="The rights, responsibilities, and Agent authority that apply when a Customer uses xMatrix."
    >
      <TermsOfServiceContent />
    </LegalDocument>
  );
}
