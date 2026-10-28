# Resource counts

A query's batch size must not become a quota on saved resources. The Space
secret implementation originally used `MAX_SPACE_SECRETS = 128` both to refuse
creation and to declare the maximum result size of complete lists. Removing
only creation admission would make larger catalogs fail at the database result
boundary. Neither the schema nor the secret access model requires 128 entries.

The resource-count audit also found silently truncated collections and device
eviction. The following fixed count limits have been removed:

| Resource | Previous behavior | Current behavior |
| --- | --- | --- |
| Space secrets | Refused secret 129; complete reads bounded to 128 | No count admission; complete keyset reads |
| Pinned Channels | Validated/truncated to 200; SQL CHECK also rejected larger arrays | Preserve all pins; authorize Channel IDs in groups of 500 |
| Push devices | Deleted older devices beyond 20; read only 500 recipients and refused retirement beyond 10,000 devices | Preserve registrations; batch recipients, devices and exact retirement evidence |
| Assistant Memory | Silently retained only 80 entries | Preserve all entries that fit its existing snapshot byte budget |
| Shared Memory | Refused a new key beyond 10,000 per workspace | Admission uses the existing encoded-byte budgets |
| GitHub installations | Refused list append after 32 and returned only 32 linker records | Preserve appended installations and read every linker record |
| Page Automations | Reconciliation/deletion failed beyond 200 rows | Process every Page-owned Automation in stable keyset batches |
| Sentry installation bindings | Refused more than 50 Space bindings; uninstall failed above its read limit | No binding count quota; uninstall processes all bindings in atomic batches |
| Discord installation bindings | Refused more than 50 Space bindings; revocation failed above 50 | No binding count quota; revocation processes all bindings in atomic batches |

`resource-pages.ts` supplies internal keyset iteration. Each SQL result remains
bounded and the existing owning transaction deadline still applies. Failure
propagates; callers never receive a successful partial collection. Mutations
keep their existing locks and transaction rollback, including installation
retirement, Page anchoring and device retirement. No public response shapes or
client changes are needed. Secret Run/registration/membership checks,
per-secret approval, ciphertext binding and audit records are unchanged.

This audit covers persistent resource cardinality admission and silent
collection loss. It does not remove request-level array/byte validation,
explicit pagination or preview windows, provider-observed quotas, pending-work
backpressure, recursion/cycle guards, retry budgets or destructive-operation
safety bounds. Those constrain a particular operation or measured storage
budget rather than substituting a fixed count for storage ownership. New
count bounds must describe that operation and must not silently drop saved
resources. Adding an arbitrary larger number is not a repair.

## Migration and recovery

`0225_expand_pin_collection.sql` consolidates the existing array-type and
count CHECKs into one array-type CHECK. Existing rows already satisfy the old
validated type CHECK, so the replacement uses `NOT VALID` to avoid a rescan
while enforcing the same type invariant on every new write. Old writers stay
compatible; optimistic versioning and current Channel visibility checks remain
enforced. It takes a short metadata lock with a five-second timeout;
no stored rows are rewritten or deleted. The migration ledger owns replay.
No other resource requires a data migration. Previously evicted devices and
silently discarded entries cannot be reconstructed; devices register again
through their ordinary signed-in registration flow.

The ordinary exact-tag expand migration step applies this change on each shard.
Release the Hub through Production Release Intent. A recovery build must keep
complete collection reads and accept already-saved large pin arrays; do not
restore the former count constraint after users have saved larger arrays.

## Verification

Real PostgreSQL regressions exercise secret creation past 128, complete
multi-page catalogs and ask approval; 1,001 pins and an unreadable tail;
121 devices and 501 recipients; 101 memory entries and 10,001 small keys;
103 GitHub installations; 251 Page Automations; and installation retirement
across batches. Existing owner suites retain concurrent-save, authority,
provider-evidence, rollback/retry and stale-installation coverage.
