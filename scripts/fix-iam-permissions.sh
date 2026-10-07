#!/usr/bin/env bash
# ============================================================
# Serene Creations Ltd — Fix GitHub Actions deploy permissions
# ============================================================
# Every "Deploy Firebase Backend" run has failed because the service
# account in the FIREBASE_SERVICE_ACCOUNT_JSON GitHub secret
#   firebase-adminsdk-fbsvc@serene-arch-studio.iam.gserviceaccount.com
# can't list/enable APIs, read the project, or deploy functions,
# schedules and rules. This grants it the roles a full backend deploy
# needs. Safe to re-run (bindings are idempotent).
#
# Run as a project Owner in Google Cloud Shell:
#   https://console.cloud.google.com/cloudshell?project=serene-arch-studio
#
#   curl -sSL https://raw.githubusercontent.com/serenecreationsltd-crypto/serene-arch-studio/main/scripts/fix-iam-permissions.sh | bash
#
# If you later switch the secret to a different service account:
#   curl -sSL <same URL> | SA_EMAIL=<that-account-email> bash
# ============================================================
set -euo pipefail

PROJECT="serene-arch-studio"
SA_EMAIL="${SA_EMAIL:-firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com}"

ROLES=(
  roles/cloudfunctions.admin              # create/update functions + make HTTPS endpoints public
  roles/iam.serviceAccountUser            # deploy functions that run as the App Engine default SA
  roles/serviceusage.serviceUsageAdmin    # check and enable required Google APIs
  roles/browser                           # read project metadata (billing/plan checks)
  roles/firebase.viewer                   # read Firebase project config during deploy
  roles/cloudscheduler.admin              # scheduledDripSend / scheduledCleanup jobs
  roles/pubsub.editor                     # Pub/Sub topics behind those schedules
  roles/firebaserules.admin               # Firestore + Storage security rules
  roles/datastore.indexAdmin              # Firestore composite indexes
)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Serene Creations — Fix GitHub Actions deploy permissions"
echo "════════════════════════════════════════════════════════"
echo "  Project:         $PROJECT"
echo "  Service account: $SA_EMAIL"
echo ""

gcloud config set project "$PROJECT" --quiet >/dev/null

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  echo "✗ Service account not found: $SA_EMAIL"
  echo "  Check the client_email field of the FIREBASE_SERVICE_ACCOUNT_JSON secret, then run:"
  echo "  SA_EMAIL=<that-email> bash fix-iam-permissions.sh"
  exit 1
fi

for ROLE in "${ROLES[@]}"; do
  printf "→ %-42s" "$ROLE"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE" \
    --condition=None \
    --quiet >/dev/null
  echo "✓"
done

echo ""
echo "→ Enabling APIs the deploy uses (no-op if already on) ..."
gcloud services enable \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com cloudbilling.googleapis.com firebaserules.googleapis.com \
  --project="$PROJECT" --quiet
echo "   ✓ APIs enabled"

echo ""
echo "→ Roles now held by $SA_EMAIL:"
gcloud projects get-iam-policy "$PROJECT" \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:${SA_EMAIL}" \
  --format="value(bindings.role)" | sed 's/^/   • /'

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✅  Done. Re-run the backend deploy:"
echo "  https://github.com/serenecreationsltd-crypto/serene-arch-studio/actions/workflows/firebase-deploy.yml"
echo "  → 'Run workflow' on main"
echo "════════════════════════════════════════════════════════"
echo ""
