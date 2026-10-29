'use strict';

const test = require('node:test');
const assert = require('node:assert');
const jpeg = require('jpeg-js');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { ColorStore } = require('../src/colors');
const { toAsset } = require('../src/drive');
const { EmbeddingIndex } = require('../src/embeddings');
const { MapLayout } = require('../src/layout');
const { paletteOf, averageOf, colorScore, lab, parseHex, PaletteFiller } = require('../src/palette');

const quiet = { info() {}, warn() {}, error() {} };
const pad = (v) => [...v, ...new Array(256 - v.length).fill(0)];
const unit = (v) => {
  const n = Math.hypot(...v);
  return Float32Array.from(pad(v.map((x) => x / n)));
};

// A solid image, or one split into two colors (left `split` of the width).
function image(width, height, [a, b = a], split = 1) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = parseHex(x < width * split ? a : b);
      data.set([...c, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

test('palettes: main colors with their share, largest first', () => {
  const palette = paletteOf(image(100, 50, ['#2f62b8', '#e07b28'], 0.75));
  assert.strictEqual(palette.length, 2);
  assert.deepStrictEqual(palette.map(([, share]) => share), [75, 25]);
  assert.ok(colorScore(palette, lab(parseHex('#2f62b8'))) > 60, 'mostly blue');
  assert.ok(colorScore(palette, lab(parseHex('#e07b28'))) > 15, 'some orange');
  assert.strictEqual(colorScore(palette, lab(parseHex('#4a7a3a'))), 0, 'no green');
  assert.match(averageOf(palette), /^#[0-9a-f]{6}$/);
});

const files = [
  { id: 'blue', look: [1, 0, 0], palette: [['#2f62b8', 80], ['#ffffff', 20]] },
  { id: 'blue2', look: [0.9, 0.3, 0], palette: [['#3a6cc0', 60], ['#151515', 40]] },
  { id: 'snow', look: [0.6, 0, 0.8], palette: [['#f1f1ef', 90]] },
  { id: 'orange', look: [0, 1, 0], palette: [['#e07b28', 70], ['#2f62b8', 10]] },
  { id: 'green', look: [0, 0.2, 1], palette: [['#4a7a3a', 100]] },
];

async function setup() {
  const root = { id: 'root', name: 'Brand' };
  const drive = {
    crawl: async () => ({
      assets: files.map((f) => toAsset({ id: f.id, name: `${f.id}.jpg`, mimeType: 'image/jpeg', thumbnailLink: 'x',
        modifiedTime: '2026-10-01T00:00:00Z', imageMediaMetadata: { width: 4000, height: 3000 } }, '', 'Brand', [root])),
      folders: [{ id: 'root', name: 'Brand', path: '', ancestors: [] }],
    }),
    thumbnail: async () => null,
  };
  const colors = new ColorStore({ log: quiet });
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), colors, log: quiet });
  await library.sync();
  for (const f of files) colors.addPalette(f.id, f.palette, averageOf(f.palette));
  // "snow" is the word for the snow photo's direction; anything else points at green.
  const similarity = new EmbeddingIndex({
    library, drive, log: quiet, embedder: { image: async () => pad([1]), text: async (q) => (q === 'snow' ? [0.6, 0, 0.8] : [0, 0.2, 1]) },
  });
  for (const f of files) similarity.vectors.set(f.id, unit(f.look));
  const layout = new MapLayout({ similarity, log: quiet });
  const app = createApp({ library, drive, similarity, layout });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  return { library, similarity, layout, get, close: () => new Promise((r) => server.close(r)) };
}

test('browse by color: photos with enough of the color, most first', async (t) => {
  const { get, close } = await setup();
  t.after(close);
  const blue = await get(`/api/assets?color=${encodeURIComponent('#2f62b8')}`);
  assert.deepStrictEqual(blue.items.map((a) => a.id), ['blue', 'blue2'], 'orange has only 10% blue');
  assert.deepStrictEqual(blue.items[0].palette, files[0].palette);
  const bad = await get('/api/assets?color=red');
  assert.strictEqual(bad.total, files.length, 'not a color: ignored');
});

