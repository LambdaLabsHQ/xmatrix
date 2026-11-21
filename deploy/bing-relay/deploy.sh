#!/usr/bin/env bash
# Deploy the Bing egress relay to Cloud Run. Run from Google Cloud Shell as a
# project owner:   TOKEN_SHA256=<hex> bash deploy.sh
# TOKEN_SHA256 is the SHA-256 of the Hub's CONNECTOR_BING_RELAY_TOKEN; it is
# not a secret. Prints the service URL to store as CONNECTOR_BING_RELAY_URL.
set -euo pipefail
PROJECT="${PROJECT:-madebyrobot-usd-prepay}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-bing-relay}"
[[ "${TOKEN_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || { echo "TOKEN_SHA256 must be a lowercase hex SHA-256" >&2; exit 1; }
cd "$(dirname "$0")"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT"
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
  --allow-unauthenticated --set-env-vars "BING_RELAY_TOKEN_SHA256=$TOKEN_SHA256" \
  --cpu 1 --memory 256Mi --min-instances 0 --max-instances 2 --concurrency 20 --timeout 15 --quiet
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
