#!/usr/bin/env bash
# GuardianEye Live — Google Cloud Run Deployment Script
# Usage: bash infra/deploy.sh [project-id] [region]
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="${1:-$(gcloud config get-value project)}"
REGION="${2:-us-central1}"
SERVICE_NAME="guardianeye-live"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
MIN_INSTANCES=1
MAX_INSTANCES=10
MEMORY="2Gi"
CPU="2"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🛡️  GuardianEye Live — Cloud Run Deployment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "  Service:  ${SERVICE_NAME}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Script must be run from repo root regardless of where it lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ── Step 1: Enable Required APIs ──────────────────────────────────────────────
echo ""
echo "⚙️  Enabling Google Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  aiplatform.googleapis.com \
  discoveryengine.googleapis.com \
  artifactregistry.googleapis.com \
  --project="${PROJECT_ID}" --quiet

# ── Step 2: Create Service Account ────────────────────────────────────────────
SA_NAME="guardianeye-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo ""
echo "🔐 Creating service account..."
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="GuardianEye Live Service Account" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "Service account already exists."

for ROLE in \
  "roles/aiplatform.user" \
  "roles/datastore.user" \
  "roles/secretmanager.secretAccessor" \
  "roles/discoveryengine.viewer" \
  "roles/logging.logWriter"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" --quiet
done

echo "✅ Service account configured."

# ── Step 3: Store Secrets in Secret Manager ───────────────────────────────────
echo ""
echo "🔑 Configuring secrets..."

store_secret() {
  local SECRET_NAME="$1"
  local PROMPT="$2"
  local CURRENT
  CURRENT=$(gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT_ID}" 2>/dev/null || echo "")
  if [ -z "${CURRENT}" ]; then
    echo -n "Enter ${PROMPT}: "
    read -rs SECRET_VALUE
    echo ""
    echo -n "${SECRET_VALUE}" | gcloud secrets create "${SECRET_NAME}" \
      --data-file=- --project="${PROJECT_ID}" --replication-policy="automatic"
    echo "✅ Secret '${SECRET_NAME}' created."
  else
    echo "ℹ️  Secret '${SECRET_NAME}' already exists."
  fi
}

store_secret "gemini-api-key" "Gemini API Key"
store_secret "vertex-search-datastore-id" "Vertex AI Search Datastore ID (or press Enter to skip)"

# ── Step 4: Build & Push Docker Image ────────────────────────────────────────
echo ""
echo "🐳 Building Docker image with Cloud Build..."
gcloud builds submit . \
  --tag="${IMAGE}:latest" \
  --project="${PROJECT_ID}" \
  --timeout="10m"

echo "✅ Image built and pushed to: ${IMAGE}:latest"

# ── Step 5: Deploy to Cloud Run ───────────────────────────────────────────────
echo ""
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}:latest" \
  --platform=managed \
  --region="${REGION}" \
  --service-account="${SA_EMAIL}" \
  --min-instances="${MIN_INSTANCES}" \
  --max-instances="${MAX_INSTANCES}" \
  --memory="${MEMORY}" \
  --cpu="${CPU}" \
  --cpu-boost \
  --timeout=300 \
  --concurrency=100 \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${REGION}" \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest,VERTEX_SEARCH_DATASTORE_ID=vertex-search-datastore-id:latest" \
  --project="${PROJECT_ID}" \
  --quiet

# ── Done ──────────────────────────────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format="value(status.url)")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  GuardianEye Live deployed successfully!"
echo ""
echo "  🌐 URL:     ${SERVICE_URL}"
echo "  🔌 WS:      wss://$(echo "${SERVICE_URL}" | sed 's|https://||')/live"
echo "  📊 Logs:    gcloud logging read 'resource.type=cloud_run_revision'"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
