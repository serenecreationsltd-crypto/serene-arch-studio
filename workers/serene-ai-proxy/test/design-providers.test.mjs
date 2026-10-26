import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDesignProviders } from '../src/design-providers.mjs';

const env = { DESIGN_GENERATION_ENABLED: 'true', FIREFLY_SERVICES_CLIENT_ID: 'test-id', FIREFLY_SERVICES_CLIENT_SECRET: 'secret-test', KLING_API_KEY: 'kling-test', RATE_KV: {} };
function request(provider, body, action = 'generate') {
  return new Request('https://worker.example/design/' + provider + '/' + action,
    action === 'generate' ? { method: 'POST', body: JSON.stringify(body) } : {});
}
function run(req, overrides = {}, opts = {}) {
  return handleDesignProviders(req, { ...env, ...overrides }, {}, { isServer: true, allow: async () => true,
    fetcher: async () => { throw new Error('Unexpected network request'); }, ...opts });
}
test('catalog never claims live authentication and exposes no secret values', async () => {
  const res = await run(new Request('https://worker.example/design/providers'));
  const data = await res.json(); assert.equal(data.providers.length, 5);
  assert.ok(data.providers.every(p => p.apiVerified === false));
  assert.ok(!JSON.stringify(data).includes('secret-test'));
});
test('anonymous paid actions are denied before provider calls', async () => {
  assert.equal((await run(request('kling', {}), {}, { isServer: false })).status, 401);
});
test('missing credentials and default disabled generation fail closed', async () => {
  assert.equal((await run(request('kling', {}), { KLING_API_KEY: '' })).status, 503);
  assert.equal((await run(request('firefly', {}), { DESIGN_GENERATION_ENABLED: undefined })).status, 503);
});
test('invalid input and oversized input are rejected locally', async () => {
  assert.equal((await run(request('firefly', { prompt: 'x'.repeat(1501) }))).status, 400);
  assert.equal((await run(request('firefly', { prompt: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await run(request('firefly', null))).status, 400);
});
test('unapproved image hosts and credentials in URLs are rejected', async () => {
  for (const imageUrl of ['http://127.0.0.1/a.png', 'https://evil.example/a.png', 'https://user:pass@storage.googleapis.com/a.png']) {
    assert.equal((await run(request('kling', { prompt: 'Animate', imageUrl }))).status, 400);
  }
});
test('generation requires shared rate storage and honors rate denial', async () => {
  assert.equal((await run(request('firefly', { prompt: 'House' }), { RATE_KV: undefined })).status, 503);
  assert.equal((await run(request('firefly', { prompt: 'House' }), {}, { allow: async () => false })).status, 429);
});
test('Firefly uses server OAuth and async generation without returning token', async () => {
  const calls = [];
  const res = await run(request('firefly', { prompt: 'House' }), {}, { fetcher: async (url, options) => {
    calls.push([url, options]);
    return Response.json(calls.length === 1 ? { access_token: 'private-token' } : { jobId: 'urn:ff:jobs:test' });
  } });
  assert.equal(res.status, 202); const result = await res.json();
  assert.equal(result.jobId, 'urn:ff:jobs:test'); assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'https://firefly-api.adobe.io/v3/images/generate-async');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer private-token');
  assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('Kling uses current endpoint, capped settings and returns job identifier', async () => {
  const res = await run(request('kling', { prompt: 'Slow pan', imageUrl: 'https://www.serenecreations.org/render.png', duration: 99 }), {}, {
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api-singapore.klingai.com/image-to-video/kling-3.0');
      const body = JSON.parse(options.body); assert.equal(body.settings.duration, 5);
      assert.equal(body.contents[1].type, 'first_frame');
      return Response.json({ code: 0, data: { id: '123', status: 'submitted' } });
    }
  });
  assert.equal(res.status, 202); assert.equal((await res.json()).jobId, '123');
});
test('polling still works when new generation is disabled and never creates a job', async () => {
  const req = new Request('https://worker.example/design/kling/status?jobId=123');
  const res = await run(req, { DESIGN_GENERATION_ENABLED: 'false' }, { fetcher: async (url, options) => {
    assert.equal(url, 'https://api-singapore.klingai.com/tasks?task_ids=123'); assert.ok(!options.body);
    return Response.json({ code: 0, data: [{ id: '123', status: 'succeeded', outputs: [] }] });
  } });
  assert.equal(res.status, 200);
});
test('bad polling IDs and methods do not reach provider', async () => {
  assert.equal((await run(new Request('https://worker.example/design/firefly/status?jobId=../../evil'))).status, 400);
  assert.equal((await run(new Request('https://worker.example/design/kling/generate'))).status, 405);
});
test('provider errors never disclose response secrets and do not retry', async () => {
  let count = 0;
  const res = await run(request('kling', { prompt: 'Pan', imageUrl: 'https://storage.googleapis.com/a.png' }), {}, {
    fetcher: async () => { count++; return new Response('secret-test', { status: 401 }); }
  });
  assert.equal(res.status, 502); assert.equal(count, 1); assert.ok(!(await res.text()).includes('secret-test'));
});
test('timeout returns uncertain outcome warning without automatic retry', async () => {
  const res = await run(request('kling', { prompt: 'Pan', imageUrl: 'https://storage.googleapis.com/a.png' }));
  assert.equal(res.status, 504); assert.match((await res.json()).error, /Check job status before retrying/);
});
