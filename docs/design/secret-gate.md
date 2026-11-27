# Secret gate

Status: proposed (2026-11-27). Design agreed between claude:10 and
antigravity:8 on Daniel's instruction that the two decide; nothing is
implemented. Each fact below is marked: **[code]** read in the source,
**[run]** shown by running the checker or evaluator, **[assumed]** not yet
verified.

## Why

A Space secret is read in one of two ways. `auto`: any live Agent Run in the
Space reads it when it asks. `ask`: a Run asks first, on a card, and a Space
admin approves that Run **[code]** (`space-secret-control.ts`).

Some secrets cannot be `auto`: a credential that reads everything in a
database gives whoever holds it more than the Hub would. Work that needs such
a secret and runs with nobody there (a check that a Page's program starts at
night) then has two outcomes, both wrong. The secret stays `ask`, the card
waits ten minutes for a person who is asleep, and the work goes without its
data. Or the secret becomes `auto`, and every Run in the Space reads it.

What is missing is a way to say ahead of time *who may use the secret under
which circumstances*, and to say it once.

## What it is

**A gate is an ordinary Norn function that answers a request to use a secret
with `reply<yesno>`.**

```norn
// The Space library `Gates`, on a Page.
pub let secretUse = (req: Secrets.use) =>
  switch req.program {
  | Some(p) if p.page == "<page id>" && p.name == "patrol" && req.secret == "database-read" =>
    Answered(Yes)
  | _ =>
    confirm(@Daniel, "Let a Run use " ++ req.secret ++ "?", ~by=30m)->wait
  }
```

- `Answered(Yes)` lets the asking Run read the secret. `Answered(No)` and
  `Refused(why)` refuse it. Anything else decides nothing.
- Today's two settings are two bodies of this function. `auto` is
  `Answered(Yes)`. `ask` is `confirm(admin, …)->wait`.
- It adds no word to Norn. The gate is a library function, checked and run by
  the checker and evaluator the Hub already has **[run]**: a one-line program
  that calls `Gates.secretUse({…})` checks against the library's source, ends
  in one pass with `Answered(Yes)` when the gate decides by itself, and opens
  a `confirm` or a `run` when the gate asks someone. A gate of the wrong type
  (`reply<string>`, a `bool`), or one the library does not export, is refused
  by the checker. One that never stops is ended by the evaluator's step budget.
  The example above was run as written, with `Secrets` supplied as a library.
- Checking a gate takes 6–9 ms and evaluating it under 1 ms on the build
  machine, once warm (26 ms and 4 ms cold) **[run]**. Requests to use an `ask`
  secret number dozens a day, so nothing is cached.

