'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { CurationStore } = require('../src/curation');
const { toAsset } = require('../src/drive');
const { rateLimit, limitRange, inlineSafe } = require('../src/security');

const quiet = { info() {}, warn() {}, error() {} };

async function setup() {
  const root = { id: 'root', name: 'Brand' };
  const drive = {
    crawl: async () => ({
      assets: [
        toAsset({ id: 'svg1', name: 'logo.svg', mimeType: 'image/svg+xml', modifiedTime: '2026-01-01T00:00:00Z' }, '', 'Brand', [root]),
        toAsset({ id: 'jpg1', name: 'a.jpg', mimeType: 'image/jpeg', modifiedTime: '2026-01-01T00:00:00Z' }, '', 'Brand', [root]),
      ],
      folders: [{ id: 'root', name: 'Brand', path: '', ancestors: [] }],
    }),
    media: async (id) => (id === 'svg1'
      ? new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'content-type': 'image/svg+xml' } })
      : new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } })),
  };
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), curation: new CurationStore({ log: quiet }), log: quiet });
  await library.sync();
  const server = createApp({ library, drive }).listen(0);
  return { library, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('security headers on pages and API answers', async () => {
  const { server, base } = await setup();
  try {
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/drive\.google\.com/);
    assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual((await fetch(`${base}/api/assets`)).headers.get('cache-control'), 'no-store');
  } finally {
    server.close();
  }
});

test('files that could run scripts (SVG) download instead of opening', async () => {
  const { server, base } = await setup();
  try {
    const svg = await fetch(`${base}/api/assets/svg1/file`);
    assert.match(svg.headers.get('content-disposition'), /^attachment/);
    assert.match(svg.headers.get('content-security-policy'), /^sandbox/);
    const jpg = await fetch(`${base}/api/assets/jpg1/file`);
    assert.match(jpg.headers.get('content-disposition'), /^inline/);
  } finally {
    server.close();
  }
});

test('cross-site requests that change things are refused', async () => {
  const { server, base } = await setup();
  const post = (headers) => fetch(`${base}/api/collections`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name: 'x' }),
  });
  try {
    assert.strictEqual((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.strictEqual((await post({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.strictEqual((await post({ Origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await post({ 'Sec-Fetch-Site': 'same-origin', Origin: base })).status, 200);
    assert.strictEqual((await post({})).status, 200, 'non-browser clients send neither');
  } finally {
    server.close();
  }
});

test('collection ids like __proto__ are unknown, not the object prototype', async () => {
  const { server, base } = await setup();
  try {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const res = await fetch(`${base}/api/collections/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'pwned', description: 'd' }),
      });
      assert.strictEqual(res.status, 404, id);
    }
    assert.strictEqual({}.name, undefined);
    assert.strictEqual({}.description, undefined);
  } finally {
    server.close();
  }
});

test('rate limits count per person and window', () => {
  const limit = rateLimit({ max: 2, windowMs: 1000 });
  const ana = { user: { email: 'ana@rux.life' } };
  const ben = { user: { email: 'ben@rux.life' } };
  assert.deepStrictEqual([limit.check(ana), limit.check(ana), limit.check(ana), limit.check(ben)], [true, true, false, true]);
});

test('video ranges are capped at 8 MB; odd ranges are dropped', () => {
  assert.strictEqual(limitRange('bytes=0-'), 'bytes=0-8388607');
  assert.strictEqual(limitRange('bytes=10-20'), 'bytes=10-20');
  assert.strictEqual(limitRange('bytes=-100'), 'bytes=-100');
  assert.strictEqual(limitRange('bytes=-999999999'), 'bytes=-8388608');
  assert.strictEqual(limitRange('bytes=0-1,5-9'), undefined);
  assert.strictEqual(limitRange('bytes=9-1'), undefined);
  assert.strictEqual(limitRange(undefined), undefined);
});

test('only raster images and video open inline', () => {
  assert.ok(inlineSafe('image/jpeg'));
  assert.ok(inlineSafe('video/quicktime'));
  assert.ok(!inlineSafe('image/svg+xml'));
  assert.ok(!inlineSafe('text/html'));
  assert.ok(!inlineSafe(null));
});
