import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const path = new URL('../src/index.js', import.meta.url);
const worker = (await import(pathToFileURL(path.pathname).href)).default;
const env = { BACKEND_ORIGIN: 'https://backend.example/', GATEWAY_SERVER_TOKEN: 'test-token' };
async function check(pathname, options, expected) {
  const response = await worker.fetch(new Request('https://gateway.example' + pathname, options), env);
  assert.equal(response.status, expected, pathname);
}
await check('/api/admin/integrations', { method: 'GET' }, 404);
await check('/api/chat', { method: 'GET' }, 405);
await check('/api/chat', { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' }, 403);
await check('/api/chat', { method: 'POST', headers: { Origin: 'https://serenecreations.org', 'Content-Type': 'text/plain' }, body: '{}' }, 415);
await check('/api/chat', { method: 'POST', headers: { Origin: 'https://serenecreations.org', 'Content-Type': 'application/json' }, body: 'x'.repeat(16385) }, 413);
const unconfigured = await worker.fetch(new Request('https://gateway.example/api/health'), {});
assert.equal(unconfigured.status, 503);
console.log('Gateway security tests passed');
