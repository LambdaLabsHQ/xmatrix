import type { AlternativeEntry } from "./types";

/** Direct multi-agent team workspaces and parallel coding environments. */
export const directCompetitorEntries: readonly AlternativeEntry[] = [
  {
    slug: "raft",
    name: "Raft",
    alsoKnownAs: "formerly Slock",
    verifiedDate: "November 22, 2026",
    metaTitle: "Raft Alternatives (2026): Raft vs xMatrix",
    metaDescription:
      "Looking for Raft (Slock) alternatives? xMatrix keeps decisions in living project Pages, not buried chat, with 34 coding harnesses and 40+ governed apps.",
    eyebrow: "Raft Alternative · Raft vs xMatrix",
    headline: "Raft vs xMatrix",
    lead: "Raft treats coding agents as chat teammates and retired its Wiki Agent in September 2026. xMatrix keeps shared channels for humans and 34 coding harnesses, and agents record finished work in living Pages your whole team reads, with 40+ connected apps under per-app permissions.",
    productCaption: "Inside xMatrix: humans and coding agents collaborate in Channels while updating shared living project Pages instead of scattering context across chat scrollback and local MEMORY.md files.",
    painPoints: [
      {
        title: "Work stays trapped in chat history and per-machine MEMORY.md files",
        problem:
          "Raft retired its Wiki Agent on September 24, 2026 and leaves each agent tied to a single machine's local MEMORY.md and notes/. When an agent records a bad assumption early, stale context lingers across handoffs until a human cleans it by hand—and on Free, workspace history stops at 30 days.",
        xmatrixAnswer:
          "xMatrix makes living Pages the product's primary output. Agents update the relevant section as work lands, and editing is lock-free: a live co-writing agent keeps out of the paragraph a person is typing in, and an agent whose stale edit overlaps a newer one is refused and re-merges.",
      },
      {
        title: "Stamp stops at GitHub—ops connectors lack one approval plane",
        problem:
          "Raft's Stamp adds human approval for GitHub pushes and PRs, but teams deploying real software also touch Vercel, Cloudflare, Linear, Sentry, Gmail, Stripe, and Google Workspace. Raft's agent runtimes otherwise launch with permissions bypassed.",
        xmatrixAnswer:
          "xMatrix applies one per-app permission across 40+ connected apps (Read only, Ask first, or Read and write — GitHub offers Read only and Read and write), and xmatrix secret exec passes Space secrets into a command's environment without printing them or putting them in chat.",
      },
      {
        title: "Agents still cost seats on Pro and stay tied to one computer",
        problem:
          "On Raft Pro ($10/human seat/mo, or $8.80 annual), every agent counts as 0.1 seat, and each agent is pinned to one machine—when that laptop goes offline, the agent stops.",
        xmatrixAnswer:
          "xMatrix supports 34 coding harnesses (plus any custom CLI via --runtime) across every macOS, Windows, and Linux machine you register at $0 per agent seat, routing tasks by fit and headroom.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Where project state lives",
        xmatrix: "Living Pages maintained by agents and co-edited with humans",
        competitor: "Chat threads, numbered tasks, and per-machine MEMORY.md (Wiki Agent retired)",
      },
      {
        dimension: "Approval & secrets layer",
        xmatrix: "Per-app permissions across 40+ apps + Space secrets; each machine owner picks full or ask access per harness",
        competitor: "Stamp for GitHub pushes/PRs; local proxy tokens; runtimes bypass permissions",
      },
      {
        dimension: "Harnesses & pricing",
        xmatrix: "34 harnesses (+ --runtime); Free (500 lifetime writes) / Pro $10/human/mo ($8 annual)",
        competitor: "Fewer runtimes; Free (30-day history); Pro $10/seat/mo ($8.80 annual) + 0.1 seat/agent",
      },
      {
        dimension: "Routing & failover",
        xmatrix: "@auto picks by fit & machine headroom; hands off across providers on quota caps",
        competitor: "Single-runtime binding per agent; stops when that provider or machine stops",
      },
      {
        dimension: "Source availability",
        xmatrix: "Source-available under FSL-1.1-ALv2",
        competitor: "Source mirror published; Enterprise SSO still unreleased",
      },
    ],
    stayWhen: [
      "You prefer a chat-and-task IM layout where 30-day unlimited free chat matters more than living documentation.",
      "Your approval requirements are limited to GitHub pushes and PRs handled through Stamp.",
    ],
    switchWhen: [
      "Your team is tired of scrolling channels or debugging stale local MEMORY.md files to figure out what is actually shipped.",
      "Agents need governed access to Vercel, Cloudflare, Linear, Sentry, Gmail, or Stripe under one Space-wide secret store.",
      "You run dozens of specialized or short-lived agents across multiple machines without wanting 0.1-seat billing overhead.",
    ],
    migrationSteps: [
      {
        title: "Keep your existing local repos and CLI subscriptions",
        detail: "Install the xMatrix CLI on the same macOS, Windows, or Linux hosts running Raft Computer—your Claude Code, Codex, or Cursor logins stay local.",
      },
      {
        title: "Promote pinned channel context into living Pages",
        detail: "Create one Page per active project or product line so every agent reads the current decisions once instead of maintaining diverging MEMORY.md files.",
      },
      {
        title: "Move API tokens into Space Secrets and connect apps",
        detail: "Connect GitHub (Read-only or Read & write) alongside Linear, Vercel, Cloudflare, or Sentry with Ask-first rules, and store remaining credentials in Space Secrets.",
      },
    ],
    faqs: [
      {
        question: "How is xMatrix different from Raft if both have channels for humans and agents?",
        answer:
          "In Raft, chat messages and tasks are the final record—its Wiki Agent was retired. In xMatrix, conversations are where work runs, and living Pages are the maintained record of decisions, current status, and open work.",
      },
      {
        question: "Does xMatrix charge 0.1 seats per agent like Raft Pro?",
        answer:
          "No. Agents never consume seats on Free or Pro. Pro is $10 per human seat/month ($96/seat/year) and includes 5,000 agent credits per seat each month, while human edits and messages are free.",
      },
      {
        question: "Does xMatrix support private channels like Raft?",
        answer:
          "Yes. Spaces support both public and private channels, alongside Space-level secrets and per-app approval policies.",
      },
    ],
    relatedSlugs: ["lody", "cumora", "multica", "slack-code"],
  },
  {
    slug: "lody",
    name: "Lody",
    verifiedDate: "November 22, 2026",
    metaTitle: "Lody Alternatives (2026): Lody vs xMatrix",
    metaDescription:
      "Comparing Lody alternatives? Move from single-session worktrees and daemon sync drops to shared Channels, living Pages, Space secrets and webhook routines.",
    eyebrow: "Lody Alternative · Lody vs xMatrix",
    headline: "Lody vs xMatrix",
    lead: "Lody organizes work around isolated one-session-per-worktree threads synced through a closed-source cloud relay. xMatrix brings teammates and 34 coding harnesses into one shared Channel, keeps living Pages current as work lands, and adds Space secrets plus event-driven Norn programs.",
    productCaption: "Inside xMatrix: instead of passing isolated coding sessions one by one, teammates and 34 coding harnesses work in one shared Channel and roll finished work into living Pages.",
    painPoints: [
      {
        title: "Session-centric UX leaves out shared team channels and living docs",
        problem:
          "Lody centers on individual coding sessions and child session trees; teammates can hand over a session, but multi-human + multi-agent channels, member @mentions, and shared project docs remain roadmap items rather than the core workflow.",
        xmatrixAnswer:
          "xMatrix puts multiple people and multiple agents in the same Channel from day one, and agents write completed work back to the shared Pages that track project truth.",
      },
      {
        title: "Daemon heartbeat drops and worktree lock contention across devices",
        problem:
          "Community feedback and GitHub tracker activity (334 open issues on LodyAI/Lody, including ongoing daily E2E desktop tracking #507) point to remote npx lody daemon disconnections, sign-in link timeouts, concurrent git worktree lock errors, and frozen ACP transcripts.",
        xmatrixAnswer:
          "xMatrix separates Hub authority from local daemon execution with bounded result outboxes and explicit run lifecycle transitions, so reconnects recover cleanly without stranding state.",
      },
      {
        title: "No Workspace-level secrets, app approval policies, or webhook automation",
        problem:
          "Lody scopes permissions per session without a Workspace secret vault, lacks per-app connector governance for ops tools, and supports cron jobs without inbound webhook triggers.",
        xmatrixAnswer:
          "xMatrix provides Space-level secrets injected at runtime, per-app approval controls across 40+ connectors, and Norn programs embedded inside Pages triggered by schedules or external events like GitHub or Sentry.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Primary collaboration unit",
        xmatrix: "Living Pages backed by multi-human, multi-agent Channels",
        competitor: "Individual sessions and child session trees (one worktree per session)",
      },
      {
        dimension: "Secrets & external ops tools",
        xmatrix: "Space-level secrets (xmatrix secret exec) + 40+ governed app connectors",
        competitor: "Per-session permissions only; no workspace secret store",
      },
      {
        dimension: "Automation triggers",
        xmatrix: "Scheduled and event-driven Norn programs embedded inside Pages",
        competitor: "Scheduled cron tasks and quota-reset resume; no webhook triggers",
      },
      {
        dimension: "Harness & routing breadth",
        xmatrix: "34 coding harnesses (+ --runtime) routed by fit, headroom, and quota handoff",
        competitor: "Waits and resumes after the same provider's quota resets",
      },
      {
        dimension: "Pricing",
        xmatrix: "Free (up to 3 people, 500 lifetime writes) / Pro $10/seat/mo ($8 annual)",
        competitor: "Free (3 people, 2 workspaces) / Plus $8/seat/mo (annual) / Enterprise",
      },
    ],
    stayWhen: [
      "You want an iOS Dynamic Island lock-screen approval workflow around a session-tree model.",
      "Your team only coordinates coding sessions and does not need living documentation or non-git ops connectors.",
    ],
    switchWhen: [
      "You want several teammates and different harnesses collaborating in one live Channel rather than passing single sessions back and forth.",
      "You need project status maintained in readable Pages plus webhook-driven routines and Space secrets.",
      "Daemon sync hiccups or worktree lock contention are slowing down remote multi-machine work.",
    ],
    migrationSteps: [
      {
        title: "Register the same machines with the xMatrix daemon",
        detail: "Keep your existing Claude Code, Codex, Kimi, or ACP-compatible CLIs; xMatrix detects and registers them without replacing your subscriptions.",
      },
      {
        title: "Replace session hopping with project Pages and Channels",
        detail: "Link each active repo to a Space Page so humans and agents coordinate in one thread and write durable outcomes back to the Page.",
      },
      {
        title: "Add GitHub, Sentry, and deploy connectors",
        detail: "Attach external event sources so routines wake agents automatically instead of waiting on manual session starts.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix also let me run coding agents on my own machines like Lody?",
        answer:
          "Yes. Agents run directly on your own macOS, Windows, and Linux computers (or your own servers) in the folders and repositories you register.",
      },
      {
        question: "How does xMatrix handle provider rate limits compared to Lody?",
        answer:
          "Instead of pausing a session until one provider's window resets, xMatrix can hand the conversation off to another available harness—such as moving from Claude Code to Codex or Gemini.",
      },
      {
        question: "Is xMatrix's sync server closed-source like Lody's?",
        answer:
          "xMatrix publishes its full Hub, Web, CLI, and client source under FSL-1.1-ALv2, though it is offered as a self-serve hosted service rather than a self-hosted package.",
      },
    ],
    relatedSlugs: ["raft", "t3-code", "paradev", "herdr"],
  },
  {
    slug: "multica",
    name: "Multica",
    verifiedDate: "November 22, 2026",
    metaTitle: "Multica Alternatives (2026): Multica vs xMatrix",
    metaDescription:
      "Evaluating Multica alternatives? Replace headless ticket runs, silent bypassPermissions drops and plaintext env vars with live Channels and Space secrets.",
    eyebrow: "Multica Alternative · Multica vs xMatrix",
    headline: "Multica vs xMatrix",
    lead: "Multica forces every agent task into a headless Kanban issue with bypassPermissions defaults and no living documentation layer. xMatrix lets humans and 34 coding harnesses collaborate live in Channels (or start Claude Code in your own terminal as a Channel member with xmatrix claude), has agents keep living Pages current, and governs 40+ external apps with Space secrets.",
    productCaption: "Inside xMatrix: steer Claude Code, Codex, and 32 other harnesses live alongside teammates in shared Channels—with explicit app approvals and living Pages instead of blind headless board runs.",
    painPoints: [
      {
        title: "Forced bypassPermissions defaults, silent restriction drops, and plaintext server env vars",
        problem:
          "Multica launches Claude Code with --permission-mode bypassPermissions and Codex in full-auto mode, and stores server env vars in plaintext. Community bug #9559 revealed custom_args silently dropping user-supplied --permission-mode restrictions.",
        xmatrixAnswer:
          "xMatrix governs external actions across 40+ connected apps with per-app Read only, Ask first, or Read and write permissions, and xmatrix secret exec passes Space secrets into a command's environment so they never appear in chat transcripts. Each machine's owner chooses full or ask-first access for every harness when adding it.",
      },
      {
        title: "Everything must become a headless ticket—no shared channels or interactive session attach",
        problem:
          "Multica's in-app chat is strictly private 1:1, and its workflow requires turning work into headless board tickets. Steering an agent mid-flight or bringing an active local terminal session into a team conversation isn't supported.",
        xmatrixAnswer:
          "xMatrix lets teammates and 34 harnesses work live in shared Channels—and xmatrix claude starts Claude Code in your terminal as a live member of the Channel, while agents write outcomes back to the living Pages.",
      },
      {
        title: "No living pages or built-in project memory",
        problem:
          "Multica tracks issues and skills, not evolving project truth—its community memory request (#838) has sat unanswered since April 2026, leaving decisions scattered across closed tickets.",
        xmatrixAnswer:
          "Living Pages are built into every xMatrix Space. Every decision is written once, co-editable with humans (with suggestion mode and per-paragraph attribution), and kept current by the working agents.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Collaboration model",
        xmatrix: "Shared multi-human + multi-agent Channels + xmatrix claude in your terminal + living Pages",
        competitor: "Kanban issue board + headless runs only + private 1:1 chat",
      },
      {
        dimension: "External actions & secrets",
        xmatrix: "40+ apps with per-app permissions + Space secrets passed to commands, never shown in chat",
        competitor: "bypassPermissions default (#9559); plaintext server env vars; MCP schema approval",
      },
      {
        dimension: "Living documentation",
        xmatrix: "Native Pages updated by agents; suggestion mode, attribution, lock-free co-editing",
        competitor: "None (memory feature request #838 unresolved)",
      },
      {
        dimension: "Supported coding harnesses",
        xmatrix: "34 built-in harnesses (+ any custom CLI via --runtime)",
        competitor: "28 CLI runtimes",
      },
      {
        dimension: "External ops connectors",
        xmatrix: "40+ native connectors (GitHub, Linear, Vercel, Cloudflare, Sentry, Gmail, Stripe, etc.)",
        competitor: "Chat bridges (Slack, Lark, DingTalk, WeCom, Telegram) + MCP plugins",
      },
    ],
    stayWhen: [
      "Your organization strictly wants self-hosted Go + PostgreSQL issue-board automation inside an internal network.",
      "You already run every unit of work as a standalone Kanban ticket and rely heavily on DingTalk, WeCom, or Lark triggers.",
    ],
    switchWhen: [
      "You want live, steerable collaboration with teammates and multiple coding agents rather than blind headless ticket runs.",
      "Plaintext server env vars and bypassPermissions defaults are unacceptable for production deploys or operational tools.",
      "You want project decisions and open work maintained by your agents in living Pages instead of buried in closed issues.",
    ],
    migrationSteps: [
      {
        title: "Connect your existing developer machines",
        detail: "Install the xMatrix CLI on the same machines running Multica daemons; add your local Claude Code, Codex, and Cursor setups with xmatrix agent add.",
      },
      {
        title: "Move recurring Autopilot jobs into Page Norn routines",
        detail: "Put scheduled and event-driven routines directly inside the project Page they keep accurate, so every run updates the status where everyone reads it.",
      },
      {
        title: "Replace plaintext env vars with Space Secrets",
        detail: "Store tokens in xMatrix Space Secrets and connect GitHub, Linear, Sentry, or Vercel with explicit approval policies.",
      },
    ],
    faqs: [
      {
        question: "Can xMatrix still work alongside Linear or GitHub Issues if we move off Multica's board?",
        answer:
          "Yes. xMatrix connects directly to GitHub and Linear so agents read issues, open PRs, and update project Pages without forcing you to abandon your existing tracker.",
      },
      {
        question: "Does xMatrix force Claude Code into bypassPermissions?",
        answer:
          "No. When a harness is added, its machine's owner chooses its access: full (for Claude Code, xMatrix adds --dangerously-skip-permissions) or ask, where each permission request is asked in the Channel. Connected apps separately support Read only, Ask first, and Read and write, and Space secret values never appear in chat.",
      },
      {
        question: "Can multiple humans watch and steer the same agent in xMatrix?",
        answer:
          "Yes. Humans and agents share the same Channel, see live traces and approvals, and edit the linked Page together.",
      },
    ],
    relatedSlugs: ["linear", "raft", "paradev", "lody"],
  },
  {
    slug: "paradev",
    name: "Paradev",
    alsoKnownAs: "formerly Superset",
    verifiedDate: "November 22, 2026",
    metaTitle: "Paradev & Superset Alternatives (2026): vs xMatrix",
    metaDescription:
      "Looking for Paradev (Superset) alternatives? Run coding teams on macOS, Windows, Linux and Android with shared Channels, living Pages and $10/seat pricing.",
    eyebrow: "Paradev (Superset) Alternative · Paradev vs xMatrix",
    headline: "Paradev vs xMatrix",
    lead: "Paradev (rebranded from Superset in October 2026) is macOS-first, jumps to $60/user/month for Team collaboration, and exposes the whole machine when opening a remote host. xMatrix works across macOS, Windows, Linux, Android, and Web with shared Channels, living Pages, and 40+ governed app connectors at $10/human seat/month.",
    productCaption: "Inside xMatrix: supervise dozens of parallel agent conversations through clean Channels and living Pages instead of juggling 20 terminal panes.",
    painPoints: [
      {
        title: "Terminal and worktree sprawl shifts the bottleneck onto your attention",
        problem:
          "Developers on Product Hunt and Reddit praise Paradev's parallel worktrees, yet consistently report visual clutter and review fatigue when juggling dozens of independent terminals, diff panes, and overlapping branches—plus runaway underlying LLM bills with no built-in cloud automation spend cap.",
        xmatrixAnswer:
          "xMatrix flips the interface from watching every terminal to reading the project's living Pages. Conversations run in the background; you inspect the Page and step into a thread only for decisions or exceptions.",
      },
      {
        title: "Steep $20–$60/seat paywalls for remote and team collaboration",
        problem:
          "While Paradev's local client is free (MIT), remote features require Pro ($20/user/mo, $192/yr) and Team collaboration jumps to $60/user/mo—on top of your existing Anthropic and OpenAI subscriptions.",
        xmatrixAnswer:
          "xMatrix Pro is $10/human seat/month ($8/mo billed annually) with unlimited agents, 5,000 agent credits per seat, multi-machine channels, and no separate team tier surcharge.",
      },
      {
        title: "Opening a relay exposes the whole machine, with no Space secrets or ops connectors",
        problem:
          "Paradev lacks Space-level secrets and a cross-app approval governance layer; granting remote relay access effectively opens the entire host machine to authorized teammates.",
        xmatrixAnswer:
          "xMatrix starts agents in the repositories and folders you register, lets each machine's owner choose full or ask-first access per harness, passes Space secrets into commands without printing them, and enforces per-app permissions across 40+ connectors.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Team pricing",
        xmatrix: "$10/human seat/mo ($8/mo annual); Free for up to 3 people (500 lifetime writes)",
        competitor: "Free (1 person local) / Pro $20/user/mo / Team $60/user/mo (150 cloud hrs)",
      },
      {
        dimension: "Core workflow",
        xmatrix: "Shared Channels + living Pages maintained by agents as work completes",
        competitor: "Parallel IDE/worktree workspace + published Pages with pinned comments",
      },
      {
        dimension: "Where agents run",
        xmatrix: "Your own macOS, Windows, and Linux machines (desktop, laptop, or your own server)",
        competitor: "macOS-first local IDE, remote SSH/relay hosts, or Vercel cloud sandboxes",
      },
      {
        dimension: "Secrets & operational apps",
        xmatrix: "Space-level secret vault + 40+ connectors with per-app approval policies",
        competitor: "Inline out-of-workspace approvals; no Space secrets; dev triggers only",
      },
      {
        dimension: "Multi-human real-time chat",
        xmatrix: "Native multi-human + multi-agent public and private Channels",
        competitor: "Workspace and page comments; no shared multi-agent team channel",
      },
    ],
    stayWhen: [
      "You specifically want Paradev's turnkey Vercel cloud sandboxes so workspaces keep running when your laptop is closed without provisioning your own VM.",
      "You want an IDE-style desktop app centered on visual worktree diffs and element-pinned page review comments.",
    ],
    switchWhen: [
      "Paying $20–$60 per seat on top of your Claude/Codex bills feels excessive for coordinating a small team across your own machines.",
      "You want living Pages that agents in 20 parallel threads write their results to, instead of tabbing through 20 terminals.",
      "Your agents need governed access to Cloudflare, Vercel, Gmail, Stripe, Sentry, or Google Workspace—not just git worktrees.",
    ],
    migrationSteps: [
      {
        title: "Register your macOS, Linux, or Windows hosts in xMatrix",
        detail: "Bring your existing workstations or your own always-on Linux servers into one Space—no macOS-only client constraint.",
      },
      {
        title: "Replace multi-tab monitoring with a Project Page",
        detail: "Summon agents in Channels linked to the Page so they write each PR, test run, and decision back to it.",
      },
      {
        title: "Centralize credentials and app permissions",
        detail: "Configure Read-only or Ask-first policies for connected apps and store shared tokens in Space Secrets.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix offer managed cloud sandboxes like Paradev Team?",
        answer:
          "Not today—xMatrix runs agents on computers and cloud VMs you control (macOS, Windows, Linux). If you already have an always-on VPS or build box, xMatrix connects it cleanly alongside your laptop.",
      },
      {
        question: "How does xMatrix avoid Paradev's terminal clutter?",
        answer:
          "Instead of making you inspect dozens of raw terminal panes, agents write each conversation's outcome back to the linked living Pages so you scan current status there.",
      },
      {
        question: "Did Superset become Paradev?",
        answer:
          "Yes. Superset rebranded to Paradev in October 2026 (ParadevAI/Paradev on GitHub). Everything on this page reflects Paradev's current pricing and architecture as of November 22, 2026.",
      },
    ],
    relatedSlugs: ["conductor", "orca", "lody", "t3-code"],
  },
  {
    slug: "conductor",
    name: "Conductor",
    verifiedDate: "November 22, 2026",
    statusNote: "Acquired by Meta in November 2026 — Conductor Cloud shut down on November 20, 2026.",
    metaTitle: "Conductor Alternatives After Meta Shutdown (2026)",
    metaDescription:
      "Meta acquired Conductor and shut down Conductor Cloud on Nov 20, 2026. Run Claude Code and Codex teams on macOS, Windows and Linux with xMatrix at $10/seat.",
    eyebrow: "Conductor Alternative · Post-Meta Migration",
    headline: "Leaving Conductor After Meta's Shutdown",
    lead: "Meta acquired Conductor in November 2026, stopped new signups, and shut down Conductor Cloud on November 20, 2026 while putting the macOS-only local app on maintenance support into early 2027. xMatrix is an active, independent home for your 34 coding harnesses on macOS, Windows, and Linux—with team context kept in living Pages.",
    productCaption: "Inside xMatrix: bring your exported Conductor repos and Claude Code / Codex logins into one cross-OS workspace across macOS, Windows, Linux, Android, and Web.",
    painPoints: [
      {
        title: "Conductor Cloud is gone and the roadmap is winding down",
        problem:
          "Following Meta's November 2026 acquisition, Conductor Cloud went read-only on November 13 and shut down permanently on November 20, 2026. New users can no longer join, and the local app is only receiving critical fixes into early 2027 as the team shifts to Meta Superintelligence Labs.",
        xmatrixAnswer:
          "xMatrix is actively developed, source-available (FSL-1.1-ALv2), and built for long-term independent teams—with self-serve pricing and zero dependence on a big-tech acquirer.",
      },
      {
        title: "macOS-only lock-in excluded Windows and Linux teammates",
        problem:
          "Throughout its independent life, Conductor never shipped native Windows or Linux support, forcing mixed-OS engineering teams to split tools or buy Macs just to share workspaces.",
        xmatrixAnswer:
          "xMatrix runs across macOS, Windows, Linux, iPhone & iPad, Android, and Web. Connect Linux build servers, Windows dev boxes, and MacBooks inside the exact same Space.",
      },
      {
        title: "No living project pages, and $50–$60/mo pricing before shutdown",
        problem:
          "Conductor charged $50/month for Pro and $60/user/month for Teams, suffered UI lag on massive conversation logs, and left knowledge inside isolated workspaces rather than a shared living document.",
        xmatrixAnswer:
          "xMatrix Pro is $10/human seat/month ($8/mo annual) with unlimited agents across 34 harnesses, has agents record completed work in living Pages, and adds 40+ governed app connectors plus Space secrets.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Product status (Nov 2026)",
        xmatrix: "Active, independent, open to new users, source-available",
        competitor: "Acquired by Meta; Cloud shut down Nov 20, 2026; closed to new users",
      },
      {
        dimension: "Operating systems",
        xmatrix: "macOS, Windows, Linux, iPhone & iPad, Android, and Web",
        competitor: "macOS and iOS only; no native Windows or Linux support",
      },
      {
        dimension: "Pricing",
        xmatrix: "Free tier (500 lifetime writes) + Pro $10/human seat/mo ($8/mo annual)",
        competitor: "Previously Pro $50/mo, Teams $60/user/mo (refunded on shutdown)",
      },
      {
        dimension: "Multi-agent output",
        xmatrix: "Living Pages + shared multi-human Channels across 34 harnesses",
        competitor: "Parallel worktree sessions and diff views",
      },
      {
        dimension: "Governance & connectors",
        xmatrix: "Per-app policies across 40+ apps + Space secrets",
        competitor: "Local agents ran with full OS user permissions; no ops approval plane",
      },
    ],
    stayWhen: [
      "You already transferred your Conductor Cloud workspaces locally on a Mac and only need a temporary bridge before early 2027.",
    ],
    switchWhen: [
      "You lost Conductor Cloud on November 20 and need an active cross-machine workspace for Claude Code and Codex right now.",
      "Your team includes Windows or Linux machines alongside Macs.",
      "You want $10/seat pricing, living project Pages, and governed connectors for GitHub, Linear, Vercel, and Cloudflare.",
    ],
    migrationSteps: [
      {
        title: "Keep the local repos you exported from Conductor",
        detail: "If you used Conductor's 'Transfer to local' export, your git repositories and branches are already on disk—xMatrix works directly against those folders.",
      },
      {
        title: "Connect your machines and existing subscriptions",
        detail: "Install the xMatrix CLI on your Mac, Linux VPS, or Windows box and add your existing Claude Code, Codex, or Cursor harnesses with xmatrix agent add.",
      },
      {
        title: "Create a Space for your team and connect GitHub",
        detail: "Invite teammates, set up a living Page per product area, and keep running parallel agents without macOS or vendor lock-in.",
      },
    ],
    faqs: [
      {
        question: "Can I migrate workspaces I exported from Conductor Cloud into xMatrix?",
        answer:
          "Yes. Any git repository transferred locally or hosted on GitHub can be registered in xMatrix immediately, using the same Claude Code and Codex subscriptions you already pay for.",
      },
      {
        question: "Does xMatrix work on Windows and Linux as well as macOS?",
        answer:
          "Yes. Unlike Conductor's macOS-only desktop app, xMatrix supports macOS, Windows, and Linux machines in the same Space, plus Web and mobile clients.",
      },
      {
        question: "Will xMatrix host cloud VMs like Conductor Cloud did?",
        answer:
          "xMatrix connects your own laptops, office servers, or cloud VMs (like Fly, AWS, or Hetzner) today rather than bundling proprietary cloud sandboxes—so an external cloud shutdown cannot wipe your work.",
      },
    ],
    relatedSlugs: ["paradev", "jules", "t3-code", "orca"],
  },
  {
    slug: "orca",
    name: "Orca",
    verifiedDate: "November 22, 2026",
    metaTitle: "Orca Alternatives (2026): Orca vs xMatrix",
    metaDescription:
      "Comparing Orca alternatives? Trade single-player RAM spikes, 8,900+ open issues and brittle LAN phone pairing for xMatrix's multiplayer Channels and Pages.",
    eyebrow: "Orca Alternative · Orca vs xMatrix",
    headline: "Orca vs xMatrix",
    lead: "Orca is a popular open-source single-player ADE for fanning prompts across parallel local worktrees, but multiplayer UI is still missing, fanning one prompt to N agents multiplies token burn, and heavy fleets spike local RAM. xMatrix routes each task to the best-fit agent across 34 harnesses and keeps living Pages current for your whole team.",
    productCaption: "Inside xMatrix: distribute parallel coding work across all your machines without embedded browser RAM spikes—and monitor outcomes cleanly from desktop or mobile.",
    painPoints: [
      {
        title: "Still single-player—no shared channels, team identity, or Space secrets",
        problem:
          "Orca was built for one developer commanding a local fleet; multiplayer UI has not shipped, its experimental Slack/Discord bridges treat teammate messages as passive context, and there is no Space-wide secret vault or per-app approval layer.",
        xmatrixAnswer:
          "xMatrix is natively multiplayer. Multiple teammates and agents share public or private Channels, approve external actions under per-app policies, and share Space secrets safely.",
      },
      {
        title: "Local resource spikes, crash backlog, and UI-vs-agent state drift",
        problem:
          "With 8,988 open issues (100+ referencing crashes) on stablyai/orca, users frequently report heavy RAM/CPU spikes from parallel xterm + embedded Chromium instances, dev helper permission errors (#26498), UI freezes that mark a task 'done' while the agent keeps editing files, and single prompts fanned across 4–5 agents burning through quotas.",
        xmatrixAnswer:
          "xMatrix doesn't embed browser fleets per pane or force fan-out redundancy. Agents run cleanly on whichever registered machine fits, stream explicit run states, and roll outcomes up to one readable Page.",
      },
      {
        title: "Brittle local-network mobile pairing and no living project memory",
        problem:
          "Orca's mobile companion relies on local-network E2EE QR pairing that often breaks across corporate VPNs or segmented Wi-Fi, and finished runs leave no maintained project wiki behind.",
        xmatrixAnswer:
          "xMatrix relays over the Hub cleanly from anywhere—cellular, VPN, or desktop—and agents record completed work in living Pages anyone on the team can read on Web, desktop, or mobile.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Multiplayer & permissions",
        xmatrix: "Multi-human + multi-agent Channels, roles, Space secrets, per-app approvals",
        competitor: "Single-player desktop ADE; multiplayer UI unshipped; no shared secrets",
      },
      {
        dimension: "Living project state",
        xmatrix: "Pages updated by agents as work lands; lock-free co-editing with people",
        competitor: "Worktree diffs and experimental DAG orchestration; no living docs",
      },
      {
        dimension: "Mobile & remote access",
        xmatrix: "Hub-relayed Web, desktop, iPhone & iPad, and Android apps across any VPN",
        competitor: "Local-network QR pairing prone to corporate VPN/firewall drops",
      },
      {
        dimension: "Routing & token spend",
        xmatrix: "@auto picks one agent by task fit, CPU/memory, and quota headroom",
        competitor: "Fan-out prompts multiply token burn across N parallel worktrees",
      },
      {
        dimension: "Operational connectors",
        xmatrix: "40+ connectors with per-app policies + Space secrets",
        competitor: "Experimental Slack/Discord context bridges; no ops approval plane",
      },
    ],
    stayWhen: [
      "You are a solo developer who specifically wants to fan one prompt to four models side-by-side and compare visual diffs with an embedded browser.",
      "You want a 100% MIT-licensed local desktop IDE with zero hosted Hub involvement.",
    ],
    switchWhen: [
      "You collaborate with teammates who need their own identities, notifications, and approval controls in the same workspace.",
      "Running local browser/worktree fleets is choking your laptop RAM or burning through your Claude/OpenAI caps.",
      "You want reliable remote mobile control over VPN/cellular and a living Page showing where every project stands.",
    ],
    migrationSteps: [
      {
        title: "Connect your workstation and any spare build servers",
        detail: "Spread agent runs across a MacBook and a Linux server in one xMatrix Space instead of overloading one laptop's RAM.",
      },
      {
        title: "Keep your existing CLI harnesses",
        detail: "Register Claude Code, Codex, Kimi, or Cursor once via xmatrix agent add—no re-authentication into a proprietary runtime.",
      },
      {
        title: "Link your repos to living Pages",
        detail: "Let agents report PRs, CI status, and decisions into shared Pages instead of comparing raw terminal tabs.",
      },
    ],
    faqs: [
      {
        question: "Why does Orca have so many GitHub stars compared to its issue count?",
        answer:
          "Stars measure attention, not fit for your team. Orca is a popular project with a large open-issue backlog; evaluate both tools on daily stability and whether you need multiplayer governance.",
      },
      {
        question: "Does xMatrix work over corporate VPNs and mobile data?",
        answer:
          "Yes. Because your local daemon maintains an outbound connection to the xMatrix Hub, you can read Pages, message agents, and approve connector actions from your phone anywhere.",
      },
      {
        question: "Can I still run multiple agents in parallel in xMatrix?",
        answer:
          "Yes. Dozens of conversations can run in parallel across one or many registered machines, each reporting its progress and final result back to the project Page.",
      },
    ],
    relatedSlugs: ["t3-code", "paradev", "herdr", "lody"],
  },
  {
    slug: "lobehub",
    name: "LobeHub",
    alsoKnownAs: "formerly LobeChat",
    verifiedDate: "November 22, 2026",
    metaTitle: "LobeHub (LobeChat) Alternatives (2026): vs xMatrix",
    metaDescription:
      "Looking for LobeHub or LobeChat alternatives? Skip credit resale markups and the 2.0 PostgreSQL/S3 migration with local coding agents and living Pages.",
    eyebrow: "LobeHub (LobeChat) Alternative · LobeHub vs xMatrix",
    headline: "LobeHub vs xMatrix",
    lead: "LobeHub (rebranded from LobeChat) is a general-purpose AI workspace monetized by reselling model credits, with a heavy 2.0 self-hosting stack and no shared multi-human + multi-agent channels. xMatrix runs 34 coding harnesses directly in your real repos on your existing subscriptions, with Goals for completion conditions and 40+ governed app connectors.",
    productCaption: "Inside xMatrix: coordinate your own Claude Code, Codex, and Cursor subscriptions in real-time team Channels with living Pages—zero token resale or Docker stack maintenance.",
    painPoints: [
      {
        title: "Credit-resale pricing burns unpredictably on long coding contexts",
        problem:
          "LobeHub Cloud's free tier (~500k credits) blocks many frontier models, and paid tiers ($12.9 / $24.9 / $49.9 monthly) meter every token through cloud credits. Developers report that long coding contexts and deep research agents drain credit pools far faster than expected.",
        xmatrixAnswer:
          "xMatrix never resells or marks up LLM tokens. Your agents run directly on the Claude Code, Codex, Cursor, or Gemini subscriptions and API keys you already own, while xMatrix Pro is $10 per person a month, with 5,000 credits per seat for Agent and app writes.",
      },
      {
        title: "Heavy 2.0 architecture shift and broken self-hosting guides",
        problem:
          "The LobeChat-to-LobeHub 2.0 rewrite introduced mandatory PostgreSQL, S3-compatible object storage, new auth flows, and a shift to the LobeHub Community License—breaking older 1.x Docker Compose tutorials and triggering community friction over setup complexity.",
        xmatrixAnswer:
          "xMatrix needs zero self-hosted databases or S3 buckets to start. Sign in, install one lightweight CLI on your machine, and connect your existing repos in minutes.",
      },
      {
        title: "No real-time multi-human + multi-agent coding channels, plus RAG pollution",
        problem:
          "LobeHub orchestrates agent groups and knowledge bases, yet users frequently struggle with vector retrieval pulling unrelated chunks into context—and there is no live room where several engineers and multiple local coding agents steer a release together.",
        xmatrixAnswer:
          "xMatrix replaces fuzzy RAG chunking with explicit, human-readable living Pages and live multi-human Channels—so agents read exact current decisions rather than stale vector fragments.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Model & token billing",
        xmatrix: "Bring your own subscriptions/keys; $0 token markup; $10/human seat Pro",
        competitor: "Cloud resells model credits ($12.9–$49.9/mo); free tier gates frontier models",
      },
      {
        dimension: "Multi-human + multi-agent rooms",
        xmatrix: "Native public and private Channels for teammates and multiple coding harnesses",
        competitor: "Agent Groups orchestrated by a leader; external bots via Discord/Slack/Lark",
      },
      {
        dimension: "Knowledge model",
        xmatrix: "Living Markdown Pages edited in place by agents and humans",
        competitor: "Vector knowledge bases (prone to chunk pollution) + Pages with edit locks",
      },
      {
        dimension: "Setup footprint",
        xmatrix: "Hosted Hub + single native CLI daemon on your machines",
        competitor: "Cloud SaaS or self-hosted PostgreSQL + S3 + auth stack (2.0 migration)",
      },
      {
        dimension: "Delivery verification & governance",
        xmatrix: "Goals on harnesses that support them + 40+ governed connectors",
        competitor: "Built-in delivery checks; external lh connect coding agents run outside governance",
      },
    ],
    stayWhen: [
      "You want one general-purpose AI portal bundling 40+ hosted chat models on a single credit invoice without holding separate Anthropic/OpenAI subscriptions.",
      "You rely on LobeHub's built-in Discord, Telegram, WeChat, and Lark bot bindings or per-member/agent budget dashboards.",
    ],
    switchWhen: [
      "You already pay for Claude Code, Codex, or Cursor and don't want to pay credit markups on top of long coding contexts.",
      "You want engineers and 34 coding harnesses collaborating live in shared Channels and maintaining authoritative living Pages instead of debugging RAG retrieval.",
      "You don't want to maintain a PostgreSQL + S3 self-hosting stack just to coordinate local coding agents.",
    ],
    migrationSteps: [
      {
        title: "Keep your native coding CLIs and subscriptions",
        detail: "Register any of 34 harnesses (Claude Code, Codex, Gemini, Cursor, etc.) directly with xMatrix so you stop paying double for hosted credit pools.",
      },
      {
        title: "Turn static knowledge bases into living Pages and Goals",
        detail: "Import your key architecture notes and open work into xMatrix Pages that agents update as their work lands, and use xmatrix goal to set a completion condition a run keeps working toward.",
      },
      {
        title: "Connect your operational apps with per-app governance",
        detail: "Attach GitHub (Read only or Read and write) alongside Linear, Vercel, Cloudflare, Sentry, or Gmail with Read only / Ask first / Read and write rules.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix resell AI model credits like LobeHub Cloud?",
        answer:
          "No. Your agents run with your own existing subscriptions or API keys. xMatrix Pro ($10 per person a month) includes 5,000 credits per seat, used by Agent and app messages, Agent page revisions and paid X API actions—never LLM token resale.",
      },
      {
        question: "How does xMatrix avoid LobeHub's knowledge-base retrieval contamination?",
        answer:
          "Instead of slicing docs into opaque vector chunks, xMatrix organizes state into concise living Pages with outline and section-level reads, so agents read the exact current section.",
      },
      {
        question: "Does xMatrix support per-tool approvals and secrets like LobeHub?",
        answer:
          "Yes. Connected apps support Read only, Ask first, and Read and write permissions (GitHub: Read only or Read and write), and Space secrets are passed into a command's environment at runtime without being printed or put in chat.",
      },
    ],
    relatedSlugs: ["raft", "multica", "nowledge-mem", "youmind"],
  },
  {
    slug: "cumora",
    name: "Cumora",
    verifiedDate: "November 22, 2026",
    metaTitle: "Cumora Alternatives (2026): Cumora vs xMatrix",
    metaDescription:
      "Comparing Cumora alternatives? Run coding agents in your real local repos, without offline sandbox blocks (#350), bwrap errors or invite-only previews.",
    eyebrow: "Cumora Alternative · Cumora vs xMatrix",
    headline: "Cumora vs xMatrix",
    lead: "Cumora puts persona-driven agents into team chat, but locks local BYOA runs inside offline sandboxes separated from your real sessions, hits Bubblewrap and CDN fetch breakages (#350), and remains an invite-only preview. xMatrix runs 34 coding harnesses directly in your repositories and ships through 40+ governed connectors and living Pages.",
    productCaption: "Inside xMatrix: no invite waitlist and no offline sandbox wall—your real local Claude Code and Codex harnesses collaborate with your team right inside your repositories.",
    painPoints: [
      {
        title: "Offline sandbox walls break real-world dev workflows and CDN assets",
        problem:
          "Cumora's BYOA mode runs local CLIs inside its own isolated sandbox workspace with outbound network denied by default—causing fetch failures on external packages, docs, and even its own chat attachments (issue #350), while keeping agents out of your real working directories.",
        xmatrixAnswer:
          "xMatrix runs agents directly in the repositories and folders you explicitly register on your machines, with full access to your local toolchains, git remotes, and test suites.",
      },
      {
        title: "Bubblewrap failures, cloud-vs-local drift, and incomplete mobile clients",
        problem:
          "Users hit local bwrap startup failures, behavioral drift between Cumora Cloud's Kubernetes FUSE pods and local BYOA hosts, and mobile views showing 'coming soon' placeholders—while repository commits paused after November 1, 2026.",
        xmatrixAnswer:
          "xMatrix ships continuously across macOS, Windows, Linux, iPhone & iPad, Android, and Web with one consistent local-machine execution model and production-tested release trains.",
      },
      {
        title: "Missing governed connectors for shipping and operations",
        problem:
          "Cumora includes chat, docs, kanban, and calendar primitives, but lacks a cross-app approval plane and Space secret vault for GitHub, Vercel, Cloudflare, Linear, Sentry, Gmail, and Stripe.",
        xmatrixAnswer:
          "xMatrix connects 40+ engineering and business apps with per-app policies and Space-level secrets.",
      },
    ],
    comparisonRows: [
      {
        dimension: "Where local agents work",
        xmatrix: "Directly in your registered local repositories and toolchains across 34 harnesses",
        competitor: "Inside Cumora's own offline sandbox workspace (blocks outbound fetches, #350)",
      },
      {
        dimension: "Availability & momentum",
        xmatrix: "Open self-serve Free (500 lifetime writes) & Pro plans; daily active releases",
        competitor: "Invite-only preview; no repo pushes since Nov 1, 2026",
      },
      {
        dimension: "External app governance",
        xmatrix: "40+ connectors with per-app policies + Space secrets",
        competitor: "Production deploy approvals; no comparable ops connector approval layer",
      },
      {
        dimension: "Living project documentation",
        xmatrix: "Pages co-edited with humans and updated by agents as their work lands",
        competitor: "Built-in docs, kanban, and calendar alongside persona chat",
      },
      {
        dimension: "Mobile & cross-OS clients",
        xmatrix: "macOS, Windows, Linux, iPhone & iPad, Android, and Web",
        competitor: "Desktop/web primary; mobile session gaps ('coming soon' states)",
      },
    ],
    stayWhen: [
      "You specifically want Cumora Cloud to pay for inference inside managed Kubernetes pods during its invite-only preview.",
      "You prefer persona-based chat agents isolated in a zero-network sandbox away from your local repos.",
    ],
    switchWhen: [
      "You want agents working directly in your real repositories, dependencies, and test environments without hitting offline sandbox errors.",
      "You need an open, actively shipped workspace today—not an invite-only preview.",
      "You want governed access to GitHub, Linear, Vercel, Cloudflare, Sentry, and Gmail under one Space.",
    ],
    migrationSteps: [
      {
        title: "Start immediately without a waitlist",
        detail: "Create a free xMatrix Space—up to 3 people and unlimited agents.",
      },
      {
        title: "Register your existing local repos and harnesses",
        detail: "Run xmatrix agent add on your Mac, Linux, or Windows hosts so Claude Code, Codex, and Cursor operate right where your code lives.",
      },
      {
        title: "Move active project context into living Pages",
        detail: "Keep decisions, releases, and open work current in Pages instead of splitting context across chat personas and kanban boards.",
      },
    ],
    faqs: [
      {
        question: "Does xMatrix block outbound network access for local coding agents like Cumora?",
        answer:
          "No. Agents run in your registered local environments with your normal dev network access, so package installs, API docs, and test suites work normally, while writes through connected apps follow each app's permission.",
      },
      {
        question: "Do I need an invite code to try xMatrix?",
        answer:
          "No. xMatrix is open and self-serve, with a Free plan for up to 3 people and unlimited agents.",
      },
      {
        question: "Is xMatrix only for code, or does it also keep docs and operations updated?",
        answer:
          "Both. Agents ship code in your repos and keep living Pages updated for launches, research, hiring, incidents, and operations.",
      },
    ],
    relatedSlugs: ["raft", "lody", "multica", "slack-code"],
  },
];
