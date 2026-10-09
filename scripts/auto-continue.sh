#!/usr/bin/env bash
# ============================================================
# Auto-continue: finish setup as soon as the owner's steps are done
# ============================================================
# Runs hourly. Each check is quiet until its prerequisite appears, then acts once:
#  - Backend: Cloud Build API now on (Blaze + permissions script done) and the
#    last backend deploy failed waiting for it -> start the backend deploy.
#  - Workers: CLOUDFLARE_API_TOKEN now set and the last Workers run skipped the
#    deploy -> start the Workers deploy (it runs its own drift check).
#  - Google sign-in: run scripts/supabase-google.sh in hourly mode.
# Needs: GH_TOKEN (github.token with actions:write, checks:read), gcloud auth.
# ============================================================
set -uo pipefail
REPO="${GITHUB_REPOSITORY:-serenecreationsltd-crypto/serene-arch-studio}"
PROJECT="serene-arch-studio"

ann() {
  local m=${3//'%'/'%25'}; m=${m//$'\n'/'%0A'}
  local t=${2//'%'/'%25'}; t=${t//':'/'%3A'}; t=${t//','/'%2C'}
  echo "::$1 title=$t::$m"
}
last_run() {  # workflow file -> "id status conclusion"
  gh api "repos/$REPO/actions/workflows/$1/runs?per_page=1&branch=main" \
    --jq '.workflow_runs[0] | "\(.id) \(.status) \(.conclusion)"' 2>/dev/null
}
run_annotations() {  # run id -> all annotation messages
  for cr in $(gh api "repos/$REPO/actions/runs/$1/jobs" --jq '.jobs[].check_run_url' 2>/dev/null); do
    gh api "${cr#https://api.github.com/}/annotations" --jq '.[].message' 2>/dev/null
  done
}
dispatch() {  # workflow file
  gh api -X POST "repos/$REPO/actions/workflows/$1/dispatches" -f ref=main >/dev/null 2>&1
}

# ---------- Backend ----------
GT=$(gcloud auth print-access-token 2>/dev/null || true)
[ -n "$GT" ] && echo "::add-mask::$GT"
cb=$(curl -sS --max-time 20 -H "Authorization: Bearer $GT" -H "X-Goog-User-Project: $PROJECT" \
     "https://serviceusage.googleapis.com/v1/projects/$PROJECT/services/cloudbuild.googleapis.com" |
     jq -r '.state // "UNKNOWN"' 2>/dev/null)
read -r bid bstatus bconc <<<"$(last_run firebase-deploy.yml)"
if [ "$cb" = "ENABLED" ] && [ "$bstatus" = "completed" ] && [ "$bconc" = "failure" ] &&
   run_annotations "$bid" | grep -q "requires the Cloud Build API to be enabled"; then
  if dispatch firebase-deploy.yml; then ann notice "Backend" "Cloud Build is now on: started the backend deploy."
  else ann warning "Backend" "Cloud Build is on, but starting the backend deploy failed."; fi
else
  if [ "$cb" = "ENABLED" ]; then
    ann notice "Backend" "No action. Cloud Build API is on; last backend deploy: ${bconc:-?}."
  else
    ann notice "Backend" "Waiting for Part 1 (Blaze plan + permissions script). Cloud Build API: ${cb:-?} (UNKNOWN = the deploy account can't read it yet; the script grants that)."
  fi
fi

# ---------- Workers ----------
if [ -n "${CF_TOKEN:-}" ]; then
  read -r wid wstatus wconc <<<"$(last_run cloudflare-workers-deploy.yml)"
  skipped=$(gh api "repos/$REPO/actions/runs/$wid/jobs" \
            --jq '[.jobs[].steps[]? | select(.name == "Deploy with Wrangler" and .conclusion == "skipped")] | length' 2>/dev/null || echo 0)
  if [ "$wstatus" = "completed" ] && [ "${skipped:-0}" -gt 0 ]; then
    if dispatch cloudflare-workers-deploy.yml; then ann notice "Workers" "Cloudflare token found: started the Workers deploy (drift check first)."
    else ann warning "Workers" "Token found, but starting the Workers deploy failed."; fi
  else
    ann notice "Workers" "No action. Last Workers run: ${wconc:-?}."
  fi
else
  ann notice "Workers" "Waiting for the CLOUDFLARE_API_TOKEN secret."
fi

# ---------- Google sign-in ----------
AUTO=1 bash scripts/supabase-google.sh || true
