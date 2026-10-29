'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { toAsset } = require('../src/drive');
const { EmbeddingIndex, VertexEmbedder, pack, unpack } = require('../src/embeddings');
const { tagSimilar } = require('../src/similar');

const quiet = { info() {}, warn() {}, error() {} };
const root = { id: 'root', name: 'Brand' };
const shootA = { id: 'fA', name: 'Snow shoot' };
const shootB = { id: 'fB', name: 'Desert shoot' };

// Each preview's bytes name a "look"; the fake model maps looks and words to directions.
const LOOKS = { snow: [1, 0, 0, 0], snow2: [0.95, 0.31, 0, 0], desert: [0, 1, 0, 0], studio: [0, 0, 1, 0] };
const WORDS = { 'snowy truck': [0.9, 0.1, 0, 0.1], 'sand dunes': [0.1, 0.9, 0, 0] };
const pad = (v) => [...v, ...new Array(252).fill(0)];
const files = [
  { id: 's1', name: 'IMG_1.jpg', look: 'snow', folder: shootA },
  { id: 's2', name: 'IMG_2.jpg', look: 'snow2', folder: shootA },
  { id: 'd1', name: 'IMG_3.jpg', look: 'desert', folder: shootB },
  { id: 'p1', name: 'packshot.jpg', look: 'studio', folder: shootB },
];
const drive = {
  crawl: async () => ({
    assets: files.map((f) => toAsset({ id: f.id, name: f.name, mimeType: 'image/jpeg', thumbnailLink: 'x', modifiedTime: '2026-10-01T00:00:00Z',
      imageMediaMetadata: { width: 4000, height: 3000 } }, f.folder.name, 'Brand', [root, f.folder])),
    folders: [{ id: 'root', name: 'Brand', path: '', ancestors: [] },
      { ...shootA, path: shootA.name, ancestors: [root] }, { ...shootB, path: shootB.name, ancestors: [root] }],
  }),
  thumbnail: async (id) => new Response(files.find((f) => f.id === id).look),
};
const fakeEmbedder = {
  calls: 0,
  image: async (b64) => { fakeEmbedder.calls++; return pad(LOOKS[Buffer.from(b64, 'base64').toString()]); },
  text: async (q) => pad(WORDS[q] || [0, 0, 0, 1]),
};

async function setup({ embedder = fakeEmbedder } = {}) {
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const similarity = new EmbeddingIndex({ library, drive, embedder, rpm: 60000, log: quiet });
  similarity.queueMissing();
  while (similarity.running || similarity.queue.length) await new Promise((r) => setTimeout(r, 5));
  const server = createApp({ library, drive, similarity }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url) => (await fetch(base + url)).json();
  return { library, similarity, server, get };
}

test('fingerprints pack to one byte per dimension and keep their direction', () => {
  const v = pad([3, 4, 0, 0]);
  const back = unpack(pack(v));
  assert.strictEqual(back.length, 256);
  assert.ok(Math.abs(back[0] - 0.6) < 0.01 && Math.abs(back[1] - 0.8) < 0.01);
  assert.strictEqual(Buffer.from(pack(v), 'base64').length, 256);
});

test('more like this, the like= filter, and search by description', async () => {
  const t = await setup();
  try {
    assert.strictEqual(fakeEmbedder.calls, 4, 'every asset with a preview is fingerprinted once');
    assert.strictEqual(t.similarity.queueMissing(), 0, 'nothing left to do');

    const similar = await t.get('/api/similar/s1');
    assert.strictEqual(similar.mode, 'visual');
    assert.deepStrictEqual(similar.items.map((a) => a.id).slice(0, 1), ['s2']);

    const like = await t.get('/api/assets?like=s1');
    assert.strictEqual(like.similarMode, 'visual');
    assert.strictEqual(like.items[0].id, 's2', 'best match first');
    assert.ok(!like.items.some((a) => a.id === 's1'), 'not the asset itself');
    assert.strictEqual((await t.get('/api/assets?like=s1&folder=fB')).items.length, 2, 'combines with other filters');

    // Text matches come first; photos that look like the words follow, marked visual.
    const search = await t.get('/api/assets?q=snowy%20truck');
    assert.strictEqual(search.items[0].id, 's1');
    assert.strictEqual(search.items[0].match, 'visual');
    const named = await t.get('/api/assets?q=packshot');
    assert.strictEqual(named.items[0].id, 'p1');
    assert.strictEqual(named.items[0].match, undefined, 'a name match is a text match');

    const status = await t.get('/api/status');
    assert.deepStrictEqual(status.similarity, { mode: 'visual', indexed: 4, total: 4, pending: 0, failed: 0 });
  } finally {
    t.server.close();
  }
});

test('without Vertex AI, similarity falls back to tags, shoot and date', async () => {
  const t = await setup({ embedder: null });
  try {
    await t.library.tags.apply(['s1', 'd1'], { add: { product: ['Gear Box 70L'] } });
    const rank = tagSimilar(t.library, 's1');
    assert.deepStrictEqual([...rank.keys()].slice(0, 2).sort(), ['d1', 's2'].sort(), 'shared product and same shoot rank highest');
    const similar = await t.get('/api/similar/s1');
    assert.strictEqual(similar.mode, 'tags');
    assert.strictEqual((await t.get('/api/assets?q=snowy%20truck')).total, 0, 'no visual search without Vertex AI');
  } finally {
    t.server.close();
  }
});

test('calls the Vertex AI multimodal embedding endpoint', async () => {
  const requests = [];
  const embedder = new VertexEmbedder({
    project: 'rux-dam',
    location: 'us-central1',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json({ predictions: [{ imageEmbedding: [0.1, 0.2] }] });
    },
  });
  assert.deepStrictEqual(await embedder.image('aGVsbG8='), [0.1, 0.2]);
  assert.strictEqual(requests[0].url,
    'https://us-central1-aiplatform.googleapis.com/v1/projects/rux-dam/locations/us-central1/publishers/google/models/multimodalembedding@001:predict');
  assert.deepStrictEqual(requests[0].body, { instances: [{ image: { bytesBase64Encoded: 'aGVsbG8=' } }], parameters: { dimension: 256 } });
});
