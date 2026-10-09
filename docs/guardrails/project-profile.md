# Project Profile

This file is a descriptive snapshot, not policy. The only canonical project rules are the ten P0/P1/P2 guardrails in `project-guardrails.md`; statements here and in the linked snapshots document the current implementation and cannot add or override a guardrail.

## Overview

This repository implements xMatrix, the multi-agent coordination/runtime layer. xMatrix is a multi-agent coordination system for AI coding agents and humans. It connects agents such as Codex, Claude Code, Kimi, Cursor, Aider, and Windsurf through shared channels backed by a relay hub. The same repository ships the Web dashboard, Cloudflare Hub, Rust CLI/daemon, protocol package, native shells, release automation, and deployment scripts.

Agents run on the subscriptions and credentials their users supply; Space
billing is independent of compute.

## Default Documentation Language

English is the default language for repository documentation, guardrails, release docs, and tool instructions. Chinese may be used for existing Chinese design notes or when maintainers explicitly ask for Chinese output.

## Current behavior

The Web composer previews Jev's summon intent while typing, with mention bands
and a declined-mention explanation and Start anyway option at the address. Human-confirmed readings travel with the exact message;
launch authorization remains server-owned, and unread or unavailable previews
retain post-send checks. See [invocation status](../design/mention-invocation/README.md).

Windows Agent children enforce UTF-8 transport settings and use managed PowerShell
entrypoints that initialize console and pipeline encoding for each command. See
[Agent text encoding](../design/agent-text-encoding.md).

The component map is `docs/ARCHITECTURE.md`. The rest of this snapshot is split into the files below. They keep the previous text.

- [Repository map](profile-repository-map.md)
- [Architecture boundaries](profile-architecture-boundaries.md)
- [Public interfaces and domain contracts](profile-public-interfaces.md)
- [Security-sensitive areas](profile-security.md)
- [SQL, clients, and local replicas](profile-clients.md)

Message syntax and execution selection use the [message interaction protocol](../design/message-interaction-protocol.md), with a shared TypeScript/Rust grammar and domain-owned authorization.

Cross-machine handoff stops the exact source Run and Instance even when it
has already exited, ending its rest before the successor can wake it with a
reply. The daemon exports the exact retained checkout or its eviction snapshot
without a live child registry row, preserving uncommitted work under the pool
guard. This requires the updated CLI; stale retained authority is refused.
Stop issuance failures refuse the handoff; a durable stop may still
await its daemon report. See [instance handoff](../same-machine-instance-handoff.md#22-moving-to-another-machine).

Machine startup failures preserve bounded, credential-redacted originating causes in
Channel notices and invocation details; Git retry classification does not replace stderr.
Machine startup failures remain visible as idempotent Channel notices even if
the Launch has already failed its Run. Public invocation details retain the originating
repository preparation error; subsequent stop cleanup
preserves the failed-startup outcome. See [invocation status](../design/mention-invocation/README.md).

Teams native integration uses a company home-tenant Bot, Human admin confirmation and primary PostgreSQL room grants, alongside explicit outbound-only manual webhooks. Its supported scope, canonical release configuration and evidence requirements are documented in [Teams native contract](../connectors/teams-native.md). Company identity and native acceptance remain external prerequisites.

New repository tasks confirm the remote default branch on every independent
launch, sharing only simultaneous checks. Invocation details retain actual
baseline evidence; continued tasks preserve their recorded checkout and warn
only on proven base divergence. Local shared Git objects are not purged by this
feature. See [repository preparation](../daemon-service-model.md#repository-snapshot-preparation).

Channel About sessions submit summary/title text directly through Hub using
CLI arguments or bounded JSON stdin; they do not stage local files. Their
own-Channel authorization and immutable database revision/input evidence are
unchanged. See [Channel metadata revisions](../design/channel-metadata-revisions.md).
