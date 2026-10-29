'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { CurationStore } = require('../src/curation');
const { toAsset } = require('../src/drive');

const quiet = { info() {}, warn() {}, error() {} };

test('ratings, personal favorites and team collections', async () => {
  const root = { id: 'root', name: 'Brand' };
  const drive = {
    crawl: async () => ({
      assets: ['a1', 'a2', 'a3', 'a4'].map((id, i) => toAsset({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', thumbnailLink: 'x',
        modifiedTime: `2026-0${i + 1}-01T00:00:00Z` }, 'Brand', 'Brand', [root])),
      folders: [{ id: 'root', name: 'Brand', path: '', ancestors: [] }],
    }),
  };
  const library = new Library(drive, ['root'], { tags: new TagStore({ log: quiet }), curation: new CurationStore({ log: quiet }), log: quiet });
  await library.sync();
  // Stand-in for Google sign-in: the x-user header names who is asking.
  const router = (req, res, next) => {
    if (req.headers['x-user']) req.user = { email: req.headers['x-user'] };
    next();
  };
  const app = createApp({ library, drive, signIn: { router, requireUser: (req, res, next) => next() } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, user = 'ana@rux.life') => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(body),
  });
  const get = async (url, user = 'ana@rux.life') => (await fetch(base + url, { headers: { 'x-user': user } })).json();
  const ids = async (qs, user) => (await get(`/api/assets?${qs}`, user)).items.map((a) => a.id);
  try {
    // Ratings: one per asset for everyone, filter by minimum stars, sort best first.
    assert.strictEqual((await post('/api/rate', { ids: ['a1'], rating: 3 })).status, 200);
    await post('/api/rate', { ids: ['a3'], rating: 5 }, 'ben@rux.life');
    assert.strictEqual((await post('/api/rate', { ids: ['a1'], rating: 9 })).status, 400);
    assert.strictEqual((await post('/api/rate', { ids: ['nope'], rating: 1 })).status, 404);
    assert.deepStrictEqual(await ids('rating=3'), ['a3', 'a1']);
    assert.deepStrictEqual(await ids('rating=4'), ['a3']);
    assert.deepStrictEqual(await ids('sort=rating'), ['a3', 'a1', 'a4', 'a2']);
    assert.strictEqual((await get('/api/assets/a1', 'ben@rux.life')).rating, 3, 'ratings are shared');
    await post('/api/rate', { ids: ['a1'], rating: 0 });
    assert.deepStrictEqual(await ids('rating=1'), ['a3'], '0 clears');

    // Favorites: each person's own.
    await post('/api/favorite', { ids: ['a2', 'a4'], on: true });
    await post('/api/favorite', { ids: ['a1'], on: true }, 'ben@rux.life');
    assert.deepStrictEqual(await ids('fav=1'), ['a4', 'a2']);
    assert.deepStrictEqual(await ids('fav=1', 'ben@rux.life'), ['a1']);
    assert.strictEqual((await get('/api/assets/a2')).favorite, true);
    assert.strictEqual((await get('/api/assets/a2', 'ben@rux.life')).favorite, false);
    assert.deepStrictEqual((await get('/api/assets')).items.filter((a) => a.favorite).map((a) => a.id), ['a4', 'a2'], 'marked in results');
    await post('/api/favorite', { ids: ['a4'], on: false });
    assert.deepStrictEqual(await ids('fav=1'), ['a2']);
    assert.strictEqual((await get('/api/collections')).favorites.count, 1);

    // Collections: anyone edits; shown in the order assets were added.
    assert.strictEqual((await post('/api/collections', { name: '  ' })).status, 400);
    const c = await (await post('/api/collections', { name: 'Spring launch', ids: ['a3', 'a1', 'gone'] })).json();
    assert.strictEqual(c.count, 2);
    assert.deepStrictEqual(c.covers.map((x) => x.id), ['a3', 'a1']);
    await post(`/api/collections/${c.id}`, { add: ['a2', 'a3'], remove: ['a1'], description: 'Hero shots' }, 'ben@rux.life');
    assert.deepStrictEqual(await ids(`collection=${c.id}`), ['a3', 'a2']);
    assert.deepStrictEqual(await ids(`collection=${c.id}&sort=name`), ['a2', 'a3'], 'another sort still applies');
    const listed = (await get('/api/collections')).collections;
    assert.deepStrictEqual(listed.map((x) => [x.name, x.description, x.count, x.createdBy]), [['Spring launch', 'Hero shots', 2, 'ana@rux.life']]);
    assert.deepStrictEqual((await get('/api/assets/a2')).collections, [{ id: c.id, name: 'Spring launch' }]);
    await post(`/api/collections/${c.id}`, { order: ['a2', 'a3'] });
    assert.deepStrictEqual(await ids(`collection=${c.id}`), ['a2', 'a3'], 'reordered');
    await post(`/api/collections/${c.id}`, { order: ['nope', 'a3'] });
    assert.deepStrictEqual(await ids(`collection=${c.id}`), ['a3', 'a2'], 'unknown ids ignored, the rest keep their place after');
    await post(`/api/collections/${c.id}`, { name: 'Spring 27' });
    assert.strictEqual((await get('/api/collections')).collections[0].name, 'Spring 27');
    assert.strictEqual((await post('/api/collections/nope', { name: 'x' })).status, 404);
    await post(`/api/collections/${c.id}`, { delete: true });
    assert.deepStrictEqual((await get('/api/collections')).collections, []);
  } finally {
    server.close();
  }
});
