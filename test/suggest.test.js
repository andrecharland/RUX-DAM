'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { toAsset } = require('../src/drive');
const { RightsStore } = require('../src/rights');
const { TagStore } = require('../src/tags');
const { Suggester, SuggestionStore } = require('../src/suggest');

const quiet = { info() {}, warn() {}, error() {} };
const root = { id: 'root', name: 'Brand' };
const trip = { id: 'fTrip', name: 'Winter Trip' };
const files = [
  { id: 'a1', name: 'truck.jpg', mimeType: 'image/jpeg', modifiedTime: '2026-01-02T00:00:00Z', thumbnailLink: 'x' },
  { id: 'a2', name: 'bag.jpg', mimeType: 'image/jpeg', modifiedTime: '2026-01-01T00:00:00Z', thumbnailLink: 'x' },
  { id: 'a3', name: 'noprev.mov', mimeType: 'video/quicktime', modifiedTime: '2026-01-01T00:00:00Z' },
];
const drive = {
  crawl: async () => ({
    assets: files.map((f) => toAsset(f, 'Winter Trip', 'Brand', [root, trip])),
    folders: [
      { id: 'root', name: 'Brand', path: '', ancestors: [] },
      { id: 'fTrip', name: 'Winter Trip', path: 'Winter Trip', ancestors: [root] },
    ],
  }),
  thumbnail: async (id) => new Response(`jpeg-bytes-${id}`, { headers: { 'content-type': 'image/jpeg' } }),
};

// Fake Claude: replies per asset (looked up from the file name in the prompt).
function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (req) => {
          calls.push(req);
          const text = req.messages[0].content[1].text;
          const reply = replies[text.match(/File name: (.*)/)[1]];
          if (reply === 'refuse') {
            return { stop_reason: 'refusal', stop_details: { category: 'other' }, usage: { input_tokens: 10, output_tokens: 0 }, content: [] };
          }
          return {
            model: req.model,
            stop_reason: 'end_turn',
            usage: { input_tokens: 2000, output_tokens: 500 },
            content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(reply) }],
          };
        },
      },
    },
  };
}

