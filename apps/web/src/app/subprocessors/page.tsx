import type { Metadata } from "next";

import { LegalDocument } from "@/components/legal/legal-document";
import { SubprocessorsContent } from "@/content/legal/subprocessors";

export const metadata: Metadata = {
  title: "Subprocessors — xMatrix",
  description: "Service providers MadeByRobot uses to process xMatrix Customer Data.",
  alternates: { canonical: "/subprocessors" },
};

export default function SubprocessorsPage() {
  return (
    <LegalDocument
      title="Subprocessors"
      description="The service providers MadeByRobot uses to host, secure, and operate xMatrix."
    >
      <SubprocessorsContent />
    </LegalDocument>
  );
}
