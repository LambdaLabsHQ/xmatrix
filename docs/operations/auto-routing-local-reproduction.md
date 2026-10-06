# Local Auto routing reproduction

Run from a checkout with dependencies installed and PostgreSQL 17 tools on PATH:

```sh
pnpm repro:auto-routing
```

This runs the Agent Launch PostgreSQL test file (command leases, name
maintenance, runtime grants, message acknowledgements and routing preflight
outcomes) against a fresh cluster. Missing PostgreSQL tools or failed tests
are errors, not skips.

The lifecycle migration checks also use a fresh database, with loopback-only TCP
for the local Workerd connection:

```sh
node scripts/run-auto-routing-repro.mjs --lifecycle-connect-retry
node scripts/run-auto-routing-repro.mjs --lifecycle-terminal
node scripts/run-auto-routing-repro.mjs --lifecycle-start-failure
node scripts/run-auto-routing-repro.mjs --lifecycle-scheduled
node scripts/run-auto-routing-repro.mjs --lifecycle-workspace
node scripts/run-auto-routing-repro.mjs --hub-suite
```

These cross the real tagged launch, signed Run credentials and daemon WebSocket
protocol, but use a transport double rather than a child process. The terminal check retains the live
socket shutdown and presence-retirement assertions, including the case where
Agent unregister never arrives.
The scheduled-message check uses the PostgreSQL scheduler and its real alarm
coordinator, then requires a leased daemon spawn without a lifetime flag and with the
same canonical source message ID as the delivered request. Its transport double
reports a startup failure for cleanup; actual child execution and once exit are
not inferred from this test.
The workspace checks retain cross-member discovery, private-field redaction and
outsider denial, then launch through tagged Auto from both Human HTTP messages
and an authenticated Agent WebSocket publication. PostgreSQL's opaque invite
tokens are resolved by their hash in its existing authoritative directory; they
are not accepted as unscoped-control invite tokens, and unknown tokens still fail.

The full Hub `test:ci` gate uses `--hub-suite`, so the migrated lifecycle checks
always receive a fresh, migrated loopback database. PostgreSQL 17 tools must be
installed on the Hub test runner, available on PATH or through `pg_config --bindir`.
Set `XMATRIX_TEST_POSTGRES_BIN` to select an explicit tool directory; all four
tools must report PostgreSQL 17, and an invalid explicit directory has no fallback.
The shared Linux CI Hub job builds PostgreSQL 17.11 from its SHA-256-pinned
official source archive in a unique job temporary directory, then exports that
tool directory. This unprivileged bootstrap does not install a system service or
connect to an existing database. Parser generators, if absent, are extracted from
the runner's configured distro packages without installing them system-wide.
Package indexes refresh into job-local directories with signature verification;
host package-manager hooks and writable system indexes are not used.
The build is limited to two jobs and a 15-minute CI step; failure blocks the gate.
Missing tools fail the
gate; an inherited database URL is never used as a fallback. The existing
process-tree supervisor, suite resource planner and test telemetry remain active.
Linux post-batch cleanup requires a unique batch marker inherited only by that
batch's test descendants. The suite-owned PostgreSQL process has no such marker
and survives between batches; ordinary Actions tracking is not changed. Missing
batch scope fails closed instead of reclaiming all current-job descendants.

To isolate the existing Channel Catalog/message verification, Focus Auto,
Focus-starting convergence and scheduled-timeout PostgreSQL integration files:

```sh
node scripts/run-auto-routing-repro.mjs --hub-postgres-integrations
```

This mode uses the same fresh migrated cluster and requires every selected test
to run; it does not skip failures or reuse an external database.
The message concurrency canary uses the current sequence-reservation authority
before appending, with one checked-out session per message. Its query budget is
three reservation statements plus four append statements (the original three
append statements and the mandatory reservation check). It verifies that all
20 messages committed their matching reservations, then removes and checks both
reservation and sequence rows as part of isolated canary cleanup.

The default runner creates a private temporary PostgreSQL cluster, disables TCP
listening and applies the real project migrations. It overrides database
connection inputs; no production database or Human login credential is used.
The cluster is stopped on completion or test failure, while its data directory
and log remain available for inspection.

Every Run launches under a Space Agent Registration
(`docs/architecture/registration-only-runs.md`). The earlier Profile candidate
query, its quota-exclusion cases and the process-level `--launch` fixture that
chose between server-side Profiles were removed with Profile routing; the
registration launch path is covered by the lifecycle modes above and the Hub
suite.

## Codex quota refresh during long turns

The Codex channel session owns a background quota reader, polling every 60
seconds through the existing provider cache (120-second successful-read TTL).
The whole read is bounded to 15 seconds; requests do not overlap within the
poller. Dropping the session cancels the poller, including an in-flight read.
Unavailable reads publish nothing and do not relabel an old observation as new.

Presence merging and outgoing frames reject quota observations older than the
latest parsed observation timestamp, while retaining independent token updates.
Before this protection, the regression below replaced a newer 100%-used sample
with a long turn's older 20%-used sample. A newer valid observation still recovers.
Hub presentation merging independently rejects older timestamped quota frames,
including frames reordered after client preparation. Legacy unmarked provider
windows retain the existing unknown-freshness behavior and never borrow the
previous timestamp. The Hub regression also failed (20 instead of 100) before
the receiver-side fix.

```bash
cargo test --manifest-path packages/cli-rs/Cargo.toml -p xmatrix-cli-core quota_
cargo test --manifest-path packages/cli-rs/Cargo.toml -p xmatrix-harness quota::refresh --lib
```

The poller tests use a virtual clock and injected readers, not provider credentials.
They cover idle/long-turn independence, unavailable-read recovery, timeout, and
session-drop cancellation. They do not prove that a particular production
account was observed correctly or that an Auto launch selected it correctly.

The authority-backed presence writer also has an executable boundary regression
in `agent-instance-quota-persistence.test.mjs`. Before the fix, it passed only
the message-header projection to `instance_presentation`, dropping all usage;
the routing query reads precisely that missing field. Persist the sanitized
provider windows and their original observation timestamp separately from the
message-header projection. Quota-only changes must invalidate the write digest;
token-only changes must not. This test captures the actual authority command
from the production port, with the authority dependency replaced by a recorder;
it does not substitute for a database-backed launch test or production trace.
