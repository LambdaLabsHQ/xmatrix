# Channel Catalog Sync

This document describes the retained complete-catalog compatibility contract.
The Next Web pagination contract is defined in
[PostgreSQL Channel catalog pagination](postgres-channel-catalog-pagination.md).

`GET /api/channels` remains an authenticated, server-authorized catalog read.
The optional `catalogSyncToken` is only a performance hint: it never identifies
a principal, proves membership, or widens a Channel grant.

## Revision model

For a complete cross-Space response, Hub returns `catalogSync` with an opaque
vector of Space id to Core `commit-sequence`. The sequence is conservative: an
unrelated write may cause an extra Space read, but an unchanged sequence proves
that no Core transaction changed that Space's durable catalog projection.

On a later request Hub always re-reads the caller's authoritative Space
directory, probes the current commit head of every listed Space through an
authorized Core query, and then:

- fully re-reads every new or changed Space;
- names every departed Space in `removedSpaceIds`;
- names every returned complete Space slice in `replacedSpaceIds`;
- omits unchanged Space rows from the response.

The token's sampled revision is retained even if a write races a changed-Space
read. This may cause one redundant replacement on the next request, but cannot
hide the write. Invalid, oversized, unsupported, or unreadable cursors fall back
to the complete catalog path.

## Client coverage

`catalogSync.complete = false` is meaningful only when the client still holds
the complete snapshot named by its request token. The Web client keys that
cursor to the authenticated user, replaces only the named Space slices, removes
only the named departed Spaces, and rejects rows outside the declared coverage.

Runtime presence is not catalog authority and does not advance the durable Core
revision. Retained unchanged rows therefore clear `memberPresence`; the
authenticated Human socket repopulates live presence. Mutations, navigation,
and authorization continue to use the merged complete network catalog, never a
partial or cached presentation.

## Compatibility

Clients that omit `catalogSyncToken` receive the existing complete `channels`
array and may ignore the additive `catalogSync` field. A new client talking to
an older Hub receives no `catalogSync` metadata and treats that response as
complete. Scoped `spaceId` reads remain complete for that Space and do not use
the cross-Space cursor.
