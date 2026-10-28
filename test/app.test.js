'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp, parseFolderIds } = require('../src/server');
const { Library } = require('../src/library');
const { DriveClient, toAsset } = require('../src/drive');
const { RightsStore } = require('../src/rights');
const { TagStore } = require('../src/tags');

const files = [
  { id: 'img1', name: 'Hero Shot.jpg', mimeType: 'image/jpeg', size: '2048', modifiedTime: '2026-01-02T00:00:00Z', thumbnailLink: 'x', imageMediaMetadata: { width: 100, height: 50 } },
  { id: 'vid1', name: 'Launch.mp4', mimeType: 'video/mp4', size: '9999', modifiedTime: '2026-01-03T00:00:00Z', videoMediaMetadata: { durationMillis: '61000' } },
];

const quiet = { info() {}, warn() {}, error() {} };
const root = { id: 'root', name: 'Brand' };
const photos = { id: 'fPhotos', name: 'Photos' };
const videos = { id: 'fVideos', name: 'Videos' };

const fakeDrive = {
  crawl: async () => ({
    assets: [
      toAsset(files[0], 'Photos', 'Brand', [root, photos]),
      toAsset(files[1], 'Videos', 'Brand', [root, videos]),
    ],
    folders: [
      { id: 'root', name: 'Brand', path: '', ancestors: [] },
      { id: 'fPhotos', name: 'Photos', path: 'Photos', ancestors: [root] },
      { id: 'fVideos', name: 'Videos', path: 'Videos', ancestors: [root] },
    ],
  }),
  thumbnail: async () => new Response('thumb', { headers: { 'content-type': 'image/jpeg' } }),
  media: async (id, range) => new Response(`bytes:${id}:${range || ''}`, {
    status: range ? 206 : 200,
    headers: { 'content-type': 'video/mp4', 'content-range': range ? 'bytes 0-1/10' : '' },
  }),
};

async function withServer(opts, fn) {
  const rights = new RightsStore({ log: quiet });
  const tags = new TagStore({ log: quiet });
  const library = new Library(fakeDrive, ['root'], { rights, tags, log: quiet });
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

    const byPath = await (await fetch(`${base}/api/assets?q=brand%20photos`)).json();
    assert.deepStrictEqual(byPath.items.map((a) => a.id), ['img1']);

    const videos = await (await fetch(`${base}/api/assets?kind=video`)).json();
    assert.deepStrictEqual(videos.items.map((a) => a.id), ['vid1']);
    assert.strictEqual(videos.items[0].durationMs, 61000);

    const folders = await (await fetch(`${base}/api/folders`)).json();
    assert.deepStrictEqual(
      folders.map(({ id, parentId, count }) => ({ id, parentId, count })),
      [{ id: 'fPhotos', parentId: 'root', count: 1 }, { id: 'fVideos', parentId: 'root', count: 1 },
        { id: 'root', parentId: null, count: 2 }],
    );

    const inPhotos = await (await fetch(`${base}/api/assets?folder=fPhotos`)).json();
    assert.deepStrictEqual(inPhotos.items.map((a) => a.id), ['img1']);
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

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('usage rights: default, folder flags, file overrides, filter', async () => {
  await withServer({}, async (base) => {
    const get = async (id) => (await fetch(`${base}/api/assets/${id}`)).json();
    assert.deepStrictEqual((await get('img1')).rights, { status: 'cleared', note: '', source: { scope: 'default' } });

    assert.strictEqual((await post(`${base}/api/rights/fPhotos`, { status: 'restricted', note: 'no release' })).status, 200);
    const flagged = (await get('img1')).rights;
    assert.strictEqual(flagged.status, 'restricted');
    assert.strictEqual(flagged.note, 'no release');
    assert.deepStrictEqual(flagged.source, { scope: 'folder', id: 'fPhotos', name: 'Photos' });
    assert.strictEqual((await get('vid1')).rights.status, 'cleared', 'sibling folder unaffected');

    const restricted = await (await fetch(`${base}/api/assets?rights=restricted`)).json();
    assert.deepStrictEqual(restricted.items.map((a) => a.id), ['img1']);

    // A file flag overrides its folder; removing it falls back to the folder.
    await post(`${base}/api/rights/img1`, { status: 'cleared' });
    assert.strictEqual((await get('img1')).rights.source.scope, 'file');
    assert.strictEqual((await get('img1')).rights.status, 'cleared');
    await post(`${base}/api/rights/img1`, { status: 'inherit' });
    assert.strictEqual((await get('img1')).rights.status, 'restricted');

    // A flag on the root covers everything without a closer flag.
    await post(`${base}/api/rights/root`, { status: 'restricted' });
    assert.strictEqual((await get('vid1')).rights.source.id, 'root');

    assert.strictEqual((await post(`${base}/api/rights/unknown`, { status: 'restricted' })).status, 404);
    assert.strictEqual((await post(`${base}/api/rights/img1`, { status: 'maybe' })).status, 400);
  });
});

test('crawl walks nested folders in parallel and records ancestors', async () => {
  const tree = {
    root: [{ id: 'a', name: 'A', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'b', name: 'B', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'x.jpg', name: 'x.jpg', mimeType: 'image/jpeg' },
      { id: '._x.jpg', name: '._x.jpg', mimeType: 'image/jpeg' }, // macOS metadata file
      { id: 'doc', name: 'notes.pdf', mimeType: 'application/pdf' }],
    a: [{ id: 'a1', name: 'A1', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'y.mp4', name: 'y.mp4', mimeType: 'video/mp4' }],
    b: [{ id: 'z.png', name: 'z.png', mimeType: 'image/png' }],
    a1: [{ id: 'w.jpg', name: 'w.jpg', mimeType: 'image/jpeg' },
      { id: 'a', name: 'A', mimeType: 'application/vnd.google-apps.folder' }], // cycle via shortcut-like re-parenting
  };
  const drive = new DriveClient(null, { concurrency: 2 });
  let active = 0;
  let peak = 0;
  drive.getFile = async () => ({ id: 'root', name: 'Root' });
  drive.listChildren = async (id) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return tree[id];
  };
  const { assets, folders } = await drive.crawl('root');
  assert.deepStrictEqual(assets.map((a) => a.id).sort(), ['w.jpg', 'x.jpg', 'y.mp4', 'z.png']);
  assert.deepStrictEqual(folders.map((f) => f.path).sort(), ['', 'A', 'A/A1', 'B']);
  const w = assets.find((a) => a.id === 'w.jpg');
  assert.strictEqual(w.path, 'A/A1');
  assert.deepStrictEqual(w.ancestors.map((f) => f.id), ['root', 'a', 'a1']);
  assert.strictEqual(peak, 2, 'listed folders concurrently, capped at the limit');
});

