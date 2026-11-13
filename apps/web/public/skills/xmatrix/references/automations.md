# A Page's Programs

Work that repeats, waits for a time or an event, or asks someone is a Norn
program: a fenced block tagged `norn run <name>` in the page section it
keeps true, written and changed with `xmatrix page edit` like any text. A
program runs in its own conversation linked to the page, as whoever last
changed its block (an Agent as its owner), so it keeps running after the Run
ends. An Agent it asks starts with the request and the page in context, so
the text says what to do, not "read this page first". What one round leaves
for the next belongs on the page, not in its conversation.

````markdown
## Architecture

```norn run audit
open Std
routine(~every=12h, ~from=2026-11-03T09:00Z, ~who=@auto(~repo="<owner/repo>"),
  ~otherwise=@claude(~repo="<owner/repo>"), "Audit duplication and update this section")
```

```norn run review
every(1d)->or(prMerged("<owner/repo>"))->or(ciFailed("<owner/repo>"))->forEach(_ =>
  run(@auto(~repo="<owner/repo>"), "Review what changed")->wait)
```

```norn run renewal
after(2026-11-03T01:00Z)->wait
say(@<person>, "Renew the domain today")
```
````

- `routine` (after `open Std`) is a round on a beat: `~every` is a duration (`30m`, `12h`, `7d`), `~from` the UTC time of the first round. `~who` does it; when that does not end in an answer, `~otherwise` is asked the same once. A round that still fails is told in the program's conversation.
- `ciFailed("<owner/repo>")`, `prMerged("<owner/repo>")` and `appEvent("<app>", ~feature="<event>")` are the events a program can wait on, joined to a beat with `or`. The Space's connection must cover the repository or app. An event that arrives while a round runs starts no second round.
- `after(<UTC time>)->wait` waits once. `say(@<person>, "…")` tells them; `run(@auto(…), "…")->wait` has an Agent check something then.
- `confirm(@<person>, "<question>", ~by=2d)`, `choose(@<person>, "<question>", [A, B])` and `ask(@<person>, "<question>")` ask a person, who answers on a card. Without an answer by `~by` the program reads `NoReply`; `decide(who, question, ~options, ~recommend, ~by)` (after `open Std`) takes the recommendation then.
- `@auto(~repo="<owner/repo>")` asks whichever Agent fits; `~pwd`, `~machine`, `~harness`, `~model` and `~effort` are the other conditions. `@claude` or `@codex` asks that one.
- Removing the block stops its program. Changing its text changes what the next round does; rounds already done are not run again.
- `page edit` prints a program that does not run as written, with why.

```bash
xmatrix page read <page-id>     # how each program stands, under programs:
xmatrix requests                # the requests you hold, and those your programs wait on
```

- An Agent asked by a program ends its turn with `xmatrix reply <request> <answer>`, `xmatrix refuse <request> <why>` or `xmatrix broke <request> <why>`, as the request's message says.
- Anyone who can edit the page manages its programs. On a page that takes Agent edits as suggestions, ask a person.
