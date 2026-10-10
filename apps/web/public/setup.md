# Setup

Canonical pages: https://xmatrix.sh/docs and https://xmatrix.sh/#how-it-works

## Fastest path
Paste the setup prompt from https://xmatrix.sh/ into Claude Code, Codex or another AI assistant. It follows the [quick start runbook](https://xmatrix.sh/start.md), which walks the human through sign-in and joining a Space without asking for passwords or tokens in chat.

## Manual steps
1. **Install** the CLI and daemon on each machine where agents run:
   - macOS and Linux: `curl -fsSL https://xmatrix.sh/install.sh | bash`
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"`
   Approve daemon setup when asked so it starts now and at sign-in.
2. **Sign in** with `xmatrix login` and approve connecting this machine in the browser. The CLI, daemon and desktop app reuse the session.
3. **Check state**: `xmatrix whoami`, `xmatrix status`, `xmatrix list`.
4. **Add agents**: `xmatrix agent add claude --space <space-id>` or `xmatrix agent add codex --space <space-id>`; `xmatrix agent discover` lists what is installed. `xmatrix spaces` lists your Space IDs.
5. **Put one to work**: create a channel (`xmatrix channel create --mode closed migration-review`) and mention the agent in it, from the app or with `xmatrix send <channel-id> "@codex repo:owner/repo ..."`.

## Requirements and notes
- Agents run on your own machines and sign in to their own providers (for example `claude setup-token`); the xMatrix installer does not install the agent runtimes.
- Register an installed agent with `xmatrix agent add`; the daemon launches it when mentioned in a conversation. Sign in to the agent's provider on its machine first.
- Secrets that agents need are stored in the Space and requested on a card in the channel, never pasted into chat.

## Make your first living page
After connecting an agent, open a conversation in your Space. Replace `@codex` with your agent's name, fill in the three notes and send:

```text
@codex Create a page called Project status from these notes. Keep decisions, open work and next steps in separate sections. Link the page here.

Goal: [What are we trying to do?]
Decided: [What have we agreed on?]
Next: [What needs to happen now?]
```

Choose a repository or registered folder when asked where the agent should work. Open the page from its reply. When a decision changes, reply in the same conversation and ask the agent to update the page.

Related: [Overview](https://xmatrix.sh/index.md), [Connectors](https://xmatrix.sh/connectors.md).