A pure function (`Allow | Deny | AlsoAsk(participant)`, norn#53, or the
`option<reply>` tried and reverted in norn#62/#63) cannot say by which
standard another participant should judge, nor what happens when they do not
answer. A function that may wait says both in the words the language has.

### Why this is not the Channel rule that was removed

On 2026-10-28 the per-Channel, per-action connector rules were replaced with
one permission per connection, and the table was dropped (#1162, #1165)
**[code]**. Production held seven allow rows and no restrictive one. A gate
is not that table come back: it has no configuration surface, one text per
Space, and a Space that signs none behaves exactly as today.

## What a gate reads

`Secrets.use` is declared by a built-in library, as `X` and `Gmail` are
**[code]** (`BUILTIN_NORN_LIBRARY_SOURCES`). The Hub writes its value into the
one-line program from facts it holds itself:

| Field | What it is | Where the Hub reads it |
|---|---|---|
| `secret: string` | the alias asked for | the request, checked against the Space's saved secrets |
| `conversation: string` | the Channel the Run works in | the Run's token |
| `owner: string` | the user who owns the Run | the Run's token |
| `program: option<{page, name, digest}>` | the Page program whose open request this Run holds now, with the SHA-256 of that program's current text | `norn_requests_open_v2`, which already answers "the open requests a Run holds" for `xmatrix requests` **[code]**; `None` when it holds none, holds requests of more than one program, or the program is not on a Page |
| `untrustedReason: string` | what the Agent wrote | the request, unchecked |

- **`program` is not "who started this Instance".** An Instance a program
  started later takes messages from people in the same conversation, under a
  new Run that holds no open request. The field says what the Run holds at
  the moment it asks.
- **`digest` lets a gate choose.** A gate that compares it lets a program use
  a secret only while the program's text is the one its admin read; every
  edit of that program then needs the gate signed again. A gate that leaves
  it out accepts any text the program has. The gate's author decides per
  secret.
- **A gate reads nothing else.** No `Holds`, no other Space library. A fact on
  a Page can be edited by any Agent with its owner's authority, and a signed
  text that read unsigned data would be signed in name only.

## Who signs it

A Page program runs with the authority of whoever last edited it, and an
Agent Run's edit carries its owner's **[code]** (`norn-host.md`). Where every
Run is owned by a Space admin, "the gate runs as an admin" is therefore true
of any text an Agent writes. So:

- **Only the text a Space admin signed in person is the gate.** The Hub keeps
  that text and its digest in `data.space_gates`, one row per Space and kind.
  The route that writes it refuses an Agent Run's token, as the routes that
  open a secret up already do **[code]** (`route("human")`).
- **The Page is where the text is written; the row is what runs.** An Agent
  edits the `Gates` library on its Page as it edits anything. That proposes a
  text. Space settings show the signed text, the Page's text when it differs,
  who the text may ask, and what keeps it from being signed. The admin signs
  the digest they were shown; a text that changed in between is not signed.
- **A signed text depends on nothing unsigned.** It may use `Std` and the
  built-in libraries. A text that names another Space library is not signed.
- **Authority is current.** A gate whose signer is no longer a Space admin, or
  whose text no longer checks, is no gate: requests go to the card.
- Signing and withdrawing are audited where secret reads are
  (`data.secret_grant_audit`).

## What happens to a request

A Run asks for a saved `ask` secret it may not read yet (`POST
/api/secret-requests`) **[code]**. With a signed gate, the Hub evaluates the
one-line program once, in memory, on an empty ledger:

| The pass | The Hub |
|---|---|
| ends `Answered(Yes)` | approves that Run for that secret, as the signer, audited as the gate's answer; answers `readable` |
| ends `Answered(No)` or `Refused(why)` | answers the request with a refusal that carries `why` |
| waits (the gate asks someone) | posts today's card: any Space admin approves it |
| fails, or ends any other way | posts today's card, and logs why |

- **A gate never makes approval harder to give than today.** Whatever it does
  not decide by itself goes where every request goes now.
- **The CLI does not change.** It posts the request once and then reads the
  secret every three seconds for ten minutes **[code]**
  (`request_secret_and_wait`). An approval written while the request is
  answered is read by the next poll; a refusal is the request's own error.
- **An approval is still one Run's.** Nothing here widens how long an approval
  lasts.

### The gate that asks someone: next change, not this one

In this change, a gate that would wait hands the request to the card and what
it would have asked is not asked. The settings say so beside "who the text
may ask". Carrying the wait out is the next change, and it is kept apart
because it needs four things this one does not:

1. **The gate's program, kept.** The Hub starts it in the Run's conversation
   as it starts the program of `xmatrix confirm` **[code]**
   (`askNornQuestion`), with the asking Instance as its author, so its end
   wakes that Instance, and the signer as its authority.
2. **An approval that reaches the Run that reads.** Approvals are keyed by Run
   **[code]**, and an Instance that is woken has a new Run: the same Instance
   here has been Runs `#1` to `#4`. An approval given after the asking Run
   ended must go, once, to that Instance's next Run, or the woken Run asks
   again and the person is asked again. Today's card loses an approval given
   after its Run ended the same way: that follows from the two facts and is
   not reproduced here **[assumed]**.
3. **A refusal the waiting CLI reads.** The old CLI reads only the secret, so
   it learns of an approval and not of a refusal.
4. **One open request per Instance and secret**, so that polling starts no
   second review, and a request that ended can be asked again.

Two more belong with it:

- `anyOf` among people is taken by the first one the Hub can reach
  **[code]** (`nornPasses`), where the card lets any admin answer. A default
  gate that replaces the card needs the group offered to all of them.
- A gate's `run(@agent, …)` starts a Run owned by the signer in the asking
  Run's conversation. It reads what the gate's text gives it; a gate that
  passes `untrustedReason` on lets the asker write to an admin's Agent.

## What a signed gate does and does not protect

- It decides from facts the Hub holds. Nothing an Agent writes in its request
  moves a branch that does not read `untrustedReason`.
- Letting a program use a secret trusts whoever can make a Run hold that
  program's request: those who can edit the program (unless the gate compares
  `digest`) and those who can write in its conversation while a request is
  open. That is narrower than `auto`, which trusts every Run in the Space.
- It does not sandbox the Run. A Run that reads a secret can do with it
  whatever its harness lets it; the gate says who gets it, not what for.

## Not in this design

- Cards that ask for what only a person has: a new secret's value, a harness
  sign-in, a setting. No gate stands in for those.
- `auto` secrets: a gate is not asked.
- Connector actions under Ask first: the same gate shape, after the waiting
  gate exists.
- The unused admission policy of norn#53: left as it is.

## Changes

1. **Database.** Expand migration: `data.space_gates (space_id, kind, source,
   source_sha256, signed_by_user_id, signed_at, version)`, primary key
   `(space_id, kind)`, added to the Space move and Space deletion lists.
2. **Hub.** The built-in `Secrets` library (the two types). A module that
   checks a text for signing and evaluates one request. Routes for a person:
   read the gate with the Page's text beside it, sign a digest, withdraw. The
   request route consults the gate before it posts a card.
3. **Web.** Space settings, Secrets: the gate's signed text, the Page's text
   when it differs, who it may ask, its problems, Sign and Withdraw.
4. **Docs.** `docs/operations/` for operating it, `norn-host.md` for where it
   sits, release notes.

## Checks

- Unit: each row of the table above; a gate of the wrong type, not exported,
  naming a Space library, or never stopping; a request whose reason pleads.
- PostgreSQL: only a human admin signs; a signer who stops being an admin
  leaves no gate; an approval names the signer and is audited; a withdrawn
  gate approves nothing; the Space move and deletion carry the row.
- Hub end to end: a Run holding a Page program's request reads an `ask`
  secret with no card; the same Run without the request gets the card; an
  Agent token cannot sign.
- Live: sign a gate for the database patrol on the beta Hub and let its next
  round run unattended. The round reads its two secrets with no card, and a
  Run summoned by hand in another conversation still gets one.

## Open for review

1. Is "a waiting gate hands the request to the card" acceptable for the first
   change, given that the gate's text already says whom it would ask?
2. Is one text per Space right, or should a Space with several admins have a
   way for two of them to sign?
3. Should the signed text be readable by the Space's Runs, so an Agent can
   see why it was refused beyond the reason it is given?
