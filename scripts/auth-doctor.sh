#!/usr/bin/env bash
# ============================================================
# Google sign-in doctor for serenecreations.org (runs in GitHub Actions)
# ============================================================
# 1. Live site: which sign-in service the account page actually calls.
# 2. Supabase: is the Google provider switched on for that project?
# 3. Firebase (serene-arch-studio): is Google sign-in on, and are the
#    website domains on the allowed list? Missing domains are ADDED.
#
# Results are written as GitHub annotations (readable without log access).
# Public values only: no access token, client secret or key is printed.
# Needs: gcloud authenticated as the Firebase deploy service account.
# ============================================================
set -uo pipefail

SITE="https://www.serenecreations.org"
PROJECT="serene-arch-studio"
FALLBACK_SB_REF="keqxryyqmrftrwmmpbsy"
FALLBACK_SB_KEY="sb_publishable_8P9gcU2rh9NHn_2qoO3uHw_RhkuJGSd"   # public, from login/config.js
WANT_DOMAINS=(serenecreations.org www.serenecreations.org portal.serenecreations.org
              serene-arch-studio.web.app serene-arch-studio.firebaseapp.com)
UA="Mozilla/5.0 (compatible; SereneAuthDoctor/1.0)"
TMP=$(mktemp -d)

ann() {  # level, title, message (escaped for workflow commands)
  local m=${3//'%'/'%25'}; m=${m//$'\n'/'%0A'}
  local t=${2//'%'/'%25'}; t=${t//':'/'%3A'}; t=${t//','/'%2C'}
  echo "::$1 title=$t::$m"
}

# ---------- 1. Live account page ----------
curl -sSL -A "$UA" --max-time 30 "$SITE/account?mode=google" -o "$TMP/page.html" || true
cp "$TMP/page.html" "$TMP/all.txt"
# Pull in the page's own scripts (up to 25, 3 MB each) so config inside bundles is seen too.
grep -oE '<script[^>]+src="[^"]+"' "$TMP/page.html" | sed -E 's/.*src="([^"]+)".*/\1/' | head -25 |
while read -r src; do
  case "$src" in
    //*) url="https:$src" ;;
    /*) url="$SITE$src" ;;
    http*) url="$src" ;;
    *) url="$SITE/$src" ;;
  esac
  curl -sSL -A "$UA" --max-time 20 --max-filesize 3000000 "$url" >> "$TMP/all.txt" 2>/dev/null || true
  echo >> "$TMP/all.txt"
done

count() { grep -o -E "$@" "$TMP/all.txt" 2>/dev/null | wc -l | tr -d ' '; }
SB_REFS=$(grep -oE '[a-z0-9]{20}\.supabase\.co' "$TMP/all.txt" | sort -u | sed 's/\.supabase\.co//' | tr '\n' ' ')
FB_DOMAINS=$(grep -oE '[a-z0-9-]+\.firebaseapp\.com' "$TMP/all.txt" | sort -u | tr '\n' ' ')
SB_KEY=$(grep -oE 'sb_publishable_[A-Za-z0-9_-]{20,}' "$TMP/all.txt" | head -1)
ann notice "1 Live account page" "Fetched $(wc -c < "$TMP/page.html") bytes of HTML plus its scripts.
Supabase projects referenced: ${SB_REFS:-none}
Firebase auth domains referenced: ${FB_DOMAINS:-none}
signInWithOAuth calls: $(count 'signInWithOAuth') | provider google mentions: $(count "provider:[[:space:]]*['\"]google['\"]")
Firebase GoogleAuthProvider: $(count 'GoogleAuthProvider') | 'setup pending' text: $(count -i -e 'setup pending')"

# ---------- 2. Supabase Google provider ----------
REFS=${SB_REFS:-$FALLBACK_SB_REF}
for ref in $REFS; do
  key=${SB_KEY:-$FALLBACK_SB_KEY}
  base="https://$ref.supabase.co/auth/v1"
  settings=$(curl -sS --max-time 20 "$base/settings" -H "apikey: $key" 2>&1 || true)
  google=$(echo "$settings" | jq -r '.external.google | if . == null then "unknown" else tostring end' 2>/dev/null || echo "unreadable")
  email=$(echo "$settings" | jq -r '.external.email | if . == null then "unknown" else tostring end' 2>/dev/null || echo "unreadable")
  auth=$(curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' \
         "$base/authorize?provider=google&redirect_to=$SITE/account" 2>&1 || true)
  code=${auth%% *}; where=${auth#* }
  case "$where" in *accounts.google.com*) where="accounts.google.com (Google sign-in page)";; esac
  if [ "$google" = "true" ]; then lvl=notice; else lvl=warning; fi
  ann "$lvl" "2 Supabase $ref" "Google provider enabled: $google | email/password enabled: $email
GET /authorize?provider=google -> HTTP $code ${where:-}"
done

# ---------- 3. Firebase serene-arch-studio ----------
API_KEY=$(grep -m1 -oE 'AIza[0-9A-Za-z_-]{35}' public/ai-studio.html || true)
if [ -n "$API_KEY" ]; then
  r=$(curl -sS --max-time 20 -X POST \
      "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=$API_KEY" \
      -H 'Content-Type: application/json' \
      -d "{\"providerId\":\"google.com\",\"continueUri\":\"https://$PROJECT.firebaseapp.com/__/auth/handler\"}" 2>&1 || true)
  if echo "$r" | jq -e '.authUri' >/dev/null 2>&1; then
    cid=$(echo "$r" | jq -r '.authUri' | grep -oE 'client_id=[^&]+' | head -1 | cut -d= -f2 | sed 's/%2E/./g')
    ann notice "3 Firebase $PROJECT Google sign-in" "ENABLED. Google OAuth client ID: ${cid:-not shown}"
    FB_GOOGLE=on
  else
    ann warning "3 Firebase $PROJECT Google sign-in" "NOT working: $(echo "$r" | jq -r '.error.message // .' 2>/dev/null | head -c 200)"
    FB_GOOGLE=off
  fi
fi

TOKEN=$(gcloud auth print-access-token 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  ann warning "4 Firebase authorized domains" "No Google Cloud credentials in this run; skipped."
  exit 0
fi
cfg_url="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config"
cfg=$(curl -sS --max-time 20 "$cfg_url" -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT")
if ! echo "$cfg" | jq -e '.authorizedDomains' >/dev/null 2>&1; then
  ann warning "4 Firebase authorized domains" "Couldn't read the Auth settings: $(echo "$cfg" | jq -r '.error.message // .' 2>/dev/null | head -c 200)"
  exit 0
fi
have=$(echo "$cfg" | jq -r '.authorizedDomains[]')
missing=()
for d in "${WANT_DOMAINS[@]}"; do grep -qx "$d" <<<"$have" || missing+=("$d"); done
if [ ${#missing[@]} -eq 0 ]; then
  ann notice "4 Firebase authorized domains" "All website domains already allowed: $(echo $have)"
  exit 0
fi
new=$( (echo "$have"; printf '%s\n' "${missing[@]}") | grep -v '^$' | sort -u | jq -R . | jq -sc '{authorizedDomains: .}')
res=$(curl -sS --max-time 20 -X PATCH "$cfg_url?updateMask=authorizedDomains" \
      -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT" \
      -H 'Content-Type: application/json' -d "$new")
if echo "$res" | jq -e '.authorizedDomains' >/dev/null 2>&1; then
  ann notice "4 Firebase authorized domains" "ADDED: ${missing[*]}
Now allowed: $(echo "$res" | jq -r '.authorizedDomains | join(" ")')"
else
  ann warning "4 Firebase authorized domains" "Missing ${missing[*]} but couldn't add them: $(echo "$res" | jq -r '.error.message // .' 2>/dev/null | head -c 200)"
fi