test('metadata: folder tags inherit, file tags add, filters and facets', async () => {
  await withServer({}, async (base) => {
    const get = async (id) => (await fetch(`${base}/api/assets/${id}`)).json();
    const search = async (qs) => (await fetch(`${base}/api/assets?${qs}`)).json();

    const fields = await (await fetch(`${base}/api/fields`)).json();
    assert.deepStrictEqual(fields.map((f) => f.key).slice(0, 6), ['product', 'activity', 'color', 'vehicle', 'season', 'event']);
    assert.ok(fields.find((f) => f.key === 'season').values.includes('Winter'), 'season suggestions');

    // Tag a folder, then a file, then several files at once.
    assert.strictEqual((await post(`${base}/api/tags`, { ids: ['root'], add: { event: ['Sea Otter 2026'] } })).status, 200);
    await post(`${base}/api/tags`, { ids: ['img1'], add: { product: ['Duffel'], color: ['Black'] } });
    await post(`${base}/api/tags`, { ids: ['img1', 'vid1'], add: { activity: ['Mountain Biking'], product: ['duffel'] } });

    const img = await get('img1');
    assert.deepStrictEqual(img.tags.event, [{ value: 'Sea Otter 2026', from: { scope: 'folder', id: 'root', name: 'Brand' } }]);
    assert.deepStrictEqual(img.ownTags.product, ['Duffel']);
    const vid = await get('vid1');
    assert.deepStrictEqual(vid.ownTags.product, ['Duffel'], 'reuses the existing spelling');

    const all = await search('');
    assert.deepStrictEqual(all.facets.product, { Duffel: 2 });
    assert.deepStrictEqual(all.facets.event, { 'Sea Otter 2026': 2 });

    assert.deepStrictEqual((await search('tag=color:black')).items.map((a) => a.id), ['img1']);
    assert.strictEqual((await search('tag=color:Black&tag=color:Red')).total, 1, 'OR within a field');
    assert.strictEqual((await search('tag=color:Black&tag=product:Duffel')).total, 1, 'AND across fields');
    assert.strictEqual((await search('q=sea%20otter')).total, 2, 'search matches inherited tags');

    await post(`${base}/api/tags`, { ids: ['img1'], remove: { color: ['BLACK'] } });
    assert.strictEqual((await get('img1')).ownTags.color, undefined);

    // Custom fields.
    assert.strictEqual((await post(`${base}/api/fields`, { label: 'Photographer' })).status, 200);
    assert.strictEqual((await post(`${base}/api/fields`, { label: 'photographer' })).status, 400);
    await post(`${base}/api/tags`, { ids: ['vid1'], add: { photographer: ['Rhys Verner'] } });
    assert.deepStrictEqual((await get('vid1')).ownTags.photographer, ['Rhys Verner']);

    assert.strictEqual((await post(`${base}/api/tags`, { ids: ['img1'], add: { nope: ['x'] } })).status, 400);
    assert.strictEqual((await post(`${base}/api/tags`, { ids: ['ghost'], add: { color: ['x'] } })).status, 404);
    assert.strictEqual((await post(`${base}/api/tags`, { ids: [] })).status, 400);

    const folders = await (await fetch(`${base}/api/folders`)).json();
    assert.deepStrictEqual(folders.find((f) => f.id === 'root').tags, { event: ['Sea Otter 2026'] });
  });
});
