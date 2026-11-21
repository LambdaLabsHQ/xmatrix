# Bing Webmaster egress relay

Bing answers every Webmaster API call from Cloudflare Workers' shared egress
addresses with `400 ThrottleIP` (ErrorCode 17), whatever the API key or call
volume, so the Hub's `bingwebmaster` connector sends those calls through this
small Cloud Run service instead. IndexNow is not relayed.

- Forwards only `GET`/`POST /webmaster/api.svc/json/<Method>` to
  `https://ssl.bing.com`, with redirects off, a 9 s timeout and 1 MiB request /
  4 MiB reply bounds.
- The Hub authenticates with `Authorization: Bearer <CONNECTOR_BING_RELAY_TOKEN>`.
  The service holds only that token's SHA-256 (`BING_RELAY_TOKEN_SHA256`), which
  is not a secret, so deploying moves no credential.
- The Bing API key arrives as `x-bing-apikey` and is added to Bing's `apikey`
  query parameter here, so it never appears in a URL Cloud Run logs.

## Deploy

1. An operator generates the token and stores it, without printing it, as the
   Space secret and the GitHub `production` secret `CONNECTOR_BING_RELAY_TOKEN`,
   and computes its SHA-256.
2. A project owner runs, in Google Cloud Shell:

   ```sh
   git clone --depth 1 https://github.com/LambdaLabsHQ/xmatrix && cd xmatrix/deploy/bing-relay
   TOKEN_SHA256=<sha256> bash deploy.sh
   ```

   `PROJECT` (default `madebyrobot-usd-prepay`), `REGION` (`us-central1`) and
   `SERVICE` (`bing-relay`) can be overridden. The script prints the service URL.
3. Store that URL as the GitHub `production` secret `CONNECTOR_BING_RELAY_URL`;
   the next Hub release injects both values. Check the Bing connection in Apps.

The build runs as `bing-relay-build` (Cloud Build builder role only) and the
service as `bing-relay-run` (no role); the default compute account is untouched.

`GET /health` answers `ok` (Cloud Run reserves `/healthz` on `*.run.app`).

Rotating the token repeats steps 1–2 with the same service; redeploying with a
new hash replaces the old one at once.

Cost: the service scales to zero; a few thousand calls a month stay inside
Cloud Run's free tier.
