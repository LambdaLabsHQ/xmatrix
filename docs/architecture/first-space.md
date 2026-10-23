# A new account's first Space

A person who opens xMatrix with no Space at all lands in one of their own,
named after them ("Ada Lovelace's Space", or the email's name part when the
account has no name). Without it the first screen is an app with no Space, in
which nothing can be done and nothing says how to start.

- `POST /api/personal-space` (Web: `/api/xmatrix/personal-space`) creates it.
  The Web shell calls it only when the Space list it loads is empty.
- The Hub creates it only for a Human session whose account has no Space at
  the moment of the call. Agent Runs are refused by the Run route allowlist.
  Anyone who already has a Space, including someone who arrived through an
  invite or join link, gets `{ "space": null }` and nothing is created.
- The Space id derives from the account id and the command id is fixed per
  account, so a retry or a second tab replays the same `create-space` command.
  Once the personal Space exists, deleting it does not bring it back: the next
  call conflicts on the id and returns `{ "space": null }`.
- It is an ordinary Space with the caller as its owner. It can be renamed,
  shared and deleted like any other.
- A plan's allowance of Spaces per account may leave it out: the Hub passes
  its id (and `private:<user id>`, which held a person's Channels before
  Spaces existed) to the billing policy's `spaceCreation` check. The official
  policy refuses a new Space (`402 free_space_limit`) while the account owns
  two Free Spaces besides these; paid and deleted Spaces do not count.

## The welcome conversation

The personal Space opens with a conversation in which xMatrix, not the owner,
tells a new person how to bring their agents in. Agents run on the person's
own computer, so a Space without one can do nothing; the first thing it says
is how to connect one.

- `POST /api/spaces/:spaceId/welcome` (Web: `/api/xmatrix/spaces/:spaceId/welcome`)
  makes it. The Web shell calls it when a Space it shows has no conversation;
  only the caller's own personal Space gets one, and any other Space answers
  `{ "channelId": null }`. Agent Runs are refused.
- The conversation is closed ("Welcome to xMatrix", only the owner) and its
  id derives from the Space. Each message has a fixed id and command, so a
  reload, a second tab or a retry keeps the first published step instead of
  adding one. The Hub checks the durable message identity, including a later
  tombstone, rather than rebuilding an append from a changed Agent list or
  account snapshot. This remains true after command replay retention expires;
  a concurrent append conflict is accepted only after the exact step is read
  back as written:
  - `bring-agents`, at once. Connection and enablement determine its setup
    progress; harness sign-in remains actionable separately, even after all
    setup rows are complete. An enabled owned agent reported signed out is
    named with its program and machine and offered the existing harness
    sign-in here, before any agent can answer;
  - `agents-in`, once the Space has an enabled agent that can answer; the Web
    asks again when it sees one, and the Hub checks the fact before writing.
    An agent of the person's own whose machine reports its program signed out
    (`login: "signed_out"`) answers nothing, so it does not count: the step
    names the program and the machine ("Claude Code on mac-mini is not signed
    in") and offers the harness sign-in in place, and no card is shown
    while no agent can answer.
  Once an agent can answer, the step offers one card for each way of working,
  each a single click: start a new conversation and just say it (routing picks
  the agent); have two of the person's agents work together (a new
  conversation whose composer holds `@a @b …` for them to finish); write a page
  with an agent (a new page that opens co-writing with it); connect another
  computer (Machines). Under them, bringing work in: connect GitHub, or draft
  pages from one of its repositories (the page import).
