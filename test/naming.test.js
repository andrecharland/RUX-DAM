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
  assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['aspect', 'date', 'version']);
  // Every part is optional; the name keeps the ones given.
  assert.strictEqual(naming.compose({ product: 'Gear Box 70L', format: 'Photo', date: '2026-06-08' }).name, 'RUX_GearBox70L_Photo_2026-06-08');
  assert.strictEqual(naming.compose({ creator: 'Blake Jorgensen', version: '2' }).name, 'RUX_BlakeJorgensen_v02');
  assert.strictEqual(naming.compose({}).name, '', 'needs at least one part');
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

test('titles and RUX names come from naming fields: folders, files, search, downloads', async () => {
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
  const folder = async () => (await get('/api/folders')).find((f) => f.id === 'fShoot');
  try {
    await post('/api/tags', { ids: ['fShoot'], add: {
      product: ['Gear Box 70L'], concept: ['Proof'], format: ['Video'], aspect: ['9:16'], creator: ['Cal'],
      shoot_date: ['2026-06-08'], version: ['v1'],
    } });
    assert.deepStrictEqual((await folder()).label, {
      title: 'Gear Box 70L · Proof · Video 9x16 · by Cal · Jun 8, 2026 · version 1',
      name: 'RUX_GearBox70L_Proof_Video_9x16_Cal_2026-06-08_v01',
    });
    assert.deepStrictEqual((await folder()).tags.version, ['1'], 'versions stored as plain numbers');

    // Files inherit the fields but keep their Drive name until they have naming fields of their own.
    let asset = await get('/api/assets/v1');
    assert.strictEqual(asset.label, null);
    assert.strictEqual(asset.tags.format[0].value, 'Video');
    assert.deepStrictEqual((await get('/api/assets?q=GearBox70L_Proof')).items.map((a) => a.id), ['v1'], 'search matches the folder name');

    // A file's own Version gives it a title with the shoot's fields, and names its download.
    await post('/api/tags', { ids: ['v1'], add: { version: ['3'] } });
    asset = await get('/api/assets/v1');
    assert.strictEqual(asset.label.name, 'RUX_GearBox70L_Proof_Video_9x16_Cal_2026-06-08_v03');
    const dl = await fetch(`${base}/api/assets/v1/file?download=1`);
    assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''RUX_GearBox70L_Proof_Video_9x16_Cal_2026-06-08_v03\.mp4$/);

    // Several values: the title lists them, the name uses the first. Changing a tag changes both.
    await post('/api/tags', { ids: ['fShoot'], add: { product: ['Duffel'] }, remove: { concept: ['Proof'] } });
    assert.deepStrictEqual((await folder()).label, {
      title: 'Gear Box 70L + Duffel · Video 9x16 · by Cal · Jun 8, 2026 · version 1',
      name: 'RUX_GearBox70L_Video_9x16_Cal_2026-06-08_v01',
    });

    const invalid = await post('/api/tags', { ids: ['fShoot'], add: { shoot_date: ['someday'] } });
    assert.strictEqual(invalid.status, 400);
    assert.match((await invalid.json()).error, /date/i);

    await post('/api/tags', { ids: ['fShoot'], remove: { product: ['Gear Box 70L', 'Duffel'], format: ['Video'], aspect: ['9x16'],
      creator: ['Cal'], shoot_date: ['2026-06-08'], version: ['1'] } });
    assert.strictEqual((await folder()).label, null, 'no naming fields, no title');
  } finally {
    server.close();
  }
});

test('tag files saved before the playbook fields get them on load; old labels move into fields', async () => {
  const tags = new TagStore({ log: quiet });
  tags.store.load = async () => {
    tags.store.data = {
      fields: [{ key: 'product', label: 'Product', suggest: ['RUX 70L Core'] }, { key: 'format', label: 'Format', suggest: ['Carousel', 'Feed Video', 'Reels', 'Static'] }],
      tags: { x: { product: ['70L Core'] } },
      labels: { x: { name: 'RUX_70LCore_2026-06-08_v02', parts: { product: '70L Core', date: '2026-06-08', version: 2 } } },
    };
  };
  await tags.load();
  const keys = tags.fields().map((f) => f.key);
  for (const k of ['concept', 'format', 'aspect', 'creator', 'shoot_date', 'version']) assert.ok(keys.includes(k), k);
  assert.deepStrictEqual(tags.fields().find((f) => f.key === 'product').presets, ['RUX 70L Core'], 'existing fields kept');
  assert.deepStrictEqual(tags.fields().find((f) => f.key === 'format').presets, ['Photo', 'Video'], 'old format presets replaced');
  assert.deepStrictEqual(tags.own('x'), { product: ['70L Core'], shoot_date: ['2026-06-08'], version: ['2'] });
  assert.strictEqual(tags.label({ id: 'x', ancestors: [] }).name, 'RUX_70LCore_2026-06-08_v02');
  assert.strictEqual(tags.data.labels, undefined);
  assert.strictEqual(tags.label({ id: 'y', ancestors: [] }), null);
});
