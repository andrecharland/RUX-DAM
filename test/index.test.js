'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Library } = require('../src/library');
const { JsonStore } = require('../src/store');
const { TagStore } = require('../src/tags');
const { toAsset } = require('../src/drive');

const quiet = { info() {}, warn() {}, error() {} };
const rootA = { id: 'A', name: 'Root A' };
const rootB = { id: 'B', name: 'Root B' };
const file = (id, root) => toAsset({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', modifiedTime: '2026-01-01T00:00:00Z' }, '', root.name, [root]);
const rootFolder = (r) => ({ id: r.id, name: r.name, path: '', ancestors: [] });

// An in-memory stand-in for the bucket, shared across "restarts".
function memoryIndex(shared) {
  const store = new JsonStore({ object: 'index.json', empty: () => ({ assets: [], folders: [] }), log: quiet });
  Object.defineProperty(store, 'persistent', { get: () => true });
  store.load = async () => { store.data = structuredClone(shared.data || { assets: [], folders: [] }); };
  store.save = async () => { shared.data = structuredClone(store.data); shared.writes = (shared.writes || 0) + 1; return true; };
  return store;
}

test('a restart shows the saved index at once, then refreshes from Drive', async () => {
  const shared = {};
  let driveFiles = { A: ['a1', 'a2'], B: ['b1'] };
  let gate = Promise.resolve();
  const drive = {
    crawl: async (id) => {
      await gate;
      const root = id === 'A' ? rootA : rootB;
      return { assets: driveFiles[id].map((f) => file(f, root)), folders: [rootFolder(root)] };
    },
  };
  const make = () => new Library(drive, ['A', 'B'], { index: memoryIndex(shared), tags: new TagStore({ log: quiet }), log: quiet });

  // First run: nothing saved yet, so the library fills from the sync and saves it.
  const first = make();
  await first.start();
  assert.strictEqual(first.assets.length, 0);
  await first.sync();
  assert.strictEqual(first.assets.length, 3);
  assert.strictEqual(shared.writes, 1);

  // An unchanged Drive isn't saved again.
  await first.sync();
  assert.strictEqual(shared.writes, 1);

  // Restart while Drive is slow: the saved list is there immediately.
  let release;
  gate = new Promise((r) => { release = r; });
  driveFiles = { A: ['a1', 'a2', 'a3'], B: ['b1'] };
  const second = make();
  await second.start();
  assert.deepStrictEqual(second.assets.map((a) => a.id).sort(), ['a1', 'a2', 'b1']);
  assert.ok(second.status().restoredFrom, 'reports that it is showing the saved index');
  release();
  await new Promise((r) => setTimeout(r, 10));
  await second.syncing;
  assert.deepStrictEqual(second.assets.map((a) => a.id).sort(), ['a1', 'a2', 'a3', 'b1']);
  assert.strictEqual(second.status().restoredFrom, null);
  assert.strictEqual(shared.writes, 2);
  clearInterval(first.timer);
  clearInterval(second.timer);
});

test('a folder that fails to sync keeps its previously known assets', async () => {
  let failB = false;
  const drive = {
    crawl: async (id) => {
      if (id === 'B' && failB) throw new Error('Drive API 500');
      const root = id === 'A' ? rootA : rootB;
      return { assets: [file(`${id}1`, root)], folders: [rootFolder(root)] };
    },
  };
  const library = new Library(drive, ['A', 'B'], { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  failB = true;
  await library.sync();
  assert.deepStrictEqual(library.assets.map((a) => a.id).sort(), ['A1', 'B1']);
  assert.ok(library.folders.has('B'));
  assert.strictEqual(library.errors[0].folderId, 'B');
});
