# Lint gates and public CI

`scripts/ci.mjs` is the shared validation entrypoint. The `node-checks`
partition runs Oxlint on tracked JavaScript and TypeScript, including tests and
scripts. The Linux `rust-cli` partition runs Clippy on the complete workspace
and all targets before the full Cargo suite. Native Windows still runs the full
Cargo suite. Install the pinned Rust 1.96.0 toolchain and its `clippy` component
before running the Rust partition locally.

Run the lint gates independently with `pnpm lint:check` and `pnpm lint:clippy`.
Oxlint's configuration is `.oxlintrc.json` (exact version pinned in the
lockfile); Clippy's thresholds are in `packages/cli-rs/clippy.toml`. Both
gates fail on any warning: there is no frozen-debt allowance, so fix the source.
A deliberate exception is a `#[expect(lint, reason = "…")]` or an
`eslint-disable-next-line` comment that says why. The existing Web ESLint rules
remain available through its package's lint command.

## Hosted runners

`ci.yml` defaults to GitHub-hosted `ubuntu-24.04` and `windows-2025`.
The public repository has no self-hosted runners. Hosted Hub validation uses
one static job and three test-file shards; Web uses one primary job and four
functional browser shards. Together with Node, desktop, Android, both Rust
jobs, the selector and aggregate, the full matrix has 16 jobs.
Reusable callers can set `linux_runner`, `offload_runner`, and `windows_runner`
to a JSON runner label or array, for example `'"ubuntu-24.04"'`. These inputs
select compute only; they do not change the tests or release authorization.
Hosted jobs use the same content-addressed CI ledger as release gates; a
missing or unreachable ledger runs the complete selected checks.

`public-ci.yml` runs the full shared matrix on a public snapshot's `main` push.
Its manual dispatch also verifies that path in the private repository. A
private `main` push skips this workflow's only job. Public PRs use `ci.yml` and
its hosted defaults, including the aggregate `ci` result.

The repository keeps CI, the content ledger, release workflows and their local
composite actions together. External pull requests are closed in favour of
prompt requests. Hosted validation requires no production secrets: Hub tests
bootstrap isolated PostgreSQL tools, Web uses the existing browser fixtures,
and native tests use the pinned toolchains. Signing and production publication
remain governed by Production Release Intent and its immutable release train.

The root `db:generate`, `db:migrate` and `db:studio` Drizzle commands were
removed because `@xmatrix/db` no longer uses Drizzle. Use its `check` command
for migration validation and the documented PostgreSQL release path for
applying migrations.

## Windows compile cache

Native Windows CI archives kache's artifact store and SQLite index after
trimming the store to 640 MiB, stopping its job-local writer, and waiting up to
45 seconds for that process to exit. Cargo finishing alone does not stop the
writer: archiving its live root previously failed with tar's "file changed as
we read it" error while the test job still succeeded. Coordination files,
locks and logs are excluded. Restore and save use identical payload paths.

The `kache-Windows-test-v2-` namespace starts this payload format with a cold
build; it does not restore the old live-root archives. Main refreshes the
cache, and a PR seeds it when no cache for its lockfile was restored, including
when it only found a different lockfile's fallback. Existing pruning retains
one entry per ref and lockfile and removes closed PR caches. These caches save
compilation work; the required native suite still runs on the selected content.

## Deny scan

In the public repository, `.github/workflows/deny-scan.yml` runs
`node scripts/deny-scan.mjs` on every pull request and push to `main`. It reads
every tracked file and refuses credentials (private keys, provider tokens, live
Stripe keys) and the official deployment's identifiers. The identifiers come
from the repository secret `XMATRIX_DENY_IDENTIFIERS` (a JSON array or one per
line, each at least 6 characters), so the list itself is never public. The job
fails closed when the secret is unreadable, which includes pull requests from
forks. Findings name the file and a redacted value only. The private repository skips
the job, since it legitimately holds the values the scan refuses.

## Shared Linux host admission

Before `scripts/ci.mjs` starts validation subprocesses on a shared Linux host,
it acquires a host-wide flock slot under `~/.cache/xmatrix/ci-host-slots`.
All runner directories and local worktrees owned by that user share this pool:
one slot below eight logical CPUs, two slots on larger hosts. Starting a new
check also requires two idle logical CPUs (one on a single-CPU host), CPU PSI
`some avg10` below 10%, and at least 4 GiB available memory. Missing readings
fail closed. Admission waits at most 20 minutes, then fails the check with the
observed pressure; it never skips tests or bypasses the required gate.

The slot is held until validation and process-tree cleanup finish. Descendants
inherit an independent batch tag; if an owner dies and leaves children, the
next waiter cannot reuse its slot until those children exit. Hub retains its
separate per-file slot pool and adaptive admission. GitHub-hosted VMs and
non-Linux validation keep their existing paths. Runner labels, deployment
routes and signing do not change. Direct build commands outside `ci.mjs` and
production artifact builds do not participate in this cooperative pool.
