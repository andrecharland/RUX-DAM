'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp, parseFolderIds } = require('../src/server');
const { Library } = require('../src/library');
const { toAsset } = require('../src/drive');

const files = [
  { id: 'img1', name: 'Hero Shot.jpg', mimeType: 'image/jpeg', size: '2048', modifiedTime: '2026-01-02T00:00:00Z', thumbnailLink: 'x', imageMediaMetadata: { width: 100, height: 50 } },
  { id: 'vid1', name: 'Launch.mp4', mimeType: 'video/mp4', size: '9999', modifiedTime: '2026-01-03T00:00:00Z', videoMediaMetadata: { durationMillis: '61000' } },
];

const fakeDrive = {
  crawl: async () => files.map((f, i) => toAsset(f, i ? 'Videos' : 'Photos/2026', 'Brand')),
  thumbnail: async () => new Response('thumb', { headers: { 'content-type': 'image/jpeg' } }),
  media: async (id, range) => new Response(`bytes:${id}:${range || ''}`, {
    status: range ? 206 : 200,
    headers: { 'content-type': 'video/mp4', 'content-range': range ? 'bytes 0-1/10' : '' },
  }),
};

async function withServer(opts, fn) {
  const library = new Library(fakeDrive, ['root'], { log: { info() {}, error() {} } });
  await library.sync();
  const server = createApp({ library, drive: fakeDrive, ...opts }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('parseFolderIds accepts IDs and Drive URLs', () => {
  assert.deepStrictEqual(
    parseFolderIds('abc123, https://drive.google.com/drive/folders/XYZ_-9?usp=sharing def'),
    ['abc123', 'XYZ_-9', 'def'],
  );
});

test('lists, searches and filters assets', async () => {
  await withServer({}, async (base) => {
    const all = await (await fetch(`${base}/api/assets`)).json();
    assert.strictEqual(all.total, 2);
    assert.strictEqual(all.items[0].id, 'vid1', 'newest first');

    const hero = await (await fetch(`${base}/api/assets?q=hero`)).json();
    assert.deepStrictEqual(hero.items.map((a) => a.id), ['img1']);

    const byPath = await (await fetch(`${base}/api/assets?q=photos%202026`)).json();
    assert.deepStrictEqual(byPath.items.map((a) => a.id), ['img1']);

    const videos = await (await fetch(`${base}/api/assets?kind=video`)).json();
    assert.deepStrictEqual(videos.items.map((a) => a.id), ['vid1']);
    assert.strictEqual(videos.items[0].durationMs, 61000);

    const cols = await (await fetch(`${base}/api/collections`)).json();
    assert.deepStrictEqual(cols, [{ name: 'Brand', count: 2 }]);
  });
});

test('proxies media with range support and blocks unknown ids', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/assets/vid1/file?download=1`, { headers: { Range: 'bytes=0-1' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(await res.text(), 'bytes:vid1:bytes=0-1');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Launch\.mp4/);

    const thumb = await fetch(`${base}/api/assets/img1/thumbnail`);
    assert.strictEqual(await thumb.text(), 'thumb');

    assert.strictEqual((await fetch(`${base}/api/assets/secret/file`)).status, 404);
  });
});

test('password gate', async () => {
  await withServer({ password: 's3cret' }, async (base) => {
    assert.strictEqual((await fetch(`${base}/api/assets`)).status, 401);
    assert.strictEqual((await fetch(`${base}/healthz`)).status, 200);
    const auth = { Authorization: `Basic ${Buffer.from('rux:s3cret').toString('base64')}` };
    assert.strictEqual((await fetch(`${base}/api/assets`, { headers: auth })).status, 200);
  });
});
