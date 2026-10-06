import Link from "next/link";

import {
  LEGAL_CONTACT_EMAIL,
  LegalContactLink,
  LegalList,
  LegalSection,
} from "@/components/legal/legal-document";

export function CookieNoticeContent() {
  return (
    <>
      <LegalSection id="scope" title="1. Scope">
        <p>
          This notice explains how xMatrix uses cookies, browser and application storage, offline
          replicas, and device permissions. It supplements our{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="required-storage" title="2. Required cookies and storage">
        <p>
          xMatrix currently uses only storage that is necessary for security, authentication, user
          choices, or requested product functionality. Depending on the client and features you use,
          this includes:
        </p>
        <LegalList>
          <li>
            secure session cookies used to sign you in, refresh your session, identify the selected
            authentication flow, prevent abuse, and route authenticated requests;
          </li>
          <li>
            local preferences and interface state, such as appearance, drafts, dismissed notices,
            navigation state, and feature configuration;
          </li>
          <li>
            authorized offline content, search indexes, media, synchronization checkpoints, and
            capacity records stored in browser IndexedDB or OPFS, or in protected application storage;
          </li>
          <li>
            bounded security, reliability, and operational diagnostics produced by our service and
            infrastructure provider; and
          </li>
          <li>
            storage used by Google or Stripe after you intentionally enter their authentication or
            payment flows, under their own notices and controls.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="offline-replicas" title="3. Offline replicas and local data">
        <p>
          Web clients may keep an origin-scoped replica in browser storage. Desktop and daemon clients
          may keep a local search replica whose content values are protected with authenticated
          encryption and a key held by the operating system credential store. A local replica is not a
          separate source of authorization: current Space and Channel permissions continue to control
          what can be synchronized or shown.
        </p>
        <p>
          Settings may provide controls to inspect or clear supported local categories. Sign-out,
          revocation, user change, deletion, and storage pressure trigger the applicable logical or
          physical cleanup. Data already downloaded to an offline or lost device cannot be guaranteed
          to disappear remotely.
        </p>
      </LegalSection>

      <LegalSection id="device-permissions" title="4. Device permissions">
        <p>
          Native clients request operating-system permissions only for a feature you use, such as
          notifications, selecting or taking an image, saving media, or reading an image that you
          explicitly provide from the clipboard. You can change these permissions in device settings,
          although the related feature may stop working.
        </p>
      </LegalSection>

      <LegalSection id="no-advertising" title="5. No advertising or cross-site tracking">
        <p>
          xMatrix does not currently use advertising cookies, cross-site behavioral tracking,
          marketing-attribution cookies, session-replay tools, or non-essential client analytics SDKs.
          We therefore do not display a consent banner that would imply those tools are active.
        </p>
        <p>
          Before activating a non-essential client-side technology, we will update this notice and our
          data and vendor disclosures and, where required, provide equally accessible accept, refuse,
          and withdrawal controls before that technology runs.
        </p>
      </LegalSection>

      <LegalSection id="choices" title="6. Your choices">
        <p>
          Browser or device settings can block or delete storage. Blocking required storage may prevent
          sign-in, offline search, media, synchronization, or other requested features. To ask what
          storage applies to your client, contact{" "}
          <LegalContactLink subject="xMatrix cookie and local storage question" />. The same address,
          {" "}{LEGAL_CONTACT_EMAIL}, handles privacy questions.
        </p>
      </LegalSection>
    </>
  );
}
