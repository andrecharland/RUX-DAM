'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DriveClient } = require('../src/drive');

const auth = { getClient: async () => ({ getRequestHeaders: async () => ({}) }) };

// Replaces fetch for one test; `handler(url)` returns a Response.
function stubFetch(t, handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return handler(String(url)); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test('thumbnails reuse cached links and look them up again when one expires', async (t) => {
  const calls = stubFetch(t, (url) => {
    if (url.includes('/files/a')) return Response.json({ id: 'a', thumbnailLink: 'https://lh3.test/new=s220' });
    if (url.startsWith('https://lh3.test/old')) return new Response('expired', { status: 403 });
    return new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } });
  });
  const drive = new DriveClient(auth);
  drive.links.set('a', { url: 'https://lh3.test/old=s220', at: Date.now() });

  const res = await drive.thumbnail('a', 600);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls.map((u) => u.replace(/\?.*/, '')), [
    'https://lh3.test/old=s600', 'https://www.googleapis.com/drive/v3/files/a', 'https://lh3.test/new=s600',
  ]);

  calls.length = 0;
  await drive.thumbnail('a', 300);
  assert.deepStrictEqual(calls, ['https://lh3.test/new=s300'], 'no Drive lookup while the link works');
});

test('thumbnail fetches are limited to a few at a time', async (t) => {
  let active = 0;
  let peak = 0;
  stubFetch(t, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return new Response('jpeg');
  });
  const drive = new DriveClient(auth, { thumbnailConcurrency: 2 });
  for (const id of ['a', 'b', 'c', 'd', 'e']) drive.links.set(id, { url: `https://lh3.test/${id}=s220`, at: Date.now() });
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => drive.thumbnail(id)));
  assert.ok(results.every((r) => r.ok));
  assert.strictEqual(peak, 2);
});

test("Drive's rate-limit errors are retried", async (t) => {
  let n = 0;
  stubFetch(t, () => (++n === 1
    ? Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 })
    : Response.json({ id: 'a', thumbnailLink: 'https://lh3.test/a=s220' })));
  const drive = new DriveClient(auth);
  assert.strictEqual(await drive.thumbnailLink('a'), 'https://lh3.test/a=s220');
  assert.strictEqual(n, 2);
});
