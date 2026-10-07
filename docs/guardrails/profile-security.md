Part of the descriptive project profile. Not policy. The index is `project-profile.md`. The ten guardrails in `project-guardrails.md` override this file.

## Security-Sensitive Areas

- Auth and device login in `packages/hub/src/index.ts` and `packages/hub/src/device-auth.ts`.
- Durable Object relay authorization, channel access, agent session registration, daemon filtering, message fanout, and attachment handling in `packages/hub/src/relay.ts`.
- Relay V2 authority/projection design, private R2 manifests, local search-replica authorization, purge, and media-cache boundaries in `docs/architecture/relay-storage-summary-zh.md` and their future Hub/Web/daemon implementations.
- External runtime process launching and environment handling in `packages/cli-rs/crates/runtime/src/lib.rs`.
- Provider credential reading (Claude keychain/credentials file, Codex and Grok `auth.json`, Cursor and OpenCode logins, Z.ai keys) for account-quota probes in `packages/cli-rs/crates/harness/src/quota` and `packages/cli-rs/crates/harness/src/claude_credentials.rs`; tokens stay in memory and only one-way fingerprints are used as cache keys.
- Native bridges in `apps/desktop/src`, `apps/ios/xMatrix`, and `apps/android/app/src/main/java/sh/xmatrix/app`.
- GitHub Actions release and runner-administration workflows/scripts that handle signing keys, App Store Connect credentials, Cloudflare credentials, Supabase keys, Android keystores, GitHub release tokens, runner scaler tokens, SSH authorization, Xcode installation, and CLI binaries.
- Prompt/agent control paths in the CLI app-server integrations and channel-delivered message text.

### Machine approval encryption independence

Plain PostgreSQL machine-request decisions do not require the Secret catalog encryption key.
The server still binds decisions to the owning user, machine, host, pending request and expiry.
Secret-bearing request decisions require the catalog key, including replayed decisions.
New decision replay digests use SHA-256 with the `xmatrix-machine-request-decision-v2` domain
and retain the existing 64-character storage format. When the original key is available,
legacy HMAC decision digests remain readable; missing keys never authorize legacy replay.
Machine notice ingestion already persists plain requests through the machine control authority.
Secret catalog reads, writes and grants continue to require their dedicated encryption material.

### Human display-name mentions

Human `@` completion inserts the current display name, including spaces and CJK.
The PostgreSQL message transaction resolves that name against currently visible
Channel members using the same current auth profile name as the Space directory.
Existing handles remain accepted aliases. Ambiguous names are rejected only when
actually mentioned; unrelated duplicate names do not block a message. Broadcast
words retain their existing meaning and completion uses the handle for a person
whose name is a broadcast word. IDs remain internal identity, authorization and
read-cursor keys, not text the author must insert. See
`docs/architecture/human-display-name-mentions.md` for compatibility details.

The Channel's pending approvals area above the composer lists the owner's open
cross-Space read requests, independently of message pagination.

### Parent-channel thread previews

Parent message rows show the latest two non-root thread replies, in chronological
order, followed by the reply count and View in thread entry. Human, Agent, and App
replies all participate. These are read-only previews of the child Channel, whose
access checks remain server-side. The existing bounded history summary now selects
the latest replies; Web also merges replies from its authorized thread cache.
The schema is unchanged; deploy the Hub and Web changes together for consistent
preview selection. Recalled replies use a placeholder and attachment-only replies
show an attachment count.

Agent history reads now present the stored
Summary and exact parent-message-to-thread references from the authorized active
Channel catalog. Context refreshes independently of cached transcript records;
see [Channel Agent read context](../architecture/channel-agent-read-context.md)
for consumer coverage and additive compatibility.

About metadata writes recheck the exact Channel-bound registration Run inside
the PostgreSQL transaction and use server-recorded input revisions for CAS.
Historical metadata and input evidence use current Channel content permissions;
restoration preserves prior revisions. About catalog reads return only their
own Channel. See [Channel metadata revisions](../design/channel-metadata-revisions.md).
