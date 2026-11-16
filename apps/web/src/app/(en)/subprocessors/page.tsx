import { sitePageMetadata } from "@/lib/site-metadata";

import { LegalDocument } from "@/components/legal/legal-document";
import { SubprocessorsContent } from "@/content/legal/subprocessors";

export const metadata = sitePageMetadata(
  "/subprocessors",
  "Subprocessors — xMatrix",
  "Service providers MadeByRobot uses to process xMatrix Customer Data.",
);

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
