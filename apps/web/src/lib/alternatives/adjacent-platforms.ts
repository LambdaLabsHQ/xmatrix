import type { AlternativeEntry } from "./types";

/** Adjacent platforms, memory layers, creation studios, and sunsetting cloud coding agents. */
export const adjacentPlatformEntries: readonly AlternativeEntry[] = [
  {
    slug: "linear",
    name: "Linear Agents",
    alsoKnownAs: "Linear Coding Sessions & Loops",
    verifiedDate: "November 22, 2026",
    metaTitle: "Linear Agents Alternatives (2026): Linear vs xMatrix",
    metaDescription:
      "Comparing Linear Agents alternatives? Skip expiring sandbox credits, cloud-only ticket runs and Enterprise-gated audit logs with local Channels and Pages.",
    eyebrow: "Linear Agents Alternative · Linear vs xMatrix",
    headline: "Linear Agents Alternative: Run Agents on Your Own Machines & Subscriptions — Works Alongside Linear",
    lead: "Linear is an extraordinary issue tracker, and Linear Agents turns well-scoped issues into cloud sandbox PRs—at $0.25 per 20 minutes plus token spend from a separate prepaid wallet that expires in 12 months. Keep Linear for issue tracking and connect it to xMatrix to run 34 coding harnesses on your own machines in live Channels and living Pages.",
    productCaption: "Inside xMatrix: keep Linear connected while running local Claude Code and Codex harnesses in live Channels with zero sandbox meters or expiring prepaid balances.",
    painPoints: [
      {
        title: "Separate prepaid credit wallets that expire and can't be refunded",
        problem:
          "On top of Basic ($10/seat) or Business ($16/seat, required for Loops), Linear Coding Sessions require topping up a separate prepaid USD balance ($10 minimum, expires after 12 months, non-refundable) billed per token plus $0.25 per 20-minute sandbox block. Ambiguous tickets that retry burn credits fast.",
        xmatrixAnswer:
          "xMatrix runs agents on your own machines using the Claude Code, Codex, or Cursor subscriptions you already pay for—no sandbox meter and no expiring prepaid cash balance.",
      },
      {
        title: "Everything is a ticket—no live multi-agent Channels or local machine orchestration",
        problem:
          "Linear Agents excels at narrow, pre-scoped issues in cloud sandboxes, but cannot orchestrate agents across your own MacBooks, Linux build boxes, or Windows rigs, and offers no shared real-time Channel for steering multiple harnesses together.",
        xmatrixAnswer:
          "xMatrix gives your team live Channels where humans and multiple local harnesses collaborate in real time, then writes the resulting state directly into living Pages.",
      },
      {
        title: "No per-action coding approvals and thin agent auditability",
        problem:
          "Linear's audit log is restricted to Enterprise and does not record granular individual agent actions, and there is no unified per-app approval gate covering Cloudflare, Vercel, Gmail, Sentry, or Stripe.",
        xmatrixAnswer:
          "xMatrix includes full conversation/run traces, Space-level secrets, and per-app policies across 35 connected apps—including Linear itself.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Where coding agents run",
        xmatrix: "Your own macOS, Windows, and Linux machines (laptops, desktops, or self-managed servers)",
        competitor: "Linear's cloud sandboxes ($0.25/20 min) or external vendor clouds",
      },
      {
        dimension: "Agent billing model",
        xmatrix: "BYO model subscriptions across 34 harnesses; Pro $10/human seat/mo ($8 annual)",
        competitor: "Seat plan ($10–$16/mo) + separate prepaid credits (12-mo expiry, non-refundable)",
      },
      {
        dimension: "Best-fit work shape",
        xmatrix: "Work starting from live Channels, living Pages & ops—connected directly to Linear",
        competitor: "Well-scoped issue tickets routed to a cloud PR",
      },
      {
        dimension: "Governance & auditability",
        xmatrix: "Per-app policies across 35 apps + Space secrets on every plan",
        competitor: "Team-level agent toggles; audit logs Enterprise-only, not per agent action",
      },
      {
        dimension: "Works together?",
        xmatrix: "Native Linear connector lets xMatrix agents read and update Linear issues",
        competitor: "Issue-first; third-party agents connect via Agent Interaction API",
      },
    ],
    stayWhen: [
      "Your workflow is strictly issue-to-PR on clean, self-contained tickets and you want zero local machine setup.",
      "You already live inside Linear Business and only need occasional cloud Loops on Linear issues.",
    ],
    switchWhen: [
      "You want to use your existing Claude Code / Codex subscriptions on your own hardware without paying per-20-minute sandbox blocks or managing expiring prepaid balances.",
      "Your team needs live multi-agent Channels and living Pages for architecture, releases, and operations—not just tickets.",
      "You want per-app approvals and Space secrets across Linear, GitHub, Vercel, Cloudflare, Sentry, and Gmail.",
    ],
    migrationSteps: [
      {
        title: "Keep Linear as your issue tracker—connect it to xMatrix",
        detail: "You don't need to rip out Linear. Connect the Linear app in xMatrix so your local agents read issues, ship PRs, and sync status.",
      },
      {
        title: "Register your local machines and harnesses",
        detail: "Run Claude Code, Codex, Cursor, or Gemini on your own workstations without paying cloud sandbox fees.",
      },
      {
        title: "Maintain project truth in living Pages",
        detail: "Link Pages to your workstreams so architecture decisions, release status, and open blockers stay readable outside ticket comments.",
      },
    ],
    faqs: [
      {
        question: "Do I have to leave Linear to use xMatrix?",
        answer:
          "No. xMatrix has a native Linear connector—your team can keep tracking issues in Linear while running multi-agent execution, living Pages, and governed ops workflows in xMatrix.",
      },
      {
        question: "Why not just use Linear's BYOK option for Coding Sessions?",
        answer:
          "Even with BYOK, Linear Coding Sessions still run only in cloud sandboxes billed at $0.25 per 20-minute block from expiring prepaid credits, and cannot coordinate your local machines or non-Linear ops connectors.",
      },
      {
        question: "Does xMatrix charge for Loops-style scheduled automation?",
        answer:
          "Scheduled and event-driven Norn routines are built into xMatrix Pages using your existing plan credits—no separate Business tier upgrade required.",
      },
    ],
    relatedSlugs: ["multica", "notion", "slack-code", "raft"],
  },
  {
    slug: "notion",
    name: "Notion Custom Agents",
    alsoKnownAs: "Notion AI & External Agents",
    verifiedDate: "November 22, 2026",
    metaTitle: "Notion Custom Agents Alternatives (2026) — xMatrix",
    metaDescription:
      "Looking for Notion Custom Agents alternatives? Skip the $20–$24 Business gate, three credit wallets and creator-drained pauses with xMatrix living Pages.",
    eyebrow: "Notion Custom Agents Alternative · Notion vs xMatrix",
    headline: "Notion Custom Agents Alternative: Living Pages Updated as Agents Ship Code — Without Three Credit Wallets",
    lead: "Notion Custom Agents sit behind a $20–$24/seat Business paywall and a convoluted three-wallet credit system where shared agents drain their creator's personal Select credits and pause mid-run. xMatrix updates living Pages automatically as 34 coding harnesses ship in your real repos—no credit wallets required.",
    productCaption: "Inside xMatrix: agents run in your real repos, talk with your team in Channels, and maintain living Pages—with one pooled Space allowance and full mobile access.",
    painPoints: [
      {
        title: "Three separate credit wallets and creator-drained pauses",
        problem:
          "Notion splits AI usage into personal Standard credits (1,500/mo), personal Select credits (500/mo, required for Custom Agents), and admin-purchased Workspace Notion Credits ($10/1,000). Personal balances can't pool or roll over, teammates triggering a shared agent burn the creator's personal Select pool by default, and agents pause mid-task the instant credits hit zero.",
        xmatrixAnswer:
          "xMatrix Pro is one flat $10/human seat/month ($8/mo annual) with 5,000 pooled agent credits per seat across the Space, a 50% grace cushion, and zero LLM token resale—human edits are always free.",
      },
      {
        title: "No local machine execution, cross-machine relay, or real-time agent channels",
        problem:
          "Notion treats documents as the manual work surface and delegates coding to external cloud APIs (alpha). It cannot run Claude Code or Codex directly on your laptops or build servers, lacks Space-level secrets, and has no multi-human + multi-agent live Channel.",
        xmatrixAnswer:
          "In xMatrix, you talk in a Channel, agents run directly in your local repositories across macOS, Windows, and Linux, and living Pages update as a natural byproduct of real engineering work.",
      },
      {
        title: "Mobile can't build or even run shared team Custom Agents",
        problem:
          "Notion's mobile app blocks creating Custom Agents and restricts mobile users to interacting only with Custom Agents they personally own—leaving teammates stranded away from a desktop.",
        xmatrixAnswer:
          "Every xMatrix member can read Pages, summon any authorized Space agent, and approve external connector actions from Web (including iPhone & iPad), Desktop, or Android.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Pricing & credit model",
        xmatrix: "Free (500 lifetime writes) + Pro $10/seat/mo ($8 annual); one pooled Space allowance",
        competitor: "Business $20–$24/seat/mo + 3 separate wallets (Standard, Select, Workspace $10/1k)",
      },
      {
        dimension: "Where agents execute",
        xmatrix: "Directly on your own macOS, Windows, and Linux machines across 34 harnesses",
        competitor: "Notion cloud browser/VM; coding delegated to external vendor clouds",
      },
      {
        dimension: "How docs stay fresh",
        xmatrix: "Working coding agents rewrite Pages as they ship; suggestion mode & attribution included",
        competitor: "Humans invoke agents/triggers to edit blocks; also has suggestion mode & attribution",
      },
      {
        dimension: "Mobile team access",
        xmatrix: "Full Channel, Page, agent summon, and approval access for all members",
        competitor: "Cannot create Custom Agents on mobile or run team-shared agents",
      },
      {
        dimension: "Secrets & engineering connectors",
        xmatrix: "Space-level secret vault + 35 connectors (including Notion itself)",
        competitor: "No Space-level secret vault for CLI execution",
      },
    ],
    stayWhen: [
      "Your company runs on relational Notion databases, CRM tables, and rich document formatting for non-engineering teams.",
    ],
    switchWhen: [
      "You're tired of untangling Standard vs. Select vs. Workspace credits or watching shared team agents stall because one builder's personal credits ran dry.",
      "You want coding agents running directly on your own repositories and automatically maintaining project Pages—not wikis that drift behind reality.",
      "Your engineers need mobile access to shared agents, Space secrets, and governed deploy/ops connectors.",
    ],
    migrationSteps: [
      {
        title: "Connect Notion instead of migrating everything overnight",
        detail: "xMatrix includes a native Notion connector so agents can read existing Notion specs while maintaining live engineering status in xMatrix Pages.",
      },
      {
        title: "Move fast-changing project state to xMatrix Pages",
        detail: "Start with release tracking, architecture decisions, and incident runbooks—the pages that go stale fastest in Notion.",
      },
      {
        title: "Attach scheduled and event-driven Norn routines",
        detail: "Embed routines directly inside each Page so it updates from GitHub, Sentry, or daily schedules without burning Notion Select credits.",
      },
    ],
    faqs: [
      {
        question: "Can xMatrix connect to our existing Notion workspace?",
        answer:
          "Yes. xMatrix has a built-in Notion connector with configurable Read-only, Ask first, or Read & write permissions.",
      },
      {
        question: "Does xMatrix charge extra when teammates trigger an agent I set up?",
        answer:
          "No. On xMatrix Pro, agent credits (5,000 per human seat/month) are pooled across the entire Space—there is no personal creator-wallet bottleneck.",
      },
      {
        question: "What happens if a person and an agent edit the same xMatrix Page?",
        answer:
          "The human always wins. If you type in a paragraph an agent is updating, the agent waits and continues from what you wrote so your words are never overwritten.",
      },
    ],
    relatedSlugs: ["nowledge-mem", "linear", "youmind", "raft"],
  },
  {
    slug: "slack-code",
    name: "Slack Code",
    alsoKnownAs: "Slack Code API",
    verifiedDate: "November 22, 2026",
    metaTitle: "Slack Code Alternatives (2026): No 15-Msg API Cap",
    metaDescription:
      "Looking for Slack Code alternatives? Escape 1 req/min limits, 15-message history on custom apps and 90-day Free caps, with real agent runtimes in xMatrix.",
    eyebrow: "Slack Code Alternative · Slack Code vs xMatrix",
    headline: "Slack Code Alternative: Agents on Your Machines, Decisions on Living Pages — Works Alongside Slack",
    lead: "Slack Code API adds task channels and diff previews inside Slack, but Slack is still just a chat shell with no agent runtime, no living documentation, and severe API throttling (1 req/min, 15 messages max on history endpoints for non-Marketplace apps). Keep Slack connected via xMatrix's Slack connector while running 34 coding harnesses on your own machines and keeping decisions in living Pages.",
    productCaption: "Inside xMatrix: native multi-human and multi-agent Channels backed by your own machines and living Pages—with full context access and zero 15-message API walls.",
    painPoints: [
      {
        title: "Aggressive Slack API throttling starves custom coding agents of context",
        problem:
          "Slack clamped conversations.history and conversations.replies for non-Marketplace apps to 1 request per minute and 15 objects per request—slashing custom agent context windows and prompting widespread developer backlash over AI gatekeeping—while Free workspaces lose history after 90 days.",
        xmatrixAnswer:
          "xMatrix is built for agents natively: full channel history, outline/section-level Page reads, and zero artificial 15-message gatekeeping on your own Space.",
      },
      {
        title: "Slack is a chat UI—it provides no runtime, no cross-machine routing, and no Space secrets",
        problem:
          "Slack Code renders diffs and partner-agent updates, but you still have to buy partner agents separately or build and host your own machine runner, daemon, quota failover, and secret injection.",
        xmatrixAnswer:
          "xMatrix provides the complete runtime coordination stack: register your macOS, Windows, and Linux machines once, route across Claude Code, Codex, Cursor, and Gemini, and inject Space secrets cleanly.",
      },
      {
        title: "Knowledge dies in scrolling Slack channels",
        problem:
          "Even with task channels, Slack has no living project document layer—decisions sink under hundreds of messages and force every new person or agent to guess what still holds true.",
        xmatrixAnswer:
          "Every xMatrix Channel connects directly to living Pages where agents rewrite the current state in place—so you read one page to know where a project stands.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Agent context & API limits",
        xmatrix: "Native full-history Channel reads + structured Page outline/section reads",
        competitor: "Non-Marketplace history/replies capped at 1 req/min & 15 messages; 90-day Free cap",
      },
      {
        dimension: "Execution runtime",
        xmatrix: "Built-in cross-machine daemon for 34 coding harnesses (+ --runtime)",
        competitor: "Chat UI only; requires separate partner agent subscriptions or custom hosting",
      },
      {
        dimension: "Living project state",
        xmatrix: "Living Pages updated by agents as work completes",
        competitor: "Rolling chat history and archived task channels",
      },
      {
        dimension: "Governed connectors & secrets",
        xmatrix: "Space secrets + 35 connected apps with per-app policies",
        competitor: "No built-in agent secret vault or cross-app runtime governance",
      },
      {
        dimension: "Works with Slack?",
        xmatrix: "Native Slack connector lets xMatrix agents read/post to Slack with approval",
        competitor: "Lives strictly inside Slack",
      },
    ],
    stayWhen: [
      "Your entire company refuses to leave Slack and you only want a paid Marketplace partner agent posting diffs into existing Slack threads.",
    ],
    switchWhen: [
      "Slack's 1 req/min, 15-message history clampdown is breaking your custom agent workflows.",
      "You want an out-of-the-box multi-machine runner for Claude Code, Codex, and Cursor without building glue infrastructure.",
      "You want project decisions captured in living Pages instead of disappearing into Slack scrollback.",
    ],
    migrationSteps: [
      {
        title: "Keep Slack for company chat and connect it to xMatrix",
        detail: "Attach xMatrix's native Slack connector with Ask-first or Read-only policies so engineering work stays structured without cutting off non-technical teammates.",
      },
      {
        title: "Move multi-agent engineering channels into xMatrix",
        detail: "Register your machines and run Claude Code, Codex, and Cursor directly in xMatrix Channels with full context.",
      },
      {
        title: "Turn pinned Slack messages into living Pages",
        detail: "Replace stale pinned messages and bookmarks with Pages that agents keep current automatically.",
      },
    ],
    faqs: [
      {
        question: "Can xMatrix still talk to our existing Slack workspace?",
        answer:
          "Yes. xMatrix includes a native Slack connector with per-app Read-only, Ask first, or Read & write permissions.",
      },
      {
        question: "Does xMatrix limit how much channel history my own agents can read?",
        answer:
          "No. Agents read the conversation history and linked living Pages directly—there is no 15-message non-Marketplace API wall.",
      },
      {
        question: "How is xMatrix priced compared to Slack plus partner coding agents?",
        answer:
          "xMatrix Pro is $10/human seat/month ($8/mo annual) with unlimited agents using your existing CLI subscriptions, instead of stacking Slack seats on top of separate partner-agent subscriptions.",
      },
    ],
    relatedSlugs: ["raft", "cumora", "linear", "multica"],
  },
  {
    slug: "nowledge-mem",
    name: "Nowledge Mem",
    verifiedDate: "November 22, 2026",
    metaTitle: "Nowledge Mem Alternatives (2026): vs xMatrix",
    metaDescription:
      "Comparing Nowledge Mem alternatives? Go beyond memory fragments from chats: run coding agents across machines and keep living Pages current in xMatrix.",
    eyebrow: "Nowledge Mem Alternative · Nowledge Mem vs xMatrix",
    headline: "Nowledge Mem Alternative: Team Project Memory Written by the Agents Doing the Work",
    lead: "Nowledge Mem builds a clever local graph/vector memory layer across AI tools, but it is a passive memory store—it guesses facts from old chats, cannot run coding agents or govern external tools, and its Team workspace remains in private beta. In xMatrix, the working runs write authoritative living Pages your whole team shares today.",
    productCaption: "Inside xMatrix: instead of passively guessing memories from old chats, the exact coding agents shipping your work keep living project Pages accurate across your team.",
    painPoints: [
      {
        title: "Extracting memory guesses vs. updating authoritative project Pages",
        problem:
          "Nowledge Mem observes chats in the background and infers Trace → Unit → Crystal memory graphs with 30-day decay and contradiction queues. When engineering truth changes in a PR or deploy, probabilistic memory extraction still lags behind the authoritative record.",
        xmatrixAnswer:
          "In xMatrix, the exact agent Run that merged the PR or ran the check rewrites the project's living Page in place—readable by humans and agents alike, with suggestion mode, per-paragraph attribution, and revision history.",
      },
      {
        title: "No agent orchestration, team Channels, or cross-machine execution",
        problem:
          "Nowledge Mem doesn't launch coding agents, doesn't coordinate multiple teammates in shared channels, and doesn't route work across machines—you still have to stitch together separate runners, tunnels, and MCP configs.",
        xmatrixAnswer:
          "xMatrix is the full coordination layer: shared Channels, multi-machine routing across 34 coding harnesses, progressive outline/section Page reading, and living Pages in one product.",
      },
      {
        title: "Private-beta team sync and zero operational governance",
        problem:
          "Nowledge Mem Team is still in private beta, local setups require macOS 15+ plus manual MCP/proxy wiring, and there is no Space secret vault or per-app approval gate for production tools.",
        xmatrixAnswer:
          "xMatrix Spaces are live and self-serve today across macOS, Windows, Linux, Android, and Web (including iPhone & iPad)—with Space-level secrets and per-app policies across 35 connected apps.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Core job",
        xmatrix: "Run multi-agent work in shared Channels and maintain living Pages",
        competitor: "Extract, index, and retrieve cross-tool conversational memories",
      },
      {
        dimension: "Source of truth",
        xmatrix: "Authoritative living Markdown Pages rewritten directly by working Runs",
        competitor: "Inferred graph/vector Crystals with 30-day decay; LLM Wiki is a derived view",
      },
      {
        dimension: "Team availability",
        xmatrix: "Self-serve Free (500 lifetime writes) & Pro team Spaces live today",
        competitor: "Local personal app GA; Cloud public beta; Team workspace private beta",
      },
      {
        dimension: "Agent execution",
        xmatrix: "Launches and routes 34 coding harnesses (+ --runtime) across your machines",
        competitor: "Does not execute or route coding agents",
      },
      {
        dimension: "Secrets & external apps",
        xmatrix: "Space-level secrets + 35 connectors with per-app policies",
        competitor: "Hosted Slack connection in Team; no ops connector approval plane",
      },
    ],
    stayWhen: [
      "You want an offline personal memory graph capturing chats across web ChatGPT, Claude web, and Cursor without changing how you execute code.",
    ],
    switchWhen: [
      "You want the agents doing the work to maintain one authoritative project Page—not a background extractor guessing facts from old transcripts.",
      "You need live team Spaces today (not a private beta) with multi-machine agent execution and 35 governed ops connectors.",
      "You want zero manual local proxy/tunnel plumbing across macOS, Windows, Linux, Android, and Web.",
    ],
    migrationSteps: [
      {
        title: "Promote durable knowledge into living xMatrix Pages",
        detail: "Export key decisions and architecture notes (including OKF/Markdown exports) into xMatrix Pages organized by project.",
      },
      {
        title: "Connect your coding harnesses once",
        detail: "Register Claude Code, Codex, Cursor, or Gemini in xMatrix so every Run reads the exact Page outline/sections it needs and writes updates back.",
      },
      {
        title: "Schedule Page upkeep with Norn routines",
        detail: "Keep metrics, release notes, and open blockers fresh automatically without paying background LLM extraction tokens on idle chat logs.",
      },
    ],
    faqs: [
      {
        question: "How does xMatrix keep agents from reading too much context without a vector database?",
        answer:
          "xMatrix supports progressive reading—agents browse the Space page tree and summaries, inspect a Page's outline and section sizes, read only the needed section, and rewrite that section in place.",
      },
      {
        question: "Can I still use Nowledge Mem alongside xMatrix?",
        answer:
          "Yes, if you want personal cross-browser memory for casual web chats, while keeping shared project truth, agent orchestration, and team approvals inside xMatrix.",
      },
      {
        question: "What happens if an agent writes something wrong to an xMatrix Page?",
        answer:
          "Every Page has full revision history and human-priority co-editing—edit any line yourself and agents immediately pick up the corrected truth.",
      },
    ],
    relatedSlugs: ["everos", "notion", "raft", "lobehub"],
  },
  {
    slug: "everos",
    name: "EverOS",
    alsoKnownAs: "EverMind / EverMemOS",
    verifiedDate: "November 22, 2026",
    metaTitle: "EverOS (EverMemOS) Alternatives (2026): vs xMatrix",
    metaDescription:
      "Looking for EverOS or EverMemOS alternatives? Leave single-machine SQLite locks, hidden extraction LLM bills and no team sync for xMatrix Channels and Pages.",
    eyebrow: "EverOS (EverMemOS) Alternative · EverOS vs xMatrix",
    headline: "EverOS Alternative: Multi-Machine Project Memory Written by the Agents Doing the Work",
    lead: "EverOS (EverMemOS) pairs Markdown files with local SQLite and LanceDB indexes, but its open-source v1 explicitly refuses a second service on the same directory, excludes multi-tenancy and sync, and burns continuous background LLM tokens on extraction. xMatrix gives teams real-time multi-machine execution across 34 harnesses and authoritative living Pages.",
    productCaption: "Inside xMatrix: real-time multi-machine Markdown Pages updated by your working coding agents—with zero single-directory locks or background extraction token drain.",
    painPoints: [
      {
        title: "Single-machine architecture with explicit no-sync, no-multi-tenant v1 boundaries",
        problem:
          "EverOS v1 is built for one local process: starting a second service on the same directory is rejected, multi-tenancy and distributed sync are explicitly out of scope, and sharing local Markdown/SQLite directories across multiple coding tools triggers lock contention.",
        xmatrixAnswer:
          "xMatrix synchronizes Pages and Channels across every teammate and every registered macOS, Windows, and Linux machine in real time—with zero local SQLite lock fights.",
      },
      {
        title: "Continuous background LLM token overhead and local indexing load",
        problem:
          "Running local LanceDB vector indexing alongside continuous LLM calls for episode extraction, conflict resolution, and profile consolidation taxes single-machine RAM and creates ongoing, hard-to-predict API bills—while multi-user EverMemBench accuracy drops to 66.67%.",
        xmatrixAnswer:
          "xMatrix doesn't burn background extraction loops guessing what happened in old transcripts. The agent Run that finished the task updates the relevant Page section directly.",
      },
      {
        title: "Memory storage alone does not execute, route, or govern coding agents",
        problem:
          "EverOS is a memory backend (and dropped Foresight predictions in v1.7.1); it cannot summon coding harnesses across machines or require human approval before touching Vercel, Cloudflare, Gmail, or Stripe.",
        xmatrixAnswer:
          "xMatrix combines multi-agent execution across 34 harnesses, Space secrets, per-app approvals across 35 connectors, and living Pages into one cohesive workspace.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Multi-machine & team sync",
        xmatrix: "Real-time multi-human, multi-machine Spaces across macOS, Windows, Linux, Android, Web",
        competitor: "Open-source v1 is strictly single-machine; multi-tenant and sync out of scope",
      },
      {
        dimension: "How knowledge stays current",
        xmatrix: "Working agent Runs rewrite authoritative Markdown Pages in place",
        competitor: "Background LLM extraction into SQLite + LanceDB indexes (extra token burn)",
      },
      {
        dimension: "Agent execution & routing",
        xmatrix: "Launches and routes 34 coding harnesses (+ --runtime) across your machines",
        competitor: "Memory layer only; does not execute or coordinate agent fleets",
      },
      {
        dimension: "Concurrent editing",
        xmatrix: "Live collaborative Pages with suggestion mode, attribution, and human edit priority",
        competitor: "Local directory locks; concurrent local tool writes cause contention",
      },
      {
        dimension: "Governance & connectors",
        xmatrix: "Space-level secrets + 35 connected apps with per-app policies",
        competitor: "None",
      },
    ],
    stayWhen: [
      "You are researching conversational memory benchmarks (LoCoMo/LongMemEval) or want an Apache-2.0 local memory engine embedded in a single-machine Python/CLI stack.",
    ],
    switchWhen: [
      "You work across multiple machines or with teammates and cannot live inside a single-directory v1 lock boundary.",
      "You want authoritative Markdown Pages maintained by working Runs rather than paying continuous background LLM extraction costs.",
      "You need real agent execution across 34 harnesses and 35 governed connectors in addition to persistent project knowledge.",
    ],
    migrationSteps: [
      {
        title: "Bring your existing Markdown files into xMatrix Pages",
        detail: "Since EverOS keeps Markdown as its authoritative layer, your clean project notes transfer straight into xMatrix Pages.",
      },
      {
        title: "Connect all your machines to one Space",
        detail: "Install the xMatrix CLI on your laptops and servers so every harness shares the same live Pages without local SQLite lock errors.",
      },
      {
        title: "Let working Runs maintain each section",
        detail: "Replace background extraction pipelines with direct section updates whenever an agent merges code or completes research.",
      },
    ],
    faqs: [
      {
        question: "Are xMatrix Pages also plain Markdown like EverOS?",
        answer:
          "Yes. Pages are structured Markdown documents with section-level reads and edits, revision history, and live human-agent co-writing.",
      },
      {
        question: "Does xMatrix charge extra LLM tokens for background memory consolidation?",
        answer:
          "No. Because the working agent updates the Page as part of finishing its task, you avoid running a separate always-on extraction pipeline over every chat log.",
      },
      {
        question: "How does xMatrix perform on multi-user collaboration compared to EverOS?",
        answer:
          "xMatrix was built from day one for multi-human and multi-agent Spaces—with attributed edits, live Channels, and zero single-machine directory locks.",
      },
    ],
    relatedSlugs: ["nowledge-mem", "notion", "lobehub", "raft"],
  },
  {
    slug: "youmind",
    name: "YouMind",
    verifiedDate: "November 22, 2026",
    metaTitle: "YouMind Alternatives (2026): YouMind vs xMatrix",
    metaDescription:
      "Comparing YouMind alternatives? Trade $20–$200/mo solo credit tiers for xMatrix's $10/seat multiplayer coding Channels, local repo runs and living Pages.",
    eyebrow: "YouMind Alternative · YouMind vs xMatrix",
    headline: "The YouMind Alternative Built for Team Coding Agents, Android, and Real Repos",
    lead: "YouMind is a slick solo creation studio for synthesizing videos, podcasts, and web research into slides and articles ($20–$200/month in credits), but it lacks native team collaboration, has no Android app, and only bridges GitHub/Linear context rather than running local coding agents. xMatrix coordinates real code, research, and operations in one multiplayer Space.",
    productCaption: "Inside xMatrix: keep research, specs, and live multi-agent software shipping in one multiplayer Space across desktop, Web, Android, and iOS.",
    painPoints: [
      {
        title: "Individual creative studio—no real-time team Channels or permission governance",
        problem:
          "YouMind is designed around personal research boards rather than multiplayer workspaces. Teams lack shared real-time channels, role-based approval policies, and Space-level secrets for collaborative shipping.",
        xmatrixAnswer:
          "xMatrix brings teammates and agents together in shared public and private Channels, backed by living Pages and per-app Read-only / Ask first / Read & write governance.",
      },
      {
        title: "Not a local coding-agent runner, and steep $40–$200/mo credit tiers",
        problem:
          "YouMind bridges GitHub and Linear for drafting specs, but doesn't orchestrate Claude Code, Codex, or Cursor across your local repos and build machines. Heavy multimodal usage burns through Starter ($20/20k credits) and Pro ($40/40k credits) quickly, pushing desktop agent workflows onto the $100–$200 Max tier.",
        xmatrixAnswer:
          "xMatrix runs your real coding harnesses on your own machines using subscriptions you already pay for—plus research, docs, and ops—for $10/human seat/month on Pro.",
      },
      {
        title: "No Android app and fragmented cross-device engineering workflows",
        problem:
          "YouMind ships iOS and Chrome extensions with no official Android app, leaving Android developers unable to monitor or steer runs away from their desk.",
        xmatrixAnswer:
          "xMatrix runs across macOS, Windows, Linux, Android, and Web (including iPhone & iPad), keeping research, specs, code PRs, and launches on one living Page.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Primary focus",
        xmatrix: "Multiplayer coding, research, and operations coordinated in living Pages",
        competitor: "Individual multimedia research and content-creation boards",
      },
      {
        dimension: "Local code execution",
        xmatrix: "Runs 34 coding harnesses (+ --runtime) directly in your local repositories",
        competitor: "Bridges GitHub/Linear context; desktop agent gated to $100–$200 Max tier",
      },
      {
        dimension: "Pricing",
        xmatrix: "Free (500 lifetime writes) + Pro $10/human seat/mo ($8 annual), BYO subscriptions",
        competitor: "Starter $20 / Pro $40 / Max $100–$200 per month (metered credits)",
      },
      {
        dimension: "Team collaboration",
        xmatrix: "Multi-human + multi-agent Channels, co-edited Pages, Space secrets",
        competitor: "Solo-oriented boards; collaboration relies mostly on exporting assets",
      },
      {
        dimension: "Platform coverage",
        xmatrix: "macOS, Windows, Linux, Android, and Web (including iPhone & iPad)",
        competitor: "Web, iOS, Chrome extension; no official Android app",
      },
    ],
    stayWhen: [
      "Your main goal is solo multimodal content production—turning YouTube videos and podcasts into illustrated articles, slide decks, and video reels.",
    ],
    switchWhen: [
      "You want research and specs to live in the exact same Space where your coding agents implement PRs, run tests, and deploy.",
      "You collaborate with teammates, use Android, or don't want to pay $40–$200/month in creative credits on top of your coding subscriptions.",
    ],
    migrationSteps: [
      {
        title: "Move active research briefs into living xMatrix Pages",
        detail: "Store competitive analysis, launch plans, and architecture notes in Pages that agents can both update and act on.",
      },
      {
        title: "Connect your coding agents and publishing tools",
        detail: "Run Claude Code, Codex, or Gemini on your machines and connect GitHub (Read-only or Read & write) alongside Google Docs, Notion, X, or Search Console with Ask-first approvals.",
      },
      {
        title: "Automate recurring research and reporting",
        detail: "Embed scheduled Norn programs inside your Pages so weekly digests and metrics stay current automatically.",
      },
    ],
    faqs: [
      {
        question: "Can xMatrix handle research, writing, and launches—not just code?",
        answer:
          "Yes. Teams use xMatrix Pages for research, SEO, product launches, hiring, and operations right alongside software engineering—all kept current by agents.",
      },
      {
        question: "Does xMatrix have an Android app?",
        answer:
          "Yes. xMatrix provides an Android app alongside macOS, Windows, Linux, and Web (including iPhone & iPad).",
      },
      {
        question: "Can external agents use xMatrix too?",
        answer:
          "Yes. xMatrix works with 34 built-in coding harnesses (plus any custom CLI via --runtime) and exposes an MCP server for external tools.",
      },
    ],
    relatedSlugs: ["notion", "lobehub", "nowledge-mem", "everos"],
  },
  {
    slug: "jules",
    name: "Google Jules",
    verifiedDate: "November 22, 2026",
    statusNote: "Google Jules entered read-only mode on November 11, 2026 and shuts down completely on December 31, 2026.",
    metaTitle: "Google Jules Alternatives (Dec 2026 Shutdown) — xMatrix",
    metaDescription:
      "Google Jules went read-only Nov 11 and shuts down Dec 31, 2026. Bring Jules memories, schedules and repos to xMatrix; run Antigravity, Claude Code and Codex.",
    eyebrow: "Google Jules Alternative · Dec 31 Shutdown Migration",
    headline: "Move Async GitHub Work Off Google Jules Before Dec 31 — Keep Dispatching From Your Phone",
    lead: "Google Jules stopped running new sessions on November 11, 2026 and turns off completely on December 31, 2026, with no automatic migration of memories, schedules, or tasks. xMatrix lets you import exported context into living Pages and keep dispatching async GitHub PRs from your phone or Web—running Google Antigravity and 34 other harnesses on an always-on computer or your own VPS.",
    productCaption: "Inside xMatrix: keep clearing GitHub issues asynchronously from Web or mobile with Google Antigravity, Claude Code, Codex, and 32 other harnesses running on your own always-on machine or VPS.",
    painPoints: [
      {
        title: "Permanent shutdown on December 31, 2026 with manual-only export",
        problem:
          "Jules entered read-only mode on November 11 and terminates entirely on December 31, 2026. While @google/jules lets you export env vars, memories, scheduled tasks, and session logs, Google provides no automatic migration into Antigravity—leaving teams to rebuild their workflows by hand.",
        xmatrixAnswer:
          "xMatrix imports cleanly into your workflow today: drop exported Jules memories into living Pages, store exported .env secrets in Space Secrets, and recreate recurring jobs as Norn programs inside those Pages.",
      },
      {
        title: "Single-vendor quota anxiety when moving solely to Google Antigravity",
        problem:
          "Developers on Hacker News, Reddit, and Google AI forums voiced frustration over losing Jules' predictable daily async task model and worrying that moving everything into one vendor's unified quota pool will trigger unexpected caps or overages.",
        xmatrixAnswer:
          "xMatrix natively runs Google Antigravity right alongside 34 other coding harnesses (Claude Code, Codex, Cursor, Gemini CLI, etc.)—and can hand work off to another provider when one vendor's quota window fills up.",
      },
      {
        title: "Rebuilding lightweight mobile and async GitHub backlog clearing",
        problem:
          "Early migrants noted that moving off Jules broke their quick mobile-to-PR habit for clearing GitHub issues asynchronously without sitting at a local IDE all day.",
        xmatrixAnswer:
          "Connect one always-on computer or your own Linux VPS, then mention @auto repo:owner/repo from Android or Web (including iPhone & iPad)—or trigger agents automatically from GitHub events—and watch PRs, CI status, and Page updates land asynchronously.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Service status (Nov 2026)",
        xmatrix: "Active, self-serve, source-available (FSL-1.1-ALv2)",
        competitor: "Read-only since Nov 11, 2026; shuts down permanently Dec 31, 2026",
      },
      {
        dimension: "Harness & model choice",
        xmatrix: "Google Antigravity + 34 other coding harnesses (+ --runtime) with quota handoff",
        competitor: "Google-only cloud agent (retiring into Google Antigravity)",
      },
      {
        dimension: "Memories & project docs",
        xmatrix: "Living Markdown Pages shared by humans and every harness",
        competitor: "Exportable via @google/jules CLI before Dec 31; no auto-migration",
      },
      {
        dimension: "Scheduled & event-driven tasks",
        xmatrix: "Norn programs embedded inside Pages (cron + GitHub/connector events)",
        competitor: "Scheduled tasks stopped Nov 11; exportable as local snapshots only",
      },
      {
        dimension: "Where code executes",
        xmatrix: "Your own always-on computer or self-managed Linux VPS (no xMatrix-hosted cloud VMs)",
        competitor: "Google-hosted cloud VMs (shutting down Dec 31)",
      },
    ],
    stayWhen: [
      "There is no option to stay on Jules past December 31, 2026—export your data with npm install -g @google/jules before access ends. Note that xMatrix requires your own always-on computer or VPS rather than hosted cloud VMs.",
    ],
    switchWhen: [
      "You want to keep using Google Antigravity alongside 34 other harnesses without betting everything on one vendor.",
      "You need a durable home for your exported Jules memories, environment secrets, and scheduled GitHub backlog jobs.",
      "You already have a Mac Studio, desktop, or inexpensive Linux VPS and want async phone-to-PR workflows that a cloud beta shutdown can't take away.",
    ],
    migrationSteps: [
      {
        title: "Export your Jules data before December 31, 2026",
        detail: "Run Google's official @google/jules export tool to save your memories, scheduled tasks, setup scripts, and environment variables locally.",
      },
      {
        title: "Load memories into Pages and secrets into Space Secrets",
        detail: "Paste your exported project memories into xMatrix Pages and move exported .env secrets into Space Secrets (never plaintext in chat).",
      },
      {
        title: "Connect your always-on machine or VPS and GitHub",
        detail: "Register an always-on desktop or your own Linux VPS in xMatrix, connect GitHub, and recreate scheduled backlog sweeps as Page Norn programs.",
      },
    ],
    faqs: [
      {
        question: "Can I run Google Antigravity inside xMatrix after migrating from Jules?",
        answer:
          "Yes. xMatrix natively supports Google Antigravity (agy) alongside 34 other harnesses (Claude Code, Codex, Cursor, Gemini, etc.) on your own machines.",
      },
      {
        question: "Does xMatrix provide hosted cloud VMs like Jules did?",
        answer:
          "No—xMatrix requires an always-on computer you control (your desktop, Mac Studio, or your own inexpensive Linux VPS). The trade-off is zero vendor lock-in: your repos and workflows never disappear when a hosted cloud beta sunsets.",
      },
      {
        question: "How do I replace Jules' scheduled tasks in xMatrix?",
        answer:
          "Add a Norn program block directly inside the project Page in xMatrix—it runs on your schedule or on GitHub events and updates that Page with the results.",
      },
    ],
    relatedSlugs: ["conductor", "paradev", "linear", "t3-code"],
  },
];
