'use strict';

const test = require('node:test');
const assert = require('node:assert');
const naming = require('../public/naming');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { toAsset } = require('../src/drive');

const quiet = { info() {}, warn() {}, error() {} };

test('builds names in the RUX convention from plain values', () => {
  const parts = { product: 'Gear Box 70L', concept: 'Proof', format: 'Reels', aspect: '9:16', creator: 'Cal', date: '2026-06-08', version: 1 };
  assert.strictEqual(naming.compose(parts).name, 'RUX_GearBox70L_Proof_Reels_9x16_Cal_2026-06-08_v01');
  assert.strictEqual(naming.compose({ ...parts, product: 'RUX 70L Core', concept: 'Product-in-Context', format: 'Feed Video', aspect: '1.91 x 1', version: 12 }).name,
    'RUX_70LCore_ProductInContext_FeedVideo_1.91x1_Cal_2026-06-08_v12');
  const bad = naming.compose({ ...parts, product: '', aspect: 'tall', date: '2026-13-40', version: 0 });
  assert.strictEqual(bad.name, '');
  assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['aspect', 'date', 'product', 'version']);
});

test('reads names that follow the convention, and aspects from pixels', () => {
  assert.deepStrictEqual(naming.parse('RUX_GearBox70L_Proof_Reels_9x16_Cal_2026-06-08_v01.mp4'), {
    product: 'GearBox70L', concept: 'Proof', format: 'Reels', aspect: '9x16', creator: 'Cal', date: '2026-06-08', version: 1,
  });
  assert.strictEqual(naming.parse('IMG_7662.HEIC'), null);
  assert.strictEqual(naming.parse('RUX_GearBox70L_Proof_Reels_9x16_Cal_2026-06-08'), null, 'version is required');
  assert.strictEqual(naming.aspectOf(1080, 1920), '9x16');
  assert.strictEqual(naming.aspectOf(1080, 1350), '4x5');
  assert.strictEqual(naming.aspectOf(1200, 628), '1.91x1');
  assert.strictEqual(naming.aspectOf(1000, 700), '');
});

test('labels on folders and files: name, tags, search, downloads', async () => {
  const root = { id: 'root', name: 'Brand' };
  const shoot = { id: 'fShoot', name: 'Cal reels june' };
  const drive = {
    crawl: async () => ({
      assets: [toAsset({ id: 'v1', name: 'final_cut_3.mp4', mimeType: 'video/mp4', modifiedTime: '2026-06-09T00:00:00Z',
        videoMediaMetadata: { width: 1080, height: 1920 } }, 'Cal reels june', 'Brand', [root, shoot])],
      folders: [{ id: 'root', name: 'Brand', path: '', ancestors: [] }, { ...shoot, path: shoot.name, ancestors: [root] }],
    }),
    media: async () => new Response('video-bytes', { headers: { 'content-type': 'video/mp4' } }),
  };
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const server = createApp({ library, drive }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (url) => (await fetch(base + url)).json();
  try {
    const parts = { product: 'Gear Box 70L', concept: 'Proof', format: 'Reels', aspect: '9x16', creator: 'Cal', date: '2026-06-08', version: 1 };
    const res = await (await post('/api/labels/fShoot', { parts })).json();
    assert.strictEqual(res.label.name, 'RUX_GearBox70L_Proof_Reels_9x16_Cal_2026-06-08_v01');

    const folder = (await get('/api/folders')).find((f) => f.id === 'fShoot');
    assert.strictEqual(folder.label.name, res.label.name);
    assert.deepStrictEqual(folder.tags, { product: ['Gear Box 70L'], concept: ['Proof'], format: ['Reels'], aspect: ['9x16'], creator: ['Cal'] });

    // The file inherits the folder's label parts as tags and is found by the label.
    const asset = await get('/api/assets/v1');
    assert.strictEqual(asset.tags.format[0].value, 'Reels');
    assert.deepStrictEqual((await get('/api/assets?q=GearBox70L_Proof')).items.map((a) => a.id), ['v1']);
    assert.strictEqual((await get('/api/assets?tag=concept:proof&tag=aspect:9x16')).total, 1);

    // Relabelling replaces the old label's tags instead of piling them up.
    await post('/api/labels/fShoot', { parts: { ...parts, format: 'Feed Video', aspect: '4:5', version: 2 } });
    const relabelled = (await get('/api/folders')).find((f) => f.id === 'fShoot');
    assert.strictEqual(relabelled.label.name, 'RUX_GearBox70L_Proof_FeedVideo_4x5_Cal_2026-06-08_v02');
    assert.deepStrictEqual(relabelled.tags.format, ['Feed Video']);
    assert.deepStrictEqual(relabelled.tags.aspect, ['4x5']);

    // A file label names its download; the extension is kept.
    await post('/api/labels/v1', { parts: { ...parts, version: 3 } });
    const dl = await fetch(`${base}/api/assets/v1/file?download=1`);
    assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''RUX_GearBox70L_Proof_Reels_9x16_Cal_2026-06-08_v03\.mp4$/);

    const invalid = await post('/api/labels/v1', { parts: { ...parts, date: 'June 8' } });
    assert.strictEqual(invalid.status, 400);
    assert.match((await invalid.json()).error, /Date/);
    assert.strictEqual((await post('/api/labels/nope', { parts })).status, 404);

    await post('/api/labels/v1', { remove: true });
    const unlabelled = await get('/api/assets/v1');
    assert.strictEqual(unlabelled.label, null);
    assert.deepStrictEqual(unlabelled.ownTags.format, ['Reels'], 'removing a label keeps its tags');
  } finally {
    server.close();
  }
});

test('tag files saved before the playbook fields get them on load', async () => {
  const tags = new TagStore({ log: quiet });
  tags.store.load = async () => {
    tags.store.data = { fields: [{ key: 'product', label: 'Product', suggest: ['RUX 70L Core'] }], tags: {} };
  };
  await tags.load();
  const keys = tags.fields().map((f) => f.key);
  for (const k of ['concept', 'format', 'aspect', 'creator']) assert.ok(keys.includes(k), k);
  assert.deepStrictEqual(tags.fields().find((f) => f.key === 'product').presets, ['RUX 70L Core'], 'existing fields kept');
  assert.strictEqual(tags.label('x'), null, 'no labels key yet is fine');
});
