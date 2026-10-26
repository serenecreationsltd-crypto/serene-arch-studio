# Cloudflare gateway rollout — Serene Intelligence

This is an **isolated new Worker**. It does not replace serene-ai-proxy or modify its rate limiting, cron, bindings, or routes.

## Architecture
serenecreations.org / serene-ai.serenecreations.org -> Cloudflare Worker -> HTTPS FastAPI origin

Cloudflare Workers do not execute the existing Python FastAPI server. Deploy that server separately to a Python/container runtime and attach a managed database.

## Security gate (must complete before deployment)
1. Configure BACKEND_ORIGIN to the verified HTTPS FastAPI origin, with a trailing slash. Store it as a Worker secret or secure variable.
2. Configure GATEWAY_SERVER_TOKEN as a Cloudflare Worker secret. **The FastAPI backend must validate this header before treating the gateway as trusted.** The current backend does not implement this verification; therefore the token is not yet an access-control mechanism.
3. Configure rate limiting for /api/chat at the edge and backend. The existing proxy RATE_KV is not shared with this Worker.
4. Lock down direct backend access, verify user authorization for conversation identifiers and add abuse protection before public exposure.
5. Configure Cloudflare API token in GitHub Actions as CLOUDFLARE_API_TOKEN and verify build/drift checks. Never put tokens in the public repository.
6. Confirm DNS routing for a new dedicated API hostname; do not redirect or replace the existing site.
7. Run integration tests including CORS, oversized request, backend unavailable, upstream redirect and unauthorized access.

## Important
The Worker exposes no admin endpoints. The four external providers are still disabled pending verified official APIs, credentials and permission.

## Deployment workflow
After code review, merging this branch will trigger the existing Workers deployment workflow. Do not merge until the security gates and secrets are configured; the workflow can deploy automatically when CLOUDFLARE_API_TOKEN is available.
