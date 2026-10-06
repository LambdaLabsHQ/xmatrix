# Repository Guardrails

This is the canonical entrypoint for repository policy. The repository has exactly ten project guardrails, organized as P0, P1, and P2 in `docs/guardrails/project-guardrails.md`.

`docs/guardrails/project-profile.md` describes the current repository, and `docs/guardrails/review-sources.md` records refresh evidence. They provide context but do not add rules or override the ten canonical guardrails.

## Branches

Branches on this repository are created with `gh workflow run new-branch.yml -f name=<branch>`, which makes the branch at the current main; a push cannot create one. A branch then moves only by fast-forward, so bring in main with a merge, not a rebase and force push. This keeps a checkout that still holds the private history from publishing it.
