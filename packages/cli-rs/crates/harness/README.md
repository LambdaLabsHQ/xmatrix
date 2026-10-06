# xmatrix-harness

`xmatrix-harness` is a Rust library for the facts an agent harness reports
about itself. It covers Claude Code, Codex, and agents that speak the Agent
Client Protocol (ACP), such as Kimi, Grok, Cursor, and OpenCode. Its outward
contract follows the boundary of the npm `@botiverse/oar` (Open Agent Runtime)
library:

- **Normalized usage.** `LlmUsage` and `LlmQuotaUsage` describe token,
  context, cost, and account-quota usage the same way for every harness.
- **Account-quota probes.** These read what a provider says a login has left.
  Claude, Codex, Cursor, Grok, OpenCode, and Z.ai have readers, and Kimi has a
  parser.
- **Record stream (planned).** Harness frames will be turned into one
  normalized record stream. See "Not yet extracted" below.

## Boundary

- The crate depends on no other `xmatrix-*` crate. The xMatrix CLI core and
  daemon runtime use it as a library, and nothing here depends on them.
- `LlmUsage` and `LlmQuotaUsage` are wire types. `xmatrix-cli-core` re-exports
  them as `protocol::LlmUsage` and `protocol::LlmQuotaUsage`, so their serde
  shape is part of the xMatrix Hub protocol. Any change to their fields or
  serde attributes is a protocol change. `usage::tests` pins the exact JSON.
- Credentials stay in process memory. A reader picks up a token from the
  provider CLI's own store: an environment variable, the macOS keychain via
  `/usr/bin/security`, or the CLI's `auth.json` or `.credentials.json`. The
  token goes only to that provider's own endpoint. Cache keys use one-way
  SHA-256 fingerprints and are never logged or sent.
- Every provider request has a time limit. Failures are cached briefly as
  "no answer", so a provider that keeps failing is not called over and over.
  A reader returns `None` and never makes up a reading. Set
  `XMATRIX_<VENDOR>_QUOTA_DEBUG` to print why a read failed.
- reqwest is built with `rustls-no-provider`. The crate installs the rustls
  `ring` provider before it makes a client. If the host has already installed
  a provider, the host's provider stays in place.

## API

```rust
use xmatrix_harness::quota::{self, Account, Provider, ReadOptions};

// The login the current process environment resolves, honouring the cache.
let usage = quota::read(Provider::Claude, ReadOptions::process()).await;

// The login stored in one explicit config home (Codex and Grok), as a
// pre-launch probe needs: the process environment is not consulted.
let usage = quota::read(
    Provider::Codex,
    ReadOptions { account: Account::Home(codex_home), force: false },
)
.await;
```

| Module | Contents |
| --- | --- |
| `usage` | `LlmUsage`, `LlmQuotaUsage`, `has_llm_usage` |
| `quota` | `read`, `Provider`, `Account`, `ReadOptions` |
| `quota::{claude, codex, cursor, grok, opencode, zai}` | Per-provider readers and pure `*_from_value` payload parsers |
| `quota::kimi` | Kimi Code `/usages` parser (no HTTP reader yet) |
| `quota::windows` | Window arithmetic: `normalized_quota_percent`, `rate_limit_window_label`, `append_quota_usages`, `prefer_codex_quota_windows` |
| `quota::refresh` | `spawn_quota_refresh`: session-owned periodic polling that stops when the returned task is dropped |
| `fields` | Tolerant JSON field readers (`first_f64`, `first_string`, `first_reset_at`, `nested_val_number`) |
| `home_dir_path` | The home directory as the harness CLIs resolve it |

Every quota reading carries `quota_source = "provider_api"` and a
`quota_observed_at` RFC 3339 timestamp. A cached reading keeps its original
observation time.

## Not yet extracted

The following code still lives in `xmatrix-cli-runtime`
(`packages/cli-rs/crates/runtime`). It is tied to channel delivery, presence,
the goal inbox, and run-status sidecars, and will move here in later steps:

- **Record stream.** A `HarnessRecord` enum covering session init, assistant
  text, tool calls and results, usage updates, compaction, turn completion and
  failure, background tasks, and rate-limit rejection. It will come with pure
  parsers for Claude stream-json frames, Codex app-server notifications, and
  ACP session updates. Today the runtime parses those frames itself
  (`runtime_claude_messages.rs`, `runtime_claude_stream_io.rs`,
  `runtime_codex_turn_errors.rs`, `runtime_agent_goal_status.rs`,
  `runtime_codex_channel_presentation.rs`).
- **Session drivers and transport.** Process spawning, the stdio and WebSocket
  JSON readers (`runtime_ws_json_reader.rs`), the Codex app-server JSON-RPC
  transport and session (`runtime_codex_app_*.rs`), the Claude stream session
  and turn drivers (`runtime_claude_stream_*.rs`, `runtime_claude_turn.rs`),
  and the ACP session (`runtime_acp_session.rs`).
- **Runtime-specific quota glue.** These stay in the runtime because they
  depend on its harness detection: `provider_subscription_quota_usage`, which
  picks a reader from the runtime's tool and command, the per-session ACP
  quota hooks, and `extract_llm_model`.
