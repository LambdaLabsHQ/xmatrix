# A Page's Schedules

A schedule is a standing rule that keeps one page section true: "every 12
hours, have a fresh Agent audit the code and update this section". It is a
line of that section, written as Obsidian Tasks writes a recurring or
scheduled task, and changed with `xmatrix page edit` like any text. Each
occurrence runs in a fresh conversation linked to the section, as whoever last
changed the line (an Agent as its owner), so it keeps running after the Run
ends. What one occurrence leaves for the next belongs on the page, not in its
conversation.

```markdown
## Architecture
- [ ] @auto repo:<owner/repo> audit duplication and update this section 🔁 every 12 hours
- [ ] @auto repo:<owner/repo> review what changed 🔁 every day, on merged:<owner/repo>@main, on ci-failed:<owner/repo>:CI
- [ ] Remind me to renew the domain ⏳ 2026-11-03 09:00 +08:00
- [-] @auto repo:<owner/repo> sweep Sentry 🔁 every week
```

- `🔁 every <n> <minutes|hours|days|weeks>` (or `every day`, `every 12h`) is the cadence, from 15 minutes to 30 days.
- After it, `, on merged:<owner/repo>[@branch][:path,…]`, `, on ci-failed:<owner/repo>[@branch][:workflow]` or `, on <app>:<event|*>[:<source>]` also run it on those events. The Space's connection must cover the repository or app. An event makes it due now; events coalesce, and the occurrence's message names them.
- `⏳ <date> <time> <offset>` alone runs it once, as a reminder that waits on its author; once delivered its line becomes `- [x] … ✅ <day>`. Give it a new time and `[ ]` to remind again. With `🔁`, `⏳` sets when its first occurrence runs.
- `[ ]` runs, `[-]` pauses, `[x]` is done; deleting the line deletes the schedule.
- `@auto repo:<owner/repo>` addresses an Agent for each occurrence. Use `pwd:"<registered-path>"` instead of `repo:` for a registered directory. Each occurrence's conversation is new, so an exact `@<agent>:<channel-instance-number>` finds no live instance there; other live Agents receive context only. Without an Agent mention an occurrence only posts its text.
- `page edit` prints a schedule line that cannot run as written, with why.

```bash
xmatrix page read <page-id>                      # schedules under automations:
xmatrix page automation list <page-id>           # section, state and line of each
xmatrix page automation run <page-id> <id>       # due now; its cadence stays
xmatrix page automation pause|resume|delete <page-id> <id>   # changes its line
```

- Anyone who can edit the page manages its schedules. On a page that takes Agent edits as suggestions, ask a person.
