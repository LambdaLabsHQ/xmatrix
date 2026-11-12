# Google Play Android Developer API discovery document

`discovery.json` is the unmodified discovery document of the Google Play
Android Developer API (`androidpublisher` v3), retrieved on 2026-11-12 from
`https://androidpublisher.googleapis.com/$discovery/rest?version=v3`.
Its revision is `20261111`. SHA-256:
`f0257728a19a126e012ae9c6de869a611ce66458ab2f56fed70682aa1b38057d`.

`pnpm play:generate` turns it into the Hub's operation catalog and request
schemas (`packages/hub/src/connectors/generated/google-play.json`) and the
operation-id type business actions compile against (`google-play.d.ts`).
`pnpm play:check` is a CI gate: the generated files must match this snapshot.
Neither the generator nor the Hub fetches a remote schema.

To refresh, download the document again and compare it first:

```sh
node scripts/google-play-discovery.mjs --check --compare /path/to/new/discovery.json
```

Review added, removed and newly deprecated methods, replace this file in a PR,
update the revision and SHA-256 above, run `pnpm play:generate`, and run the
connector tests (`packages/hub/test/connector-google-play.test.mjs`). The
generator refuses a document for another API, a method needing another OAuth
scope, or an upload path it cannot derive from the method path.
