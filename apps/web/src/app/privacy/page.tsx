import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { PrivacyPolicyContent } from "@/content/legal/privacy-policy";

export const metadata: Metadata = {
  title: "Privacy Policy — xMatrix",
  description: "How MadeByRobot, LLC processes Customer Data, Agent data, and personal information in xMatrix.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPolicyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      description="How MadeByRobot, LLC processes Customer Data, Agent activity, and personal information across xMatrix."
    >
      <PrivacyPolicyContent />
    </LegalDocument>
  );
}
