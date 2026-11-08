# Apple App Store Connect specification

`openapi.json` is the unmodified JSON member `openapi.oas.json` of Apple's
[official specification archive](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip),
retrieved on 2026-11-08. Its declared API version is 4.6. SHA-256:
`f7043a0e0fa56c2834fa912fbdcc0382f937cf9f5260bf2cea002040d72f2221`.

The connector maintainers own refreshes. Download the archive and extract its
actual JSON member, excluding the macOS metadata member. Compare a new copy:

```sh
node scripts/app-store-connect-openapi.mjs --check --compare /path/to/new/openapi.oas.json
```

Review added/removed/deprecated operations and schema changes, replace this
snapshot in a PR, update this provenance, run `pnpm asc:generate`, and validate
the connector's boundary tests. `pnpm asc:check` is also a CI gate. No remote
schema is fetched or executed by the generator or the Hub. A new upstream
version does not silently replace the pinned runtime authority.

The generator emits zero-runtime TypeScript declarations and a compact
operation/request-schema catalog under `packages/hub/src/connectors/generated`.
The generated declarations are excluded from dead-export and duplicate-code
scanners: they preserve the whole provider schema, including structurally
repeated types, and are verified from this one source instead. Handwritten
connector code remains subject to those gates. The Hub adds no runtime SDK.
