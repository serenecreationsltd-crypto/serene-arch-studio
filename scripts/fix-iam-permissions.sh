#!/usr/bin/env bash
# ============================================================
# Serene Creations Ltd — Fix GitHub Actions IAM Permissions
# ============================================================
# Run this in Google Cloud Shell:
#   https://console.cloud.google.com/cloudshell
#
# Or paste this one-liner into Cloud Shell:
#   curl -sSL https://raw.githubusercontent.com/serenecreationsltd-crypto/serene-arch-studio/main/scripts/fix-iam-permissions.sh | bash
#
# What it does:
#   Grants the two IAM roles that the GitHub Actions service
#   account needs to deploy Cloud Functions:
#     - roles/cloudfunctions.developer
#     - roles/iam.serviceAccountUser
# ============================================================
set -euo pipefail

PROJECT="serene-arch-studio"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Serene Creations — Fix GitHub Actions IAM Permissions"
echo "════════════════════════════════════════════════════════"
echo ""

# ── 1. Confirm project ──────────────────────────────────────
echo "→ Setting active project to: $PROJECT"
gcloud config set project "$PROJECT" --quiet

# ── 2. Find the GitHub Actions service account ──────────────
#    The SA stored in FIREBASE_SERVICE_ACCOUNT_JSON is the
#    firebase-adminsdk service account OR a manually created
#    github-actions SA.  We look for both patterns.
echo ""
echo "→ Looking for GitHub Actions / Firebase Admin SDK service account ..."

# Try explicit known patterns first
SA_EMAIL=""

# Pattern 1: manually named github-actions SA
CANDIDATE=$(gcloud iam service-accounts list \
  --project="$PROJECT" \
  --format="value(email)" \
  --filter="email:github-actions" 2>/dev/null | head -1 || true)
[ -n "$CANDIDATE" ] && SA_EMAIL="$CANDIDATE"

# Pattern 2: firebase-adminsdk SA (default Firebase SA)
if [ -z "$SA_EMAIL" ]; then
  CANDIDATE=$(gcloud iam service-accounts list \
    --project="$PROJECT" \
    --format="value(email)" \
    --filter="email:firebase-adminsdk" 2>/dev/null | head -1 || true)
  [ -n "$CANDIDATE" ] && SA_EMAIL="$CANDIDATE"
fi

# Pattern 3: any SA that is not the compute default
if [ -z "$SA_EMAIL" ]; then
  echo ""
  echo "⚠  Could not auto-detect the service account."
  echo "   Please open a new tab and go to:"
  echo "   https://console.cloud.google.com/iam-admin/serviceaccounts?project=$PROJECT"
  echo ""
  echo "   Find the service account email stored in the GitHub secret"
  echo "   FIREBASE_SERVICE_ACCOUNT_JSON, then re-run this script with:"
  echo "   SA_EMAIL=<paste-email-here> bash fix-iam-permissions.sh"
  echo ""
  if [ -z "${SA_EMAIL:-}" ]; then
    exit 1
  fi
fi

echo "   Found: $SA_EMAIL"

# ── 3. Grant roles ──────────────────────────────────────────
echo ""
echo "→ Granting roles/cloudfunctions.developer ..."
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudfunctions.developer" \
  --quiet
echo "   ✓ roles/cloudfunctions.developer granted"

echo ""
echo "→ Granting roles/iam.serviceAccountUser ..."
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet
echo "   ✓ roles/iam.serviceAccountUser granted"

# ── 4. Verify ────────────────────────────────────────────────
echo ""
echo "→ Verifying bindings ..."
gcloud projects get-iam-policy "$PROJECT" \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA_EMAIL}" \
  --format="table(bindings.role)" 2>/dev/null || true

# ── 5. Done ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✅  Permissions fixed!"
echo ""
echo "  Now re-run the failed GitHub Actions workflow:"
echo "  https://github.com/serenecreationsltd-crypto/serene-arch-studio/actions"
echo ""
echo "  Click the failed run → 'Re-run all jobs'"
echo "════════════════════════════════════════════════════════"
echo ""
