#!/usr/bin/env bash
# ============================================================
# Turn on "Continue with Google" for www.serenecreations.org (runs in GitHub Actions)
# ============================================================
# One Google sign-in key for both services: the key Firebase serene-arch-studio
# already uses is copied into Supabase (project keqxryyqmrftrwmmpbsy), whose
# Google switch the website's account page checks.
#
#  1. Read that key from Firebase (the secret is masked and never printed).
#  2. Check Google accepts Supabase's callback address for it. If not, stop
#     before switching anything on, so the site never shows a broken button.
#  3. Switch Google on in Supabase and add the website to its redirect list
#     (needs the SUPABASE_ACCESS_TOKEN repository secret).
#  4. Confirm from the outside: Supabase reports Google on, and its sign-in
#     link hands off to Google.
#  Also: add www.serenecreations.org to Firebase serene-creations' allowed
#  domains if this deploy account has access to that project.
# ============================================================
set -uo pipefail

SB_REF="keqxryyqmrftrwmmpbsy"
SB_URL="https://$SB_REF.supabase.co"
SB_PUBLISHABLE="sb_publishable_8P9gcU2rh9NHn_2qoO3uHw_RhkuJGSd"     # public (in the site's code)
CALLBACK="$SB_URL/auth/v1/callback"
SITE="https://www.serenecreations.org"
WANT_REDIRECTS=("https://www.serenecreations.org/**" "https://serenecreations.org/**")
FB_PROJECT="serene-arch-studio"
PORTAL_PROJECTS=("serene-creations" "355156595172")   # project id, then number
UA="Mozilla/5.0 (compatible; SereneAuthSetup/1.0)"
TMPD="${RUNNER_TEMP:-$(mktemp -d)}"

