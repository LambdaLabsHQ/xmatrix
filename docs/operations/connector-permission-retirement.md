# Connector permission retirement

The maintainer replaced Channel/per-action rules with one Space-connection
permission on October 28, 2026. `read` permits reads and blocks all mutations;
`ask` permits reads and asks a Space admin before each mutation; `write` permits
both directly. NULL inherits the app's one manifest default. This is a product
permission, independent of Google OAuth consent, provider capabilities, current
Run/Channel access, mailbox ownership and approval account/version fencing.

Calendar defaults to write. Gmail, Google Ads, X and Linear default to ask.
Other writable apps default to write, and read-only apps to read. GitHub has no
approval executor and rejects ask. Configuration is Human-admin-only; every
mutation rechecks the uncached permission immediately before provider I/O.
The connection owns the durable value, so deleting it removes the setting.

## Rollout and recovery

1. Independently inventory both production databases using read-only queries.
   Count old rules by provider/mode and Space/Channel cardinality, without
   reading credential values or message content. Record evidence in the work
   conversation/PR, not on a Page. The observed inventory was seven allow rows
   and zero restrictive rows on the primary, zero rows on shard 1.
2. Apply expand migration 0226, adding nullable `permission_mode`. It takes the old table's write-conflicting lock and independently
   rejects any non-allow row. If the live inventory changed, stop and prepare
   a restrictive-rule conversion; never erase it or guess wider authority.
   A NOT VALID false check freezes old INSERT/UPDATE writers. The seven redundant allow rows remain
   intact as evidence while the old Hub drains. Old policy updates now refuse.
3. Deploy the new Hub and Web through the normal beta train. The new executor,
   permission API, cleanup paths and X durable-upload authorization never read
   or write the retired table. Old Channel/action request bodies return 400;
   they cannot silently become Space-wide grants. The Web shows only the one
   setting. Verify real read/ask/write behavior and absence of old runtime use.
4. After that release is verified, apply and release contract migration 0227 to drop
   the old table and its freeze constraint. No old rule writer/reader or fallback
   remains. The temporary frozen-table test classification is removed too.
   Historical applied migrations retain their original bytes.

The initial NULL column is compatible with the previous Hub during expansion;
new settings are exposed only alongside the new Hub. Once users configure the
new permission, recovery must use the new executor (or a CI-validated forward
fix). Deploying an old Hub would ignore it and is not a valid rollback. Do not
unfreeze old policy writers or recreate their authority after retirement.

Tests at the PostgreSQL boundary protect admin ownership, reset/inheritance,
connection deletion and durable uploads; migration tests retain restrictive
rows on refusal and prove that frozen writers cannot change the snapshot.
HTTP tests reject Agent tokens and obsolete request shapes. Existing dispatch
cases cover ask, direct scheduling and permission changes during preparation.
