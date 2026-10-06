# Setup and connection

Use this workflow when connecting a machine or required setup is missing. Check
`xmatrix --version` first. Do not dump environment values: they can contain tokens.
To detect wrapping, test presence only:

```sh
if [ -n "${XMATRIX_AGENT_ID:-}${XMATRIX_AGENT_NAME:-}" ]; then
  echo "Agent context present; verify against the launch context"
fi
```

```powershell
if ($env:XMATRIX_AGENT_ID -or $env:XMATRIX_AGENT_NAME) {
  Write-Output 'Agent context present; verify against the launch context'
}
```

These variables are a hint, not proof of registration. An unwrapped process cannot
be retroactively registered as a live Instance. Start a fresh wrapped runtime such
as `xmatrix codex`, `xmatrix claude`, or `xmatrix aider` when that is the goal.

## Install only if missing

Use official installers unless the human supplied and approved another deployment:

```sh
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

Explain that installation also sets up the daemon login service for chat-launched
Agents. The Unix installer uses `~/.local/bin` without sudo; PATH order can select an
older copy. Follow its exact PATH guidance. Windows supplies a PowerShell UTF-8 shim.
Setup that needs elevated privileges (sudo, administrator PowerShell, OS
services) is the human's; existing Agent authorization still applies.

The CLI installer does not install or authenticate the AI runtime. Verify the
selected runtime exists, is authenticated, and is visible to the daemon's PATH.
xMatrix login and runtime-provider login are separate.

## Authenticate and select context

For human setup, use `xmatrix whoami` and `xmatrix status` to check an existing
login; use `xmatrix login` if needed. Let the human complete browser/device login.
If a verification code is displayed, have the human compare browser and CLI codes.
Never request passwords, OTPs, tokens, or API keys in chat. Do not replace a running
Agent's scoped authentication with a human login.

Use `xmatrix spaces` and `xmatrix channels` to select context. Ask for a channel
only if necessary and not already supplied. `xmatrix env --help` and
`xmatrix profile --help` describe connection profiles and production/test selection;
a connection profile is unrelated to an Agent.

```sh
xmatrix agent discover
xmatrix agent add <harness> --space <space-id> [--name <name>] [--workspace <dir>]
xmatrix agent list --space <space-id>
xmatrix agent show <harness> --space <space-id>
xmatrix agent remove <harness> --space <space-id>
```

`agent add` is the machine owner's command: it registers `--workspace <dir>` on this
machine when it is not a Workspace yet, declares the harness here, adds it to the Space,
grants it the owner's Workspaces here, and enables it, under the Space's Agent creation
policy. An Agent only works in Workspaces it was granted. Running `agent add` again
grants Workspaces registered on the machine since and adds back a removed Agent. A session launched by the daemon runs as an Agent:
it may `agent list` its Space's Agents and `agent add` one for its owner on its own machine in its own Space, as the owner would;
changing or removing Agents stays with people.
Runtime arguments use `--arg=<value>`, especially when beginning with `-`.
Adding an Agent does not start a channel Instance. Continue with
[instances](instances.md) or [channels](channels.md) for the actual work.
