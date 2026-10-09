# Cloudflare Workers

The live Workers, imported from the Cloudflare dashboard on 2026-10-09. Each folder
holds the Worker's code exactly as it was running, plus a `wrangler.toml`:

| Folder | Live Worker name | What it serves |
|---|---|---|
| `serene-ai-proxy/` | `serene-ai-proxy` | AI estimates (`/boq-generate`), live tenders (`/scrape` + daily cron), news (`/news`), Anthropic proxy for Activepieces |
| `serene-growth/` | `throbbing-dew-b70b` | Newsletter, calculator leads, quote requests, AI assistant, auto-blog, listings, promo banner |
| `serene-blog/` | `crimson-wave-dc4e` | `serenecreations.org/blog*` pages from Firebase RTDB `/blog` |

The `name` in each `wrangler.toml` is the live Worker's name, so deploys update
the existing Worker (they don't create a new one).

| | |
|---|---|
| Cloudflare account ID | `aec23a55e10eea9fcb2cb9bcbaf69298` (set in the workflow) |
| workers.dev subdomain | `serenecreationsltd.workers.dev` |

## How deploys work

Pushing a change under `workers/` to `main` runs
`.github/workflows/cloudflare-workers-deploy.yml`. For each Worker it:

1. **Build check:** `wrangler deploy --dry-run`. Runs with or without the token.
2. **Drift check:** `scripts/cf-worker-drift.py` reads the live Worker's settings and
   stops the deploy if it would remove a live binding (KV, D1, R2, AI, service…), or
   change compatibility_date or flags, workers.dev, Workers Logs, logpush or placement.
   The job summary prints the live values as a `wrangler.toml` block to paste in.
3. **Deploy:** `wrangler deploy`. Secrets, dashboard variables (`keep_vars = true`),
   cron schedules and routes are left as they are in the dashboard.

To make an intentional change the drift check would block (say, a newer
`compatibility_date`), run the workflow by hand with **Allow config changes** ticked.

## One-time setup: the API token

Until this secret exists, runs do the build check only and pass with a warning.

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → template
   **Edit Cloudflare Workers** → Account resources: Serene Creations Ltd; Zone
   resources: `serenecreations.org` → Create. Copy the token; it's shown once.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository
   secret** → name `CLOUDFLARE_API_TOKEN`, paste, save.
3. **Actions → Deploy Cloudflare Workers → Run workflow.** If the drift check stops
   a Worker, copy the block from the job summary into its `wrangler.toml`, push,
   and it deploys.

Never paste the token into code, chat or a config file. If it's ever exposed,
roll it from the same API Tokens page.

## Not imported (on purpose)

| Worker | Why |
|---|---|
| `empty-queen-b0f7` (Pesapal IPN) | Its code contains a live Resend API key, and this repo is public. Rotate that key in Resend, move it into a Worker secret, then import. |
| `twilight-poetry-6fab` | Firebase account creation endpoint; open to anyone (no auth, CORS `*`). Review before keeping. |
| `royal-term-ccf5`, `odd-thunder-adbe`, `summer-mouse-76ad` | Three copies of a ZeptoMail welcome-email sender, open to any recipient. Keep one, delete the rest. |
| `weathered-flower-fc6c`, `bold-sun-b4d3` | Unmodified Workers AI hello-world templates. Safe to delete. |

Never commit API keys, passwords or service-account JSON here; use
`wrangler secret put <NAME> --name <worker>` or the dashboard's Variables and Secrets.
