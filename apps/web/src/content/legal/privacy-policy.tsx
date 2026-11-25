import Link from "next/link";

import {
  LEGAL_ENTITY,
  LegalContactLink,
  LegalList,
  LegalSection,
} from "@/components/legal/legal-document";
import { appHref } from "@/lib/site-url";

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
            not received by xMatrix. Purchases in the iPhone and Android apps are processed by Apple or
            Google Play; xMatrix receives the purchase and subscription identifiers, product, status, and
            renewal dates they report, not your payment method.
          </li>
          <li>
            <strong className="text-foreground">Service and diagnostic information:</strong> IP
            address, browser and device type, operating system, application version, request time,
            route or event category, response status, duration, counts, capacity, server-side Hub
            error reports (sent to Sentry), and keyed-HMAC pseudonymized identifiers used to
            operate, secure, and troubleshoot the Services. Optional client-side diagnostics—startup
            timing, first-party onboarding step counts, CLI network reconnect samples, automatic
            desktop daemon startup failure reports, and scrubbed browser Sentry error reports—are{" "}
            <strong className="text-foreground">off by default</strong> in the stable apps and CLI. In
            beta builds they are on by default only where both the country your account signed up from
            and the country your current connection comes from (as reported by Cloudflare) are outside
            the European Union, the European Economic Area, the United Kingdom, and Switzerland, with
            a short notice that links to privacy settings; there they rest on our legitimate
            interest in fixing defects in pre-release software. Anywhere else, or where the country
            cannot be determined, beta builds send nothing until you tick the unticked opt-in box or
            turn the setting on. To apply this rule we record, once, whether your account was created
            from a country that requires prior consent (a single category, not the country or your IP
            address); it is deleted with your account. Your explicit choice, and when you made it, is
            stored with your account. Unless you have opted in, diagnostics are not sent when you turn
            them off, when your browser sends Do Not Track or Global Privacy Control, or when{" "}
            <code className="font-mono text-xs">DO_NOT_TRACK=1</code> is set for the CLI. You can opt in
            under Settings → Legal and privacy, with{" "}
            <code className="font-mono text-xs">xmatrix config telemetry on</code> or{" "}
            <code className="font-mono text-xs">XMATRIX_TELEMETRY=1</code>, or by sending a desktop
            failure report from the failure card;{" "}
            <code className="font-mono text-xs">XMATRIX_TELEMETRY=0</code> always turns them off. Each
            diagnostic event has a declared set of fields, and each field may hold only a fixed
            value, a number, true or false, a version, a short code, or an opaque identifier; an event with any
            other field or value is refused. Client errors are reported by their class, code, and
            code locations, never by their message. The one exception is the redacted startup
            output you choose to send from a desktop failure card. Server-side Hub error reports
            keep the server&apos;s own error message with quoted values, email addresses, URL
            queries, home-directory paths, and token-shaped strings removed. See our{" "}
            <Link className="font-medium text-foreground underline underline-offset-4" href="/docs/privacy">
              Telemetry and Local Privacy guide
            </Link>
            .
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
          You can connect an outside AI application, such as ChatGPT, Grok, or Cursor, through
          xMatrix&apos;s MCP server. Before access is granted, an xMatrix consent page shows the
          application and the permissions it requests. The application acts as you, with your
          current access to Spaces, Pages, and Channels. A read grant allows it to receive that
          content; a write grant also lets it create or edit Pages and post messages as you.
          Messages that mention an Agent can ask that Agent to act, just as messages you post in
          xMatrix can.
        </p>
        <p>
          Content the application reads is sent to that provider and processed under its own
          terms, privacy notice, and settings. We keep application registration, consent, and
          authorization records; stored refresh tokens and client secrets are hashed. You can
          remove an application under Profile → AI apps. Removal ends its consent and refresh
          access; a previously issued access token can remain valid for up to 15 minutes.
          Removal does not delete copies already received by the outside provider.
        </p>
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
          disclosed endpoint. To keep a connected computer stable across reinstalls under your
          account, the daemon derives an owner-scoped <code className="font-mono text-xs">machineId</code>{" "}
          locally by hashing your xMatrix user ID with an OS machine identifier; raw hardware
          identifiers and unscoped fingerprints are never sent to xMatrix. A sandbox can restrict
          filesystem and long-lived credential access, but current local sandbox support varies by
          platform and mode and does not enforce network egress. A run configured without a
          supported sandbox does not receive that sandbox protection.
        </p>
        <div id="local-quota-probes" className="scroll-mt-8 space-y-3 rounded-md border border-border p-4">
          <h3 className="font-bold text-foreground">
            The daemon reads other AI tools&apos; login files to check your remaining quota
          </h3>
          <p>
            <strong className="text-foreground">Which files.</strong> For an AI tool you registered
            as an Agent on a computer, the xMatrix daemon on that computer may read that tool&apos;s
            own sign-in: for example Grok&apos;s{" "}
            <code className="font-mono text-xs">~/.grok/auth.json</code>, or the API key the tool
            uses. The full list is in the{" "}
            <Link className="font-medium text-foreground underline underline-offset-4" href="/docs/privacy">
              Telemetry and local privacy guide
            </Link>
            . It never reads the login of a tool you did not register. Codex, Claude Code and
            OpenCode 2.2.0 or later are not read this way: the daemon asks the tool itself, and the
            tool answers with its own sign-in. Codex is asked through the Codex session already
            running or a briefly started <code className="font-mono text-xs">codex app-server</code>,
            Claude Code through the Claude Code session already running or a briefly started{" "}
            <code className="font-mono text-xs">claude</code> (a usage request that sends no
            prompt), and OpenCode through a briefly started{" "}
            <code className="font-mono text-xs">opencode serve</code>. xMatrix opens no Codex or
            Claude Code login file or keychain entry, and no login file of OpenCode 2.2.0 or later.
          </p>
          <p>
            <strong className="text-foreground">Only with your permission, for tools without an official quota interface.</strong>{" "}
            Cursor offers no official way to ask for its quota, so its sign-in (the macOS keychain
            entry <code className="font-mono text-xs">cursor-access-token</code>, its{" "}
            <code className="font-mono text-xs">auth.json</code>, or a{" "}
            <code className="font-mono text-xs">CURSOR_API_KEY</code> or{" "}
            <code className="font-mono text-xs">CURSOR_AUTH_TOKEN</code> already set for Cursor) is
            not read at all until the computer&apos;s owner allows it, for that computer and that tool
            alone: &quot;Allow reading Cursor sign-in to show quota&quot; where xMatrix shows the
            quota, or <code className="font-mono text-xs">xmatrix config quotaAccess cursor on</code>.
            Until then its quota shows as unknown, and xMatrix still recognizes a used-up quota from
            Cursor&apos;s own error message. The permission is bound to the Cursor account signed in
            when it is first used, by a fingerprint kept only on that computer: if the account or
            credential changes, the permission ends and the last quota numbers are deleted. It can be
            withdrawn at any time in the same place, in Settings → Legal and privacy, or with{" "}
            <code className="font-mono text-xs">xmatrix config quotaAccess cursor off</code>, and the
            next read is already refused. The switch below still overrides it.
          </p>
          <p>
            OpenCode before 2.2.0 has no official quota interface either, and is handled the same
            way: until the computer&apos;s owner allows it (&quot;Allow reading OpenCode sign-in to show
            quota&quot;, or <code className="font-mono text-xs">xmatrix config quotaAccess opencode on</code>),
            xMatrix opens neither OpenCode&apos;s <code className="font-mono text-xs">auth.json</code> nor
            an <code className="font-mono text-xs">OPENCODE_API_KEY</code> set for it, asks no OpenCode
            endpoint, and shows its quota as unknown. With the permission, it reads only the key
            OpenCode stored for OpenCode Go and uses it for one request to OpenCode Go&apos;s own usage
            endpoint (<code className="font-mono text-xs">opencode.ai/zen/go/v1/usage</code>). It never
            refreshes an expired sign-in on OpenCode&apos;s behalf: the quota then shows as unknown,
            marked expired, until OpenCode is signed in again. The same account binding, withdrawal
            and override apply. From OpenCode 2.2.0 on, xMatrix asks OpenCode itself and reads no
            OpenCode credential, with or without the permission.
          </p>
          <p>
            <strong className="text-foreground">Why.</strong> To ask that provider how much of your
            subscription or balance is left, so xMatrix can show it and route work away from an
            exhausted account without spending a model turn to find out.
          </p>
          <p>
            <strong className="text-foreground">What leaves your computer.</strong> The credential is
            held in memory and sent only to that provider&apos;s own usage endpoint, the same
            provider the tool itself signs in to. Nothing read from the file (no token, account id, file
            contents, or fingerprint of the file) is sent to xMatrix. The Hub receives only the
            normalized answer: the percentage left in each quota window, when it resets, whether the
            provider still serves the account, and a prepaid balance where applicable.
          </p>
          <p>
            <strong className="text-foreground">How to turn it off.</strong> One switch stops the
            file reads, the requests to Codex, Claude Code and OpenCode, and the provider requests
            on that computer:
            Desktop Settings → Legal and privacy → Local provider quota probes, or{" "}
            <code className="font-mono text-xs">xmatrix config quotaProbes off</code>, or the
            environment variable{" "}
            <code className="font-mono text-xs">XMATRIX_DISABLE_QUOTA_PROBES=1</code>. With it off,
            remaining quota shown for that computer&apos;s Agents may be missing or out of date.
          </p>
        </div>
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
          at most 5,000 events, 16 MiB, or 24 hours for each available Instance, whichever boundary is
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
            occasionally email you to ask for feedback on the Services or to offer you something related to
            them, such as complimentary plan time; every such email has a one-click unsubscribe link, and
            unsubscribing never affects authentication, billing, or security messages;
          </li>
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
          A user authorizes support access by handing a conversation to xMatrix support. They write one
          line about the problem and choose what to include, with nothing selected by default: the
          conversation’s messages; diagnostics for the conversation that contain only states,
          failure codes, counts, and times; and a recent tail of the xMatrix daemon log from one of
          their online machines. The machine removes home folder paths, email addresses, the query
          part of web addresses, and token-like strings from those log lines before they leave it, and
          the user sees exactly what will be sent before sending. That preview remains readable only by
          the user for about a week, and log lines sent with a handoff are erased when it is
          withdrawn. Nothing is shared until they tick “I agree to let xMatrix
          support read what I selected”. xMatrix support, meaning our team and its support Agents, may
          then read only what was selected, read-only, for 14 days. The user, or an owner or admin of
          their Space, may withdraw it at any time, and reading stops when it is withdrawn or expires.
          Every read is shown in the conversation: one note an hour, updated with each further read in
          that hour to give the number of reads and the time of the latest. Support’s replies arrive
          there or by email. Only the person who started the conversation, or an owner or admin of its Space,
          can hand it over. Without a handoff, support staff and Agents do not read a customer’s
          conversations, and product analysis uses metadata only.
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
            to our service providers, including Cloudflare for infrastructure, Sentry for scrubbed
            error and crash reporting, and Anthropic for the MadeByRobot-selected management
            extraction that an authorized user invokes;
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
          changes, or deletes mail. Gmail signs in through our subprocessor Composio, whose verified
          Google application holds the Gmail grant and relays each request. Search Console, AdSense, and Google Cloud access lets them read the
          sites, reports, projects, costs, logs, metrics, and alerts they ask about, and make the
          changes they request. Search Console can also verify site ownership and manage property,
          sitemap, and verification owner records when requested. Google Analytics access is read-only:
          it lists the connected account&apos;s GA4 properties and reads the reports a person or Agent
          asks for, including sessions, users, and landing pages. Google Calendar access lists the
          connected account&apos;s calendars, reads events and availability, and creates, edits or deletes
          events when requested and permitted by the app&apos;s permission or a specific approval.
          Event content can include titles, descriptions, locations and guest email addresses; Google
          may notify guests according to the requested notification setting. Google Business Profile access lists
          accounts and locations, reads performance and reviews, and publishes a review reply only when
          someone in the Space asks for that reply. Google Ads access reads the selected advertising
          account&apos;s settings, campaigns, budgets, ads, and performance reports. When requested and
          permitted by the app&apos;s permission or a specific approval, it validates, creates,
          updates, pauses, or enables advertising resources in that account. Enabling a campaign can
          incur Google Ads charges in the Customer&apos;s account. Google Play Console access lists the
          Android apps the connected account can manage and reads their releases, store listings,
          testers, subscriptions and prices, purchases and orders, Android Vitals metrics, reviews,
          and read-only Play Console bulk report exports (installs, store performance, ratings,
          crashes, sales, earnings, and subscriptions stored in the developer&apos;s Google Play Cloud
          Storage bucket) when a person or Agent asks. When requested and permitted by the app&apos;s
          permission or a specific approval, it uploads app builds, publishes or changes a release,
          and edits those listings, testers and subscription plans. Purchase, order and review records
          can include the personal data of the app&apos;s own users.
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
          , including the Limited Use requirements. Google Ads account management uses that account&apos;s
          advertising configuration and reports only for the features described above. We do not use
          Google user data from Gmail, Drive, or other connected Google services to build advertising
          audiences or target ads. We do not sell Google user data, use or transfer it for retargeting,
          personalized or interest-based advertising, use it to determine credit-worthiness or for
          lending, or use it to develop,
          improve, or train generalized AI or machine-learning models. Our staff do not read it except
          with your affirmative agreement for specific content, when necessary for security or to
          comply with law, or when the data is aggregated and anonymized for internal operations.
        </p>
        <p>
          Google access and refresh tokens are stored encrypted, by xMatrix or, for Gmail, by Composio,
          and are used only for the connected Space. Disconnecting a Google app in xMatrix deletes its
          stored tokens, including the Gmail account held at Composio; you can
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
          The xMatrix Chrome extension opens xMatrix in Chrome&apos;s side panel and, when you ask
          about selected text, directly in an inline conversation card on the page (which can be
          minimized to an edge tab or moved into the side panel; approvals, confirmations, and secret
          requests are always handled in the side panel rather than in a page overlay). It reads a
          web page only when you act on it: its menu item or its panel button. If you turn on its
          optional question box, which asks for access to web pages first, it reads the text you
          select on a page to show it in the box under the selection; that text stays in your
          browser. Only when you send a question does it pass the page title, address, and selected
          text to xMatrix with it. Whichever conversation is open in a tab&apos;s inline card or side
          panel becomes bound to that tab while it remains open, and each message you write there
          carries the title and address of the page in that tab (you can take the page off in the
          side panel before sending). While a tab has a bound conversation or an open side panel, an
          Agent in that conversation may read that tab&apos;s page: the extension reads what the
          browser exposes to assistive technology (headings, text, links, form fields and their
          values as shown), not hidden content or the page&apos;s code. An Agent may also ask to read
          another page you have open; the side panel asks you first and reads it only if you allow
          it. A page read this way goes to that Agent only, and xMatrix does not store it. The
          extension never opens a page for an Agent, does not read pages in the background, record
          your browsing history, or contact any server other than xMatrix. It keeps your sign-in
          session, tab-to-conversation bindings, and text you picked until the panel takes it in the
          browser&apos;s extension storage on that device. To prevent losing questions if you close
          or navigate away from a page on a slow network, an in-flight message is also temporarily
          stored in local extension storage and deleted immediately once delivered (or after at most
          10 minutes if delivery does not succeed, in which case a short delivery-failure notice is
          kept locally for at most 24 hours unless dismissed). Signing out ends the session and
          clears this extension storage. The xMatrix app in the card and panel keeps the same local
          copies there as it does in a browser tab. The extension does not sell this data or use it
          for advertising. What you send is handled as Customer Data under this Policy.
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
          Some connected providers limit how long results obtained through their APIs may be stored.
          For those connectors, currently Google Cloud, Gmail, Google Docs, Drive and Sheets, and Google
          Calendar, xMatrix deletes the original results (command receipts, inbound events, execution
          summaries, and private results) 29 days after they were returned, and at once when the
          connection is disconnected. Records that you, your members, or your Agents write from those
          results, such as Pages, notes, or files, are your Customer Data: you decide what to keep and
          are responsible for keeping it consistent with that provider&apos;s terms.
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
          authentication, Space/Channel/Run access controls, explicit owner approval before connecting
          a machine, scoped short-lived Agent credentials, per-app connector permission policies,
          private object storage, no-store handling for sensitive responses, protected deployment
          workflows, and incident response. Production service traffic uses HTTPS/TLS. Our
          infrastructure providers—including PlanetScale (managed PostgreSQL) and Cloudflare (Durable
          Objects, D1, and R2)—provide provider-managed encryption at rest. Saved Secrets and daemon
          local replicas receive additional authenticated encryption with protected key material.
        </p>
        <p>
          These controls are not end-to-end encryption: MadeByRobot and its service providers process
          readable collaboration content (such as Channel messages, Pages, and attachments) when
          required to synchronize multi-user workspaces, index and search, route Agents, maintain
          collaborative Pages, run Page automations and connected-app webhooks, secure the service,
          or perform another authorized feature. Source code, local files, SSH keys, and local
          provider credentials remain on your computer as described in Section 4 and our{" "}
          <Link className="font-medium text-foreground underline underline-offset-4" href="/docs/privacy">
            Telemetry and Local Privacy guide
          </Link>
          ; support access to customer conversations requires an explicit user handoff as described
          in Section 6. We do not currently promise a fixed data-residency region or represent that
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
          Space owners and admins can delete a Channel from its actions or details after confirming
          its current name and the consequences for all members. Access ends immediately and
          interrupted data cleanup resumes automatically. Linked Pages remain separate documents;
          shared content-addressed bytes follow the existing retention policy.
        </p>
        <p>
          You can start account deletion in Settings → Account or at the{' '}
          <Link href={appHref("/account/delete")}>account deletion page</Link>. A recent sign-in, your account
          email, and explicit confirmation are required. Close owned Spaces, leave other Spaces,
          and stop active agent work before proceeding. You can delete your account before a subscription expires; cancel provider renewal separately to stop future charges. Account deletion does
          not cancel Apple, Google Play, or Stripe subscriptions or move them to another Space.
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
          version and effective date and preserve accessible version history in our{" "}
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href="https://github.com/LambdaLabsHQ/xmatrix/commits/main/apps/web/src/content/legal"
          >
            public legal document history
          </a>
          . We will provide additional email or in-product notice when a change materially affects
          privacy rights. A policy notice is not treated as consent where law requires a separate
          affirmative choice.
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
