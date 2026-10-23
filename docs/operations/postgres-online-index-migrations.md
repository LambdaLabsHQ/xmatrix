# Online PostgreSQL index migrations

The Production Release Intent train still applies the exact tag's expand
migrations on both existing shards before deploying a Hub that uses them.
Ordinary migrations retain their transactional ledger and 25-second statement
deadline. Application read deadlines and commit recovery rules do not change.

A migration beginning with `-- xmatrix:online-indexes` contains only named,
non-unique `CREATE INDEX CONCURRENTLY` statements on `control` or `data` tables,
up to eight indexes. PostgreSQL's parser rejects mixed statements, implicit
schemas, duplicate names, unique indexes and `IF NOT EXISTS`. Contract migrations
cannot use this mode. No dashboard or separate deployment command is involved.

The migrator holds the existing migration advisory lock at session scope across
the build's internal commits and final ledger transaction. Before building each
index, it reserves an absent name in `control.schema_migration_index_builds`,
binding the migration checksum, exact statement checksum and target table.
Each concurrent build has a ten-minute server deadline and a slightly longer
driver deadline; lock acquisition still has five seconds. The production
verification job's existing fifteen-minute total limit remains in force.
Long scans do not take the ordinary index build's lock against concurrent writes.
Migration lock contenders use bounded try-lock polling between SQL statements;
a blocking advisory-lock SELECT would retain a snapshot the concurrent build
needs to drain and can deadlock with its owner.

After construction, the migrator checks readiness, validity and target identity,
then marks the index with its exact build identity. Only after all builds pass
and target-table analysis collects expression selectivity does the usual
transaction commit runtime grants and the migration receipt.
A partial build is not a completed migration. On retry, an exact marked, valid
index is reused. A durable matching intent may remove and rebuild its unmarked
or invalid index, covering interruption between CREATE's internal commits and
the marker. A pre-existing name without an intent, changed checksum, foreign
marker, unique/exclusion index or different target fails closed. No unrelated
index is adopted or removed. Failed attempts retain their intent for recovery.

Recovery evidence for the first use: the original transactional Channel replay
index migration exceeded the production DDL deadline and rolled back. Both
shards had neither its ledger receipt nor any of its three indexes before the
source was changed into a reservation-table migration followed by an online
index migration. An already-applied checksum must never be edited; the normal
ledger reconciliation still rejects that case. Release run identifiers and
read-only verification evidence belong in the fixing PR and conversation.
