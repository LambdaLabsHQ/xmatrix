# Repository duplicate-code check

`pnpm check:duplicates` runs one whole-repository gate. It requires **zero clones**,
with a shared minimum of five lines and fifty tokens for all scanned languages.
The detector covers program and template source, tests, workflow YAML and
extensionless shell hooks. It enumerates tracked files and new files that Git
has not ignored; a tracked source file cannot disappear from the check merely
because a local ignore pattern matches it.

JSON/TOML configuration, protocol registry data, lockfiles, prose and diagrams
are not program implementations for this text-clone check. Their consumers,
schema checks and compatibility tests validate their contents. In particular,
shared protocol registries stay canonical data consumed by both TypeScript and
Rust; repeated standard manifest fields do not justify a new generation layer.

Only generated dependencies, build/release output, generated Android web assets
and Gradle wrappers, and immutable database migrations are excluded from the
source scan. Historical migrations are left unchanged. There are no source-file
exceptions or annotations to hide clones.

The Node wrapper passes actual infinite size and line bounds to jscpd's API;
leaving these fields out of a CLI configuration would restore jscpd's defaults
of 100 KB and 1,000 lines. It also checks the clone count directly so a small
nonzero percentage rounded to zero still fails. Inline ignore markers are
rejected before detection. A shell hook without a filename extension is scanned;
another extensionless executable must identify its language with an extension.

The wrapper initializes the source languages present in the repository before
detection. Related Prism grammars mutate their parent language tables during
initialization; completing that work first makes lexing independent of which
source file happens to be visited first.

CI runs the `duplicates` partition independently from product tests. Every
nonempty repository change selects it, including newly introduced languages and
extensionless files. The aggregate required check fails if this partition does
not pass. The content ledger can reuse a result only for the same repository
content. There is no separate large-file tolerance or weaker Rust/test gate.
