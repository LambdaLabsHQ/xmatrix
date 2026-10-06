# Hub reconnect and catch-up protocol smoke

This command-line smoke validates the Hub HTTP/WebSocket contract used for
reconnect and history catch-up. It deliberately uses a synthetic client; it
does not execute the Web or iOS production client and must not be treated as
client regression coverage.

Run the reconnect catch-up smoke from the repo root:

```bash
pnpm e2e:hub-network
```

The script starts a local Hub worker by default. To point it at an existing Hub:

```bash
node scripts/hub-network-e2e/run-reconnect-catchup.mjs \
  --hub-url "$HUB_URL" \
  --token "$XMATRIX_TOKEN"
```

JSON reports are written under `scripts/hub-network-e2e/results/` and are
ignored by git.
