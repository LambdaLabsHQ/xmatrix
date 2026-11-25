import type { AlternativeEntry } from "./types";

/** Single-player multi-harness control planes, terminals, and first-party desktop tools. */
export const controlPlaneEntries: readonly AlternativeEntry[] = [
  {
    slug: "t3-code",
    name: "T3 Code",
    verifiedDate: "November 22, 2026",
    metaTitle: "T3 Code Alternatives (2026): T3 Code vs xMatrix",
    metaDescription:
      "Looking for T3 Code alternatives? Give your team real user identities, shared Channels, living project Pages, Space secrets and cross-provider handoff.",
    eyebrow: "T3 Code Alternative · T3 Code vs xMatrix",
    headline: "T3 Code vs xMatrix",
    lead: "T3 Code is an impressive free single-player coding workbench, but it binds each environment to one account, has no shared living project pages, and waits at 'Limited' until the quota resets or you switch providers by hand. xMatrix gives your team shared Channels, living Pages, Space secrets, and 34 coding harnesses across your machines.",
    productCaption: "Inside xMatrix: real multiplayer Channels where 34 coding harnesses work across all your machines and keep living Pages current for the whole team.",
    painPoints: [
      {
        title: "No real multiplayer identity or shared team channels",
        problem:
          "T3 Code binds each environment to a single T3 Connect account—everyone in logs is just 'user', and guest links expire in 24 hours with every guest message requiring host approval. Repeated GitHub Discussion requests (#27974, #12283, #27708) have gone unanswered, pushing teams onto third-party forks.",
        xmatrixAnswer:
          "xMatrix is built for multi-human + multi-agent Spaces from the ground up: real user identities, public and private Channels, attributed Page edits, and notifications routed to the person who asked.",
      },
      {
        title: "Hits 'Limited' and stops—no automatic cross-provider quota handoff",
        problem:
          "When Claude or Codex hits a usage cap in T3 Code, the thread freezes at Limited until reset or manual switching. GitHub Discussion requests for automatic cross-provider failover (#15846, #24453, #18949) remain unbuilt, and users also report wrapper sub-task overhead draining limits faster or showing false 'Limited' states.",
        xmatrixAnswer:
          "xMatrix monitors provider quota windows across your registered harnesses and automatically hands work from a capped provider (like Claude Code) to another available provider (like Codex or Gemini) so work keeps moving.",
      },
      {
        title: "No living project pages, Space secrets, or ops connectors",
        problem:
          "T3 Code excels at local diffs and emulators, but has no shared project memory or living documentation (GitHub Discussion #15858), defaults new threads to Full access, caps free T3 Connect tunnels at 3 machines, and focuses strictly on code rather than governed ops apps.",
        xmatrixAnswer:
          "In xMatrix, agents record completed work in living Pages; you connect as many machines as you like across 34 harnesses, store Space-level secrets, and govern 40+ connected apps like Vercel, Cloudflare, Sentry, Gmail, and Stripe.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Multiplayer & attribution",
        xmatrix: "Full team Spaces, per-person identity, public/private Channels, attributed edits",
        competitor: "Single-user environment; 24-hour guest link beta; no team identity",
      },
      {
        dimension: "When a provider hits its quota limit",
        xmatrix: "Automatic cross-provider handoff with uncommitted changes intact",
        competitor: "Pauses at Limited; manual switch or wait for reset only",
      },
      {
        dimension: "Project status & living docs",
        xmatrix: "Living Pages kept current by agents and co-edited with humans",
        competitor: "Thread-by-thread history; no project memory or living docs (Discussion #15858)",
      },
      {
        dimension: "Default safety & ops governance",
        xmatrix: "Machine owner picks full or ask access per harness; per-app policies across 40+ apps + Space secrets",
        competitor: "New threads default to Full access; machine-local secrets; dev issues only",
      },
      {
        dimension: "Harnesses & remote machines",
        xmatrix: "34 coding harnesses (+ --runtime) across all your macOS, Windows, and Linux machines",
        competitor: "10 harnesses + ACP; T3 Connect free tier caps at 3 machines",
      },
    ],
    stayWhen: [
      "You work strictly solo and want a free local IDE workbench with built-in diff review, checkpoint rollback, browser preview, and iOS/Android simulators.",
      "You want zero-account local setup on 1–3 machines and don't need teammates, living docs, or non-code connectors.",
    ],
    switchWhen: [
      "Two or more people need to work with coding agents in the same workspace with real attribution and shared context.",
      "You're tired of watching threads stall at 'Limited' when Claude hits its 5-hour or weekly cap while your Codex or Gemini quota sits unused.",
      "You want work across dozens of threads distilled into living Pages plus governed access to Vercel, Cloudflare, Linear, Sentry, and Gmail.",
    ],
    migrationSteps: [
      {
        title: "Keep your local CLIs—or even pair xMatrix via MCP",
        detail: "xMatrix uses the exact same local Claude Code, Codex, Cursor, OpenCode, Grok, and Antigravity CLIs you already installed for T3 Code.",
      },
      {
        title: "Connect more than 3 machines without a T3 Chat bundle",
        detail: "Register your laptops, build boxes, and your own servers directly into one Space so @auto routes to whichever machine and provider has headroom.",
      },
      {
        title: "Give every project a living Page",
        detail: "Stop repeating architectural decisions across fresh threads—write them once on the project Page where every harness reads them.",
      },
    ],
    faqs: [
      {
        question: "Why pay for xMatrix Pro when T3 Code is free?",
        answer:
          "If you only want a free solo coding workbench on 1–3 machines, T3 Code is great. Teams choose xMatrix when they need real multiplayer Spaces, living project Pages, cross-provider quota handoff, Space secrets, and 40+ governed operational connectors.",
      },
      {
        question: "Does xMatrix automatically switch providers when Claude hits its limit?",
        answer:
          "Yes. When one provider's quota window is exhausted, xMatrix routes or hands off work to another available harness you've registered—without doing multi-account ToS rotation on a single vendor.",
      },
      {
        question: "Can I still use xMatrix alongside T3 Code?",
        answer:
          "Yes. xMatrix exposes an MCP server for reading and updating Pages and sending Channel messages, and runs against the same local repositories without locking them.",
      },
    ],
    relatedSlugs: ["orca", "herdr", "multica", "lody"],
  },
  {
    slug: "herdr",
    name: "herdr",
    verifiedDate: "November 22, 2026",
    metaTitle: "herdr Alternatives (2026): herdr vs xMatrix",
    metaDescription:
      "Evaluating herdr alternatives? xMatrix ships built-in auth, team permissions, live cross-device relay with no waitlist, per-app approvals and living Pages.",
    eyebrow: "herdr Alternative · herdr vs xMatrix",
    headline: "herdr vs xMatrix",
    lead: "herdr evolved from a beloved Rust TUI multiplexer into herdr-core plus native apps, bringing breaking protocol changes and Reddit pushback over GUI lock-in—while still lacking multi-user auth, approvals, secrets, and a live cloud relay. xMatrix gives you a complete, governed collaboration layer today.",
    productCaption: "Inside xMatrix: cross-device desktop, web, and mobile coordination live today—with authenticated Spaces, Space secrets, and living Pages instead of an unauthenticated preview socket.",
    painPoints: [
      {
        title: "No authentication, permission boundaries, approvals, or secrets",
        problem:
          "herdr-core is explicitly a single-user local runtime: anyone who can reach its socket effectively has shell access. There are no user roles, no action approvals, no secret vault, and no scheduled or webhook-triggered automation.",
        xmatrixAnswer:
          "xMatrix builds the trust boundary on top of local execution: verified human and agent identities, Space-level secrets passed into commands without being printed or put in chat, per-app approval policies, and Norn automation.",
      },
      {
        title: "Protocol churn, breaking changes, and TUI-to-GUI backlash",
        problem:
          "Rewriting into herdr-core broke older third-party clients, v0.9.2 dropped the pane graphics API, and Reddit users pushed back against the shift away from universal SSH TUI access toward dedicated client apps. Active issues also track SSH stderr bleeding into panes, macOS main-thread stalls (os error 35), and CLAUDE_CODE_* env var leakage across systemd units.",
        xmatrixAnswer:
          "xMatrix delivers one cohesive Web, desktop, CLI, and mobile experience backed by versioned Hub/CLI compatibility contracts and explicit per-run isolation.",
      },
      {
        title: "Herdr Cloud is still waitlisted—and terminals don't maintain living docs",
        problem:
          "Cross-device encrypted relaying (Herdr Cloud) and the official mobile app remain waitlisted/in-progress, and even once live, a PTY multiplexer leaves every decision buried inside terminal scrollback.",
        xmatrixAnswer:
          "Cross-machine relaying across macOS, Windows, Linux, iPhone & iPad, Android, and Web works in xMatrix today, and agents write finished work back to living Pages.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Identity & security boundary",
        xmatrix: "Authenticated Spaces, member roles, Space secrets, per-app approvals",
        competitor: "None—local socket access equals full shell access",
      },
      {
        dimension: "Cross-device relay & mobile",
        xmatrix: "Live today across macOS, Windows, Linux, iPhone & iPad, Android, and Web",
        competitor: "SSH manual setup today; Herdr Cloud relay on waitlist",
      },
      {
        dimension: "Where work outcomes live",
        xmatrix: "Living Pages maintained by agents + searchable Channels",
        competitor: "Persistent PTY scrollback panes",
      },
      {
        dimension: "Automation & connectors",
        xmatrix: "Scheduled/event-driven Norn programs + 40+ connected apps",
        competitor: "No built-in cron, webhook automation, or app connectors",
      },
      {
        dimension: "Target audience",
        xmatrix: "Solo vibe coders and teams coordinating multiple agents and apps",
        competitor: "Single-user terminal power users building on a PTY runtime",
      },
    ],
    stayWhen: [
      "You specifically want an Apache-2.0 local PTY daemon with a raw JSON-RPC/OpenRPC socket to script custom terminal UIs over SSH.",
      "You work strictly alone in a terminal and never need team access, living Pages, or external app approvals.",
    ],
    switchWhen: [
      "You want cross-device desktop and mobile access today without waiting on the Herdr Cloud waitlist or debugging SSH ProxyCommand leaks.",
      "You need real auth, Space secrets, and human-in-the-loop approvals before agents act through Vercel, Cloudflare, Linear, or other connected apps.",
      "You want project status summarized in living Pages rather than hunting through persistent PTY panes.",
    ],
    migrationSteps: [
      {
        title: "Install the xMatrix CLI alongside your existing tools",
        detail: "Register your macOS, Linux, or Windows machines with one command—no manual SSH tunnel plumbing required.",
      },
      {
        title: "Connect your coding harnesses once",
        detail: "Add Claude Code, Codex, Cursor, Gemini, or OpenCode using xmatrix agent add; your subscriptions stay local.",
      },
      {
        title: "Move recurring status tracking to living Pages",
        detail: "Create Pages for your active projects and let scheduled or event-driven routines keep them accurate.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix keep agent runs alive if I close my browser or laptop lid?",
        answer:
          "Yes, for any machine that stays awake (such as a desktop, Mac Studio, or Linux VPS), runs continue on the daemon and stream updates to your Web, desktop, and mobile clients whenever you reconnect.",
      },
      {
        question: "How is xMatrix safer than exposing a local PTY socket?",
        answer:
          "xMatrix enforces server-side Space authentication and membership, separates machine registration from Space access, passes Space secrets into commands via xmatrix secret exec without printing them, and gates connected SaaS actions with Read only or Ask first permissions.",
      },
      {
        question: "Can I still use xMatrix from the terminal?",
        answer:
          "Yes. The native Rust CLI (xmatrix) lets both humans and agents read Pages, send messages, inspect runs, and invoke governed connectors right from the shell.",
      },
    ],
    relatedSlugs: ["seedmux", "t3-code", "lody", "orca"],
  },
  {
    slug: "seedmux",
    name: "Seedmux",
    verifiedDate: "November 22, 2026",
    metaTitle: "Seedmux Alternatives (2026): Seedmux vs xMatrix",
    metaDescription:
      "Looking for Seedmux alternatives? Escape macOS + iPhone lock-in, closed binaries and YOLO phone defaults with xMatrix on macOS, Windows, Linux and Android.",
    eyebrow: "Seedmux Alternative · Seedmux vs xMatrix",
    headline: "Seedmux vs xMatrix",
    lead: "Seedmux pairs a slick Ghostty + tmux macOS terminal with an iPhone companion app, but it is closed-source, Mac-only, single-player, and launches phone-initiated sessions in YOLO mode by default. xMatrix brings cross-OS multi-machine coordination, real team Spaces, and living Pages to macOS, Windows, Linux, Android, and iOS.",
    productCaption: "Inside xMatrix: one workspace across macOS, Windows, Linux, iPhone & iPad, Android, and Web—with governed app approvals and harness access each machine's owner chooses.",
    painPoints: [
      {
        title: "macOS + iPhone lock-in leaves Windows, Linux, and Android behind",
        problem:
          "Seedmux is strictly a native macOS app with notch-dependent alerts and an iPhone companion (behind Seedmux Pro). There is no native Windows or Linux desktop app, no web workspace, and no Android app.",
        xmatrixAnswer:
          "xMatrix runs across macOS, Windows, Linux, iPhone & iPad, Android, and Web—so every machine and phone you or your teammates use joins the exact same Space.",
      },
      {
        title: "Single-player terminal panes with YOLO defaults on mobile",
        problem:
          "Seedmux has no team channels, no shared roles, and no Space secrets; sessions started from the iPhone companion default to YOLO permissions, and cellular/corporate-firewall relays can add approval latency.",
        xmatrixAnswer:
          "xMatrix applies the same rules whichever device starts the work: each harness runs with the full or ask-first access its machine's owner confirmed, connected apps follow Read only / Ask first / Read and write permissions, Space secrets stay out of chat, and Space admins approve Ask-first actions in shared Channels.",
      },
      {
        title: "Fragile CLI state scraping and no living project documentation",
        problem:
          "Because Seedmux wraps local CLI panes via tmux, CLI upgrades or expired auth tokens can stall pane status detection, heavy multi-pane runs tax local MacBook RAM, and work ends in scrollback rather than durable team docs.",
        xmatrixAnswer:
          "xMatrix uses structured harness adapters with explicit lifecycle states, distributes work across all your connected machines, and turns finished work into living Pages.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Supported platforms",
        xmatrix: "macOS, Windows, Linux, iPhone & iPad, Android, and Web",
        competitor: "macOS + iPhone companion only (SSH/relay to Linux hosts)",
      },
      {
        dimension: "Team collaboration",
        xmatrix: "Multi-human + multi-agent Channels and co-edited living Pages",
        competitor: "Single-player terminal only; no shared team channels or docs",
      },
      {
        dimension: "Mobile safety defaults",
        xmatrix: "Harness access its machine owner confirmed (full or ask) + the same per-app policies from any device",
        competitor: "Phone-initiated sessions default to YOLO mode",
      },
      {
        dimension: "Source transparency",
        xmatrix: "Source-available under FSL-1.1-ALv2",
        competitor: "Closed-source binary releases",
      },
      {
        dimension: "External ops apps",
        xmatrix: "40+ connected apps (GitHub, Linear, Vercel, Cloudflare, Sentry, Gmail, Stripe, etc.)",
        competitor: "Terminal CLI commands only; no SaaS connector approval layer",
      },
    ],
    stayWhen: [
      "You are a solo macOS + iPhone terminal enthusiast who specifically wants Ghostty rendering, tmux pane splits, and MacBook notch popups.",
    ],
    switchWhen: [
      "You work on Windows, Linux, or Android—or collaborate with teammates who do.",
      "You want mobile control where each machine's owner has explicitly chosen full or ask-first access for every harness.",
      "You want decisions and project progress maintained in living Pages rather than ephemeral terminal splits.",
    ],
    migrationSteps: [
      {
        title: "Keep your existing CLI tools and subscriptions",
        detail: "Install xMatrix on your Mac and Linux hosts and add any of 34 harnesses (Claude Code, Codex, Grok, OpenCode, Kimi, etc.) with xmatrix agent add.",
      },
      {
        title: "Use Web, Desktop, or Mobile without self-hosting a relay",
        detail: "Follow progress and answer approvals from any browser, the desktop app, or the iPhone, iPad, and Android apps.",
      },
      {
        title: "Collect worker outputs in living Pages",
        detail: "Instead of checking worker pane receipts manually, let each agent update its section on the project Page.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix have structured task receipts like Seedmux workers?",
        answer:
          "Yes. Every program request sent to an agent ends with a typed reply, alongside explicit lifecycle states and updates directly in the Channel and linked Page.",
      },
      {
        question: "Can I connect my Linux servers alongside my MacBook?",
        answer:
          "Yes. Install the native xMatrix daemon on Linux, macOS, and Windows machines—all of them appear in one unified Agents matrix inside your Space.",
      },
      {
        question: "Is xMatrix open source or closed source?",
        answer:
          "xMatrix is source-available under FSL-1.1-ALv2 on GitHub (LambdaLabsHQ/xmatrix), whereas Seedmux is closed-source.",
      },
    ],
    relatedSlugs: ["herdr", "t3-code", "orca", "lody"],
  },
];
