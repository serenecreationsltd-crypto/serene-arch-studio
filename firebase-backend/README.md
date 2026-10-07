# Serene Arch Studio — Firebase Backend

Full Cloud Functions + Firestore + Storage backend for the AI Architecture Render Portal.

---

## Architecture Overview

```
Portal (Artifact / HTML)
    │
    ├── Firebase Auth  ── sign-in / sign-up
    ├── Firestore      ── renderQueue, gallery, users
    └── Storage        ── uploads/{uid}/{file}
            │
            └── Cloud Functions (this repo)
                    ├── processRenderJob  ← triggered by renderQueue doc creation
                    │       └── calls Replicate API → writes result to gallery
                    ├── onUserCreated     ← triggered by users doc creation
                    │       └── POSTs to Activepieces WELCOME_HOOK
                    └── trackLead         ← HTTPS endpoint
                            └── POSTs to Activepieces LEAD_HOOK
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS | https://nodejs.org |
| Firebase CLI | 13.29.1 | `npm i -g firebase-tools@13.29.1` |
| Firebase account | — | https://console.firebase.google.com |
| Replicate account | — | https://replicate.com |

---

## Step 1 — Create Firebase Project

1. Go to https://console.firebase.google.com → **Add project**
2. Name it (e.g. `serene-arch-studio`) and note the **Project ID**
3. Disable Google Analytics if you don't need it (optional)

---

## Step 2 — Enable Firebase Services

### Authentication
1. Console → **Authentication** → **Get started**
2. **Sign-in method** tab → enable:
   - **Email/Password** → Save
   - **Google** → set Project public-facing name + support email → Save

### Firestore Database
1. Console → **Firestore Database** → **Create database**
2. Choose **production mode** (rules are deployed from this repo)
3. Pick a region close to your users (e.g. `europe-west1` for East Africa)

### Cloud Storage
1. Console → **Storage** → **Get started**
2. Accept production mode; pick the same region as Firestore

---

## Step 3 — Register a Web App (get config)

1. Console → ⚙️ **Project Settings** → **Your apps** → **Add app** → Web (`</>`)
2. Register with any nickname (e.g. "Portal")
3. Copy the `firebaseConfig` object — you'll paste it into the portal HTML

**Portal HTML snippet to update** (`ai-arch-portal.html` → search `FIREBASE_CONFIG`):
```javascript
const FIREBASE_CONFIG = {
  apiKey:            "AIza...",          // ← replace
  authDomain:        "your-id.firebaseapp.com",
  projectId:         "your-id",
  storageBucket:     "your-id.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123:web:abc"
};
```

---

## Step 4 — Update `.firebaserc`

Open `.firebaserc` in this folder and replace `YOUR_FIREBASE_PROJECT_ID` with your actual Project ID:
```json
{
  "projects": {
    "default": "serene-arch-studio"
  }
}
```

---

## Step 5 — Get Replicate Credentials

1. Sign up at https://replicate.com → **Account settings** → **API tokens** → copy token
2. That's all. The functions look up the latest version of the render model
   (`lucataco/sdxl-controlnet` by default) at runtime — no version hash to copy.

---

## Step 6 — Install Dependencies & Set Secrets

```bash
cd firebase-backend/functions
npm install
```

Secrets are passed as environment variables. In CI, the deploy workflow writes
`firebase-backend/functions/.env` from GitHub repo secrets of the same names
(Settings → Secrets and variables → Actions):

| Secret | Required | Purpose |
|--------|----------|---------|
| `REPLICATE_TOKEN` | yes, for renders | Replicate API token (`r8_…`) |
| `REPLICATE_MODEL` | no | Render model name; default `lucataco/sdxl-controlnet` |
| `REPLICATE_MODEL_VERSION` | no | Pin a specific version hash instead of latest |
| `REPLICATE_VIDEO_MODEL` | no | Video model name — video stays off until set (billed per run) |
| `REPLICATE_VIDEO_MODEL_VERSION` | no | Pin a video version hash |
| `DRIP_SECRET` | for `httpDripSend` | Shared secret the Activepieces "Daily Drip Send" flow sends as `X-Drip-Secret` |

For a local deploy, put the same keys in `functions/.env` (gitignored).
`functions:config` is decommissioned — don't use it.

---

## Step 7 — Deploy

```bash
# From the firebase-backend/ directory:

# Deploy everything at once
firebase deploy

# Or deploy individually:
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
firebase deploy --only storage
firebase deploy --only functions
```

Expected output:
```
✔  functions: Finished running predeploy script.
✔  functions[processRenderJob]: Successful create operation.
✔  functions[onUserCreated]: Successful create operation.
✔  functions[trackLead]: Successful create operation.
✔  firestore: Released rules/indexes.
✔  storage: Released rules.
```

---

## Step 8 — Wire `trackLead` URL into the Portal

After deployment, get the `trackLead` HTTPS URL from the Firebase Console:
1. Console → **Functions** → copy the URL for `trackLead`
   - Format: `https://REGION-PROJECT_ID.cloudfunctions.net/trackLead`

