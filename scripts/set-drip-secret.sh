#!/usr/bin/env bash
# set-drip-secret.sh — one-time bootstrap for DRIP_SECRET GitHub Actions secret
#
# Usage:
#   export GITHUB_TOKEN=<your-personal-access-token>  # needs secrets:write scope
#   ./scripts/set-drip-secret.sh
#
# Or pass the secret value directly:
#   DRIP_SECRET=<value> ./scripts/set-drip-secret.sh
#
# The generated value is also saved to firebase-backend/functions/.env
# for local firebase deploy runs.

set -euo pipefail

REPO="serenecreationsltd-crypto/serene-arch-studio"

# Generate a strong random secret if not provided
DRIP_SECRET="${DRIP_SECRET:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"

echo "DRIP_SECRET value (save this!): $DRIP_SECRET"

# ── Set GitHub Actions secret ──────────────────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Get repo public key
  PUB_KEY_JSON=$(curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/actions/secrets/public-key")
  KEY_ID=$(echo "$PUB_KEY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['key_id'])")
  KEY_B64=$(echo "$PUB_KEY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['key'])")

  # Encrypt with PyNaCl
  ENCRYPTED=$(python3 - <<PYEOF
import base64, nacl.public, nacl.encoding
key_bytes = base64.b64decode("$KEY_B64")
pk = nacl.public.PublicKey(key_bytes)
box = nacl.public.SealedBox(pk)
encrypted = box.encrypt("$DRIP_SECRET".encode())
print(base64.b64encode(encrypted).decode())
PYEOF
)

  curl -sS -X PUT \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/$REPO/actions/secrets/DRIP_SECRET" \
    -d "{\"encrypted_value\":\"$ENCRYPTED\",\"key_id\":\"$KEY_ID\"}"
  echo "✅ DRIP_SECRET set in GitHub Actions secrets"
else
  echo "⚠️  GITHUB_TOKEN not set — skipping GitHub secret upload"
  echo "   Set it manually at: https://github.com/$REPO/settings/secrets/actions"
fi

# ── Write local .env for firebase deploy ──────────────────────────────────
ENV_FILE="$(dirname "$0")/../firebase-backend/functions/.env"
if [ -f "$ENV_FILE" ]; then
  # Update existing value
  sed -i "s|^DRIP_SECRET=.*|DRIP_SECRET=$DRIP_SECRET|" "$ENV_FILE" || \
    echo "DRIP_SECRET=$DRIP_SECRET" >> "$ENV_FILE"
else
  echo "DRIP_SECRET=$DRIP_SECRET" >> "$ENV_FILE"
fi
echo "✅ Written to firebase-backend/functions/.env (gitignored)"
