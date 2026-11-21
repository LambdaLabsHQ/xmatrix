#!/usr/bin/env bash
# Deploy the Bing egress relay to Cloud Run. Run as a project owner (for
# example in Google Cloud Shell):   PROJECT=<project-id> TOKEN_SHA256=<hex> bash deploy.sh
# TOKEN_SHA256 is the SHA-256 of the Hub's CONNECTOR_BING_RELAY_TOKEN; it is
# not a secret. Prints the service URL to store as CONNECTOR_BING_RELAY_URL.
#
# The build runs as its own service account holding only the Cloud Build
# builder role, and the service runs as one holding no role, so the project's
# default compute account is neither used nor granted anything.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT to the Google Cloud project to deploy into}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-bing-relay}"
[[ "${TOKEN_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || { echo "TOKEN_SHA256 must be a lowercase hex SHA-256" >&2; exit 1; }
cd "$(dirname "$0")"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com --project "$PROJECT"

account() {
  local name="$1" title="$2" email="$1@$PROJECT.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$email" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$name" --project "$PROJECT" --display-name "$title" >/dev/null
  echo "$email"
}
BUILDER="$(account "$SERVICE-build" "Builds the $SERVICE Cloud Run service")"
RUNTIME="$(account "$SERVICE-run" "Runs the $SERVICE Cloud Run service (no roles)")"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$BUILDER" \
  --role roles/cloudbuild.builds.builder --condition None >/dev/null

gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
  --build-service-account "projects/$PROJECT/serviceAccounts/$BUILDER" --service-account "$RUNTIME" \
  --allow-unauthenticated --set-env-vars "BING_RELAY_TOKEN_SHA256=$TOKEN_SHA256" \
  --cpu 1 --memory 256Mi --min-instances 0 --max-instances 2 --concurrency 20 --timeout 15 --quiet
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