- On a phone (the shell's phone width) the first step shows no command, and no
  setup command is prepared: a command is no use there. It says to open
  xmatrix.sh on the computer and sign in with the same email, where the
  computer shows its own command; the phone then sees that computer's agents
  arrive.
- The messages are `xmatrix.onboarding.v1` system notices (`xmatrixSystemNotice`,
  `system_fact` provenance), written under the owner's principal with the
  xMatrix label, so no Agent takes them as the owner's request. A message names
  only its step; the Web draws what the step shows from the facts (the setup
  command and its approval, the machine's agents, the Space's registrations),
  so the conversation reopened later shows what happened, never a stale command.
- Language: the Web posts `{ "locale": "zh" | "en" }` from the person's saved
  display locale for the Space, else the browser's first language; any `zh` tag
  gets Chinese (`onboardingLocale`). The Hub writes the conversation name and
  both steps in that language, and the Web draws the first ten minutes (the
  steps, the cards, Bring them in, empty Space and Agents, the download
  card) from `apps/web/src/lib/onboarding-copy.ts`. The rest of the app is
  English; a client that posts no body gets English.

## Counting who gets through

Most of bringing agents in leaves a fact in the Hub: a machine connected, an
agent turned on, a first message, a first reply, a first page. The steps only
the person's screen sees are counted on their own (`onboarding-funnel.ts`):

| Step | When |
| --- | --- |
| `app_loaded` | the signed-in app finds the person with no Space (`shell`) |
| `space_ready` | it then has their personal Space (`shell`) |
| `command_shown` | the setup command is on screen |
| `command_copied` | its copy button is pressed |
| `download_clicked` | "Download the desktop app" is followed |
| `terminal_seen` | the terminal's sign-in request is shown for approval |
| `approved` | the person approves it |
| `starter_chosen` | a card in the welcome is chosen (`talk`, `together`, `cowrite`, `machines`) |

- Each step names where it was shown (`welcome`, `space`, `agents`, or
  `shell` for the app before any of them) and what
  on: `phone` at the shell's phone width, `desktop_app` in the desktop app,
  otherwise `desktop_web`.
- The Web reports each step once per showing. `POST
  /api/observable/onboarding-step` takes only those three values (and a first
  task's id), and writes one point to the diagnostics dataset. That point
  holds the person's keyed hash and nothing else that identifies them: no
  email, no Space, no conversation.
- No page views, and no third-party analytics.

The day's funnel, by people (Analytics Engine SQL; the production dataset is
`xmatrix_diagnostics`):

```sql
SELECT blob2 AS device, blob5 AS surface, blob4 AS step, COUNT(DISTINCT index1) AS people
FROM xmatrix_diagnostics
WHERE blob3 = 'onboarding_step' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY device, surface, step
ORDER BY device, surface, people DESC
```

## Measuring live co-writing

The page session records `cowrite_first_text` when a session-requested turn
first changes text in its CRDT, and `cowrite_turn_end` when that turn finishes,
fails, is interrupted, disconnects, or actually times out (`stalled`). Markers,
blank structure, notes, pass responses, empty replacements deleting old words
and trailing whitespace cleanup are not text writes. A first-text
point does not wait for a revision save or the turn's end. These are Hub clock
measurements, **not browser paint times**; a person may receive the update later.
Conversation-initiated streaming writes are outside this metric's population.

Each point uses `blob1=pages`, `blob2=hub`, `blob3` the event, `blob4` its
outcome, and `blob5=session_clock`. `index1` is the authenticated Agent owner's
keyed hash, `blob6` the Agent's keyed hash, `blob9` the turn's keyed hash and
`blob11` the page/conversation pair's keyed hash (session). No text, name, raw
page, conversation, Run id or execution credential is recorded. Missing owner
or conversation evidence stays `unknown`; do not count it as a known person
or session. An absent diagnostics binding disables this best-effort observation;
sink failures never block writing. There are at most two points per turn.

| Number | Meaning (milliseconds unless stated) |
| --- | --- |
| `double1` | event count (1) |
| `double2` | elapsed since the session asked this turn |
| `double3` | earliest pending human edit received by Hub → turn requested, including waiting on an earlier turn |
| `double4` | turn requested → first runtime delta (may contain only markers) |
| `double5` | turn requested → first actual text change |
| `double6` | that pending human edit → this turn's first actual text change |
| `double7` | largest gap between actual text changes in this turn |
| `double8` | number of actual text changes in this turn |

An unobserved duration is **-1**, not zero: joining has no preceding human
edit, a pass or stalled answer may have no text, and one write has no gap.
Changes made while a turn is answering belong to the *next* request; an
existing answer's text must not be attributed to edits it has not read.
The largest gap excludes silence before the first or after the final write.
Reconnection starts new timing evidence; these events are not a durable audit
log and cannot reconstruct turns lost to process failure. Missing events are
unknown, not proof that a turn never stalled.

Read the two populations separately, then group by turn/session hash locally.
First-text points measure successful text latencies; terminal points include
answers that never wrote, and support counts of observed stalled turns and
distinct sessions with a stalled turn. Do not count both events as two turns,
or average -1 into latency. Check `_sample_interval` before calling counts exact.
For a bounded daily window, read metadata only:

```sql
SELECT timestamp, index1, blob3, blob4, blob9, blob11,
  double2, double3, double4, double5, double6, double7, double8, _sample_interval
FROM xmatrix_diagnostics
WHERE blob1 = 'pages' AND blob5 = 'session_clock'
  AND timestamp >= toDateTime('2026-10-19 00:00:00')
  AND timestamp < toDateTime('2026-10-20 00:00:00')
LIMIT 10000
```

Analytics Engine requires DateTime operands: use `toDateTime` for the UTC
endpoint strings ([reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/)).
Use the requested endpoints, check truncation, and keep revision proxies separate. A historical report cannot fill these fields before this observation
was deployed. Actual on-screen first text and interruption durations still
require a browser interaction measurement.

## When the App's background service does not start

A fresh desktop App has no installed CLI. It signs in through the CLI seed it
ships (`Resources/cli`), which also creates the Machine, but nothing on PATH
can run the daemon. Once signed in, the App installs that seed
(`xmatrix setup install --from <seed> --daemon`), which registers the
login-session service (macOS LaunchAgent, Windows scheduled task), and starts
it. Setup names a new Machine after its hostname, as a setup command's login
does, before it copies anything; an existing name is kept. An earlier install
that stopped at naming is set up again from the seed once the CLI's session
import reports the Machine still has no name. A daemon whose connection fails
before it is online ends the session it exchanged, so its retries leave none
behind. A failed install waits for the person's "Try again" instead of repeating on
every keep-alive check.

When a start fails, the daemon status carries where (`cli_install`,
`service_start`, `service_not_up`, `spawn`, `exit`), the exit code and the
CLI's last lines; for a LaunchAgent that did not come up, the lines are read
from `~/Library/Logs/xmatrix-daemon.err.log`. The App redacts them before they
leave the machine (home directory, emails, URL queries, tokens; at most 8 lines
and 600 characters). The App's first screen says what it means in one sentence,
shows those lines and offers "Try again". The Web sends each failure once per
page to `POST /api/observable/desktop-daemon-failure`, which writes one point to
the diagnostics dataset under the person's keyed hash.

The day's failures, by stage:

```sql
SELECT blob2 AS platform, blob5 AS app_version, blob4 AS stage, double3 AS exit_code, blob11 AS detail,
  COUNT(DISTINCT index1) AS people
FROM xmatrix_diagnostics
WHERE blob3 = 'daemon_start_failed' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY platform, app_version, stage, exit_code, detail
ORDER BY people DESC
```
