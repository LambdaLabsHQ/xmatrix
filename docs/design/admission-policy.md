# Admission policy for secrets that ask first

Status: implemented in the Hub and on the settings card (2026-11-27): the
policy, its adoption through the settings registry, the request route, the
`adopt` control and the row in Settings › Secrets
(`/api/spaces/:spaceId/admission-policy`). A first draft proposed
a gate that could wait on people and Agents; it broke four recorded decisions
and was withdrawn (see "Recorded decisions").

Each fact is marked: **[code]** read in the source, **[run]** shown by running
the checker or evaluator, **[page]** recorded on a Page, **[assumed]** not
verified.

## Why

A Space secret is read in one of two ways **[code]**
(`space-secret-control.ts`). `auto`: any live Agent Run in the Space reads it.
`ask`: a Run asks first on a card, and a Space admin approves that Run.

Some secrets cannot be `auto`. The production database credentials read
message bodies and the secret tables themselves, so a Run that holds one goes
around the Hub's tenant checks **[page]** (fbfd3bc1, "生产数据库凭据"). A
read-only account does not change that: it still reads them.

Work that needs such a secret and runs with nobody there has two outcomes
today, both wrong. The secret stays `ask`: the card waits ten minutes for a
person who is asleep and the work goes without its data. Or the secret
becomes `auto`: every Run in the Space reads it. What is missing is a way to
say ahead of time who may use the secret, and to say it once.

## Recorded decisions

