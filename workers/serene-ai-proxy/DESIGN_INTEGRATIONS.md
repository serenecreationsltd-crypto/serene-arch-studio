# Serene design integrations

The Studio links to `/design-tools.html`, which offers 17 external workflows and
a local project-brief builder. Opening a provider is not an API connection. No
reference file or brief is automatically uploaded to a third party.

## Activation status

| Service | Implemented | Required for automation |
| --- | --- | --- |
| Coohom | External launcher and brief | Enterprise API agreement, credentials and licensed SDK documentation |
| Planner 5D | External launcher and brief | B2B contract, provisioned REST/JS access and domain approval |
| Nim Plan Walkthrough | External launcher and brief | Confirmed Plan Walkthrough API documentation and entitlement |
| Adobe Firefly | Server-only asynchronous generation and job polling | Firefly Services OAuth credentials, entitlement and live validation |
| Kling AI | Server-only image-to-video generation and job polling | Current API key, API credits and live validation |
| Pika / Pikaframes | Server-only two-keyframe transition and job polling | Pika API key, separate API billing and live validation |
| Revid AI | Server-only script-to-video and job polling | Revid API key, active plan, credits and live validation |
| Luma Dream Machine | External launcher and brief | Luma API platform access and current model/endpoint provisioning |
| Hailuo AI | External launcher and brief | MiniMax API access and current video model provisioning |
| Kaiber | External launcher and brief | Public automation API remains unverified |
| HeyGen | External launcher and brief | API plan, credentials and approved avatar/voice |
| Immersity | External launcher and brief | API entitlement and current account credentials |
| Higgsfield | External launcher and brief | API console credentials and model entitlement |
| Magnific | External launcher and brief | Magnific/Freepik API access and current endpoint verification |
| Dzine | External launcher and brief | Developer API credentials and provisioned endpoint scope |
| OpenArt | External launcher and brief | Official help states no public API at time of review |
| Getfloorplan | External launcher and brief | Business API provisioning and account-specific documentation |

Public GET `/design/providers` intentionally reports `apiVerified: false` for all
providers. Do not change this merely because a key exists. Replace static status
with a verified, persisted connection record before presenting API readiness.

## Firefly, Kling, Pika and Revid server setup

Store secrets on the existing `serene-ai-proxy` Worker, never in HTML or Git:

- `FIREFLY_SERVICES_CLIENT_ID`
- `FIREFLY_SERVICES_CLIENT_SECRET`
- `KLING_API_KEY` (current Bearer API key; legacy access/secret key JWTs are not implemented)
- `PIKA_API_KEY`
- `REVID_API_KEY`
- Existing `SERVER_SECRET` authenticates the trusted automation backend.

New paid requests remain disabled unless `DESIGN_GENERATION_ENABLED=true` is set
explicitly. A `RATE_KV` binding is also required for generation. Existing Worker
configuration and secrets are preserved; no new deployment target is created.
The existing rate limiter uses KV read/write counters, which are best-effort and
not atomic. Keep provider-side spending limits; serialize automation starts. This
is an initial server integration, not a public customer billing/credit feature.

Only a trusted backend such as Activepieces may use the following routes, with
header `X-Server-Secret`. Never put that shared secret in browser code.

| Method | Route | Input |
| --- | --- | --- |
| POST | `/design/firefly/generate` | JSON: `prompt`, 1–1500 characters |
| GET | `/design/firefly/status?jobId=...` | Job ID from generation |
| POST | `/design/kling/generate` | JSON: `prompt`, `imageUrl` |
| GET | `/design/kling/status?jobId=...` | Job ID from generation |
| POST | `/design/pika/generate` | JSON: `prompt`, `images` (exactly two approved reference URLs) |
| GET | `/design/pika/status?jobId=...` | Job ID from generation |
| POST | `/design/revid/generate` | JSON: `prompt` containing the approved spoken script |
| GET | `/design/revid/status?jobId=...` | Project ID from generation |

Kling uses a 5-second, 1080p, silent single-shot request. References must be HTTPS
URLs on serenecreations.org, www.serenecreations.org, storage.googleapis.com or
firebasestorage.googleapis.com. Attach an approved render, not an unreviewed plan.
Do not add new allowed hosts without reviewing where reference images are sent.

Pikaframes uses exactly two approved image URLs and a single 5-second transition
at 720p. Revid uses the script-to-video workflow; the prompt is the spoken script,
not a visual direction or a project brief. Review both the script and generated
visuals. No social publishing or Buffer schedules are changed by these routes.

Generation responds with HTTP 202 and a provider job ID. Save the ID in the
automation's durable job record and poll status. Polling remains available when
new generation is disabled. These routes do not implement billing, durable job
storage, idempotent replay, customer entitlements or automatic retries. Do not
retry a timed-out create request automatically: the provider may have accepted it.
Check the provider dashboard first. Review results against original drawings.

## Validation and release

Run `node --test workers/serene-ai-proxy/test/design-providers.test.mjs`.
The tests use mocked provider responses; they do not verify live API access.
Before enabling automation: confirm account entitlements; configure secrets;
run one controlled job per provider; verify status and downloaded outputs;
record the test result; connect durable job tracking and repeat-send prevention.
The initial PR must not be described as live provider activation.

## Official references

- https://www.coohom.com/enterprise/api
- https://coohom.readme.io/reference/api
- https://support.planner5d.com/en/articles/15189751-planner-5d-b2b-api-technical-overview
- https://nim.video/planwalkthrough
- https://developer.adobe.com/firefly-services/docs/firefly-api/getting-started/
- https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis
- https://kling.ai/document-api/api/get-started/authentication
- https://kling.ai/document-api/apiReference/model/imageToVideo
- https://dev.pika.art/models/pika/pikaframes/image-to-video
- https://www.revid.ai/docs
- https://docs.lumalabs.ai/docs/video-generation
- https://platform.minimax.io/docs/llms.txt
- https://helpcenter.kaiber.ai/
- https://www.heygen.com/
- https://docs-api.immersity.ai/docs/getting-started
- https://higgsfield.ai/creator-hub/help-center/getting-started/official-higgsfield-platforms
- https://magnific.ai/
- https://www.dzine.ai/api/
- https://openart.ai/help/
- https://getfloorplan.com/news/cut-costs
