# Project Profile

This file is a descriptive snapshot, not policy. The only canonical project rules are the ten P0/P1/P2 guardrails in `project-guardrails.md`; statements here and in the linked snapshots document the current implementation and cannot add or override a guardrail.

## Overview

This repository implements xMatrix, the multi-agent coordination/runtime layer. xMatrix is a multi-agent coordination system for AI coding agents and humans. It connects agents such as Codex, Claude Code, Kimi, Cursor, Aider, and Windsurf through shared channels backed by a relay hub. The same repository ships the Web dashboard, Cloudflare Hub, Rust CLI/daemon, protocol package, native shells, release automation, and deployment scripts.

Agents run on the subscriptions and credentials their users supply; Space
billing is independent of compute.

## Default Documentation Language

English is the default language for repository documentation, guardrails, release docs, and tool instructions. Chinese may be used for existing Chinese design notes or when maintainers explicitly ask for Chinese output.

## Current behavior

Device pushes share a bounded outbound delivery profile across Web Push, APNs
and FCM, including OAuth refresh, response decoding and notification fan-out.
Delivery accounting and diagnostics share a finite outcome table; push logs
contain fixed reasons and device kinds, never raw exceptions or private inputs.
Registration lookup and retirement share one capacity; gone registrations are
deleted completely in bounded, atomic SQL chunks rather than silently truncated.
See [device push delivery](../operations/push-delivery.md).

The operational activation report reads registration cohorts across all currently
placed PostgreSQL shards and emits aggregate message, first-reply, Page and
second-week activity counts. External users require explicit classification;
unknown accounts stay separate from team/test accounts. See
[activation report](../operations/activation-report.md).

The public user guide includes a local-folder walkthrough for creating and
updating a first project wiki with Claude Code or Codex, linked from the homepage.
Its source is [the project wiki guide](../guide/project-wiki.md).

The Google Cloud operations connector uses a separate GCP OAuth grant and
provides bounded resource, Cloud Run status, log, metric and alert-policy reads,
plus direct App Optimize gross-cost reports, billing/export discovery and
parameterized cost/credit analysis, public SKU attribution, bounded daily or credential/method API request counts, secret-free API key metadata and historical audit-principal summaries. Caller evidence distinguishes key IDs, key administrators and actual inference identities. Explicit quota project selection preserves Google IAM and the same OAuth grant. Temporary report creation and API enablement is a separate policy-controlled write; no IAM grants are changed.
Monitoring incident edges route by metrics-scope project through authenticated
per-connection ingress. See [GCP connector](../connectors/gcp.md).

The Web composer previews Jev's summon intent while typing, with mention bands
and a declined-mention explanation and Start anyway option at the address. Human-confirmed readings travel with the exact message;
launch authorization remains server-owned, and unread or unavailable previews
retain post-send checks. See [invocation status](../design/mention-invocation/README.md).

Windows Agent children enforce UTF-8 transport settings and use managed PowerShell
entrypoints that initialize console and pipeline encoding for each command. See
[Agent text encoding](../design/agent-text-encoding.md).

The component map is `docs/ARCHITECTURE.md`. The rest of this snapshot is split into the files below. They keep the previous text.

Automatic repository selection passes optional GitHub project descriptions
alongside repository names to Jev, bounded per choice. Names and current task
context remain semantic evidence; recent repository activity does not determine
relevance. Explicit repository constraints retain their existing launch path.
See [Space agent routing](../architecture/space-agent-routing.md).

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

### Search Console ownership and management

The Search Console connector covers the Search Console and Site Verification API
methods through typed actions. New OAuth grants request webmasters plus
siteverification; existing webmasters grants remain usable and refreshable,
while verification requires a new consent. Verification records are public,
separate from OAuth credentials, and are published through the site's own DNS or
website workflow. Advanced analytics supports validated JSON, Pacific calendar
dates, filters, explicit offsets and fresh/hourly data within bounded calls.
See [app connectors](../operations/app-connectors.md) for onboarding and policy.
