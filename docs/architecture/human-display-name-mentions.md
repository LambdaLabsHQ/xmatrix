# Human display-name mentions

The composer inserts `@Yiming Hu` or `@王力` for a Human with that display name.
PostgreSQL message appends resolve current auth profile names, falling back to the
Space member display name exactly as directory hydration does. They also accept
current handles for existing clients. Email addresses and user IDs are not mention
aliases. Bare Agent display names are harness shouts: the composer offers one `@codex`
(or `@grok`, `@claude`, …) per Space, routing picks the machine, and message
append does not reject repeated Agent names as ambiguous. Repo and working-dir
suffixes after `:new` / `:once` stay. Instance command syntax (`:reborn`,
`:handoff`, `@codex:2`) is unchanged. A unique handle still disambiguates Humans.

Names are case-insensitive and longest matches win. Only members who can read the
Channel contribute candidates. If a matched token belongs to multiple Humans, or
collides a Human with an Agent, append fails with the existing
`attention_target_ambiguous` error before committing message facts. A unique handle
can disambiguate. Unrelated duplicate names do not prevent ordinary messages or
broadcasts. Web rendering leaves ambiguous tokens as text, retaining those tokens
in the scanner so a shorter name cannot receive an ambiguous longer mention.
Broadcast names (`everyone`, `channel`, `all`, `here`) retain broadcast semantics;
completion never inserts one as a Human name, using their handle instead.

Stable subject IDs still own authorization, committed attention and read cursors.
Renaming does not rewrite message bodies or committed attention. Client chips use
the current directory and are not a historical identity snapshot. Handle profile
editing and persistence remain supported; this change does not remove that data.

## Compatibility and rollout

No schema or wire-field migration is needed. Release the PostgreSQL resolver before
or together with the Web composer: older servers recognize only handles. Older
clients continue sending handles accepted by the new resolver. Native clients
using the shared Web composer inherit its behavior; CLI and AI authors may write
display names directly once the server is updated. Legacy SQLite compatibility
resolvers remain unchanged and are not the active PostgreSQL message commit path.
Production release remains subject to the repository release workflow.
