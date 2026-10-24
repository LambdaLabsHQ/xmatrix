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

## CI tiers

CI validates in two tiers, chosen in one place: the `changes` job of `ci.yml`
(its `tier` output). Pull request CI is the fast tier, a pre-merge check whose
jobs each finish in about two minutes including setup:

- `node-tests`: Oxlint, synchronized versions, dependency reachability,
  unused imports, duplicate CSS rules, the source line limit, and the
  protocol, billing, PostgreSQL package and script tests;
- `node-tests (duplicates)`: the duplicate-code scan, on its own runner;
- `web-unit`, `web-build` and `web-check`: the Web unit tests, the production
  build, and the lint and typecheck that build would run (`next typegen`, then
  `tsc`, beside `next lint`); in the full tier the checked build stays the
  authoritative Web lint and typecheck;
- `hub-check`: the Hub typecheck and its deploy bundle;
- `rust-clippy`: Clippy on the complete Rust workspace and all targets.

A release train runs the full tier for what it ships. Every train runs the
protocol, billing, PostgreSQL package and script tests and the duplicate-code
scan again on the merged revision, and a train that ships the Hub runs the Hub
suite. Pull requests run the Node tests and the duplicate scan too: a change
that fails them only after merge fails the train for every change riding it.
The Web suites (the
checked build, browser shards and performance budget) and the client suites
(the Rust tests on Linux and Windows, Desktop, Android and the iOS simulator
gate) gate the stable train that ships them, not each beta: a beta Web or
client reaches only the people on the beta Web, its dev channel or TestFlight,
its pull requests checked it and the release builds it (`scripts/ci-areas.mjs`,
`releaseOutputs`). Merging runs nothing more.
Only full-tier jobs carry ledgered names (`scripts/ci-ledger.mjs`), so a release
reuses only results the full tier earned and still blocks on every gate its
scope and channel select.

## Hosted runners

`ci.yml` defaults to GitHub-hosted `ubuntu-24.04` and `windows-2025`.
The public repository has no self-hosted runners. In the full tier, hosted Hub
validation uses one static job and four test-file shards; Web uses one primary
job, four functional browser shards and a performance job. The primary job runs
the unit tests and checked production build; the performance job starts
alongside it on its own VM with one worker. Unsharded local runs still execute
every performance case. The Node checks and the duplicate scan run as two jobs
beside each other. Together with Desktop, Android, both Rust jobs, the selector
and aggregate, the full matrix has 19 jobs. The primary job also saves its
Next.js and Turbo build caches without waiting for browser sampling to finish.

Each hosted job carries PNPM's lockfile supply-chain verification record
(`lockfile-verified.jsonl`) in the Actions cache, keyed by the lockfile, the
workspace policy files and the PNPM version. PNPM itself skips its per-entry
registry check only for a lockfile with the same content hash verified under a
policy at least as strict; any other lockfile or policy is checked in full.
Reusable callers can set `linux_runner`, `offload_runner`, and `windows_runner`
to a JSON runner label or array, for example `'"ubuntu-24.04"'`. These inputs
select compute only; they do not change the tests or release authorization.
Hosted jobs use the same content-addressed CI ledger as release gates; a
missing or unreachable ledger runs the complete selected checks.
The Node job queries that dependency-free ledger before bootstrapping PNPM or
installing workspace dependencies. A hit finishes without installation; a miss
or unavailable ledger installs dependencies and runs its tier's Node checks as
usual.

The reusable workflow's optional `ref` accepts only its triggering commit or
that commit's verified release stamp. Each job first checks out the triggering
revision and uses its dependency-free release verifier before switching to the
target. A different source, extra code change, or malformed ref fails before
target code or local actions can execute in the caller's cache scope. The
Production Release Request caller already supplies this exact stamped child;
public main and PR validation keep testing their triggering revision.

Changes to `packages/db` select Node, Web/browser and Hub validation because
both products consume the shared database package. Database unit tests alone
do not validate the Hub's message coordination and authority fixtures.

`public-ci.yml` runs the full shared matrix on manual dispatch. Public PRs use
`ci.yml`'s fast tier and its hosted defaults, including the aggregate `ci`
result.

The repository keeps CI, the content ledger, release workflows and their local
composite actions together. External pull requests are closed in favour of
prompt requests. Hosted validation requires no production secrets: Hub tests
bootstrap isolated PostgreSQL tools, Web uses the existing browser fixtures,
and native tests use the pinned toolchains. Signing and production publication
remain governed by Production Release Intent and its immutable release train.

The shared Node setup bootstraps pinned PNPM with at most three npm install
attempts for recognized connection, timeout, DNS and transient HTTP errors.
Each registry request has a 60-second timeout; npm's nested retries are disabled
and the outer retries wait two and four seconds. Authentication, package
integrity, permissions, disk and other install failures stop immediately.
PNPM enters the job's PATH only after installation and its version probe succeed.
This recovery applies only to package-manager bootstrap, never validation or
deployment failures.

CodeQL scans before a release ships, not on pull requests or merges. Each
release train runs CodeQL's security-extended queries on its frozen source for
the languages its components are written in, plus the workflows that release
them (`codeql` in `production-release-request.yml`; languages from
`codeqlLanguages` in `scripts/release-train.mjs`). Swift builds on macOS with
autobuild; the other languages use build mode `none`. Results upload as code
scanning alerts on `main` under the same `/language:<name>` categories GitHub's
default setup used, which must stay disabled: GitHub refuses a workflow's
upload while default setup is on. The analysis has to finish before the train
ships; its findings are alerts, not a gate verdict.

CLI release builds run both macOS architectures in parallel on isolated hosted
VMs. When `XMATRIX_RUNNER_FLEET=self-hosted`, macOS builds remain serialized
across architectures and release runs because runner services can share the
user's Keychain search list. Signing identities, per-build isolated keychains,
artifact verification and publication gates use the same paths in both fleets.

The root `db:generate`, `db:migrate` and `db:studio` Drizzle commands were
removed because `@xmatrix/db` no longer uses Drizzle. Use its `check` command
for migration validation and the documented PostgreSQL release path for
applying migrations.

## Windows compile cache

Windows CI and CLI release first fetch the locked dependencies for
`x86_64-pc-windows-msvc`. Recognized transient curl and HTTP transfer failures
receive at most three attempts, each bounded to two minutes, with five seconds
between attempts. Lockfile, authorization, checksum and process failures stop
immediately. Subsequent Cargo metadata, compilation and tests use the fetched
registry offline; compiler, build-script and test failures are never retried.

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

Windows handoff coverage follows the daemon's monitor retries under a five-second
test deadline, since process queries can be transiently denied during teardown.
An exclusive status-file reader also forces a restoration failure: the handoff
must retain the original Run, emit no terminal report on any sweep, and restore
its PID, status and adoption evidence after the reader releases the file.

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
