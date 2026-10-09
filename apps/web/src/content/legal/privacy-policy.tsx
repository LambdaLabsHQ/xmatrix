import Link from "next/link";

import {
  LEGAL_ENTITY,
  LegalContactLink,
  LegalList,
  LegalSection,
} from "@/components/legal/legal-document";

export function PrivacyPolicyContent() {
  return (
    <>
      <LegalSection id="scope" title="1. Scope, roles, and who we are">
        <p>
          This Privacy Policy explains how {LEGAL_ENTITY} (“MadeByRobot,” “we,” “us,” or “our”)
          collects, uses, discloses, and protects personal information when you use xMatrix. xMatrix
          includes our websites, hosted collaboration service, desktop and mobile applications,
          command-line tools, local daemon, and support interactions (the “Services”).
        </p>
        <p>
          A person or organization that creates or controls a Space is the “Customer.” For Customer
          Data in an organization Space, the Customer generally determines why and how that data is
          processed, and MadeByRobot processes it on the Customer&apos;s behalf. For a personal Space,
          the individual owner is the Customer. MadeByRobot separately determines processing for
          account administration, service security, billing, direct support, legal compliance, and
          our own operational records.
        </p>
        <p>
          This Policy does not govern a model provider, repository, integration, website, Agent, or
          execution environment that a Customer selects or operates independently. Those services
          process information under their own terms, settings, and privacy notices.
        </p>
      </LegalSection>

      <LegalSection id="information-we-collect" title="2. Information we collect">
        <p>The information we process depends on the clients and features you use and includes:</p>
        <LegalList>
          <li>
            <strong className="text-foreground">Account and authentication information:</strong>{" "}
            email address, account and user identifiers, name, profile image, invite records, sign-in
            provider, session information, and authentication and security records. If you choose
            Google authentication, we receive the profile information Google makes available for
            sign-in.
          </li>
          <li>
            <strong className="text-foreground">Customer Data and collaboration content:</strong>{" "}
            Spaces, Channels, memberships, permissions, messages, threads, attachments, reactions,
            tasks, Follow-ups, plans, automations, feedback, organization memory, and other content a
            person or Agent submits to the Services.
          </li>
          <li>
            <strong className="text-foreground">Agent, Run, and machine information:</strong> Agent
            Profiles and Instances, Roles, runtime and model configuration, permissions, sandbox
            selection, machine, host, daemon, repository, and working-directory references, presence,
            execution and approval status, and bounded command or tool metadata sent to the Services.
          </li>
          <li>
            <strong className="text-foreground">Instance Trace:</strong> structured events described
            in Section 5, which may include content from inputs, outputs, tools, and errors depending on
            the Agent runtime and the access granted by its owner.
          </li>
          <li>
            <strong className="text-foreground">Saved Secrets:</strong> aliases, descriptions, risk
            labels, suggested environment names, encrypted values, versions, expiry, approvals,
            one-shot grants, and audit records. Secret values are not ordinary message or Profile
            fields and are not shown in Agent catalog responses.
          </li>
          <li>
            <strong className="text-foreground">Billing information:</strong> billing contact,
            Customer and transaction identifiers, subscription status, invoices, tax information,
            payment status, and limited payment-method details Stripe makes available to a merchant.
            Full card numbers and card security codes are entered into Stripe&apos;s hosted flow and are
            not received by xMatrix.
          </li>
          <li>
            <strong className="text-foreground">Service and diagnostic information:</strong> IP
            address, browser and device type, operating system, application version, request time,
            route or event category, response status, duration, counts, capacity, crash and error
            information, and pseudonymized identifiers used to operate, secure, and troubleshoot the
            Services. Operational diagnostics are designed not to contain message or command bodies.
          </li>
          <li>
            <strong className="text-foreground">Support and communications:</strong> information you
            include when contacting us, exercising a right, reporting a problem, submitting a copyright
            report, or responding to a service notice.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection id="sources" title="3. Sources of information">
        <p>We receive information:</p>
        <LegalList>
          <li>directly from you and other people or Agents acting in your Spaces;</li>
          <li>automatically from the clients, daemon, Hub, and infrastructure that provide the Services;</li>
          <li>
            from a Customer or Space administrator that provisions your account, permissions, Agent,
            or integration;
          </li>
          <li>
            from Google, Stripe, and other providers when you intentionally authenticate, purchase, or
            connect a service; and
          </li>
          <li>from support, security, and legal communications.</li>
        </LegalList>
      </LegalSection>

      <LegalSection id="agents" title="4. Agent environments, permissions, and your computer">
        <p>
          xMatrix can coordinate a Customer-operated Agent on a computer the Customer controls, a
          third-party Agent or environment the Customer selects, or a MadeByRobot-operated “Service
          Agent” if we later offer and enable one. MadeByRobot is responsible for the security,
          permissions, provider selection, and disclosed processing of the Services and any Service
          Agent or hosted sandbox we operate. The Customer controls its own Agents and independently
          selected providers.
        </p>
        <p>
          Local source files, raw terminal output, provider history, and working context remain on the
          connected computer unless a person, Agent, tool, connector, or requested feature sends them
          to a Channel, attachment, task, trace event, support request, model provider, or another
          disclosed endpoint. A sandbox can restrict filesystem and long-lived credential access, but
          current local sandbox support varies by platform and mode and does not enforce network egress.
          A run configured without a supported sandbox does not receive that sandbox protection.
        </p>
        <p>
          Secret injection, privileged host commands, destructive changes, external publication,
          production deployment, security-permission changes, purchases, and other high-risk actions
          require a separate one-shot approval or an Owner/Admin policy that expressly authorizes the
          bounded action.
        </p>
      </LegalSection>

      <LegalSection id="instance-trace" title="5. Instance Trace">
        <p>
          A connected runtime automatically publishes a structured Instance Trace to its host process.
          Depending on the runtime and event, trace data may include user input, attachment summaries,
          model output, usage, status, goals, tool names, commands, arguments, file paths, patches, tool
          output, and errors. Content can therefore enter a trace through tool events even though a trace
          is not a complete repository, terminal, or provider-history mirror. Runtime redaction differs,
          and we do not promise that every trace field is redacted.
        </p>
        <p>
          The authenticated Agent host is the exact trace-payload authority. Its in-memory store keeps
          at most 500 events, 768 KiB, or 24 hours for an available Instance, whichever boundary is
          reached first. Eviction can make history incomplete. An ordinary disconnect does not itself
          clear host memory; Instance termination clears it, and a still-live Instance may begin a new
          suffix after expiry.
        </p>
        <p>
          The Hub forwards live events and routes authenticated on-demand reads to the exact host. It
          does not currently keep a Relay authority, R2, or other persistent copy or archive of trace payloads;
          Authority stores only grant metadata. The browser may keep up to 500 events per Instance in React
          memory, does not persist trace events to localStorage or IndexedDB, requests them with no-store
          semantics, and clears them during authentication lifecycle changes. If the exact host is
          unavailable, xMatrix does not serve a stale fallback.
        </p>
        <p>
          An Agent&apos;s owner controls trace access and may view its available trace. Another user
          requires an active owner-approved trace grant plus the required shared Space and per-event
          Channel access. A Space Owner or Admin does not automatically gain trace access.
          Revocation, expiry, loss of Channel access, or host expiry ends access immediately.
        </p>
        <p>
          xMatrix does not publish a provider&apos;s complete private chain of thought. ACP thought chunks
          are not published; other adapters expose only the visible text, tool events, lifecycle events,
          or reasoning summary metadata their reviewed adapter supports.
        </p>
      </LegalSection>

      <LegalSection id="uses" title="6. How we use information">
        <p>We use information to:</p>
        <LegalList>
          <li>provide, authenticate, synchronize, bill for, and maintain the Services;</li>
          <li>deliver Customer Data to authorized people, Agents, and integrations;</li>
          <li>perform a feature or instruction a Customer requests;</li>
          <li>protect accounts, enforce permissions, prevent abuse, and respond to security incidents;</li>
          <li>provide support and communicate about authentication, billing, security, and service changes;</li>
          <li>
            measure reliability, capacity, and product performance using operational metrics and, where
            appropriate, aggregate or de-identified information; and
          </li>
          <li>comply with law, resolve disputes, and enforce our agreements.</li>
        </LegalList>
        <p>
          MadeByRobot does not use Customer Data, collaboration content, or Instance Trace to train a
          MadeByRobot model. Product improvement uses non-body operational metrics, aggregate or
          de-identified information, and voluntary feedback. Support personnel use Customer Data only
          when a user provides or authorizes it for support and we limit that access to what is needed.
        </p>
        <p>
          We do not sell personal information, share it for cross-context behavioral advertising, or use
          it for targeted advertising. If we ever propose a use that crosses one of these boundaries, we
          will conduct a separate product and legal review before collection and obtain any consent or
          opt-in that applicable law requires.
        </p>
      </LegalSection>

      <LegalSection id="legal-bases" title="7. Legal bases for processing">
        <p>
          Where law requires a legal basis, we process information as necessary to perform a contract,
          follow a Customer&apos;s instructions, pursue legitimate interests such as securing and operating
          the Services, comply with legal obligations, protect vital interests, or act with consent. Our
          legitimate interests do not override your rights where law provides otherwise. You may withdraw
          consent for processing that relies on consent without affecting earlier lawful processing.
        </p>
      </LegalSection>

      <LegalSection id="customer-control" title="8. Customer and Space control">
        <p>
          The Customer controls Customer Data in its Space. Depending on current product functionality
          and permissions, an organization Owner or Admin may invite or remove members, authorize Agents
          and integrations, access all Space Channels, export available data, set access rules, and edit,
          recall, retain, or delete content. If an organization provides your access, direct questions
          about its instructions and policies to that organization.
        </p>
        <p>
          If we receive a rights request for Customer Data controlled by an organization, we may direct
          it to that Customer and assist as required by our agreement and law. MadeByRobot remains
          responsible for the account, security, billing, diagnostics, support, and other processing for
          which we determine the purpose and means.
        </p>
      </LegalSection>

      <LegalSection id="disclosures" title="9. How we disclose information">
        <p>We disclose information only as needed for the purposes described in this Policy:</p>
        <LegalList>
          <li>
            to authorized Space members, Agents, and administrators under current Space, Channel, role,
            and grant rules;
          </li>
          <li>
            to our service providers, including Cloudflare for infrastructure and Anthropic for the
            MadeByRobot-selected management extraction that an authorized user invokes;
          </li>
          <li>
            to Google or Stripe when you choose their authentication or payment flow, and to a model,
            repository, connector, runtime, or third-party Agent that a Customer selects or invokes;
          </li>
          <li>
            to professional advisers, law enforcement, regulators, courts, or other parties when we
            reasonably believe disclosure is required by law or needed to protect rights and safety; and
          </li>
          <li>
            to a successor or prospective successor in a financing, merger, reorganization, or sale,
            subject to appropriate confidentiality and data-protection safeguards.
          </li>
        </LegalList>
        <p>
          Our current MadeByRobot-appointed providers, purposes, data categories, and primary processing
          regions are listed on the{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/subprocessors">
            Subprocessors page
          </Link>
          . A Customer-selected provider is governed by the Customer&apos;s account and configuration. Its
          own retention, training, privacy, and fees may apply. For a provider MadeByRobot selects, we
          are responsible for selection, configuration, minimization, and disclosure and use an
          enterprise or API no-training setting where one is available.
        </p>
      </LegalSection>

      <LegalSection id="google-user-data" title="10. Google user data">
        <p>
          If you sign in with Google, we receive your name, email address, and profile image to create
          and secure your account. If a Space administrator connects a Google service as an app, xMatrix
          requests only the access that app needs. Google Docs, Drive and Sheets access is limited to
          files created with or explicitly opened in xMatrix. Read-only Gmail access lets authorized
          people and Agents in that Space search and read the messages they ask for; it never sends,
          changes, or deletes mail. Search Console, AdSense, and Google Cloud access lets them read the
          sites, reports, projects, costs, logs, metrics, and alerts they ask about, and make the
          changes they request.
        </p>
        <p>
          We use Google user data only to provide those user-facing features: we retrieve it when a
          person or Agent in the Space invokes an action, and deliver the result to the Channel, Page,
          Automation, or Agent that asked. Results become Customer Data in that Space and are shown to
          its authorized members and Agents. A Customer-selected Agent may pass them to the model
          provider that Customer chose.
        </p>
        <p>
          xMatrix&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href="https://developers.google.com/terms/api-services-user-data-policy"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We do not sell Google user data, use or transfer it
          for advertising, use it to determine credit-worthiness or for lending, or use it to develop,
          improve, or train generalized AI or machine-learning models. Our staff do not read it except
          with your affirmative agreement for specific content, when necessary for security or to
          comply with law, or when the data is aggregated and anonymized for internal operations.
        </p>
        <p>
          Google access and refresh tokens are stored encrypted and are used only by the Hub for the
          connected Space. Disconnecting a Google app in xMatrix deletes its stored tokens; you can
          also revoke xMatrix at any time in your{" "}
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href="https://myaccount.google.com/permissions"
          >
            Google Account permissions
          </a>
          . Google data already delivered into a Space is retained and deleted as described in Sections
          12 and 17, and you may ask us to delete it at the contact below.
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="11. Cookies, local storage, and device permissions">
        <p>
          xMatrix currently uses only security, authentication, preference, and functionality storage.
          It does not use advertising cookies, cross-site behavioral tracking, marketing attribution,
          session replay, or non-essential client analytics SDKs. Web and native clients may keep an
          authorized local replica, index, media cache, synchronization state, and preferences. Native
          clients request device permissions only for a feature you choose.
        </p>
        <p>
          The{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/cookies">
            Cookie and Local Storage Notice
          </Link>{" "}
          explains these categories, local cleanup limits, and your choices. We will not activate a
          non-essential client technology in a region that requires consent before providing accept,
          refuse, and withdrawal controls.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="12. Retention and deletion">
        <p>
          We retain Customer Data according to the Customer&apos;s instructions, our agreement, actual
          product controls, and applicable law. We retain account, authentication, security, billing,
          support, and operational information for as long as needed for the purposes described here,
          including audits, legal compliance, fraud prevention, dispute resolution, and enforcement.
        </p>
        <p>
          Deleting an account or Space, terminating the Services, or receiving a valid instruction may
          cause related information to be deleted or de-identified. Limited information may remain when
          required by law, reasonably needed for security or a dispute, or present in a bounded backup
          recovery cycle. Aggregate or de-identified information that no longer identifies a person may
          be retained. We do not publish invented universal deletion periods or promise Customer-configured
          retention features that the product does not provide.
        </p>
        <p>
          Client replicas and media caches follow their documented bounded lifecycle and current access
          controls. Offline or lost devices may retain previously downloaded data until local cleanup.
          Instance Trace follows the exact host and browser boundaries in Section 5.
        </p>
      </LegalSection>

      <LegalSection id="security" title="13. Security">
        <p>
          We use risk-appropriate administrative, technical, and organizational measures, including
          authentication, Space/Channel/Run access controls, scoped short-lived Agent credentials,
          private object storage, no-store handling for sensitive responses, protected deployment
          workflows, and incident response. Production service traffic uses HTTPS/TLS. Cloudflare&apos;s
          Durable Objects, D1, and R2 provide provider-managed encryption at rest. Saved Secrets and
          daemon local replicas receive additional authenticated encryption with protected key material.
        </p>
        <p>
          These controls are not end-to-end encryption: MadeByRobot and its service providers process
          readable content when required to route, synchronize, search, support, secure, or perform an
          authorized feature. We do not currently promise a fixed data-residency region or represent that
          xMatrix is certified for SOC 2, ISO 27001, HIPAA, or PCI workloads. No system is completely
          secure, and we cannot guarantee that unauthorized access, loss, or misuse will never occur.
        </p>
        <p>
          If a data incident requires notice under applicable law or contract, we will notify affected
          Customers or individuals as required. You are responsible for protecting devices and accounts,
          configuring least privilege, rotating credentials, reviewing high-risk Agent actions, and
          maintaining appropriate backups.
        </p>
      </LegalSection>

      <LegalSection id="sensitive-data" title="14. Regulated and highly sensitive data">
        <p>
          Unless we separately agree in writing and expressly provide the relevant compliance capability,
          do not use the Services to process protected health information subject to HIPAA, full payment
          card numbers or security codes, government-classified information, export-controlled technical
          data, or biometric templates used for unique identification. Ordinary personal information may
          be processed under this Policy and an applicable DPA. Credentials must use the Saved Secrets or
          other expressly supported authorization mechanism with least privilege and rotation.
        </p>
      </LegalSection>

      <LegalSection id="international" title="15. International processing and transfers">
        <p>
          MadeByRobot is based in the United States. We and our providers may process information in the
          United States and other countries, including countries with data-protection rules different
          from those where you live. Before a transfer requires a regional transfer mechanism, we will
          put the applicable mechanism and supplementary safeguards in place. These may include Standard
          Contractual Clauses or a UK Addendum where applicable.
        </p>
        <p>
          Before offering the Services commercially in an affected region, we will complete the required
          DPA, transfer, representative, and rights-handling arrangements. This Policy does not claim a
          transfer certification or regional representative that has not actually been established.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="16. Your privacy rights and choices">
        <p>
          Depending on where you live, you may have rights to access, correct, delete, or obtain a copy
          of personal information; restrict or object to processing; withdraw consent; opt out of certain
          disclosures; or appeal a denied request. You may have the right to use an authorized agent and
          to complain to a data-protection authority. We will not discriminate against you for exercising
          a privacy right.
        </p>
        <p>
          To submit a request, email <LegalContactLink subject="xMatrix privacy request" />. We verify
          identity and authority proportionately and may request information needed to find the relevant
          account or processing. If a Customer controls the requested Customer Data, we may refer the
          request to that Customer. We will explain a denial and available appeal route where required.
        </p>
        <p>
          We do not sell personal information or use it for targeted or cross-context behavioral
          advertising, so xMatrix does not currently offer a sale, sharing, or targeted-advertising
          opt-out. If that practice changes, we will update this Policy and provide any required opt-out
          or Global Privacy Control response before the change takes effect.
        </p>
      </LegalSection>

      <LegalSection id="account-deletion" title="17. Account and Space deletion">
        <p>
          You can start account deletion in Settings → Account or at the{' '}
          <Link href="/account/delete">account deletion page</Link>. A recent sign-in, your account
          email, and explicit confirmation are required. Close owned Spaces, leave other Spaces,
          and stop active agent work before proceeding. You can delete your account before a subscription expires; cancel provider renewal separately to stop future charges. Account deletion does
          not cancel Apple or Stripe subscriptions or move them to another Space.
        </p>
        <p>
          Once committed, deletion revokes sign-in access and removes your profile, login credentials,
          avatars, and private account settings. Interrupted cleanup resumes automatically. It does
          not delete files on your computers. Shared work and audit or billing records remain under
          the relevant Space and retention policies. Minimal identity retirement records prevent old
          credentials from regaining access. Scheduled Space deletions continue and cannot be restored
          by the deleted account.
        </p>
        <p>
          For assistance, contact <LegalContactLink subject="xMatrix account deletion" />. Legal
          obligations, security records, processor deletion cycles, and data already held by a
          Customer-selected provider may affect retention and timing.
        </p>
      </LegalSection>

      <LegalSection id="children" title="18. Children">
        <p>
          The Services are not intended for anyone under 18, and we do not knowingly collect personal
          information from children. Contact us if you believe a child has provided personal information,
          and we will take appropriate steps to investigate and delete it.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="19. Changes to this Policy">
        <p>
          We may update this Policy as the Services, law, or our practices change. We will publish a new
          version and effective date and preserve accessible version history. We will provide additional
          email or in-product notice when a change materially affects privacy rights. A policy notice is
          not treated as consent where law requires a separate affirmative choice.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="20. Contact and language">
        <p>
          Questions, complaints, and privacy requests may be sent to {LEGAL_ENTITY} at{" "}
          <LegalContactLink subject="xMatrix privacy" />. We do not publish a postal address in this
          general Policy. A legally required regional representative or designated contact will be
          published before the related obligation applies.
        </p>
        <p>
          English is the controlling version of this Policy. A translation is provided for convenience
          unless applicable law requires the local-language version or another rule to control.
        </p>
      </LegalSection>
    </>
  );
}
