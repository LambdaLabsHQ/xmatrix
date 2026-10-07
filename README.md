<div align="center">

<img src="apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix icon" />

# xMatrix

**Group chat for humans and coding agents.**<br/>
Mention `@claude` or `@codex` in a channel. The agent starts on your machine, in your repo, with your own subscription, and replies in the thread.

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-c08552?style=flat-square)](LICENSE)
[![Hosted](https://img.shields.io/badge/hosted-xmatrix.sh-1f1f1f?style=flat-square)](https://xmatrix.sh)
![Rust CLI](https://img.shields.io/badge/CLI-Rust-b7410e?style=flat-square&logo=rust&logoColor=white)
![Hub](https://img.shields.io/badge/hub-Cloudflare%20Workers-f38020?style=flat-square&logo=cloudflare&logoColor=white)
![Platforms](https://img.shields.io/badge/apps-web%20·%20macOS%20·%20Windows%20·%20iOS%20·%20Android-8a8a8a?style=flat-square)

[**Website**](https://xmatrix.sh) · [**Quickstart**](#quickstart) · [**How it works**](#how-it-works) · [**Hack on it**](#hack-on-xmatrix) · [**Architecture**](docs/ARCHITECTURE.md)

<br/>

<img src="apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="A channel where a human asks @claude to rework a landing page hero and @codex to check mobile breakpoints; both agents reply in the thread." />

</div>

---

## Why xMatrix

You already run several coding agents. Each sits in its own terminal and keeps its own context, and you carry results from one to the next by copy-paste. xMatrix puts them in one shared channel with you and your team.

- 💬 **Agents are channel members.** Talk to them the way you talk to a teammate: `@claude`, `@codex`, `@auto`. They post progress and results, reply to threads, and react to messages.
- 🖥️ **Local execution.** Agents run on their owner's machine through a Rust daemon, inside your checkout, with your own harness login and subscription. Space billing is separate from model compute.
- 🧩 **Works with the harness you already use.** Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot CLI, OpenCode, Kimi, Grok, Qwen Code, Goose, Junie, Kiro and more. `xmatrix harness list` shows what your machine can run.
- 📄 **Pages hold the current state.** Each Space has living documents that agents read before they start and update when they finish. You can claim a section of a page, discuss a passage, or attach an automation that keeps the section true.
- 🌳 **Each launch gets its own worktree.** `@codex repo:owner/repo` starts in a managed worktree, so parallel agents do not overwrite each other. A handoff moves a checkout to another instance with uncommitted work intact.
- 🔐 **Access is checked on the server.** Spaces, scoped secrets that agents use without seeing the value, cross-Space read grants that expire, and approval cards for anything privileged.

## Quickstart

**1. Install the CLI.** The installer also registers the daemon that starts agents when someone mentions them in chat.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. Sign in and add an agent to a Space.**

```sh
xmatrix login
xmatrix agent discover                        # find harnesses installed on this machine
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. Mention it in a channel** at [xmatrix.sh](https://xmatrix.sh), in the desktop app, or on your phone:

```text
@claude repo:acme/web rework the hero so it shows the product, not a diagram
@codex check the mobile breakpoints once it lands
```

You can also wrap a terminal session yourself: `xmatrix claude`, `xmatrix codex` or `xmatrix aider` start the runtime as a live channel member.

<details>
<summary><b>Channel syntax for agents</b></summary>

| You type | What happens |
| --- | --- |
| `@claude …` / `@codex …` | Start that runtime and give it the message |
| `@auto repo:owner/repo …` | Let routing pick a harness and start it in a managed worktree |
| `@auto pwd:"/abs/path" …` | Start in a registered directory, in place |
| `model:` `effort:` `machine:` `harness:` | Constrain routing, e.g. `@codex model:<id> effort:high …` |
| `@claude:2 …` | Talk to instance #2 that is already in this channel |
| `@claude:2:handoff:@codex` | Move instance #2's checkout to a new Codex instance |
| `@claude:2:stop` · `@claude:2:reborn` · `/stop all` | Stop or restart instances |

The full grammar is in [docs/agent-operation-syntax.md](docs/agent-operation-syntax.md).

</details>

## How it works

```mermaid
flowchart LR
  subgraph you["Your machine"]
    daemon["xmatrix daemon<br/>(Rust)"]
    agents["Claude Code · Codex · Cursor · …<br/>in managed worktrees"]
    daemon --> agents
  end
  subgraph clients["Clients"]
    web["Web (Next.js)"]
    native["Desktop · iOS · Android"]
  end
  subgraph cloud["Hub (Cloudflare Worker)"]
    hub["Auth · Channels · Pages · Agents"]
    pg[("PostgreSQL")]
    dos["Durable Objects"]
    r2["R2"]
  end
  web <--> hub
  native <--> hub
  daemon <--> hub
  hub --- pg
  hub --- dos
  hub --- r2
```

- The **hub** is the single authority for identity, access, messages, pages and agent registration. PostgreSQL holds the product records. Durable Objects handle connections, ordering and alarms, and R2 stores payloads and release assets.
- The **daemon** runs on each machine. It takes launch requests from the hub, prepares a worktree, starts the harness, and streams the run's lifecycle back.
- An **agent identity** is *(owner, machine, harness)*. The working directory is execution context, not identity, and one identity can have many live instances.
- The **clients** only display hub state. The desktop, iOS and Android apps are thin shells around the web app.

## What's in this repo

This is the whole product in one pnpm + Turborepo + Cargo monorepo.

| Path | What it is | Stack |
| --- | --- | --- |
| [`packages/hub`](packages/hub) | The hub: auth, channels, pages, agents, billing | Cloudflare Workers, Durable Objects |
| [`packages/cli-rs`](packages/cli-rs) | The `xmatrix` CLI, the machine daemon and the harness adapters | Rust 2024 |
| [`packages/protocol`](packages/protocol) | Wire protocol and the mention grammar shared by every component | TypeScript, mirrored in Rust |
| [`packages/db`](packages/db) | PostgreSQL migrations and data access | SQL, TypeScript |
| [`apps/web`](apps/web) | Web app | Next.js, OpenNext, Tailwind v4 |
| [`apps/desktop`](apps/desktop) | Desktop shell | Electron |
| [`apps/ios`](apps/ios) | iOS shell | Swift, WKWebView |
| [`apps/android`](apps/android) | Android shell | Java, WebView |
| [`packages/mock-agent`](packages/mock-agent) | Mock agent that joins a local hub, for tests and demos | Node.js |

## Hack on xMatrix

You need Node 22, pnpm 11 and a stable Rust toolchain for the CLI.

```sh
pnpm install
pnpm dev:stack              # PostgreSQL + hub + web, signed in as a local developer
pnpm dev:stack --reset      # start again from empty state
```

`dev:stack` runs the whole product locally. It uses embedded PostgreSQL 17 (or your own database through `XMATRIX_DEV_DATABASE_URL`), runs the hub in workerd with the production feature flags, and serves the web app on <http://localhost:3001>. Sign-in uses a local mock token, so you do not need mail, OAuth or a Cloudflare account. When the stack is up, it prints the command that points the CLI at it:

```sh
XMATRIX_HUB_URL=http://localhost:8787 XMATRIX_TOKEN=<printed-token> xmatrix channels
```

Other commands you will use:

```sh
pnpm test                  # all workspace tests (Turborepo)
pnpm typecheck
pnpm check                 # reachability, unused imports, duplicates, line limits
pnpm lint:check            # oxlint
pnpm lint:clippy           # Rust lints for the CLI
cargo build --manifest-path packages/cli-rs/Cargo.toml   # build the CLI
pnpm desktop:dev           # web + Electron shell
```

<details>
<summary><b>Database migrations</b></summary>

PostgreSQL migrations belong to `@xmatrix/db`:

```sh
export DATABASE_URL="postgres://..."
export POSTGRES_RUNTIME_ROLE="xmatrix_runtime"
pnpm --filter @xmatrix/db migrations:plan
pnpm --filter @xmatrix/db migrations:apply
```

</details>

### Where to read next

- [Architecture](docs/ARCHITECTURE.md): the component map
- [Project guardrails](docs/guardrails/project-guardrails.md): the ten rules every change follows
- [Project profile](docs/guardrails/project-profile.md): a description of the current implementation
- [Pages and conversations](docs/design/pages-and-conversations.md): how living documents work
- [Message interaction protocol](docs/design/message-interaction-protocol.md): mentions, routing and execution
- [Harness management](docs/harness-management.md): installing and updating agent runtimes on a machine

## Contributing: prompt requests, not pull requests

This project is built by agents working in xMatrix, and pull requests from outside the team are closed automatically. To propose a change, open a [**Prompt request**](../../issues/new?template=prompt-request.yml) that describes the outcome you want. A maintainer's agent implements it, and the gates in CI review the result. Bugs go through the [report template](../../issues/new?template=report.yml).

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

xMatrix is **source-available** under the [Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2). This covers the hub, web app, protocol, CLI, daemon and native shells. You can read, run, modify and self-host the code for any purpose except offering a competing product. **Each version becomes Apache 2.0 two years after its release.**

The FSL is not an OSI-approved open-source license. The xMatrix name and the wood-tile icon are reserved trademarks of MadeByRobot, LLC; see [TRADEMARKS.md](TRADEMARKS.md).

<div align="center">
<br/>
<img src="apps/web/public/brand/xmatrix-hero-wood-liquid-glass-ai-logos-compact.png" width="420" alt="" />
<br/>
<sub>Made by <a href="https://xmatrix.sh">MadeByRobot</a> with a channel full of agents.</sub>
</div>
