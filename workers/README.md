# Cloudflare Workers

Each Worker lives in its own folder with a wrangler config:

```
workers/
  serene-backend/   wrangler.toml + src/   (payments, leads)
  serene-growth/    wrangler.toml + src/   (marketing, AI, listings)
```

Pushing a change under `workers/` to `main` deploys it via
`.github/workflows/cloudflare-workers-deploy.yml`. You can also run that workflow by
hand (Actions → Deploy Cloudflare Workers → Run workflow) for one Worker or all.

## One-time setup: authentication (replaces the `{API_TOKEN}` placeholder)

1. Create the token: Cloudflare dashboard → **My Profile → API Tokens → Create Token**
   → template **Edit Cloudflare Workers** → Account resources: your account;
   Zone resources: `serenecreations.org` → Create. Copy the token; it's shown once.
2. Find the account ID: Cloudflare dashboard → **Workers & Pages** → right-hand
   sidebar, **Account ID**.
3. Add both as GitHub repository secrets (repo → Settings → Secrets and variables →
   Actions → New repository secret):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

Never paste the token into code, chat or a config file. If it's ever exposed,
roll it from the same API Tokens page.

## First import of a Worker that's already live

`wrangler deploy` replaces the live Worker with what's in the folder, including its
bindings. Before the first deploy, make the folder match what's running:

- **Code:** Workers & Pages → the Worker → **Edit code**; copy the files into `src/`.
- **Config:** copy the name, `main`, `compatibility_date`, routes / custom domains, and
  every binding (KV, D1, R2, service bindings, cron triggers) from the Worker's
  **Settings** tab into `wrangler.toml`. A binding left out is removed on deploy.
- **Secrets** (Pesapal keys etc.) set in the dashboard or with `wrangler secret put`
  survive deploys, so don't put them in `wrangler.toml`.
- Add `keep_vars = true` to `wrangler.toml` so plain-text variables set in the
  dashboard aren't wiped.

Minimal `wrangler.toml`:

```toml
name = "serene-backend"
main = "src/index.js"
compatibility_date = "2026-10-01"
keep_vars = true

# routes = [{ pattern = "api.serenecreations.org", custom_domain = true }]
# [[kv_namespaces]]
# binding = "LEADS"
# id = "<namespace id from the dashboard>"
```
