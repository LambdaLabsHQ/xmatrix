import Link from "next/link";

import { LegalContactLink, LegalList, LegalSection } from "@/components/legal/legal-document";

type Provider = {
  name: string;
  purpose: string;
  data: string;
  region: string;
  added?: string;
};

const subprocessors: Provider[] = [
  {
    name: "Cloudflare, Inc.",
    purpose:
      "Website and Hub hosting, content delivery, Workers, Durable Objects, D1, private R2 object storage, email sending, security, and operational diagnostics.",
    data:
      "Account and authentication records, Customer Data, attachments, service metadata, network and security events, and support email delivery data as required by the feature.",
    region:
      "Cloudflare global infrastructure, including the United States. xMatrix does not currently promise a customer-selected or fixed data-residency region.",
  },
  {
    name: "PlanetScale, Inc.",
    purpose: "Managed PostgreSQL database hosting for production account, collaboration, and service records.",
    data: "Account and authentication records, Customer Data stored in the database, billing metadata, and service records required by the enabled features.",
    region: "The configured production database region. xMatrix does not currently promise a customer-selected or fixed data-residency region.",
    added: "October 2026",
  },
  {
    name: "Anthropic, PBC",
    purpose:
      "MadeByRobot-selected model processing for management extraction and any Service Agent feature that is actually enabled and disclosed.",
    data:
      "The selected prompts, message context, attachment summaries, outputs, and related request metadata needed for the authorized feature.",
    region:
      "United States and other locations described by Anthropic for its enterprise or API services.",
  },
  {
    name: "Functional Software, Inc. (Sentry)",
    purpose: "Error and crash reporting for the xMatrix website, apps, and Hub.",
    data:
      "Error messages, stack traces, release and route identifiers, browser or device type, and the operational context of a failure. Reports exclude request bodies, query strings, cookies, and account identifiers.",
    region: "United States.",
    added: "October 2026",
  },
];

function ProviderCard({ provider }: { provider: Provider }) {
  return (
    <li className="rounded-lg border border-border p-4">
      <h3 className="font-bold text-foreground">{provider.name}</h3>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="font-medium text-foreground">Purpose</dt>
          <dd>{provider.purpose}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Data categories</dt>
          <dd>{provider.data}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Main processing region</dt>
          <dd>{provider.region}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Added</dt>
          <dd>{provider.added ?? "Initial public release"}</dd>
        </div>
      </dl>
    </li>
  );
}

export function SubprocessorsContent() {
  return (
    <>
      <LegalSection id="scope" title="1. Scope and change notices">
        <p>
          A subprocessor is a service provider MadeByRobot appoints to process Customer Data on behalf
          of a Customer. This list applies to the generally available xMatrix service. A signed order,
          DPA, or enterprise deployment may identify additional or different providers.
        </p>
        <p>
          We will add a provider before it begins material processing and provide reasonable advance
          notice of a significant new subprocessor where our agreement or law requires it. To subscribe
          to those notices, email{" "}
          <LegalContactLink subject="Subscribe to xMatrix subprocessor notices" />.
        </p>
      </LegalSection>

      <LegalSection id="current-subprocessors" title="2. Current subprocessors">
        <ul className="space-y-4">
          {subprocessors.map((provider) => (
            <ProviderCard key={provider.name} provider={provider} />
          ))}
        </ul>
      </LegalSection>

      <LegalSection id="other-third-parties" title="3. Other third parties">
        <p>The following services are disclosed separately because their role depends on your choice:</p>
        <LegalList>
          <li>
            <strong className="text-foreground">Google authentication:</strong> you choose Google as
            an identity provider, and Google independently processes the sign-in interaction.
          </li>
          <li>
            <strong className="text-foreground">Stripe:</strong> you intentionally enter Stripe&apos;s
            hosted payment flow. Stripe processes full payment credentials; MadeByRobot receives
            transaction, subscription, billing, and limited payment-method records needed to administer
            the purchase.
          </li>
          <li>
            <strong className="text-foreground">Customer-selected providers:</strong> model providers,
            source-control hosts, repositories, connectors, runtimes, and third-party Agents selected or
            operated by a Customer are not MadeByRobot subprocessors merely because xMatrix connects to
            them. Their terms, settings, training, retention, and fees apply.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="future-hosting" title="4. Future hosted Agent environments">
        <p>
          xMatrix may later offer a MadeByRobot-hosted sandbox or Service Agent environment. No vendor is
          listed for that future capability because no additional hosted-sandbox vendor is represented as
          active in this draft. Before such a vendor processes Customer Data, we will add it here and
          update the{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/privacy">
            Privacy Policy
          </Link>{" "}
          with the actual storage, retention, security, and transfer facts.
        </p>
      </LegalSection>
    </>
  );
}
