'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RightsStore } = require('../src/rights');

// Minimal fake of the Cloud Storage JSON API for one object, with generation preconditions.
function fakeGcs() {
  const gcs = { body: null, generation: 0, writes: 0 };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'GET') {
      if (!gcs.body) return new Response('not found', { status: 404 });
      return new Response(gcs.body, { headers: { 'x-goog-generation': String(gcs.generation) } });
    }
    if (u.searchParams.get('ifGenerationMatch') !== String(gcs.generation)) {
      return new Response('precondition failed', { status: 412 });
    }
    gcs.body = init.body;
    gcs.generation++;
    gcs.writes++;
    return Response.json({ generation: String(gcs.generation) });
  };
  gcs.restore = () => { global.fetch = realFetch; };
  return gcs;
}

const auth = { getClient: async () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer t' }) }) };
const store = () => new RightsStore({ auth, bucket: 'b', log: { warn() {} } });

test('persists flags and merges concurrent edits from another instance', async () => {
  const gcs = fakeGcs();
  try {
    const a = store();
    const b = store();
    await a.load();
    await b.load();
    await a.set('file1', 'restricted', 'no release');
    await b.set('folder1', 'restricted'); // b is stale: 412, reload, reapply
    assert.deepStrictEqual(Object.keys(JSON.parse(gcs.body).flags).sort(), ['file1', 'folder1']);

    const c = store();
    await c.load();
    assert.strictEqual(c.get('file1').note, 'no release');
    await c.set('file1', 'inherit');
    assert.strictEqual(JSON.parse(gcs.body).flags.file1, undefined);
    assert.strictEqual(gcs.writes, 3);
  } finally {
    gcs.restore();
  }
});