ann() {
  local m=${3//'%'/'%25'}; m=${m//$'\n'/'%0A'}
  local t=${2//'%'/'%25'}; t=${t//':'/'%3A'}; t=${t//','/'%2C'}
  echo "::$1 title=$t::$m"
}
GTOKEN=$(gcloud auth print-access-token 2>/dev/null || true)
[ -n "$GTOKEN" ] && echo "::add-mask::$GTOKEN"
gapi() {  # method url [json]
  curl -sS --max-time 30 -X "$1" "$2" -H "Authorization: Bearer $GTOKEN" \
       -H "X-Goog-User-Project: $FB_PROJECT" -H 'Content-Type: application/json' ${3:+-d "$3"}
}

# Hourly mode (AUTO=1, from auto-continue): nothing to do once sign-in works.
if [ "${AUTO:-}" = 1 ]; then
  g0=$(curl -sS --max-time 20 "$SB_URL/auth/v1/settings" -H "apikey: $SB_PUBLISHABLE" | jq -r '.external.google | tostring' 2>/dev/null)
  if [ "$g0" = "true" ]; then ann notice "Google sign-in" "Already on in Supabase; nothing to do."; exit 0; fi
fi

# ---------- 0. Firebase serene-creations: allow www ----------
done_portal=""
for p in "${PORTAL_PROJECTS[@]}"; do
  [ -n "$GTOKEN" ] || break
  cfg=$(gapi GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$p/config")
  if echo "$cfg" | jq -e '.authorizedDomains' >/dev/null 2>&1; then
    if echo "$cfg" | jq -e '.authorizedDomains | index("www.serenecreations.org")' >/dev/null; then
      ann notice "0 Firebase serene-creations" "www.serenecreations.org is already allowed."
    else
      body=$(echo "$cfg" | jq -c '{authorizedDomains: (.authorizedDomains + ["www.serenecreations.org"] | unique)}')
      res=$(gapi PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$p/config?updateMask=authorizedDomains" "$body")
      if echo "$res" | jq -e '.authorizedDomains | index("www.serenecreations.org")' >/dev/null 2>&1; then
        ann notice "0 Firebase serene-creations" "ADDED www.serenecreations.org to allowed domains."
      else
        ann warning "0 Firebase serene-creations" "Couldn't add www: $(echo "$res" | jq -r '.error.message // .' | head -c 200)"
      fi
    fi
    done_portal=yes; break
  fi
  last_err=$(echo "$cfg" | jq -r '.error.message // .' 2>/dev/null | head -c 200)
done
[ -n "$done_portal" ] || ann warning "0 Firebase serene-creations" \
  "This deploy account can't change serene-creations (${last_err:-no credentials}). Add it by hand: console.firebase.google.com/project/serene-creations/authentication/settings → Authorized domains → Add domain → www.serenecreations.org"

# ---------- 1. The Google key from Firebase serene-arch-studio ----------
if [ -z "$GTOKEN" ]; then ann error "1 Google key" "No Google Cloud credentials in this run."; exit 1; fi
idp=$(gapi GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$FB_PROJECT/defaultSupportedIdpConfigs/google.com")
CID=$(echo "$idp" | jq -r '.clientId // empty' 2>/dev/null)
CSECRET=$(echo "$idp" | jq -r '.clientSecret // empty' 2>/dev/null)
[ -n "$CSECRET" ] && echo "::add-mask::$CSECRET"
if [ -z "$CSECRET" ] && [ -n "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]; then
  CSECRET="$GOOGLE_OAUTH_CLIENT_SECRET"; echo "::add-mask::$CSECRET"
fi
if [ -z "$CID" ]; then
  ann error "1 Google key" "Couldn't read Firebase's Google key: $(echo "$idp" | jq -r '.error.message // .' 2>/dev/null | head -c 200)"
  exit 1
fi
ann notice "1 Google key" "Using Firebase $FB_PROJECT's Google key. Client ID: $CID | secret available: $([ -n "$CSECRET" ] && echo yes || echo NO)"

# ---------- 2. Does Google accept Supabase's callback for this key? ----------
q="client_id=$CID&redirect_uri=$(jq -rn --arg u "$CALLBACK" '$u|@uri')&response_type=code&scope=openid%20email%20profile"
code=$(curl -sS -A "$UA" --max-time 30 -o "$TMPD/g1.html" -D "$TMPD/g1.hdr" -w '%{http_code}' \
       "https://accounts.google.com/o/oauth2/v2/auth?$q" 2>/dev/null || echo 000)
loc=$(grep -i '^location:' "$TMPD/g1.hdr" 2>/dev/null | head -1 | tr -d '\r' | sed -E 's/^[Ll]ocation: *//')
reason=""
if [[ "$loc" == *"/oauth/error"* ]]; then
  # Google forwards errors to /signin/oauth/error?authError=<base64 protobuf naming the error>
  reason=$(python3 -c 'import base64,re,sys,urllib.parse as u
q=u.parse_qs(u.urlparse(sys.argv[1]).query).get("authError",[""])[0]
b=base64.urlsafe_b64decode(q+"="*(-len(q)%4)) if q else b""
m=re.findall(rb"[a-z_]{6,}",b); print(m[0].decode() if m else "oauth error")' "$loc" 2>/dev/null)
  REDIRECT_OK=no
elif [[ "$code" =~ ^4 ]]; then
  reason=$(grep -oE 'redirect_uri_mismatch|invalid_client|deleted_client|disabled_client|unauthorized_client|invalid_request' "$TMPD/g1.html" | head -1)
  REDIRECT_OK=no; reason=${reason:-HTTP $code}
elif [[ "$code" =~ ^30 ]] && [[ "$loc" =~ signin|ServiceLogin|accountchooser|AccountChooser|oauthchooseaccount ]]; then
  REDIRECT_OK=yes
elif [ "$code" = "200" ] && ! grep -qE 'redirect_uri_mismatch|invalid_client' "$TMPD/g1.html"; then
  REDIRECT_OK=yes
else
  REDIRECT_OK=unknown
fi
case "$REDIRECT_OK" in
  no)  ann error "2 Google accepts Supabase" "NO (Google says: $reason). In Google Cloud → project $FB_PROJECT → Credentials → client $CID → Authorized redirect URIs → Add URI → $CALLBACK → Save. Then re-run this job. Supabase was NOT switched on, so the site keeps its 'setup pending' notice instead of showing a broken button.";;
  yes) ann notice "2 Google accepts Supabase" "YES: Google opens its sign-in page for this key with Supabase's callback (HTTP $code).";;
  *)   ann warning "2 Google accepts Supabase" "Unclear (HTTP $code ${loc:0:80}). Proceeding.";;
esac

# ---------- 3. Supabase: switch Google on ----------
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  ann warning "3 Supabase" "Repository secret SUPABASE_ACCESS_TOKEN is missing, so Supabase wasn't changed. Create one at supabase.com/dashboard/account/tokens (Generate new token, name it github-actions) and add it at GitHub → Settings → Secrets and variables → Actions → New repository secret → SUPABASE_ACCESS_TOKEN. Then re-run this job."
elif [ "$REDIRECT_OK" = "no" ]; then
  ann warning "3 Supabase" "Skipped until Google accepts Supabase's callback (step 2)."
elif [ -z "$CSECRET" ]; then
  ann error "3 Supabase" "Firebase didn't return the key's secret. Add repository secret GOOGLE_OAUTH_CLIENT_SECRET (Firebase → Authentication → Sign-in method → Google → Web SDK configuration → Web client secret) and re-run."
else
  MAPI="https://api.supabase.com/v1/projects/$SB_REF/config/auth"
  cur=$(curl -sS --max-time 30 "$MAPI" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN")
  if ! echo "$cur" | jq -e 'has("site_url")' >/dev/null 2>&1; then
    ann error "3 Supabase" "Couldn't read the project's auth settings: $(echo "$cur" | jq -r '.message // .error // .' 2>/dev/null | head -c 200)"
  else
    if [ "${AUTO:-}" = 1 ] && [ -n "$(echo "$cur" | jq -r '.external_google_client_id // empty')" ]; then
      ann notice "3 Supabase" "Google was set up before and is now off; leaving it as the owner set it."
      exit 0
    fi
    site=$(echo "$cur" | jq -r '.site_url // ""')
    allow=$(echo "$cur" | jq -r '.uri_allow_list // ""')
    merged=$( (echo "$allow" | tr ',' '\n'; printf '%s\n' "${WANT_REDIRECTS[@]}") | sed 's/^ *//;s/ *$//' | grep -v '^$' | awk '!s[$0]++' | paste -sd, -)
    body=$(jq -n --arg cid "$CID" --arg sec "$CSECRET" --arg allow "$merged" \
           '{external_google_enabled: true, external_google_client_id: $cid, external_google_secret: $sec, uri_allow_list: $allow}')
    case "$site" in ""|*localhost*|*127.0.0.1*) body=$(echo "$body" | jq --arg s "$SITE" '. + {site_url: $s}'); site_note="Site URL set to $SITE (was '${site:-empty}')";;
                    *) site_note="Site URL left as $site";; esac
    res=$(curl -sS --max-time 30 -X PATCH "$MAPI" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
          -H 'Content-Type: application/json' -d "$body")
    if echo "$res" | jq -e '.external_google_enabled == true' >/dev/null 2>&1; then
      ann notice "3 Supabase" "Google switched ON with the Firebase key. Redirect list: $merged. $site_note."
    else
      ann error "3 Supabase" "Supabase refused the change: $(echo "$res" | jq -r '.message // .error // .' 2>/dev/null | head -c 200)"
    fi
  fi
fi

# ---------- 4. Check from the outside ----------
g=$(curl -sS --max-time 20 "$SB_URL/auth/v1/settings" -H "apikey: $SB_PUBLISHABLE" | jq -r '.external.google | tostring' 2>/dev/null)
a=$(curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' "$SB_URL/auth/v1/authorize?provider=google&redirect_to=$SITE/account" 2>/dev/null)
case "$a" in *accounts.google.com*) hand="hands off to Google";; *) hand="does not hand off to Google yet";; esac
if [ "$g" = "true" ] && [ "$hand" = "hands off to Google" ]; then lvl=notice; else lvl=warning; fi
ann "$lvl" "4 Live result" "Supabase reports Google on: $g | Sign-in link (HTTP ${a%% *}) $hand.
$([ "$lvl" = notice ] && echo "The account page now shows 'Continue with Google'. Test in a private window with a Google account other than yours.")"

# Red run until Google sign-in works end to end (also lets it be re-run as a failed job).
[ "$lvl" = notice ] || { [ "${AUTO:-}" = 1 ] && exit 0; exit 1; }
