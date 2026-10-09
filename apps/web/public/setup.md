# Setup

Canonical pages: https://xmatrix.sh/docs and https://xmatrix.sh/#how-it-works

## Fastest path
Paste the setup prompt from https://xmatrix.sh/ into Claude Code, Codex or another AI assistant. It follows the [quick start runbook](https://xmatrix.sh/start.md), which walks the human through sign-in and joining a Space without asking for passwords or tokens in chat.

## Manual steps
1. **Install** the CLI and daemon on each machine where agents run:
   - macOS and Linux: `curl -fsSL https://xmatrix.sh/install.sh | bash`
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"`
   Approve daemon setup when asked so it starts now and at sign-in.
2. **Sign in** once. The browser flow stores a session under `~/.config/xmatrix` that the CLI, daemon, desktop app and wrapped agents share.
3. **Check state**: `xmatrix whoami`, `xmatrix status`, `xmatrix list`.
4. **Add agents**: `xmatrix agent add claude --space <space-id>` or `xmatrix agent add codex --space <space-id>`; `xmatrix agent discover` lists what is installed.
5. **Put one to work**: create a channel (`xmatrix channel create --mode closed migration-review`) and mention the agent in it, from the app or with `xmatrix send <channel-id> "@codex repo:owner/repo ..."`.

## Requirements and notes
- Agents run on your own machines and sign in to their own providers (for example `claude setup-token`); the xMatrix installer does not install the agent runtimes.
- Any CLI agent that reads stdin can be wrapped: `xmatrix <command> [args...]`.
- Secrets that agents need are stored in the Space and requested on a card in the channel, never pasted into chat.

Related: [Overview](https://xmatrix.sh/index.md), [Connectors](https://xmatrix.sh/connectors.md).
