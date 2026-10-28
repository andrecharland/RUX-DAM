'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, fromShopifyCsv } = require('../public/shopify');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');

// Shape of a real Shopify "Products → Export" file: one row per variant, with the
// title, status and option names only on each product's first row.
const CSV = [
  '﻿Handle,Title,Body (HTML),Vendor,Type,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant SKU,Status',
  'rux-70l-core,RUX 70L Core,"<p>Rugged, modular ""gear box""</p>",RUX,Gear Box,Color,Black,,,R70-BLK,active',
  'rux-70l-core,,,,,,Steel Blue,,,R70-STB,',
  'rux-70l-core,,,,,,Green,,,R70-GRN,',
  'rux-25l-bag,RUX 25L Bag,"Multi-line',
  'description",RUX,Bag,Size,One Size,Colour,black,R25-BLK,active',
  'rux-25l-bag,,,,,,One Size,,Orange,R25-ORG,',
  'old-thing,Old Thing,,RUX,,Color,Purple,,,OLD,archived',
  'secret,Prototype,,RUX,,Title,Default Title,,,PRO,draft',
  'rux-essentials-set,RUX Essentials Set,,RUX,Bundle,Title,Default Title,,,ESS,active',
].join('\r\n');

test('parses quoted CSV fields with commas, quotes and newlines', () => {
  const rows = parseCsv('a,"b, ""c""","d\ne"\r\n1,2,3\n');
  assert.deepStrictEqual(rows, [['a', 'b, "c"', 'd\ne'], ['1', '2', '3']]);
});

test('extracts active product names and color options from a Shopify export', () => {
  const result = fromShopifyCsv(CSV);
  assert.deepStrictEqual(result.products, ['RUX 25L Bag', 'RUX 70L Core', 'RUX Essentials Set']);
  assert.deepStrictEqual(result.colors, ['Black', 'Green', 'Orange', 'Steel Blue'], 'case-insensitive, first spelling wins');
  assert.strictEqual(result.skipped, 2, 'archived and draft products are skipped');
});

test('rejects files that are not a Shopify products export', () => {
  assert.throws(() => fromShopifyCsv('Name,Email\nA,a@b.c'), /Shopify products export/);
});

test('preset values feed autocomplete and survive alongside used values', async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const drive = { crawl: async () => ({ assets: [], folders: [] }) };
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const server = createApp({ library, drive }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const res = await post('/api/fields/product/presets', { values: ['RUX 70L Core', ' rux 70l core ', 'RUX 25L Bag', ''] });
    assert.deepStrictEqual((await res.json()).presets, ['RUX 70L Core', 'RUX 25L Bag']);
    const product = (await (await fetch(`${base}/api/fields`)).json()).find((f) => f.key === 'product');
    assert.deepStrictEqual(product.presets, ['RUX 70L Core', 'RUX 25L Bag']);
    assert.deepStrictEqual(product.values, ['RUX 25L Bag', 'RUX 70L Core']);
    assert.strictEqual((await post('/api/fields/nope/presets', { values: [] })).status, 400);
    assert.strictEqual((await post('/api/fields/product/presets', { values: 'x' })).status, 400);
  } finally {
    server.close();
  }
});