async function setup(replies, options = {}) {
  const tags = new TagStore({ log: quiet });
  const library = new Library(drive, ['root'], {
    rights: new RightsStore({ log: quiet }), tags, suggestions: new SuggestionStore({ log: quiet }), log: quiet,
  });
  await library.sync();
  const client = fakeClient(replies);
  const suggester = new Suggester({ library, drive, client, log: quiet, ...options });
  const server = createApp({ library, drive, suggester }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const get = async (url) => (await fetch(base + url)).json();
  return { library, client, suggester, server, post, get };
}

const empty = { description: '', product: [], activity: [], color: [], vehicle: [], season: [], tags: [], creator: [] };

test('suggests, then accepts and dismisses values as tags', async () => {
  const t = await setup({
    'truck.jpg': {
      ...empty,
      description: 'A pickup with a black duffel on the roof rack in snow.',
      product: ['duffel', 'Roof Rack'], color: ['Black'], vehicle: ['Toyota Tacoma'], season: ['Winter'], activity: ['Overlanding'],
    },
    'bag.jpg': { ...empty, product: ['Duffel'], color: ['Black', 'black'] },
  });
  try {
    // Existing vocabulary and folder tags shape the request and the result.
    await t.post('/api/tags', { ids: ['root'], add: { product: ['Duffel'] } });
    await t.post('/api/tags', { ids: ['a1'], add: { season: ['Winter'] } });

    const res = await t.post('/api/suggest', { folder: 'fTrip' });
    const body = await res.json();
    assert.strictEqual(body.added, 2, 'skips the asset without a preview');
    while (t.suggester.active || t.suggester.queue.length) await new Promise((r) => setTimeout(r, 5));

    const req = t.client.calls.find((c) => c.messages[0].content[1].text.includes('truck.jpg'));
    assert.strictEqual(req.model, 'claude-haiku-5-5');
    assert.strictEqual(req.fallbacks, undefined, 'Haiku has no server-side fallback');
    assert.strictEqual(req.output_config.effort, 'low');
    assert.deepStrictEqual(req.output_config.format.schema.required,
      ['description', 'product', 'activity', 'color', 'vehicle', 'season', 'tags', 'creator']);
    assert.strictEqual(req.messages[0].content[0].source.data, Buffer.from('jpeg-bytes-a1').toString('base64'));
    assert.match(req.messages[0].content[1].text, /Folder: Brand \/ Winter Trip/);
    assert.match(req.system[0].text, /- product: Duffel/, 'vocabulary is in the cached system prompt');
    assert.deepStrictEqual(req.system[0].cache_control, { type: 'ephemeral' });
    assert.doesNotMatch(req.system[0].text, /truck\.jpg/, 'nothing per-photo in the cached part');

    let truck = await t.get('/api/assets/a1');
    assert.deepStrictEqual(truck.suggestions.pending, {
      product: ['Roof Rack'], // "duffel" is already a folder tag, so it isn't pending
      activity: ['Overlanding'],
      color: ['Black'],
      vehicle: ['Toyota Tacoma'],
      // season "Winter" is already on the asset
    });
    assert.strictEqual(truck.suggestions.count, 4);

    const bag = await t.get('/api/assets/a2');
    assert.deepStrictEqual(bag.suggestions.pending, { color: ['Black'] }, 'deduplicated case-insensitively');

    // Filter, search the description, accept one, dismiss one, accept the rest in bulk.
    assert.strictEqual((await t.get('/api/assets?suggested=pending')).total, 2);
    assert.deepStrictEqual((await t.get('/api/assets?q=pickup')).items.map((a) => a.id), ['a1']);

    await t.post('/api/suggest/accept', { ids: ['a1'], field: 'vehicle', value: 'toyota tacoma' });
    await t.post('/api/suggest/dismiss', { id: 'a1', field: 'activity', value: 'Overlanding' });
    truck = await t.get('/api/assets/a1');
    assert.deepStrictEqual(truck.ownTags.vehicle, ['Toyota Tacoma']);
    assert.strictEqual(truck.suggestions.pending.activity, undefined);
    assert.strictEqual(truck.suggestions.count, 2);

    await t.post('/api/suggest/accept', { ids: ['a1', 'a2'] });
    assert.deepStrictEqual((await t.get('/api/assets/a1')).ownTags,
      { season: ['Winter'], vehicle: ['Toyota Tacoma'], product: ['Roof Rack'], color: ['Black'] });
    assert.deepStrictEqual((await t.get('/api/assets/a2')).ownTags, { color: ['Black'] });
    assert.strictEqual((await t.get('/api/assets?suggested=pending')).total, 0);

    // Already-suggested assets are skipped unless forced.
    assert.strictEqual((await (await t.post('/api/suggest', { ids: ['a1'] })).json()).added, 0);
    const status = await t.get('/api/suggest/status');
    assert.strictEqual(status.done, 2);
    assert.ok(Math.abs(status.costUsd - (4000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12);
  } finally {
    t.server.close();
  }
});

test('records refusals and errors on the asset', async () => {
  const t = await setup({ 'truck.jpg': 'refuse' });
  try {
    const asset = await (await t.post('/api/suggest/a1/run', {})).json();
    assert.match(asset.suggestions.error, /declined/);
    assert.strictEqual((await t.get('/api/suggest/status')).failed, 1);
    // Failed assets can be queued again without forcing.
    assert.strictEqual((await (await t.post('/api/suggest', { ids: ['a1'] })).json()).added, 1);
  } finally {
    t.server.close();
  }
});

test('suggestion endpoints report when no API key is set', async () => {
  const library = new Library(drive, ['root'], { log: quiet });
  await library.sync();
  const suggester = new Suggester({ library, drive, log: quiet });
  const server = createApp({ library, drive, suggester }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await (await fetch(`${base}/api/suggest/status`)).json()).enabled, false);
    const res = await fetch(`${base}/api/suggest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['a1'] }),
    });
    assert.strictEqual(res.status, 503);
  } finally {
    server.close();
  }
});

test('Opus requests opt into server-side refusal fallbacks', async () => {
  const t = await setup({ 'truck.jpg': empty }, { model: 'claude-opus-5-5' });
  try {
    await t.post('/api/suggest/a1/run', {});
    assert.strictEqual(t.client.calls[0].fallbacks, 'default');
    assert.deepStrictEqual(t.client.calls[0].betas, ['server-side-fallback-2026-07-01']);
  } finally {
    t.server.close();
  }
});

test('shoot suggestions: sample photos from a folder in one request, accept onto the folder', async () => {
  const t = await setup({});
  t.client.beta.messages.create = async (req) => {
    t.client.calls.push(req);
    return {
      model: req.model, stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 300 },
      content: [{ type: 'text', text: JSON.stringify({
        description: 'Winter overlanding trip in the mountains.',
        activity: ['Overlanding'], season: ['Winter'], location: ['Mountains'], event: [], vehicle: [], tags: ['Lifestyle'],
      }) }],
    };
  };
  try {
    const folder = await (await t.post('/api/suggest/folder/fTrip/run', {})).json();
    assert.strictEqual(t.client.calls.length, 1);
    const req = t.client.calls[0];
    assert.strictEqual(req.messages[0].content.filter((c) => c.type === 'image').length, 2, 'samples the photos with previews');
    assert.match(req.messages[0].content.at(-1).text, /samples from one shoot folder: Brand \/ Winter Trip/);
    assert.deepStrictEqual(Object.keys(req.output_config.format.schema.properties),
      ['description', 'activity', 'vehicle', 'season', 'event', 'location', 'tags', 'creator']);
    assert.deepStrictEqual(folder.suggestions.pending,
      { activity: ['Overlanding'], season: ['Winter'], location: ['Mountains'], tags: ['Lifestyle'] });

    await t.post('/api/suggest/accept', { ids: ['fTrip'] });
    const asset = await t.get('/api/assets/a1');
    assert.deepStrictEqual(asset.tags.season, [{ value: 'Winter', from: { scope: 'folder', id: 'fTrip', name: 'Winter Trip' } }]);
    const folders = await t.get('/api/folders');
    assert.strictEqual(folders.find((f) => f.id === 'fTrip').suggestions.count, 0);
  } finally {
    t.server.close();
  }
});

test('runs over the batch threshold go through the Message Batches API', async () => {
  const t = await setup({}, { batchMin: 1 });
  const batches = [];
  t.client.messages = {
    batches: {
      create: async ({ requests }) => { batches.push(requests); return { id: 'msgbatch_1', processing_status: 'in_progress' }; },
      retrieve: async () => ({ processing_status: 'ended', request_counts: { succeeded: 1, errored: 1, processing: 0 } }),
      results: async () => (async function* results() {
        yield { custom_id: 'a1', result: { type: 'succeeded', message: {
          model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 400 },
          content: [{ type: 'text', text: JSON.stringify({ ...empty, product: ['Gear Box'] }) }],
        } } };
        yield { custom_id: 'a2', result: { type: 'expired' } };
      }()),
    },
  };
  try {
    const body = await (await t.post('/api/suggest', { folder: 'fTrip' })).json();
    assert.strictEqual(body.batch, true);
    assert.strictEqual(body.added, 2);
    while (!t.library.suggestions.batches.length) await new Promise((r) => setTimeout(r, 5));

    assert.deepStrictEqual(batches[0].map((r) => r.custom_id).sort(), ['a1', 'a2']);
    const params = batches[0][0].params;
    assert.strictEqual(params.fallbacks, undefined, 'batches reject the fallbacks parameter');
    assert.strictEqual(params.betas, undefined);
    assert.strictEqual(params.messages[0].content[0].type, 'image');

    // While a batch is out, the same photos aren't sent again.
    assert.strictEqual((await (await t.post('/api/suggest', { ids: ['a1', 'a2'] })).json()).added, 0);
    const status = await t.get('/api/suggest/status');
    assert.strictEqual(status.batches[0].count, 2);

    await t.suggester.pollBatches();
    assert.deepStrictEqual((await t.get('/api/assets/a1')).suggestions.pending, { product: ['Gear Box'] });
    assert.match((await t.get('/api/assets/a2')).suggestions.error, /expired/);
    assert.strictEqual(t.library.suggestions.batches.length, 0);
    const after = await t.get('/api/suggest/status');
    assert.ok(Math.abs(after.costUsd - (1000 * 0.1 + 400 * 0.5) / 1e6 / 2) < 1e-12, 'batch results cost half');
  } finally {
    t.server.close();
  }
});
