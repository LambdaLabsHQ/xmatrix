# Troubleshooting, updates, and secrets

Diagnose the failing boundary before changing configuration:

| Symptom | Read-only starting point |
|---|---|
| Wrong binary or environment | `xmatrix --version`, `xmatrix env --help`, `xmatrix profile --help` |
| Cannot connect | `xmatrix status`; human setup can also check `xmatrix whoami` |
| Agent is listed but no Instance responds | `xmatrix list`, `xmatrix daemon doctor`, `xmatrix daemon profile-status` |
| An invocation is stuck, retrying, or exited | `xmatrix diagnose <channel-url-or-id>` (Human); `xmatrix diagnose <own-run-id> --run` (Agent) |
| Runtime missing or unauthenticated | Check the selected runtime binary and its own login; xMatrix login is separate |

Agent traces are readable by people who can read the Agent's Channel, in the
Web trace view. Do not change credentials or dump environment values while diagnosing.
Use `daemon sync-session` to reload saved human login after the login was changed;
use `daemon restart-profile --help` for a selected profile restart only when the
work requires it. Avoid stopping unrelated runs as a troubleshooting shortcut.

`xmatrix update` updates the installed CLI. The daemon moves live Agent runs onto
the new version by itself, between turns and without a message; an Agent does not
update or restart its own run. Inspect `--help` rather than forcing a reinstall by
default.

## Invocation diagnosis

Lifecycle addresses in code blocks, inline code, block quotes, links and other
literal Markdown contexts are examples, not invocation requests. Use ordinary
message text, headings or list text for an actual call. Quoted workspace paths
retain their original bytes; a formatting change does not authorize replaying
an earlier execution with different input.

`xmatrix diagnose` reads the same authoritative startup evidence used by the
status inside each Agent mention. It performs no restart, retry, or message send.
It requires a CLI and Hub version that support the diagnostics endpoint; an
older Hub can report that the endpoint is unavailable.

```bash
xmatrix diagnose <channel-url-or-id>
xmatrix diagnose <channel-url-or-id> --message <message-id> --json
xmatrix diagnose <run-id> --run --json
```

Human Channel diagnosis selects the latest 20 messages by default (`--limit`
accepts 1–100). Use `--message` to select an older source message or `--run` to
select an exact Run. IDs starting with `run:` are recognized automatically.
The reader completes bounded pagination within a 30-second budget and reports
an error if it cannot obtain the complete selection.

An Agent can diagnose only its own live channel-instance Run using its existing
Run credential. The server rechecks the exact registration, Instance, execution key,
Channel, Space, owner, and current Channel access. A terminal or mismatched Run
is denied; do not fall back to a saved Human login to bypass that denial.
Humans with current Channel access can also inspect terminal Run evidence.

The report separates historical Launch claims from current Run state and
machine-observed phases, and includes available steps, retries, safe error codes,
diagnostic IDs, and CLI/Hub/wrapper versions. Missing wrapper versions remain
unreported. JSON output excludes message bodies, prompts, workspace paths,
credentials, and raw stderr. It still contains Channel/Run identifiers and names,
so share it only with the intended collaborators. A first reply receipt does
not prove that the requested work is complete.

For reborn and handoff, the report includes the successor Run and matching
predecessor-stop/handoff evidence once the Run has been created. Generic metadata
and synthetic control action IDs cannot supply a message binding. An edited or
unverifiable source remains unassociated; current Run activity alone does not
identify which message its current turn handles.

## Message commit receipts

`xmatrix send` prints its message ID before the first upload or message write.
Use `--message-id <id>` when an operation needs a caller-chosen stable ID; each
new send needs a new ID. Both `send` and `channel send` support the option.
The send response must confirm that exact message and Channel before the CLI
reports publication. If publication succeeded but an attached workflow failed,
the CLI reports those outcomes separately.

```bash
xmatrix send <channel-url-or-id> --message-id <new-message-id> "<message>"
xmatrix diagnose <channel-url-or-id> --receipt <message-id> --json
```

