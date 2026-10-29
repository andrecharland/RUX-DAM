'use strict';

const { authedFetch } = require('./google');
const { JsonStore } = require('./store');

const MODEL = 'multimodalembedding@001';
const DIM = 256;
const PREVIEW_SIZE = 512;

// --- vector helpers ---------------------------------------------------------

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

// Stored as int8 (one byte per dimension) to keep embeddings.json small:
// 256 bytes per image, ~3.4 MB for 10,000 images.
function pack(v) {
  const q = Int8Array.from(normalize(v), (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
  return Buffer.from(q.buffer).toString('base64');
}

function unpack(s) {
  const b = Buffer.from(s, 'base64');
  return normalize(new Int8Array(b.buffer, b.byteOffset, b.length));
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// --- Vertex AI ----------------------------------------------------------------

// Google's multimodal embeddings: images and text land in the same space, so an
// image's nearest neighbours look alike, and a text query finds matching images.
class VertexEmbedder {
  constructor({ auth, project, location = 'us-central1', fetchImpl }) {
    this.auth = auth;
    this.project = project;
    this.location = location;
    this.fetchImpl = fetchImpl; // tests
  }

  async url() {
    const project = this.project || (this.project = await this.auth.getProjectId());
    return `https://${this.location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${this.location}` +
      `/publishers/google/models/${MODEL}:predict`;
  }

  async predict(instance) {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [instance], parameters: { dimension: DIM } }),
    };
    const res = this.fetchImpl ? await this.fetchImpl(await this.url(), init) : await authedFetch(this.auth, await this.url(), init);
    if (!res.ok) throw new Error(`Vertex AI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const prediction = (await res.json()).predictions?.[0] || {};
    const vector = prediction.imageEmbedding || prediction.textEmbedding;
    if (!vector?.length) throw new Error('Vertex AI returned no embedding');
    return vector;
  }

  image(base64) {
    return this.predict({ image: { bytesBase64Encoded: base64 } });
  }

  // The model reads up to ~32 tokens of text; a search phrase fits.
  text(query) {
    return this.predict({ text: String(query).slice(0, 200) });
  }
}

// --- index ------------------------------------------------------------------

// Visual fingerprints for every asset with a preview, built in the background
// and stored as embeddings.json in the data bucket.
class EmbeddingIndex {
  constructor({ library, drive, embedder, auth, bucket, rpm = 100, log = console }) {
    this.library = library;
    this.drive = drive;
    this.embedder = embedder;
    this.log = log;
    this.interval = 60000 / rpm;
    this.store = new JsonStore({ auth, bucket, object: 'embeddings.json', log,
      empty: () => ({ model: MODEL, dim: DIM, vectors: {} }) });
    this.vectors = new Map();
    this.queue = [];
    this.queued = new Set();
    this.failed = new Map();
    this.running = false;
    this.dirty = 0;
    this.textCache = new Map();
  }

  get enabled() {
    return Boolean(this.embedder);
  }

  async load() {
    await this.store.load();
    const { model, dim, vectors } = this.store.data;
    if (model !== MODEL || dim !== DIM) this.store.data = { model: MODEL, dim: DIM, vectors: {} };
    this.vectors = new Map(Object.entries(this.store.data.vectors).map(([id, s]) => [id, unpack(s)]));
    this.log.info(`Loaded ${this.vectors.size} visual fingerprints`);
  }

  status() {
    const total = this.library.assets.filter((a) => a.hasThumbnail).length;
    return {
      mode: this.enabled ? 'visual' : 'tags',
      indexed: [...this.vectors.keys()].filter((id) => this.library.byId.has(id)).length,
      total,
      pending: this.queue.length + (this.running ? 1 : 0),
      failed: this.failed.size,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  has(id) {
    return this.vectors.has(id);
  }

  // Queues every asset with a preview that has no fingerprint yet.
  queueMissing() {
    if (!this.enabled) return 0;
    let added = 0;
    for (const a of this.library.assets) {
      if (!a.hasThumbnail || this.vectors.has(a.id) || this.queued.has(a.id) || (this.failed.get(a.id) || 0) >= 3) continue;
      this.queue.push(a.id);
      this.queued.add(a.id);
      added++;
    }
    if (added) this.log.info(`Fingerprinting ${added} assets in the background`);
    this.run();
    return added;
  }

  // One request at a time, spaced to stay under the Vertex AI per-minute quota.
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const started = Date.now();
        try {
          const res = await this.drive.thumbnail(id, PREVIEW_SIZE);
          if (!res || !res.ok) throw new Error('No preview from Google Drive');
          const vector = await this.embedder.image(Buffer.from(await res.arrayBuffer()).toString('base64'));
          this.vectors.set(id, normalize(vector));
          this.store.data.vectors[id] = pack(vector);
          this.failed.delete(id);
          if (++this.dirty >= 50) await this.flush();
        } catch (err) {
          this.failed.set(id, (this.failed.get(id) || 0) + 1);
          this.lastError = err.message;
          this.log.error(`Fingerprint failed for ${id}: ${err.message}`);
        } finally {
          this.queued.delete(id);
        }
        const wait = this.interval - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      this.running = false;
      await this.flush();
    }
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = 0;
    const vectors = { ...this.store.data.vectors };
    try {
      // Merge with whatever another instance saved meanwhile.
      await this.store.update((data) => { data.vectors = { ...data.vectors, ...vectors }; });
    } catch (err) {
      this.log.error(`Failed to save fingerprints: ${err.message}`);
    }
  }

  // Assets ranked by similarity to a vector, as a Map(id -> score), best first.
  rank(vector, { limit, exclude } = {}) {
    const scored = [];
    for (const a of this.library.assets) {
      const v = this.vectors.get(a.id);
      if (v && a.id !== exclude) scored.push([a.id, dot(vector, v)]);
    }
    scored.sort((x, y) => y[1] - x[1]);
    return new Map(scored.slice(0, limit));
  }

  // Assets that look like this one, or null if it has no fingerprint yet.
  similar(id, limit = 200) {
    const v = this.vectors.get(id);
    return v ? this.rank(v, { limit, exclude: id }) : null;
  }

  // Assets that look like a text description.
  async searchText(query, limit = 60) {
    const key = query.trim().toLowerCase();
    let v = this.textCache.get(key);
    if (!v) {
      v = normalize(await this.embedder.text(key));
      this.textCache.set(key, v);
      if (this.textCache.size > 200) this.textCache.delete(this.textCache.keys().next().value);
    }
    return this.rank(v, { limit });
  }
}

module.exports = { VertexEmbedder, EmbeddingIndex, pack, unpack, normalize, MODEL, DIM };
