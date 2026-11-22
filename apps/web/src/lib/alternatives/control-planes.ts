import type { AlternativeEntry } from "./types";

/** Single-player multi-harness control planes, terminals, and first-party desktop tools. */
export const controlPlaneEntries: readonly AlternativeEntry[] = [
  {
    slug: "t3-code",
    name: "T3 Code",
    category: "control-planes",
    verifiedDate: "November 22, 2026",
    metaTitle: "T3 Code Alternative for Teams, Living Pages & Auto Quota Handoff — xMatrix",
    metaDescription:
      "Outgrowing T3 Code? Get the exact three things T3 Code users keep requesting: real multiplayer identity, living project Pages, and automatic cross-provider quota handoff.",
    eyebrow: "T3 Code Alternative",
    headline: "A T3 Code alternative when one developer's control plane needs a team, living docs, and quota handoff.",
    lead: "T3 Code is an impressive free single-player coding workbench, but it binds each environment to one account, stops cold at 'Limited' when a provider quota runs out, and has no shared project pages. xMatrix delivers the exact three upgrades T3 Code's own community keeps asking for.",
    indexSummary: "Single-user account binding (multiplayer requests #27974, #12283, #27708 unanswered), no living project memory (#15858), no automatic cross-provider quota failover (#15846), and Full access default on new threads.",
    painPoints: [
      {
        title: "No real multiplayer identity or shared team channels",
        problem:
          "T3 Code binds each environment to a single T3 Connect account—everyone in logs is just 'user', and guest links expire in 24 hours with every guest message requiring host approval. Repeated team requests (#27974, #12283, #27708) have gone unanswered, pushing teams onto third-party forks.",
        xmatrixAnswer:
          "xMatrix is built for multi-human + multi-agent Spaces from the ground up: real user identities, public and private Channels, attributed Page edits, and notifications routed to the person who asked.",
      },
      {
        title: "Hits 'Limited' and stops—no automatic cross-provider quota handoff",
        problem:
          "When Claude or Codex hits a usage cap in T3 Code, the thread freezes at Limited until reset or manual switching. Community requests for automatic cross-provider failover (#15846, #24453, #18949) remain unbuilt, and users also report wrapper sub-task overhead draining limits faster or showing false 'Limited' states.",
        xmatrixAnswer:
          "xMatrix monitors provider quota windows across your registered harnesses and automatically hands work from a capped provider (like Claude Code) to another available provider (like Codex or Gemini) so work keeps moving.",
      },
      {
        title: "No living project pages, Space secrets, or ops connectors",
        problem:
          "T3 Code excels at local diffs and emulators, but has no shared project memory or living documentation (#15858), defaults new threads to Full access, caps free T3 Connect tunnels at 3 machines, and focuses strictly on code rather than governed ops apps.",
        xmatrixAnswer:
          "xMatrix turns completed conversations into living Pages, connects unlimited machines across your team, stores Space-level secrets safely, and governs 20+ apps like Vercel, Cloudflare, Sentry, Gmail, and Stripe.",
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
        xmatrix: "Automatic cross-provider handoff (e.g. Claude Code to Codex/Gemini)",
        competitor: "Pauses at Limited; manual switch or wait for reset only",
      },
      {
        dimension: "Project status & living docs",
        xmatrix: "Living Pages kept current by agents and co-edited with humans",
        competitor: "Thread-by-thread history; no project memory or living docs (#15858)",
      },
      {
        dimension: "Default safety & ops governance",
        xmatrix: "Per-app Read-only / Ask first / Read & write across 20+ apps + Space secrets",
        competitor: "New threads default to Full access; machine-local secrets; dev issues only",
      },
      {
        dimension: "Remote machine limits",
        xmatrix: "Register all your macOS, Windows, and Linux machines in one Space",
        competitor: "T3 Connect free tier caps at 3 machines (requires paid T3 Chat for 10/100)",
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
        detail: "Register your laptops, build boxes, and cloud VMs directly into one Space so @auto routes to whichever machine and provider has headroom.",
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
          "If you only want a free solo coding workbench on 1–3 machines, T3 Code is great. Teams choose xMatrix when they need real multiplayer Spaces, living project Pages, automatic cross-provider quota handoff, Space secrets, and 20+ governed operational connectors.",
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
    relatedSlugs: ["orca", "herdr", "claude-code", "lody"],
  },
  {
    slug: "herdr",
    name: "herdr",
    category: "control-planes",
    verifiedDate: "November 22, 2026",
    metaTitle: "herdr Alternative with Auth, Approvals, Living Pages & Zero Lock-In — xMatrix",
    metaDescription:
      "Comparing herdr (herdr-core) vs xMatrix? Get built-in authentication, multi-user permissions, per-app approvals, Space secrets, and living Pages instead of an unauthenticated preview socket.",
    eyebrow: "herdr Alternative",
    headline: "A herdr alternative with real auth, team permissions, and living Pages—not an unauthenticated preview socket.",
    lead: "herdr evolved from a beloved Rust TUI multiplexer into herdr-core plus native apps, bringing breaking protocol changes and Reddit pushback over GUI lock-in—while still lacking multi-user auth, approvals, secrets, and a live cloud relay. xMatrix gives you a complete, governed collaboration layer today.",
    indexSummary: "Zero multi-user auth or permission boundaries (socket access equals shell access), Herdr Cloud still on waitlist, breaking protocol shifts (v0.9.2 graphics removal), and TUI-to-GUI lock-in backlash.",
    painPoints: [
      {
        title: "No authentication, permission boundaries, approvals, or secrets",
        problem:
          "herdr-core is explicitly a single-user local runtime: anyone who can reach its socket effectively has shell access. There are no user roles, no action approvals, no secret vault, and no scheduled or webhook-triggered automation.",
        xmatrixAnswer:
          "xMatrix builds the trust boundary on top of local execution: verified human and agent identities, Space-level secrets injected without exposing values, per-app approval policies, and Norn automation.",
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
          "Cross-machine relaying across macOS, Windows, Linux, Web, Android, and iOS TestFlight works in xMatrix today, and finished runs keep living Pages up to date automatically.",
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
        xmatrix: "Live today across Web, macOS, Windows, Linux, Android, iOS TestFlight",
        competitor: "SSH manual setup today; Herdr Cloud relay on waitlist",
      },
      {
        dimension: "Where work outcomes live",
        xmatrix: "Living Pages maintained by agents + searchable Channels",
        competitor: "Persistent PTY scrollback panes",
      },
      {
        dimension: "Automation & connectors",
        xmatrix: "Scheduled/event-driven Norn routines + 20+ connected apps",
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
      "You need real auth, Space secrets, and human-in-the-loop approvals before agents touch GitHub, Vercel, Cloudflare, or production services.",
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
          "xMatrix enforces server-side Space authentication and membership, separates machine registration from Space access, masks Space secrets via xmatrix secret exec, and gates connected SaaS actions with Read-only or Ask-first policies.",
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
    category: "control-planes",
    verifiedDate: "November 22, 2026",
    metaTitle: "Seedmux Alternative for Cross-Platform Teams, Android & Living Pages — xMatrix",
    metaDescription:
      "Comparing Seedmux vs xMatrix? Go beyond closed-source macOS + iPhone-only terminal panes and default YOLO phone sessions with cross-OS teamwork, living Pages, and governed app approvals.",
    eyebrow: "Seedmux Alternative",
    headline: "A Seedmux alternative that isn't locked to macOS, iPhone, solo panes, or YOLO phone sessions.",
    lead: "Seedmux pairs a slick Ghostty + tmux macOS terminal with an iPhone companion app, but it is closed-source, Mac-only, single-player, and launches phone-initiated sessions in YOLO mode by default. xMatrix brings cross-OS multi-machine coordination, real team Spaces, and living Pages to macOS, Windows, Linux, Android, and iOS.",
    indexSummary: "Closed-source, macOS + iPhone only (no Windows, Linux desktop, or Android), single-player only, phone-started sessions default to YOLO, and no shared living docs or ops connectors.",
    painPoints: [
      {
        title: "macOS + iPhone lock-in leaves Windows, Linux, and Android behind",
        problem:
          "Seedmux is strictly a native macOS app with notch-dependent alerts and an iPhone companion (behind Seedmux Pro). There is no native Windows or Linux desktop app, no web workspace, and no Android app.",
        xmatrixAnswer:
          "xMatrix runs natively across macOS, Windows, Linux, Web, Android, and iOS TestFlight—so every machine and phone you or your teammates use joins the exact same Space.",
      },
      {
        title: "Single-player terminal panes with YOLO defaults on mobile",
        problem:
          "Seedmux has no team channels, no shared roles, and no Space secrets; sessions started from the iPhone companion default to YOLO permissions, and cellular/corporate-firewall relays can add approval latency.",
        xmatrixAnswer:
          "xMatrix keeps explicit governance on mobile and desktop alike: per-app Read-only / Ask first / Read & write policies, masked Space secrets, and multi-human Channels where teammates can review and approve actions.",
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
        xmatrix: "macOS, Windows, Linux, Web, Android, iOS TestFlight",
        competitor: "macOS + iPhone companion only (SSH/relay to Linux hosts)",
      },
      {
        dimension: "Team collaboration",
        xmatrix: "Multi-human + multi-agent Channels and co-edited living Pages",
        competitor: "Single-player terminal only; no shared team channels or docs",
      },
      {
        dimension: "Mobile safety defaults",
        xmatrix: "Same per-app approval policies and Space secrets on mobile and web",
        competitor: "Phone-initiated sessions default to YOLO mode",
      },
      {
        dimension: "Source transparency",
        xmatrix: "Source-available under FSL-1.1-ALv2",
        competitor: "Closed-source binary releases",
      },
      {
        dimension: "External ops apps",
        xmatrix: "20+ connected apps (GitHub, Linear, Vercel, Cloudflare, Sentry, Gmail, Stripe)",
        competitor: "Terminal CLI commands only; no SaaS connector approval layer",
      },
    ],
    stayWhen: [
      "You are a solo macOS + iPhone terminal enthusiast who specifically wants Ghostty rendering, tmux pane splits, and MacBook notch popups.",
    ],
    switchWhen: [
      "You work on Windows, Linux, or Android—or collaborate with teammates who do.",
      "You want mobile control without defaulting remote sessions into YOLO permissions.",
      "You want decisions and project progress maintained in living Pages rather than ephemeral terminal splits.",
    ],
    migrationSteps: [
      {
        title: "Keep your existing CLI tools and subscriptions",
        detail: "Install xMatrix on your Mac and Linux hosts and add Claude Code, Codex, Grok, OpenCode, or Kimi with xmatrix agent add.",
      },
      {
        title: "Use Web, Desktop, or Mobile without self-hosting a relay",
        detail: "Follow progress and answer approvals from any browser, desktop app, Android device, or iOS TestFlight.",
      },
      {
        title: "Collect worker outputs in one living Page",
        detail: "Instead of checking worker pane receipts manually, let each agent update its section on the project Page.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix have structured task receipts like Seedmux workers?",
        answer:
          "Yes. Every xMatrix agent run reports explicit lifecycle states, final receipts, and updates directly into the Channel and linked Page.",
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
    relatedSlugs: ["herdr", "t3-code", "orca", "claude-code"],
  },
  {
    slug: "claude-code",
    name: "Claude Code Desktop",
    alsoKnownAs: "Claude Desktop, Cowork & Dispatch",
    category: "control-planes",
    verifiedDate: "November 22, 2026",
    metaTitle: "Claude Code Desktop Alternative for Multi-Vendor Quotas, Teams & Living Pages — xMatrix",
    metaDescription:
      "Hitting Claude Code 5-hour or weekly quota walls? Keep using Claude Code inside xMatrix—and add automatic handoff to Codex/Gemini, multiplayer Channels, living Pages, and Space secrets.",
    eyebrow: "Claude Code Desktop Alternative",
    headline: "Keep Claude Code. Leave behind single-vendor quota walls, solo silos, and vanished context.",
    lead: "Claude Code Desktop and Cowork are excellent for pairing with one Claude session, but November 2026 community reports highlight 3x faster quota burn across shared Pro/Max allowances—and Anthropic will never hand your work to Codex or Gemini when Claude caps out. xMatrix orchestrates Claude Code alongside every other harness in multiplayer Channels and living Pages.",
    indexSummary: "Single-vendor lock-in (no Codex/Gemini failover when shared 5h/weekly limits burn out), solo sessions without multiplayer channels or shared living Pages, and no Space-level secrets.",
    painPoints: [
      {
        title: "Shared 5-hour and weekly quota walls stop work dead",
        problem:
          "Because Claude Code, Claude Desktop, and Cowork all draw from the same plan allowance—and background subagents plus /code-review dramatically accelerate token consumption (many r/claude users report 3x burn in November 2026)—Pro and lower tiers hit limits mid-day with no way to roll work over to another provider.",
        xmatrixAnswer:
          "xMatrix doesn't replace Claude Code—it elevates it. When Claude Code hits its 5-hour or weekly cap, xMatrix hands the conversation and Page context straight to Codex, Gemini, Cursor, or Grok so your work never stalls.",
      },
      {
        title: "Built for solo pairing, not multiplayer teams or shared living docs",
        problem:
          "Claude Code Desktop is designed for one person watching one agent step by step; Projects memory belongs to a single user, Claude Tag is restricted to Slack Team/Enterprise, and there is no shared living Page maintained collaboratively across humans and multiple harnesses.",
        xmatrixAnswer:
          "xMatrix sits one layer up: teammates and dozens of parallel agents collaborate in shared Channels, while every finished run updates the shared living Page so you supervise outcomes and decisions rather than every line of terminal output.",
      },
      {
        title: "No Space-level secrets or cross-harness governance across your machines",
        problem:
          "Claude Code Desktop ties local execution to Anthropic's ecosystem, lacks Space-wide secret injection across heterogeneous harnesses, and Anthropic's regional restrictions block unsupported territories outright.",
        xmatrixAnswer:
          "xMatrix coordinates Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, and OpenCode across all your macOS, Windows, and Linux machines under one set of Space secrets and per-app connector approvals.",
      },
    ],
    comparisonRows: [
      {
        dimension: "When Claude hits its usage limit",
        xmatrix: "Automatic handoff to Codex, Gemini, Cursor, or Grok with full Page context",
        competitor: "Work pauses until the 5-hour/weekly reset or requires switching to paid API keys",
      },
      {
        dimension: "Supported coding harnesses",
        xmatrix: "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode, Antigravity",
        competitor: "Claude only",
      },
      {
        dimension: "Collaboration & shared memory",
        xmatrix: "Multiplayer public/private Channels + living Pages co-edited by humans and agents",
        competitor: "Single-user sessions and personal Projects; Claude Tag limited to Slack paid plans",
      },
      {
        dimension: "Supervision model",
        xmatrix: "Manage dozens of parallel runs by reading Pages, PR checks, and approval cards",
        competitor: "Pair closely with one session's diff viewer, terminal, and action prompts",
      },
      {
        dimension: "Ops connectors & secrets",
        xmatrix: "Space-level secrets + 20+ apps with Read-only / Ask first / Read & write rules",
        competitor: "Per-session MCP tools; Duet cloud VM still in US-only research waitlist",
      },
    ],
    stayWhen: [
      "You only use Claude, work completely solo, and want tight inline diff pairing and built-in cloud VMs bundled inside your Anthropic subscription.",
    ],
    switchWhen: [
      "You are tired of losing half a workday whenever Claude's 5-hour or weekly cap triggers and want Codex or Gemini to pick up seamlessly.",
      "You want teammates and multiple harnesses sharing the same Channels, living Pages, and Space secrets.",
      "You supervise many parallel workstreams and want to read project Pages and exception cards instead of babysitting every terminal.",
    ],
    migrationSteps: [
      {
        title: "Keep your existing Claude Code CLI—don't uninstall it",
        detail: "xMatrix drives your official local Claude Code CLI directly using your existing login; nothing is lost.",
      },
      {
        title: "Add a second harness for automatic quota continuity",
        detail: "Register Codex, Gemini, Cursor, or OpenCode alongside Claude Code via xmatrix agent add so @auto routes around quota caps automatically.",
      },
      {
        title: "Move recurring context from local CLAUDE.md files into living Pages",
        detail: "Keep project status, decisions, and open tasks in Pages that every harness and teammate shares.",
      },
    ],
    faqs: [
      {
        question: "Do I have to give up Claude Code to use xMatrix?",
        answer:
          "Not at all. Claude Code is a first-class harness in xMatrix—you keep using Claude Code on your own machines while gaining multiplayer Channels, living Pages, and automatic failover to Codex or Gemini when Claude limits hit.",
      },
      {
        question: "Can teammates share my personal Claude subscription in xMatrix?",
        answer:
          "No—xMatrix respects vendor terms of service and does not market subscription pooling. Each machine and user brings their own authorized harness subscriptions or API keys.",
      },
      {
        question: "Does xMatrix include cloud VMs like Claude Cowork?",
        answer:
          "Not today. xMatrix connects your own laptops, desktops, and cloud VMs across macOS, Windows, and Linux.",
      },
    ],
    relatedSlugs: ["t3-code", "jules", "orca", "paradev"],
  },
];
