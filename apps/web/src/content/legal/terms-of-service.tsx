import Link from "next/link";

import {
  LEGAL_ENTITY,
  LegalContactLink,
  LegalList,
  LegalSection,
} from "@/components/legal/legal-document";

export function TermsOfServiceContent() {
  return (
    <>
      <LegalSection id="agreement" title="1. Agreement and defined parties">
        <p>
          These Terms of Service (the “Terms”) are a binding agreement between you and {LEGAL_ENTITY}
          (“MadeByRobot,” “we,” “us,” or “our”) governing xMatrix, including our websites, hosted
          collaboration service, desktop and mobile applications, command-line tools, local daemon, and
          related support (the “Services”).
        </p>
        <p>
          A person or organization that creates or controls an xMatrix Space is the “Customer.” The
          individual owner is the Customer for a personal Space; the organization is the Customer for
          an organization Space. A person or Agent the Customer authorizes to use the Services is an
          “Authorized User.” “Customer Data” means messages, files, tasks, Agent content, and other data
          submitted to or through a Customer&apos;s Space.
        </p>
        <p>
          By accepting these Terms through the registration or sign-in flow, creating an account,
          accepting an invitation, or using the Services, you agree to these Terms and acknowledge our
          Privacy Policy. If you act for an organization, you represent that you can bind it. If you do
          not agree, do not use the Services.
        </p>
      </LegalSection>

      <LegalSection id="eligibility" title="2. Eligibility and accounts">
        <p>
          You must be at least 18 and legally able to enter into these Terms. You must provide accurate
          information, protect authentication methods and devices, and promptly notify us of suspected
          unauthorized use. A Customer is responsible for its Authorized Users and their compliance with
          these Terms, except to the extent an event results from MadeByRobot&apos;s breach.
        </p>
      </LegalSection>

      <LegalSection id="customer-spaces" title="3. Customer control of Spaces">
        <p>
          The Customer controls its Space, Customer Data, Authorized Users, Channels, Agents,
          integrations, roles, and retention instructions. An organization Owner or Admin may access,
          export, edit, recall, retain, or delete Customer Data according to current product functionality
          and may provision or remove an Authorized User&apos;s access. An Authorized User must follow the
          Customer&apos;s policies and understand that losing access may also end access to content created
          with that account.
        </p>
        <p>
          The Customer is responsible for having the rights and notices needed to submit Customer Data,
          invite people, authorize Agents, connect providers, give instructions, and allow MadeByRobot
          to process Customer Data under these Terms. MadeByRobot does not decide an organization&apos;s
          internal employment, monitoring, records, or access policies.
        </p>
      </LegalSection>

      <LegalSection id="service-license" title="4. The Services and license to Customer">
        <p>
          Subject to these Terms and payment of applicable fees, we grant the Customer a limited,
          non-exclusive, non-transferable, revocable right to access and use the Services for its
          internal personal or business purposes during the applicable term. We and our licensors retain
          all rights in the Services, software, designs, documentation, trademarks, and materials that
          we do not expressly grant.
        </p>
        <p>
          Components distributed under an open-source license are governed by that license where it
          conflicts with these Terms. These Terms do not grant rights to use MadeByRobot or xMatrix
          names, logos, or marks except to identify the Services.
        </p>
      </LegalSection>

      <LegalSection id="customer-data" title="5. Customer Data and service license">
        <p>
          As between MadeByRobot and Customer, Customer owns and controls Customer Data. MadeByRobot
          does not acquire ownership of Customer Data. Customer grants MadeByRobot and its disclosed
          subprocessors a worldwide, non-exclusive, limited-term license to host, copy, transmit,
          display, format, and otherwise process Customer Data only as reasonably necessary to provide,
          maintain, protect, secure, and support the Services; comply with law; follow Customer&apos;s
          instructions and Space controls; or perform another use Customer expressly authorizes.
        </p>
        <p>
          That license does not authorize a general “improve the Services” use of Customer Data and does
          not authorize model training. MadeByRobot does not use Customer Data to train a MadeByRobot
          model. Product improvement uses non-body operational metrics, aggregate or de-identified
          information, and voluntary Feedback. The Customer Data license ends after deletion from active
          systems, subject to the limited legal, security, dispute, and backup retention described in
          the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection id="agent-environments" title="6. Agent environments and responsibility">
        <p>The Services may coordinate three types of Agent environment:</p>
        <LegalList>
          <li>
            a <strong className="text-foreground">Customer-operated Agent</strong> running on a
            computer, account, repository, or environment Customer controls;
          </li>
          <li>
            a <strong className="text-foreground">Service Agent</strong> or hosted sandbox that
            MadeByRobot operates and expressly makes available; and
          </li>
          <li>
            a <strong className="text-foreground">third-party Agent or environment</strong> Customer
            selects and that is governed by the third party&apos;s terms.
          </li>
        </LegalList>
        <p>
          Customer chooses and is responsible for its Customer-operated and third-party Agents,
          providers, repositories, working directories, instructions, tool permissions, credentials,
          and third-party fees. MadeByRobot remains responsible for the Services and for the security,
          permissions, configuration, disclosed providers, and operation of a Service Agent or hosted
          sandbox we control. Nothing in these Terms shifts responsibility for our own breach, gross
          negligence, willful misconduct, or product defect to Customer.
        </p>
      </LegalSection>

      <LegalSection id="management-agent" title="7. Management Agent authority">
        <p>
          A Space may operate without a Management Agent. When an Owner or Admin designates one, the
          designation gives that Agent full Space role access to all current and future Channels,
          including closed, private, or restricted Channels, and their messages, threads, attachments,
          tasks, Follow-ups, plans, and organization memory. It does not need a separate per-Channel
          join. The Owner or Admin can cancel or replace the designation, and any retained ordinary
          Agent permission remains a separate grant.
        </p>
        <p>
          The designation alone does not authorize access to another Space, raw local workspace or
          terminal data, Saved Secret plaintext, or Instance Trace. Trace requires its own owner grant.
          A Management Agent may autonomously perform ordinary, visible, and auditable management work,
          including reading and summarizing the Space, maintaining tasks and plans, updating Channel
          topics or summaries, and dispatching authorized Profiles or routine controls.
        </p>
      </LegalSection>

      <LegalSection id="high-risk-actions" title="8. High-risk actions and local sandbox limits">
        <p>
          The following require a separate one-shot human approval or an Owner/Admin policy that
          expressly authorizes the bounded action: reading or injecting secret values; privileged host
          commands; destructive changes to local, repository, production, or Customer data; external
          publication or third-party mutations; production deployment or security-permission changes;
          purchases or paid commitments; and other actions with comparable legal, financial, privacy,
          or security effects.
        </p>
        <p>
          Supported local sandbox modes can restrict filesystem and long-lived credential access, but
          sandbox support varies by platform, runtime, and configuration. Current local sandboxing does
          not enforce network egress, and an explicitly disabled or unsupported mode may run without
          that sandbox after a warning. A worktree, prompt, or Agent label is not itself a security
          boundary. Customers should use least privilege, backups, testing, separate environments, and
          human review proportionate to risk.
        </p>
      </LegalSection>

      <LegalSection id="ai-output" title="9. AI output and human review">
        <p>
          To the extent permitted by law and any rights MadeByRobot holds, MadeByRobot does not claim
          ownership of output generated for Customer through the Services, and assigns those rights to
          Customer. Third-party model and content terms still apply. Output may not be unique or eligible
          for intellectual-property protection, and another user or provider may produce similar output.
        </p>
        <p>
          AI output may be inaccurate, incomplete, unsafe, biased, or unsuitable. Customer must apply
          risk-proportionate human review, testing, backups, and access controls before relying on output
          or permitting an action with legal, financial, medical, employment, housing, credit, safety,
          security, publication, production, or destructive effects. The Services do not provide legal,
          medical, financial, or other professional advice and must not be the final decision-maker for
          a high-impact professional or regulated decision without qualified human judgment.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="10. Acceptable use and regulated data">
        <p>You may not direct, authorize, or allow an Authorized User or Agent to:</p>
        <LegalList>
          <li>violate law or another person&apos;s rights, privacy, safety, or intellectual property;</li>
          <li>
            access, test, scan, control, or obtain data from an account, repository, device, or system
            without permission from the person authorized to grant it;
          </li>
          <li>
            steal or expose credentials, personal data, source code, or confidential information, or
            evade a sandbox, approval, permission, usage limit, or security control;
          </li>
          <li>
            create or distribute malware, conduct phishing, account takeover, denial of service, supply
            chain compromise, or another destructive or deceptive activity;
          </li>
          <li>
            harass, threaten, defraud, impersonate, discriminate against, spam, or mislead another
            person, including by falsely claiming that AI output received human review;
          </li>
          <li>interfere with, reverse engineer where prohibited, or unreasonably burden the Services; or</li>
          <li>
            process data requiring a special compliance commitment that MadeByRobot has not made in
            writing, including HIPAA protected health information, full payment card data, government
            classified information, export-controlled technical data, or biometric identification
            templates.
          </li>
        </LegalList>
        <p>
          These restrictions do not prohibit ordinary development, automation, or good-faith security
          testing on a system Customer owns or has express authority to test. Credentials must use the
          Saved Secrets or another supported authorization mechanism with least privilege and rotation.
        </p>
      </LegalSection>

      <LegalSection id="third-parties" title="11. Third-party services and model providers">
        <p>
          A Customer-selected model, repository, connector, Agent, runtime, or other third-party service
          is governed by the Customer&apos;s account and the third party&apos;s terms, privacy, retention,
          training, pricing, and availability. Customer authorizes the data exchange needed for the
          connection it enables and is responsible for its selection and configuration. MadeByRobot is
          not responsible for that provider&apos;s independent conduct.
        </p>
        <p>
          When MadeByRobot selects a provider to perform management extraction or a Service Agent
          feature, the provider acts as our service provider or subprocessor. We are responsible for
          selection, configuration, data minimization, and disclosure and use an enterprise or API
          no-training configuration where available. Current providers are identified on our{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/subprocessors">
            Subprocessors page
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="billing" title="12. Fees, subscriptions, renewal, cancellation, taxes, and refunds">
        <p>
          <strong className="text-foreground">What we charge for.</strong> xMatrix Pro is a Space
          subscription billed per human seat. Owner, Admin, and Member roles consume seats; Viewer and
          Agent identities never consume a seat. The Space Owner is the billing manager and is the only
          person who can start, change, or cancel a Space subscription. The checkout
          page, billing portal, order form, or signed agreement identifies the applicable fees, currency,
          billing period, seat quantity, and payment terms, and controls if it conflicts
          with this Section. Stripe processes hosted checkout, invoices, and full payment credentials;
          MadeByRobot never stores your full card number. You authorize the disclosed charges, including
          each renewal charge described below. Enterprise purchases are governed by their order and
          agreement.
        </p>
        <p>
          <strong className="text-foreground">Free Spaces.</strong> A Free Space includes up to three
          human seats and a lifetime allowance of 500 accepted durable messages. The allowance does not
          reset monthly or on any date, and deleting or recalling a message does not restore it. When a
          Free Space reaches the allowance, existing messages remain readable and new messages are refused
          until the Space is upgraded.
        </p>
        <p>
          <strong className="text-foreground">Automatic renewal.</strong> A self-service subscription,
          whether monthly or annual, automatically renews at the end of each paid period for another period
          of the same length at the then-current price until Customer cancels. A monthly subscription
          renews every month. An annual subscription is charged in advance for twelve months and renews
          for another twelve months; before an annual renewal we send a reminder to the billing email
          address at least 30 days before the renewal charge. Each renewal is charged to the payment method
          on file with Stripe, and Stripe emails a receipt or invoice for every charge.
        </p>
        <p>
          <strong className="text-foreground">Cancellation and changes.</strong> Customer may cancel a
          self-service subscription at any time from the <Link className="font-medium text-foreground underline underline-offset-4" href="/billing">billing page</Link> through the Stripe billing portal.
          Cancellation takes effect at the end of the current paid period: the Space keeps its paid
          features until then, no further renewal is charged, and the unused remainder of a monthly
          or annual period is not refunded except as stated under refunds below. Seat and plan changes are made
          through the billing portal where that option is available, or by contacting us; each change is
          prorated and applied exactly as shown to Customer before it is confirmed. A Pro Space cannot hold more billable human members than purchased seats; if seats fall
          below the current members, the Space is flagged and new messages and invitations are refused
          until the Owner removes members or adds seats. A Space cannot be deleted while a checkout is
          pending or while its subscription has not ended; cancel first and wait for the cancellation to
          complete.
        </p>
        <p>
          <strong className="text-foreground">Taxes.</strong> Prices exclude taxes. Where required, sales
          tax, VAT, GST, or a similar tax is calculated at checkout and on each renewal from Customer&apos;s
          billing address and is shown before payment. Customer is responsible for all applicable taxes
          other than taxes on MadeByRobot&apos;s net income, and for keeping the billing address and any tax
          identification number in the billing portal accurate.
        </p>
        <p>
          <strong className="text-foreground">Payment failure.</strong> If a renewal charge fails, Stripe
          notifies the billing email address and retries the charge. A Pro Space then enters a seven-day
          read-only grace period measured from the first failed payment; the grace period is not extended by
          later payment attempts. During grace, existing content stays readable and the billing portal stays
          available, but new messages, invitations, and new billable memberships are refused. If the
          payment is not resolved by the end of grace, the Space returns to Free limits until payment
          succeeds. Customer remains
          responsible for fees that accrued while the subscription was active. We may otherwise limit paid
          functionality only after reasonable notice and an opportunity to cure.
        </p>
        <p>
          <strong className="text-foreground">Refunds and disputes.</strong> Fees are
          non-refundable and non-creditable except where law, a published refund policy, an order form, or
          a written agreement requires otherwise, where we discontinue a paid Service under Section 15, or
          where a charge was duplicated or made in error; report an erroneous charge to us within 30 days
          of the charge. An approved refund is returned to the original payment method, and a refunded
          period ends the paid features for that period. Please contact us before disputing a charge with
          your bank or card issuer; after reviewing a chargeback we may suspend the affected subscription
          and, where law allows, recover related costs.
        </p>
        <p>
          <strong className="text-foreground">Promotions and price changes.</strong> Promotional or
          introductory pricing applies only to the invoices, billing interval, and eligibility stated in
          the offer, does not combine with another offer, and reverts to the regular price when the offer
          ends. A price change applies only to a future period after at least 30 days&apos; advance notice
          to the billing email address; if Customer does not accept it, Customer may cancel before the next
          period. Non-waivable consumer cancellation, renewal, withdrawal, and refund rights continue to
          apply.
        </p>
      </LegalSection>

      <LegalSection id="confidentiality" title="13. Confidentiality for business use">
        <p>
          Each party may receive non-public information that reasonably should be treated as confidential.
          The receiving party will use it only to perform or exercise rights under the agreement, protect
          it with reasonable care, and disclose it only to personnel and providers who need it and are
          bound to protect it. This does not cover information the receiving party lawfully knew without
          restriction, receives lawfully from another source, independently develops, or that becomes
          public without breach.
        </p>
        <p>
          A party compelled to disclose Confidential Information will provide advance notice where
          legally permitted and reasonable assistance at the disclosing party&apos;s expense. The receiving
          party may disclose only what is legally required. Customer Data is Customer Confidential
          Information.
        </p>
      </LegalSection>

      <LegalSection id="feedback" title="14. Feedback">
        <p>
          If you voluntarily give MadeByRobot suggestions or feedback about the Services (“Feedback”),
          you grant us a perpetual, irrevocable, worldwide, royalty-free right to use that Feedback
          without restriction or compensation. This does not transfer ownership of Customer Data or
          authorize use of Customer Data for model training.
        </p>
      </LegalSection>

      <LegalSection id="service-changes" title="15. Beta features and changes to the Services">
        <p>
          We may add, change, suspend, or discontinue features. Beta, preview, or experimental features
          may be incomplete, change without notice, and receive less support. We do not promise that
          every integration, provider, Agent runtime, or feature will always be available. Where
          reasonably practicable, we will notify affected Customers of a material discontinuation.
        </p>
        <p>
          If we discontinue a paid Service, we will give reasonable advance notice and, where applicable,
          refund prepaid fees for the unused period after discontinuation. This does not apply when
          immediate action is required by law, security, a provider failure, or an event beyond reasonable
          control.
        </p>
      </LegalSection>

      <LegalSection id="suspension" title="16. Suspension, termination, and data retrieval">
        <p>
          Customer may stop using a free Service or cancel a paid subscription under Section 12. Either
          party may terminate for the other party&apos;s material breach if that breach is not cured within
          30 days after written notice. Insolvency or similar statutory termination rights apply as
          provided by law.
        </p>
        <p>
          MadeByRobot may narrowly limit an account, Space, Agent, connection, or feature when we
          reasonably believe it presents illegality, an urgent security threat, material harm to the
          Services or another party, sanctions risk, or a continuing payment failure. We will give notice
          and a reasonable opportunity to cure when practicable. An urgent case may be limited first and
          explained afterward where law permits.
        </p>
        <p>
          Before termination or during a reasonable transition period, Customer may use the export
          functionality then actually available to retrieve Customer Data. We do not promise an export
          format or enterprise export feature the product does not provide. An urgent security action,
          legal prohibition, or completed valid deletion instruction may make data unavailable. After
          termination, data follows the Privacy Policy and Customer instructions. Terms that by their
          nature should survive do survive, including payment, ownership, confidentiality, disclaimers,
          liability, indemnity, disputes, and general provisions.
        </p>
      </LegalSection>

      <LegalSection id="copyright" title="17. Copyright and intellectual-property reports">
        <p>
          Please send a good-faith report of material you believe infringes intellectual property to{" "}
          <LegalContactLink subject="xMatrix copyright report" /> with the work, material and location,
          your contact information, your authority, and the basis for the report. We may remove or
          restrict material and may terminate repeat infringers in appropriate circumstances. We may
          forward a report and contact information to the Customer or user that supplied the material.
        </p>
        <p>
          This general reporting route does not represent that a DMCA designated-agent registration has
          been completed. Before MadeByRobot relies on 17 U.S.C. §512 safe harbor for the commercial
          Service, it will publish the registered agent&apos;s contact information and notice,
          counter-notice, and repeat-infringer process.
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="18. Disclaimers">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICES, BETA FEATURES, AND AI OUTPUT ARE PROVIDED
          “AS IS” AND “AS AVAILABLE.” MADEBYROBOT DISCLAIMS EXPRESS, IMPLIED, AND STATUTORY WARRANTIES,
          INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AND ANY
          WARRANTY THAT THE SERVICES OR OUTPUT WILL BE ACCURATE, SECURE, AVAILABLE, OR FREE OF LOSS,
          ERROR, HARMFUL CONTENT, OR INTERRUPTION.
        </p>
        <p>
          Customer is responsible for appropriate backups of repositories, files, credentials, and
          device data. This Section does not exclude a warranty or right that cannot lawfully be excluded
          and does not excuse MadeByRobot from obligations expressly stated in these Terms or a signed
          agreement.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="19. Limitation of liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR INDIRECT, INCIDENTAL,
          SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, GOODWILL,
          DATA, OR BUSINESS INTERRUPTION, EVEN IF ADVISED THAT THE DAMAGES ARE POSSIBLE.
        </p>
        <p>
          FOR A PAID SERVICE, MADEBYROBOT&apos;S TOTAL LIABILITY ARISING OUT OF OR RELATING TO THAT SERVICE
          OR THESE TERMS WILL NOT EXCEED THE SERVICE FEES CUSTOMER ACTUALLY PAID MADEBYROBOT DURING THE
          12 MONTHS BEFORE THE EVENT GIVING RISE TO LIABILITY. FOR A FREE OR NO-FEE SERVICE, THE TOTAL
          CAP IS USD $100. THE USD $100 CAP IS NOT ADDED TO OR USED AS A MINIMUM FOR A PAID SERVICE.
        </p>
        <p>
          The exclusions and cap do not apply to a party&apos;s fraud, willful misconduct, or gross
          negligence; death or personal injury caused by negligence where liability cannot be limited;
          Customer&apos;s overdue Service fees; indemnification obligations in Section 20; or another
          liability that law does not permit the parties to limit. Privacy, security, confidentiality,
          and intellectual-property claims do not receive an automatic separate or unlimited cap under
          these public Terms; a signed enterprise agreement or DPA may provide a different allocation.
        </p>
      </LegalSection>

      <LegalSection id="indemnity" title="20. Mutual third-party indemnities for Business Customers">
        <p>
          This Section applies only when Customer uses the Services for business or professional purposes,
          not as a consumer. MadeByRobot will defend Customer against a third-party claim that Customer&apos;s
          permitted use of the MadeByRobot Service itself infringes that party&apos;s intellectual-property
          right and will pay resulting finally awarded damages or an approved settlement. This does not
          cover Customer Data, a Customer or third-party Agent or service, unauthorized modification or
          combination, continued use after notice and a reasonable replacement, or use that violates the
          agreement.
        </p>
        <p>
          Business Customer will defend MadeByRobot and its personnel against a third-party claim arising
          from Customer Data, Customer-operated Agents, Customer-selected third-party services,
          Customer&apos;s material breach, or Customer&apos;s violation of another person&apos;s rights, and will pay
          resulting finally awarded damages or an approved settlement. This does not cover the portion
          caused by MadeByRobot&apos;s breach, gross negligence, or willful misconduct.
        </p>
        <p>
          The indemnified party must promptly notify the indemnifying party and provide reasonable
          cooperation at the indemnifying party&apos;s expense. The indemnifying party controls defense and
          settlement, but may not admit fault, impose a non-monetary obligation, or fail to provide a
          complete release for the indemnified party without written consent not unreasonably withheld.
          The base cap in Section 19 does not apply to these indemnification obligations, and the indirect
          damages exclusion does not prevent recovery of amounts payable to the third party under them.
        </p>
      </LegalSection>

      <LegalSection id="export" title="21. Export controls and sanctions">
        <p>
          You may not access, use, export, re-export, transfer, or make the Services or related technology
          available in violation of United States or other applicable export-control, economic-sanctions,
          anti-boycott, or import laws. You represent that you are not a restricted party and are not
          owned or controlled by one, and that you will not use the Services for a prohibited destination,
          end user, or end use.
        </p>
        <p>
          MadeByRobot may request reasonable compliance information, screen transactions, refuse a
          transaction, or restrict access as needed to comply with law. Because sanctions and export
          rules change and may target people, entities, activities, destinations, and end uses, these
          Terms do not contain a fixed country list.
        </p>
      </LegalSection>

      <LegalSection id="disputes" title="22. Governing law and disputes">
        <p>
          These Terms are governed by Delaware law, without regard to conflict-of-law rules. For a
          Business Customer and where law permits, the state and federal courts located in Delaware have
          exclusive jurisdiction, and each party consents to those courts. These Terms do not require
          arbitration and do not contain a class-action waiver.
        </p>
        <p>
          Before filing a claim, each party will give written notice and try in good faith for 30 days to
          resolve it. This does not prevent urgent injunctive or protective relief. A consumer may rely on
          non-waivable local consumer law and bring a claim in a court that mandatory local law makes
          available notwithstanding the Delaware provisions.
        </p>
      </LegalSection>

      <LegalSection id="updates" title="23. Updates, notice, and acceptance records">
        <p>
          We may update these Terms as the Services, law, or our business changes. We will publish a new
          version and effective date and preserve accessible version history. If a change materially
          affects rights or obligations, we will provide reasonable advance email or in-product notice.
          Where a new agreement is required, we will request affirmative re-acceptance rather than rely
          only on continued use. A Customer that does not accept may stop using the Services and use the
          available cancellation and data-retrieval process before the change takes effect.
        </p>
        <p>
          The formal acceptance flow records the user, Terms and Privacy versions, effective date,
          acceptance time, and acceptance surface. Existing users will be asked to accept the effective
          Terms at their next sign-in. The pre-launch “By continuing” notice is not represented as the
          final acceptance evidence until that versioned flow is implemented.
        </p>
      </LegalSection>

      <LegalSection id="general" title="24. General terms and language">
        <p>
          These Terms, the Privacy Policy, and documents incorporated by reference are the entire
          agreement about the Services unless the Customer has a separate written agreement with us. A
          signed agreement controls to the extent of conflict. You may not assign these Terms without
          our written consent; we may assign them to an affiliate or in a financing, merger,
          reorganization, or sale. Failure to enforce a provision is not a waiver. If a provision is
          unenforceable, it will be modified only as needed and the remainder stays effective. Neither
          party is liable for delay caused by events beyond reasonable control.
        </p>
        <p>
          English is the controlling version. A translation is for convenience unless applicable law
          requires the local-language version or another rule to control. Notices to MadeByRobot must be
          sent to the contact in Section 25; we may send notices to the account email or through the
          Services.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="25. Contact us">
        <p>
          Questions or legal notices about these Terms may be sent to {LEGAL_ENTITY} at{" "}
          <LegalContactLink subject="xMatrix Terms of Service" />.
        </p>
      </LegalSection>
    </>
  );
}
