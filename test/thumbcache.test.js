'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { toAsset } = require('../src/drive');
const { ThumbCache, snapSize, thumbVersion } = require('../src/thumbcache');

const quiet = { info() {}, warn() {}, error() {} };

test('previews are fetched from Drive once per size and cached by version', async () => {
  const root = { id: 'root', name: 'Brand' };
  const sizes = [];
  const drive = {
    crawl: async () => ({
      assets: Array.from({ length: 30 }, (_, i) => toAsset({ id: `a${i}`, name: `a${i}.jpg`, mimeType: 'image/jpeg', thumbnailLink: 'x',
        modifiedTime: '2026-06-01T10:00:00Z' }, 'Brand', 'Brand', [root])),
      folders: [{ id: 'root', name: 'Brand', path: '', ancestors: [] }],
    }),
    thumbnail: async (id, size) => {
      sizes.push(size);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(`jpeg ${id} ${size}`, { headers: { 'content-type': 'image/jpeg' } });
    },
  };
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const server = createApp({ library, drive }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const v = thumbVersion(library.byId.get('a1'));
    // 600 and 700 both round up to 1024; requests at the same moment share one fetch.
    const [one, two] = await Promise.all([
      fetch(`${base}/api/assets/a1/thumbnail?size=600&v=${v}`),
      fetch(`${base}/api/assets/a1/thumbnail?size=700`),
    ]);
    assert.strictEqual(await one.text(), 'jpeg a1 1024');
    assert.strictEqual(await two.text(), 'jpeg a1 1024');
    assert.deepStrictEqual(sizes, [1024]);
    assert.match(one.headers.get('cache-control'), /immutable/, 'kept for good with the current version');
    assert.strictEqual(two.headers.get('cache-control'), 'private, max-age=3600', 'an hour without it');
    const stale = await fetch(`${base}/api/assets/a1/thumbnail?size=600&v=old`);
    assert.strictEqual(stale.headers.get('cache-control'), 'private, max-age=3600');
    assert.deepStrictEqual(sizes, [1024], 'served from the cache');
    await fetch(`${base}/api/assets/a1/thumbnail?size=200`);
    assert.deepStrictEqual(sizes, [1024, 256]);

    // JSON is compressed.
    const list = await fetch(`${base}/api/assets`, { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(list.headers.get('content-encoding'), 'gzip');
    assert.strictEqual((await list.json()).total, 30);
  } finally {
    server.close();
  }
});

test('sizes round up to a standard size', () => {
  assert.deepStrictEqual([1, 256, 257, 600, 1024, 1500, 4000].map(snapSize), [256, 256, 512, 1024, 1024, 2048, 2048]);
});

test('previews are kept in the bucket, so a restart still finds them', async (t) => {
  const objects = new Map();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      const name = u.searchParams.get('name');
      if (objects.has(name)) return new Response('', { status: 412 });
      objects.set(name, { body: Buffer.from(init.body), type: init.headers['Content-Type'] });
      return Response.json({ name });
    }
    const name = decodeURIComponent(u.pathname.split('/o/')[1]);
    const hit = objects.get(name);
    return hit ? new Response(hit.body, { headers: { 'content-type': hit.type } }) : new Response('', { status: 404 });
  };
  t.after(() => { globalThis.fetch = real; });
  const auth = { getClient: async () => ({ getRequestHeaders: async () => ({}) }) };
  let loads = 0;
  const load = async () => { loads++; return { body: Buffer.from('jpeg'), type: 'image/jpeg' }; };

  const first = new ThumbCache({ auth, bucket: 'b', log: quiet });
  assert.strictEqual((await first.fetch('thumbs/a/x-512', load)).body.toString(), 'jpeg');
  await new Promise((r) => setTimeout(r, 20)); // background save
  assert.ok(objects.has('thumbs/a/x-512'));

  const restarted = new ThumbCache({ auth, bucket: 'b', log: quiet });
  const again = await restarted.fetch('thumbs/a/x-512', load);
  assert.strictEqual(again.body.toString(), 'jpeg');
  assert.strictEqual(again.type, 'image/jpeg');
  assert.strictEqual(loads, 1, 'Drive asked once');
});