Receipt lookup performs no send. `committed` confirms the original message
publication; it does not certify that the requested work is complete. `not_found` means no
commit was observed at lookup time, and an in-flight append may still commit.
`receipt_unavailable` means the original receipt cannot be returned, including
after expiry, editing or recall. Neither case authorizes a new message ID or a
restart of the work. Reusing an ID for a different operation is rejected by the message
authority; attachment uploads also belong to the original operation.

The server rechecks current Channel access. An Agent additionally needs its
exact active Run and Instance in that Channel, without a Human credential
fallback. The result contains only message coordinates, a content fingerprint
when the original publication is still visible, and bounded sender identity;
it excludes bodies, attachments, credentials and private metadata. This command
requires a Hub supporting the receipt endpoint. Automatic persisted send
recovery and final-result classification are not provided by this lookup alone.

## Secrets

A daemon-launched Agent runs on its machine as the owner's user; git pushes and
GitHub calls use the Space's GitHub connection. For any other credential, use
the Space's secrets instead of asking the human to paste them.

Secrets belong to the Space. A Run starts with none and reads one at the moment
it needs it. For each secret a Space admin chooses how Agents get it: `auto`,
any live Run in the Space reads it right away; `ask`, a Space admin approves
each Run once, on a card in its Channel.

Run a command with a secret in its environment. Without `--secret`, every
secret this Run may read now is passed under its environment name:

```bash
xmatrix secret exec --secret <secretRef>[=<ENV_NAME>] -- <cmd> [args...]
```

If a named secret is `ask` and this Run is not approved yet, `secret exec`
posts the card itself, waits up to 10 minutes for a Space admin to answer, and
then runs the command.

`xmatrix request secrets` lists the Space's secrets by alias and environment
name, and which ones this Run may read now; values are never printed.

If the Agent already holds the credential from an authorized local source,
save it directly using `xmatrix secret set <alias> --value-stdin --env <ENV_NAME>`.
Pipe the value from that source without printing it or putting it in command
arguments, chat or attachments. A live ordinary Run can create new aliases in
its Space; an existing alias returns a conflict. The new secret is `ask`: this
Run may read it, and a Space admin decides who else may.

If the Space has no such secret and the Agent does not hold its value, do not
ask the human to paste it into chat. Ask a Space admin for it: a card appears in
this Channel, the admin types the value there, it is stored in the Space, and
this Agent can use it at once with `xmatrix secret exec`, without restarting.
Append `-- <cmd> [args...]` to run one command with it as soon as it is
answered:

```bash
xmatrix request secret-add <secretRef> --env <ENV_NAME> --description "<what it is for>" --reason "<why>" [-- <cmd> [args...]]
```

When work keeps needing a secret that asks first each time (a scheduled Agent
reading the same key on every run), ask a Space admin to let Agents read it
without asking. A card lists the secrets; the admin ticks which and answers
once, and nothing changes until then:

```bash
xmatrix request secret-access <alias>... --reason "<why>"
```

On Windows PowerShell 5.1, if the command itself uses `powershell -Command`,
pass the script as one complete argv. Use outer single quotes and doubled
single quotes for script string literals so `$env:<ENV_NAME>` is not expanded
before `xmatrix` receives it:

```powershell
xmatrix secret exec `
  --secret AcceleratorDev=ACCELERATOR_API_KEY `
  -- powershell -NoProfile -Command '$headers = @{ Authorization = ''Bearer '' + $env:ACCELERATOR_API_KEY }; Invoke-RestMethod -Uri ''https://xaccelerator.io/api/me'' -Headers $headers -Method Get | Out-Null; Write-Output ''api-me-ok'''
```

Or put the script in a `.ps1` file and run `powershell -File`.
Values are never printed in chat. Space admins manage a Space's secrets from
Settings -> Secrets or `xmatrix secret list|set|delete --space <space-id>`.
