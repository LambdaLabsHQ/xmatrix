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

`ci.yml` uses the existing private labels by default in private repositories.
Short shared checks (`changes`, `node-checks`, `desktop`, and the aggregate)
use `xmatrix-ci-offload`; product partitions use `xmatrix-ci-linux`. This keeps
an available short-check runner useful while the long-test pool is occupied.
In public repositories it defaults to `ubuntu-24.04` and `windows-2025`.
Reusable callers can set `linux_runner`, `offload_runner`, and `windows_runner`
to a JSON runner label or array, for example `'"ubuntu-24.04"'`. These inputs
select compute only; they do not change the tests or release authorization.
Hosted jobs always execute their checks rather than reusing the private CI
ledger.

`public-ci.yml` runs the full shared matrix on a public snapshot's `main` push.
Its manual dispatch also verifies that path in the private repository. A
private `main` push skips this workflow's only job. Public PRs use `ci.yml` and
its hosted defaults, including the aggregate `ci` result.

The public snapshot must keep both workflows, the local composite setup
actions they reference, and their scripts. Exclude private runner maintenance,
CI ledger recording, credential-bearing deployment and release workflows from
the snapshot. `node scripts/public-snapshot.mjs <destination>` applies that
filter. It also drops contract tests that read the excluded workflows and
rewrites `knip.jsonc` so the snapshot's Node gate does not refer to removed
files. The external pull-request closer stays, because the snapshot takes
prompt requests. Hosted validation requires no production secrets: Hub tests
bootstrap isolated PostgreSQL tools, Web uses the existing browser fixtures,
and native tests use the pinned toolchains. Signing and production publication
remain governed by the agent release workflow.

The root `db:generate`, `db:migrate` and `db:studio` Drizzle commands were
removed because `@xmatrix/db` no longer uses Drizzle. Use its `check` command
for migration validation and the documented PostgreSQL release path for
applying migrations.

## Deny scan

In the public repository, `.github/workflows/deny-scan.yml` runs
`node scripts/deny-scan.mjs` on every pull request and push to `main`. It reads
every tracked file and refuses credentials (private keys, provider tokens, live
Stripe keys) and the official deployment's identifiers. The identifiers come
from the repository secret `XMATRIX_DENY_IDENTIFIERS` (a JSON array or one per
line, each at least 6 characters), so the list itself is never public. The job
fails closed when the secret is unreadable, which includes pull requests from
forks. Findings name the file and a redacted value only. The public snapshot
export runs the same scan on the exported tree. The private repository skips
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
