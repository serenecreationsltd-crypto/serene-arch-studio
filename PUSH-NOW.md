# Push to GitHub — Serene Arch Studio

Your repo: https://github.com/serenecreationsltd-crypto/serene-arch-studio.git

## Step 1: Get your FIREBASE_TOKEN (run once, on your computer)

```powershell
npm install -g firebase-tools
firebase login:ci
```
Copy the token that starts with `1//` — you'll add it as a secret next.

## Step 2: Add all 7 secrets to GitHub

Go to: https://github.com/serenecreationsltd-crypto/serene-arch-studio/settings/secrets/actions

Add each secret:

| Name | Value |
|------|-------|
| FIREBASE_TOKEN | the 1//... token from Step 1 |
| FIREBASE_SERVICE_ACCOUNT_JSON | contents of your service-account.json |
| STRIPE_SECRET_KEY | your Stripe sk_live_... key |
| STRIPE_WEBHOOK_SECRET | your Stripe whsec_... key |
| SMTP_PASSWORD | j2ecJ7seT2Nu |
| REPLICATE_TOKEN | your Replicate API token |
| WORKER_PROXY_SECRET | serene-proxy-2026 |

## Step 3: Extract this zip and push

Extract this zip to a folder, then run these commands in PowerShell from that folder:

```powershell
git init
git add .
git commit -m "Initial: Serene Arch Studio v3 — 10 functions + 3 Workers"
git remote add origin https://github.com/serenecreationsltd-crypto/serene-arch-studio.git
git branch -M main
git push -u origin main
```

## Step 4: Watch your deployment

Go to: https://github.com/serenecreationsltd-crypto/serene-arch-studio/actions

The deployment runs automatically. Takes about 3–5 minutes.
11 stages complete = SUCCESS ✅

## Every future deploy

```powershell
git add firebase-backend/
git commit -m "Update: <what changed>"
git push
```