test('more like this follows a trail, and words steer it', async (t) => {
  const { get, close } = await setup();
  t.after(close);
  const one = await get('/api/assets?like=blue');
  assert.strictEqual(one.similarMode, 'visual');
  assert.strictEqual(one.items[0].id, 'blue2');
  assert.ok(!one.items.some((a) => a.id === 'blue'), 'the trail itself is left out');

  // The latest step counts most: from blue to green, green's neighbours lead.
  const trail = await get('/api/assets?like=blue,green');
  assert.strictEqual(trail.items[0].id, 'snow');
  assert.ok(!trail.items.some((a) => ['blue', 'green'].includes(a.id)));

  const snowy = await get('/api/assets?like=blue&more=snow');
  assert.strictEqual(snowy.items[0].id, 'snow', '“more snow” pulls the snow photo up');
  const less = await get('/api/assets?like=blue&less=snow');
  const rankOf = (r) => r.items.findIndex((a) => a.id === 'snow');
  assert.ok(rankOf(less) > rankOf(one), '“less snow” pushes it down');

  const unknown = await get('/api/assets?like=nope');
  assert.strictEqual(unknown.total, files.length, 'an unknown id is ignored');
});

test('the visual map: arranged in a worker, then every match with a place', async (t) => {
  const { get, layout, close } = await setup();
  t.after(close);
  const first = await get('/api/map');
  assert.strictEqual(first.building, true);
  await layout.building;
  const map = await get('/api/map');
  assert.strictEqual(map.items.length, files.length);
  for (const it of map.items) assert.ok(Number.isFinite(it.x) && Number.isFinite(it.y), it.id);
  assert.ok(map.items[0].color && map.items[0].modifiedTime);
  const filtered = await get(`/api/map?color=${encodeURIComponent('#4a7a3a')}`);
  assert.deepStrictEqual(filtered.items.map((a) => a.id), ['green']);
});

test('the map places newly fingerprinted photos beside their closest match', async (t) => {
  const { similarity, layout, library, close } = await setup();
  t.after(close);
  await layout.get();
  await layout.building;
  similarity.vectors.set('late', unit([0.99, 0.05, 0]));
  library.byId.set('late', { id: 'late' });
  const positions = await layout.get();
  const [x, y] = positions.get('late');
  const [bx, by] = positions.get('blue');
  assert.ok(Math.hypot(x - bx, y - by) < 0.1);
});

test('the map is off without visual fingerprints', async (t) => {
  const drive = { crawl: async () => ({ assets: [], folders: [] }) };
  const library = new Library(drive, ['root'], { log: quiet });
  const app = createApp({ library, drive });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/map`);
  assert.strictEqual(res.status, 404);
});

test('palette filler works out colors from JPEG previews and skips the rest', async () => {
  const blue = jpeg.encode(image(64, 48, ['#2f62b8']), 90).data;
  const assets = [{ id: 'j', hasThumbnail: true }, { id: 'svg', hasThumbnail: true }, { id: 'none', hasThumbnail: false }];
  const colors = new ColorStore({ log: quiet });
  const library = { assets, colors };
  const filler = new PaletteFiller({
    library, log: quiet,
    preview: async (a) => (a.id === 'j' ? { body: blue, type: 'image/jpeg' } : { body: Buffer.from('<svg/>'), type: 'image/svg+xml' }),
  });
  await filler.run();
  const palette = colors.palette('j');
  assert.ok(palette && colorScore(palette, lab(parseHex('#2f62b8'))) > 80, JSON.stringify(palette));
  assert.ok(colors.get('j'), 'average color recorded too');
  assert.strictEqual(colors.palette('svg'), null);
  assert.deepStrictEqual(filler.missing(), [], 'failures are not retried in the same run');
});