2. In `ai-arch-portal.html`, find the `trackLead` fetch call (search `trackLead`) and replace the placeholder URL:
```javascript
fetch("https://YOUR-REGION-YOUR-ID.cloudfunctions.net/trackLead", { ... })
```

---

## Step 9 — Test with Emulators (optional but recommended)

```bash
# Install emulator dependencies
firebase init emulators
# (choose Functions, Firestore, Storage, Emulator UI)

# Start all emulators
firebase emulators:start

# Emulator UI: http://localhost:4000
# Functions:   http://localhost:5001
# Firestore:   http://localhost:8080
# Storage:     http://localhost:9199
```

To point the portal at the emulators during local testing, add to the portal's init block:
```javascript
if (location.hostname === "localhost") {
  auth.useEmulator("http://localhost:9099");
  db.useEmulator("localhost", 8080);
  storage.useEmulator("localhost", 9199);
}
```

---

## Firestore Data Schema

### `users/{uid}`
| Field | Type | Description |
|-------|------|-------------|
| `uid` | string | Firebase Auth UID |
| `email` | string | User email |
| `displayName` | string | Full name |
| `plan` | string | `"free"` \| `"pro"` \| `"studio"` |
| `totalRenders` | number | Lifetime render count |
| `dailyRenderCount` | number | Renders today |
| `lastRenderDate` | string | `"YYYY-MM-DD"` — resets daily |
| `lastRenderAt` | timestamp | Last render timestamp |
| `createdAt` | timestamp | Account creation |

### `renderQueue/{jobId}`
| Field | Type | Description |
|-------|------|-------------|
| `uid` | string | Owner UID |
| `sourceURL` | string | Storage download URL |
| `style` | string | e.g. `"modernist"` |
| `environment` | string | e.g. `"golden-hour"` |
| `status` | string | `"pending"` → `"processing"` → `"done"` \| `"error"` |
| `outputURL` | string | Replicate output image URL (when done) |
| `errorMessage` | string | Human-readable error (when error) |
| `createdAt` | timestamp | Job creation time |

### `gallery/{docId}`
| Field | Type | Description |
|-------|------|-------------|
| `uid` | string | Author UID |
| `authorName` | string | Display name |
| `title` | string | Auto-generated title |
| `style` | string | Render style |
| `environment` | string | Lighting environment |
| `imageURL` | string | Final render URL |
| `public` | boolean | Always `true` (admin writes) |
| `featured` | boolean | `false` by default |
| `createdAt` | timestamp | Gallery entry time |

---

## Rate Limiting

Free tier users are limited to **3 renders per day**.

The limit is tracked on the user's Firestore document (`dailyRenderCount` + `lastRenderDate`). When the date changes, the count resets automatically — no cron job needed.

Pro/Studio tier bypasses the limit (set `plan: "pro"` or `plan: "studio"` on the user doc via Firebase Console or admin script).

---

## Webhook Integrations (Activepieces)

| Hook | Trigger | URL |
|------|---------|-----|
| WELCOME_HOOK | New user created | `https://cloud.activepieces.com/api/v1/webhooks/uusAJlkobrnDCeGwdQITw` |
| LEAD_HOOK | "Get Started" clicked | `https://cloud.activepieces.com/api/v1/webhooks/gaqpTTBjcrwCpNPukckrm` |

Both hooks are called server-side from Cloud Functions — never from the browser.

---

## Replicate Model Config

The backend uses **SDXL ControlNet** for architectural rendering:
- Model: `lucataco/sdxl-controlnet` (override with `REPLICATE_MODEL`)
- Version: resolved to the model's latest at runtime and cached per instance; set `REPLICATE_MODEL_VERSION` to pin one
- Input: URL of source drawing + text prompt. The request is trimmed to the
  fields the resolved version's schema accepts (e.g. `controlnet_conditioning_scale`
  is sent as `condition_scale` for this model), so switching models doesn't
  fail on unknown inputs
- Output: photorealistic architectural render

---

## Security Notes

- **Never commit** `replicate.token` or any API key to git
- Firebase Security Rules prevent direct client writes to `gallery` and status updates to `renderQueue`
- The admin SDK used in Cloud Functions bypasses security rules intentionally
- Storage `uploads/` has public read so Replicate can fetch source images via plain HTTPS
- `trackLead` HTTPS endpoint has CORS `*` — acceptable because it only receives public lead data

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `functions:config:get` returns empty | Run `firebase functions:config:set` again |
| Replicate returns `401` | Check `replicate.token` is set correctly |
| Gallery is empty after render | Check Function logs: Console → Functions → Logs |
| `Error: quota exceeded` | Free tier limit hit; wait until tomorrow or upgrade plan |
| CORS error on `trackLead` | Ensure function is deployed; check URL in portal HTML |
| Emulator won't start | Run `firebase init emulators` first |

---

## Next Steps

1. Deploy to Firebase (Step 7 above)
2. Update portal `FIREBASE_CONFIG` with real values
3. Wire `trackLead` URL into portal HTML
4. Deploy portal to Cloudflare Pages for a permanent public URL
5. Set up Activepieces flows to handle WELCOME_HOOK and LEAD_HOOK payloads (send emails, add to CRM, etc.)