| Recorded | This design |
|---|---|
| **A team's cross-cutting norms are a pure Norn admission policy the host evaluates when it admits: `request => Allow \| Deny(string) \| AlsoAsk(participant)`** (915dd291 §6; research 6548d112, whose example is a second approval over budget). In the language since norn#53 **[code]** | **Follows.** It is that function, wired for the first time, for one thing a host admits |
| **Effect handlers are not opened to libraries** (915dd291 §6) | **Follows.** The policy has no effect; the checker and the evaluator both refuse one |
| **Only people and Agents answer; a program is not asked** (915dd291 "请求身份与程序之间的边界" 3; open tradeoff 4 in 6548d112, for the owner to decide, advice: not yet) | **Follows.** The host evaluates the policy; nobody asks it anything, and it holds no request. The first draft's waiting gate was a program being asked, and is dropped |
| **No LLM risk classifier; opening a secret up is a person's decision** (fbfd3bc1 "安全策略以竞品为上限") | **Follows.** No Agent judges a request here or in any later step of this design. A person adopts the policy |
| **Where a new thing goes; three red lines** (915dd291 "新东西放哪", "分层"): no app or business name in the host interface or a standard capability interface; no privileged built-in for one use case | **Follows.** The policy is a Space library (the team's words). What is admitted is described by a standard capability interface with generic fields; "secret" appears only as data. The first draft's built-in `Secrets` library put a business name in a built-in and is dropped |
| **Code is pinned and adopted explicitly** (915dd291 "工作 = f(事实)", "当前实现"; #2147, #2149) | **Follows the rule, with one difference.** Pins live in a running program's ledger and anyone who may edit the Page adopts. A policy the host evaluates has no ledger, and adopting it opens secrets up, so its pin is its own row and only a Space admin adopts it, in person. Same hashing, same two words |
| **Person-only settings go through the settings registry; cards, state, writes and the wake go through it and nowhere else** (84661dda 已定 4; `docs/design/settings-cards.md`) | **Follows.** Adopting the policy is one address in the registry. The first draft's own routes and settings panel are dropped |
| **An approval card admits one operation and is not a setting** (84661dda "和其他卡的边界") | **Follows.** The card a Run gets for one secret stays the card it is |
| **Later layers: gates on actions, standing rules; cards become ledger requests; standing delegation** (803a0ba8 "语言要改什么", "委托", "xMatrix 这边怎么接") | **Does the first, for one action.** Cards into the ledger and standing delegation are not part of this |
| **A rule engine does not replace programs** (803a0ba8 "被放下的路线") | **Unaffected.** A policy admits or refuses; it sequences nothing |
| **One permission per connection; per-Channel rules removed** (#1162, #1165, 2026-10-28) | **Unaffected, and not undone.** No per-Channel configuration returns: one text per Space, no surface, and a Space that adopts none behaves as today |
| **The current secret rules** (524517b5 "Secret") | **Changes once shipped**: that section gains the policy |

Pages to rewrite in place once this ships: 915dd291 "当前实现" and §6,
803a0ba8 "语言要改什么", 84661dda (the new address), 524517b5 "Secret",
fbfd3bc1 "生产数据库凭据", and `docs/architecture/norn-host-index.md`.

## What it is

```norn
// A Space library, on a Page: norn 1 lib Access
pub let admit = (req: Admission.request) =>
  switch req.work {
  | Some(w) if req.what == "secret.use" && req.target == "database-read"
      && w.program == "<page id>/patrol" => Allow
  | _ => if req.target == "retired-key" { Deny("That secret is retired") } else { AlsoAsk(@Daniel) }
  }
```

The example was run as written against the vendored checker and evaluator,
with a stand-in library for the interface's two record types **[run]**: the
patrol's Run is answered `Allow`, another Run `AlsoAsk(@Daniel)`, the retired
secret `Deny`. A policy that asks someone is found to have the effects
`confirm` and `wait` before it runs; one that reads a field the record lacks,
or answers a `reply`, does not check.

For a Run that asks to use a saved `ask` secret:

| The policy answers | The Hub |
|---|---|
| `Allow` | approves that Run for that secret, as the admin who adopted the policy, audited as the policy's answer |
| `Deny(why)` | refuses the request with `why` |
| `AlsoAsk(p)` | posts the card, as without a policy |
| nothing it can use (it fails, or no longer checks) | posts the card, as without a policy, and logs why |

- A Space with no adopted policy is unchanged. `auto` secrets are never put to
  the policy.
- **The policy can only spare a person the card or refuse outright.** Where it
  does neither, the request goes where every request goes today.
- **`AlsoAsk(p)` in this version does not change whom the card waits on.** It
  waits on the Run's owner and any Space admin answers it, as now **[code]**
  (`requestCardAppend`); the settings-card Page records the same limit for
  every card (84661dda 未完成 2). Nothing here sends a request to an Agent,
  whoever `p` is. The `adopt` control says so beside the text, so nobody
  adopts a policy believing that `AlsoAsk(@alice)` reaches Alice alone.
- An approval is still one Run's. Nothing widens how long it lasts.

## Norn: admission becomes a standard capability

What exists **[code]**: the built-in variant `admission = Allow | Deny(string)
| AlsoAsk(participant)` and `evaluateAdmissionPolicy`, which takes a ledger
request and passes the policy seven of its fields. No interface file, no spec
section, and no host calls it.

What is added, and nothing else:

1. **`interfaces/admission.norn`**: what a host is about to admit, in fields
   no host or app names.

   ```norn
   // The program request the asker is working on now.
   type work = { program: string, digest: string }
   type request = {
     what: string,       // the kind of thing, in the host's words: "secret.use"
     target: string,     // what it is done to
     place: string,      // where it is asked from
     owner: string,      // whose authority the asker runs under
     work: option<work>,
   }
   ```

   A declared type is needed: records are nominal, so a library function that
   reads `req.target` with no type in sight is refused ("no record type has
   it") **[run]**. `Admission` is a reserved module name, as `Events`,
   `Actions` and `Holds` are: no Page's library shadows it.
2. **The evaluator takes that record as a value.** Today it builds its own from
   a ledger request. Passing a value means no host ever writes a request's
   fields into source text.
3. **A spec section** that says what the three answers mean, that a policy has
   no effect, and that how `AlsoAsk` is carried out is the host's.

No new result, no new keyword. The words an asker wrote are not a field: no
branch of a policy should turn on them, so the policy is not given them.

## What the Hub passes

| Field | For a secret request | Where the Hub reads it |
|---|---|---|
| `what` | `"secret.use"` | constant |
| `target` | the secret's alias | the request, checked against the Space's saved secrets |
| `place` | the Channel the Run works in | the Run's token |
| `owner` | the user who owns the Run | the Run's token |
| `work` | `<page id>/<block name>` of a Page program and the SHA-256 of its current text, when this Run is executing the delivery of one of that program's open requests | a query of its own, below |

**`work` is attributed by Run, not by Instance.** `norn_requests_open_v2`
(what `xmatrix requests` reads) is not used: it also counts requests the
Instance itself asked, and it holds whenever the request names the Instance,
so a chat message that wakes the same Instance while the request is open
would be read as the program's work **[code]**. The query here requires all
of:

- the program is running, not stopped, and on a Page;
- the request is open and nobody delegated it;
- **this Run** is working on that request's delivery message now: it has an
  execution of it in state `accepted` or `running`
  (`agent_message_executions`) **[code]**. A Run that has reported no
  execution at all yet is taken by what triggered its launch
  (`agent_launches.trigger_id`), which covers only the moment before its first
  report. The trigger alone is not enough: it stays true for the Run's whole
  life, so a Run that finished the delivery's turn and was then woken by a
  chat message would still read as the program's work;
- exactly one program qualifies. Otherwise `work` is `None`.

`digest` lets a policy choose. One that compares it admits a program only
while its text is the one the admin read, and every edit of that program
needs the policy adopted again. One that leaves it out admits whatever text
the program has. The policy's author decides per secret.

## Adopting it

- **One address in the settings registry**: `admission:<page id>/<library>`,
  writer `space-admin`, sensitivity `plain`. The address names the Page, so a
  second Page that declares a library of the same name cannot stand in for it
  or block it: the Space-wide library catalog reports such a pair as a
  conflict **[code]** and is not consulted.
- **A new control, `adopt`.** The card shows the library's text as it stands
  on the Page and what keeps it from being adopted. The person's answer
  carries the digest of the text they were shown; the domain reads the Page
  again and adopts only if the digest still matches. `proposed` is not used:
  it holds one line of at most 200 characters **[code]**, and the text
  already has a home an Agent can edit.
- **An Agent asks with `xmatrix settings ask admission:<page id>/<library>`.**
  The Hub defines that command, so no CLI release is needed **[code]**
  (`cli-commands-settings.ts`). The registry wakes the Instance that asked
  once the card is satisfied.
- **Satisfied is the state, not a click after the card**: the adopted digest
  is the Page's. A text adopted before the card was posted satisfies it at
  once, as an already-open secret satisfies `secret-access` **[code]**
  (`settings-domain-secret.ts`). What the card asks for is that the Page's
  text be the adopted one, and it is.
- **The Page is in the reader's Space**, or the address names nothing. The
  text is given only to a reader who may adopt it; other members and Agent
  Runs get the state without it.
- **What is adopted**: `data.space_admission_policies`, one row a Space:
  `page_id`, `library_name`, `source_text`, `source_sha256`,
  `adopted_by_user_id`, `adopted_at`. The Hub evaluates that row and never
  the Page.
- **What can be adopted**: a library that exports `admit` of the type above,
  has no effect, and names no other library than `Admission`. So one text is
  everything that was read.
- **Authority is current.** The transaction that reads the policy for a
  request also reads that its adopter is still an owner or admin of the
  Space; the one that writes an approval reads it again. A policy whose
  adopter lost that role, or whose text no longer checks, is no policy.
- **No card is needed.** Settings › Secrets shows the adopted policy, its Page
  and when it was adopted. An admin withdraws it there, and adopts the Page's
  text where it changed since, through the same domain write. A first policy
  is proposed on a card.
  It is also where the address's `href` leads, for a client without the
  control and for an admin who edited the Page themselves. Withdrawing
  clears the row.
- Adopting and withdrawing are audited where secret reads are
  (`data.secret_grant_audit`).

## The request route and the CLI

`POST /api/secret-requests` is where a Run asks **[code]**. For a saved `ask`
secret the Run cannot read yet, the Hub reads the policy and `work` in one
uncached transaction, evaluates, and then:

- `Allow`: writes the approval, re-reading the policy's digest, its adopter's
  role and the Run's liveness in that transaction, and answers `readable`.
- `Deny(why)`: answers `403 secret_request_refused` with `why`. A `why` that
  contains either phrase the CLI waits on (below) is replaced by a fixed
  sentence, so no policy text can leave an old CLI polling for ten minutes.
- otherwise: posts the card.

The CLI is unchanged **[code]** (`request_secret_and_wait`). It posts the
request once before it starts polling, so a refusal ends it at once: its error
text carries neither `is not saved` nor `not configured for this Agent`, the
two phrases the CLI keeps waiting on. After an approval its first read
succeeds.

Evaluating is pure computation between two transactions; no connection is
held across it. Checking a library of this size takes 6–9 ms and evaluating
under 1 ms on the build machine once warm **[run]**. Requests for `ask`
secrets number dozens a day, so nothing is cached.

## What it protects, and what it does not

- A policy decides from facts the Hub holds. It is given nothing the asking
  Agent wrote.
- Admitting a program trusts whoever can make a Run execute that program's
  request: those who can edit the program, unless the policy compares
  `digest`, and those who can write to that Run while it works. That is
  narrower than `auto`, which trusts every Run in the Space.
- It does not say what a Run does with a secret it reads.
- An Agent Run cannot adopt: the registry's write route takes a person's
  session and the domain checks the Space role again **[code]**. An Agent
  that edits the Page has proposed a text.

## Not in this design

- A policy that waits, and an Agent that judges a request. Either would change
  a recorded decision, and is the owner's to reopen.
- Honouring whom `AlsoAsk` names, the card as a ledger request, approvals that
  follow an Instance to its next Run, offering a card to several admins. These
  belong with moving cards into the ledger.
- Cards that ask for what only a person has: a new secret's value, a sign-in,
  a setting.
- Connector actions under Ask first: the same policy with another `what`,
  later.
- Admission of a program's own requests, which is what norn#53 was written
  for. The evaluator keeps taking a ledger request for it; no host does it yet.

## Changes

1. **norn**: the interface file and its two built-in record types; the
   evaluator's value input; the spec section; tests.
2. **xmatrix, database and Hub**: the vendored Norn; expand migration for
   `data.space_admission_policies`, in the Space move and deletion lists; the
   `admission` settings domain; the attribution query; the request route.
3. **xmatrix, Web**: the `adopt` control; the row in Settings › Secrets.
4. **Docs and Pages**: `docs/design/settings-cards.md`,
   `docs/architecture/norn-host.md` and its index, an operations page, release
   notes, and the Pages listed above.

## Checks

- **norn**: the four rows of the answer table from a value; a policy with an
  effect, of another type, or that reads a field the record lacks is refused.
- **PostgreSQL**: only a person who is a Space admin adopts; an adopter who
  loses the role leaves no policy, in the same transaction as the read; an
  approval names the adopter and is audited; a withdrawn policy approves
  nothing; `work` is `Some` only for a Run executing the delivery, and `None`
  for a Run the same Instance got from a chat message, for the same Run woken
  by a chat message after it finished the delivery's turn, for a delegated
  request, for a request the Instance asked, for a stopped program, and in a
  branch conversation it is the Page program's; the Space move and deletion
  carry the row.
- **Hub**: each answer through the route; a refusal's text carries neither
  phrase the CLI waits on, also when the policy's own `why` contains one; a
  Page of another Space adopts nothing; a reader who cannot adopt is not given
  the text; an Agent token cannot adopt; a digest that changed
  between showing and answering adopts nothing; a second Page with the same
  library name changes nothing.
- **Live**: on the beta Hub, a Page program whose Run asks for a harmless `ask`
  secret reads it with no card once its policy is adopted, and a Run summoned
  by hand elsewhere still gets the card. Then the database patrol's next
  round.

## Review

Reviewed by antigravity:8 against the source and the Pages (2026-11-27). Its
three answers are in the text above: `AlsoAsk` may leave the card's waiting
unchanged if the control says so; the field names stand and `what` stays, so
a second kind breaks no adopted policy; one policy a Space, exported as
`admit`.
