// Server-only generation adapters. Website links do not establish API access.
const FIREFLY = 'https://firefly-api.adobe.io';
const KLING = 'https://api-singapore.klingai.com';
const SCOPE = 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis';
const definitions = [
  { id: 'coohom', name: 'Coohom', url: 'https://www.coohom.com', capability: 'Interior design and 3D presentation', requirement: 'Coohom enterprise API agreement and project credentials' },
  { id: 'planner5d', name: 'Planner 5D', url: 'https://planner5d.com', capability: 'Editable 2D/3D floor plans', requirement: 'Planner 5D B2B contract, API credentials and approved embed domains' },
  { id: 'nim', name: 'Nim Plan Walkthrough', url: 'https://nim.video/planwalkthrough', capability: 'Concept walkthrough from a floor plan', requirement: 'Use the provider website; Plan Walkthrough API access is unverified' },
  { id: 'firefly', name: 'Adobe Firefly', url: 'https://firefly.adobe.com', capability: 'Concept image generation', requirement: 'Adobe Firefly Services OAuth server credentials and API entitlement' },
  { id: 'kling', name: 'Kling AI', url: 'https://kling.ai', capability: 'Animate a reference render', requirement: 'Kling API key and API credit balance' }
];

export function providerCatalog() {
  // Deliberately not "connected": configuration alone is not a live test.
  return definitions.map(p => ({ ...p, status: 'external-workflow', apiVerified: false }));
}

class ProviderError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
const reply = (body, status, cors) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ProviderError('JSON body required', 400);
  let size = 0, chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new ProviderError('Request too large', 413); }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new ProviderError('Invalid JSON object', 400); }
}

async function upstream(url, options, fetcher) {
  let res;
  try { res = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) }); }
  catch { throw new ProviderError('Provider request timed out or failed. Check job status before retrying.', 504); }
  if (!res.ok) throw new ProviderError('Provider rejected the request (HTTP ' + res.status + '). Check API entitlement, credentials and credits.');
  try { return await res.json(); }
  catch { throw new ProviderError('Provider returned an unreadable response'); }
}

async function adobeHeaders(env, fetcher) {
  const auth = await upstream('https://ims-na1.adobelogin.com/ims/token/v3', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.FIREFLY_SERVICES_CLIENT_ID,
      client_secret: env.FIREFLY_SERVICES_CLIENT_SECRET, scope: SCOPE }).toString()
  }, fetcher);
  if (!auth.access_token) throw new ProviderError('Adobe did not issue an access token');
  return { 'Content-Type': 'application/json', Accept: 'application/json',
    'x-api-key': env.FIREFLY_SERVICES_CLIENT_ID, Authorization: 'Bearer ' + auth.access_token };
}

function promptOf(body) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 1500)
    throw new ProviderError('A prompt of 1–1500 characters is required', 400);
  return body.prompt.trim();
}

function referenceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('An approved HTTPS reference image URL is required', 400); }
  // No arbitrary URL proxy, private network hosts or embedded credentials.
  const approved = ['serenecreations.org', 'www.serenecreations.org', 'firebasestorage.googleapis.com', 'storage.googleapis.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !approved.includes(url.hostname))
    throw new ProviderError('Use a Serene website or Google Storage reference image URL', 400);
  return url.href;
}

export async function handleDesignProviders(request, env, cors, { isServer, allow, fetcher = fetch }) {
  const url = new URL(request.url);
  if (url.pathname === '/design/providers' && request.method === 'GET')
    return reply({ providers: providerCatalog() }, 200, cors);
  // Paid actions and provider job results are never exposed to anonymous clients.
  if (!isServer) return reply({ error: 'Server authentication required' }, 401, cors);
  const match = url.pathname.match(/^\/design\/(firefly|kling)\/(generate|status)$/);
  if (!match) return reply({ error: 'Route not found' }, 404, cors);
  const [, provider, action] = match;
  if (request.method !== (action === 'generate' ? 'POST' : 'GET'))
    return reply({ error: 'Method not allowed' }, 405, cors);
  const configured = provider === 'firefly'
    ? env.FIREFLY_SERVICES_CLIENT_ID && env.FIREFLY_SERVICES_CLIENT_SECRET
    : env.KLING_API_KEY;
  if (!configured || (action === 'generate' && env.DESIGN_GENERATION_ENABLED !== 'true'))
    return reply({ error: 'Provider setup required; generation is not enabled' }, 503, cors);
  try {
    let body, jobId;
    if (action === 'generate') {
      body = await readBody(request);
      body.prompt = promptOf(body);
      if (provider === 'kling') body.imageUrl = referenceUrl(body.imageUrl);
    } else {
      jobId = url.searchParams.get('jobId') || '';
      if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(jobId)) throw new ProviderError('Invalid job ID', 400);
    }
    // Use the Worker's existing rate store; require it for paid generation.
    if (action === 'generate' && !env.RATE_KV) throw new ProviderError('Shared rate store required', 503);
    if (!(await allow(env, 'design-' + action, action === 'generate' ? 10 : 120, 3600)))
      throw new ProviderError('Design request limit reached', 429);
    if (provider === 'firefly') {
      const headers = await adobeHeaders(env, fetcher);
      const data = await upstream(action === 'generate' ? FIREFLY + '/v3/images/generate-async' : FIREFLY + '/v3/status/' + encodeURIComponent(jobId),
        action === 'generate' ? { method: 'POST', headers, body: JSON.stringify({ prompt: body.prompt, contentClass: 'photo' }) } : { headers }, fetcher);
      if (action === 'generate') {
        if (!data.jobId) throw new ProviderError('Adobe response did not include a job ID');
        return reply({ provider, jobId: data.jobId, status: 'submitted' }, 202, cors);
      }
      return reply({ provider, jobId, result: data }, 200, cors);
    }
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.KLING_API_KEY };
    const data = await upstream(action === 'generate' ? KLING + '/image-to-video/kling-3.0' : KLING + '/tasks?task_ids=' + encodeURIComponent(jobId),
      action === 'generate' ? { method: 'POST', headers, body: JSON.stringify({
        contents: [{ type: 'prompt', text: body.prompt }, { type: 'first_frame', url: body.imageUrl }],
        settings: { resolution: '1080p', duration: 5, audio: 'off', multi_shot: false }
      }) } : { headers }, fetcher);
    if (data.code !== 0) throw new ProviderError('Kling rejected the request. Check the provider dashboard.');
    if (action === 'generate') {
      if (!data.data?.id) throw new ProviderError('Kling response did not include a job ID');
      return reply({ provider, jobId: data.data.id, status: data.data.status || 'submitted' }, 202, cors);
    }
    return reply({ provider, jobId, result: data.data }, 200, cors);
  } catch (error) {
    // Never reflect provider response bodies, tokens, or internal error details.
    return reply({ error: error instanceof ProviderError ? error.message : 'Design provider request failed' },
      error instanceof ProviderError ? error.status : 500, cors);
  }
}
