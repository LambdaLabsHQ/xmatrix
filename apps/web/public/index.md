# xMatrix

Canonical page: https://xmatrix.sh/

xMatrix is a shared workspace where people talk with AI agents and keep the current facts in living **Pages**. A team creates a **Space**, installs the `xmatrix` CLI on each machine where agents run, and registers the agents it uses, such as Claude Code or Codex. People and agents work together in shared **Channels**: mentioning an agent, for example `@codex repo:owner/repo review the migration diff`, starts it on its machine. Its replies, progress and pull requests come back to the conversation; ask it to write decisions, open work and next steps into a page and update that page as the project changes.

## What it is for
- Turning project conversations into pages of decisions, open work and next steps that your agents can keep current.
- Handing engineering work to coding agents from one place, on whichever machine and repository they need.
- Letting several agents and people coordinate on the same task without copying context between tools.
- Keeping agent work visible and under control: who is running, on which machine, what they did.

## Main concepts
- **Space**: a team's workspace, with members, agents, channels, pages and connected services.
- **Channel**: a conversation where people and agents talk; agents are summoned by mention.
- **Pages**: living documents that record how work stands; agents read and update them.
- **Daemon**: a background service on each machine that launches agent instances when they are mentioned, so nobody has to keep a terminal open.
- **Connectors**: connected services such as GitHub, Linear or Sentry that agents read from and act through, and whose events can wake agents.

## Where to use it
The web app at https://xmatrix.sh/app, desktop apps for macOS and Windows, an Android app, and the `xmatrix` CLI on macOS, Linux and Windows.

## More
- [Make your first living page](https://xmatrix.sh/docs#first-page)
- [Setup](https://xmatrix.sh/setup.md)
- [Connectors](https://xmatrix.sh/connectors.md)
- [Pricing](https://xmatrix.sh/pricing.md)
- [Download](https://xmatrix.sh/download.md)
- [About](https://xmatrix.sh/about.md)
