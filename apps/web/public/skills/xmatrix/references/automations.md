# A Page's Automations

An Automation is a standing rule that keeps one page section true: "every 12
hours, have a fresh Agent audit the code and update this section". It belongs
to that section and is referenced in its text by a link to
`xmatrix:automation/<id>`; the editor shows it as a live chip. It runs in a conversation of its own,
linked to the section, as a Human: when an Agent creates it, as the Agent's
owner, so it keeps running after the Run ends.

```bash
xmatrix page automation list <page-id>
xmatrix page automation create <page-id> --block <heading-slug> --name "Code audit" --every 12h \
  -m "@auto repo:<owner/repo> audit duplication and update this section"
xmatrix page automation edit <page-id> <automation-id> --version <n> --every 1d
xmatrix page automation pause|resume|delete <page-id> <automation-id> --version <n>
xmatrix page automation attach <page-id> <automation-id> --block <heading-slug>
xmatrix page automation create <page-id> --block architecture --name "Merge review" --every 12h \
  --on merged:<owner/repo>@main --on ci-failed:<owner/repo>:CI -m "@auto repo:<owner/repo> review what changed"
```

- Also run it on events: `--on merged:<owner/repo>[@branch][:path,…]` (a pull request merged into the branch, default the repository's default branch, touching one of the paths), `--on ci-failed:<owner/repo>[@branch][:workflow]`, or `--on owed` (a claim on its section completed or released). The Space's GitHub connection must cover the repository. An event makes it due now; events coalesce, and the occurrence's message names them.
- `xmatrix page read <page-id>` lists the page's Automations under `automations:` with their section and state.
- `@auto repo:<owner/repo>` addresses an Agent for each occurrence. `--every` controls the independent cadence. Use `pwd:"<registered-path>"` instead of `repo:` for a registered directory. The retired `:new` and `:once` launch suffixes are rejected.
- Exact `@<agent>:<channel-instance-number>` addresses an occurrence only to that instance while it is live in the Automation's conversation; other live Agents receive context only. Without an Agent mention an occurrence only posts its text in its conversation; it does not choose or start an Agent.
- Anyone who can edit the page manages its Automations, from any conversation. On a page that takes Agent edits as suggestions, ask a person.
- An Automation runs as its author. Editing someone else's replaces it with one authored by your owner and points the page's reference at it.
- Deleting its reference from the page pauses it (`detached`); `attach` puts the reference back, which resumes it or moves it to another section.
- Use the version from `list` for edit, pause, resume and delete. After a version conflict, re-read and reassess rather than retrying.
