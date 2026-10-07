# Onboarding: connect a machine from the Web

Status: design, 2026-10-07. Product context: the Space page "Onboarding" (P1),
whose first-ten-minutes path this implements. Decision recorded there: the
command carries a setup intent id, never a credential, and the device sign-in
is approved on the page that showed the command.

## Problem

A person on the Web who has no machine connected today has to:

1. find install instructions outside the app;
2. run the installer, then `xmatrix login`, open a second browser tab and
   compare a code;
3. name the machine at a terminal prompt;
4. copy a Space id the Web shows nowhere into `xmatrix agent add`;
5. come back to the Web and refresh to see whether anything happened.

Every step is a place to stop. The Web learns nothing until the last one.

## Target experience

The Space's empty screen ("Bring your agents into xMatrix") shows one command
for the reader's platform:

```
curl -fsSL https://xmatrix.sh/install.sh | bash -s -- --connect <intent>
```

The same screen then narrates what happens, live, without a refresh:

| Screen line | Fact that drives it |
| --- | --- |
| Waiting for the command… | intent created, no device sign-in attached |
| **daniel-laptop wants to connect. Code WDJB-MJHT** [Approve] | a device sign-in started with this intent |
| daniel-laptop is connected | the approved session's daemon registered a Machine |
| Found Claude Code and Codex [Bring them in] | that Machine reported its harness inventory |
| Claude Code and Codex are in this Space | registrations exist for (owner, machine, harness) |

A slow step escalates its hint over time: after about 30 seconds "Still
waiting; check the terminal for an error", after 2 minutes "Prefer the desktop
app? Download xMatrix".

The terminal needs no browser tab and asks no question: the machine name
defaults to the hostname, and the person approves on the page they are already
signed in to.

## Design

### Setup intent (Hub)

- `POST /api/setup-intents` (Human session) with `{ spaceId }` creates
  `{ intentId, ownerUserId, spaceId, createdAt, expiresAt }`.
  - `intentId` is 128 random bits; `expiresAt` is 30 minutes later.
  - The caller must be able to add Agents to the Space.
- `GET /api/setup-intents/:id` is readable only by its owner. It returns the
  derived state above: `waiting`, `approval` (`userCode`, `hostname`),
  `connected` (`machineId`, `machineName`), `inventory` (`harnesses`) and
  `added` (`registrations`).
  - Every field is derived from the device-auth record, the Machine daemon
    record and the registrations. The intent stores no copy of their state,
    so it cannot drift from them.
- The intent is not a credential. Knowing an intent id lets a terminal ask to
  be approved; only the owner, signed in on the page and clicking Approve, can
  grant it.

### Device sign-in carries the intent

- `POST /api/auth/cli/device/start` accepts an optional
  `{ setupIntentId, hostname, platform }`.
  - The broker stores them on the device request.
  - One pending request per intent: a second start for the same intent is
    refused until the first expires or is declined.
- `POST /api/setup-intents/:id/approve` (owner, Human session) approves the
  device request attached to the intent. It reuses the broker's approve path,
  including the `userCode` match, which the page sends back from what it
  displayed. "This is not my terminal" declines and expires the request.
- The session issued to the CLI records the `setupIntentId`. The daemon's
  `POST /api/machine-daemon-credentials` passes it on. That ties the Machine to
  the intent without the Web guessing from hostnames.

### CLI and installer

- `install.sh --connect <intent>` (and `XMATRIX_CONNECT` for `install.ps1`)
  forwards to `xmatrix login --connect <intent>`.
  - The CLI starts the device sign-in with the intent and prints "Approve this
    terminal in your browser: code WDJB-MJHT". It opens no URL.
  - With `--connect`, the machine name defaults to the hostname, so no prompt
    is shown. The person can rename the machine on the Web afterwards.
  - The installer no longer exits on a failed login. It prints the one command
    that resumes (`xmatrix login --connect <intent>`) and still installs the
    daemon.

### Bringing agents in

- "Bring them in" on the Web creates a registration per detected harness with
  key (owner, machine, harness), using the existing Human registration command.
  A Human may already create registrations for their own Machines.
- No working directory is chosen here. A directory is chosen when the first
  task needs one (Onboarding P3).

### Live updates

There is no push event today for "machine online", "inventory reported" or
"registration created" (only polling `GET /api/machine-daemons`). The intent
read is cheap and owner-scoped, so the page polls it every 2 seconds while
open and only until `added` or `expiresAt`. A push fan-out from the Machine
daemon port can replace the polling later without changing the page.

## Security

- **No credential in the command.** The command, the screen and any shared
  screenshot leak only an intent id. A leaked id lets someone request approval
  on the owner's page. The page shows the requesting hostname and code beside
  the owner's own terminal, as the CLI device flow already does, and grants
  nothing without the click.
- **Approval stays explicit.** Device sign-ins are approved only by a click
  since #41. The intent page uses the same rule.
- **One request per intent, owner-only reads.** Intents expire after 30
  minutes. They are rate limited per owner like device starts.
- **No new authority.** The issued session is the same user session the
  device flow issues today. The intent only links facts that already exist.

## Phases

1. Explicit device approval (#41, merged).
2. Setup intents, the device start carrying them, the approve and decline
   routes, the intent read, and the CLI and installer `--connect`.
3. The Web live narration on the Space's empty screen and in the Agents view,
   escalating hints, and "Bring them in".
4. Replace polling with a push event from the Machine daemon port.

## Open questions

- Desktop app: it already finds local runtimes. Should it create the intent
  itself, so the same narration covers it? Proposed: yes, in phase 3.
- Headless servers with no browser on the same network still work: the page
  that approves can be on any device the owner is signed in on.
