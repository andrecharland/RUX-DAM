'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { JsonStore } = require('./store');

// Rebuild when this share of fingerprinted assets isn't on the map yet.
const STALE = 0.1;

// Where each photo sits on the visual map: its fingerprint squeezed down to 2D
// with UMAP, so photos that look alike land near each other. Built in a worker
// thread the first time someone opens the map, saved as map.json in the data
// bucket, and rebuilt once enough new photos have been fingerprinted; until
// then, new photos are placed beside the photo they look most like.
class MapLayout {
  constructor({ similarity, auth, bucket, log = console, worker = path.join(__dirname, 'layout-worker.js') }) {
    this.similarity = similarity;
    this.log = log;
    this.worker = worker;
    this.store = new JsonStore({ auth, bucket, object: 'map.json', log, empty: () => ({ ids: [], xy: [] }) });
    this.positions = null; // Map(id -> [x, y])
    this.built = 0; // how many photos the last build arranged
    this.building = null;
    this.loaded = null;
    this.lastError = null;
  }

  load() {
    this.loaded ||= this.store.load()
      .then(() => this.adopt(this.store.data))
      .catch((err) => this.log.error(`Could not load the map: ${err.message}`));
    return this.loaded;
  }

  adopt({ ids, xy }) {
    if (!ids?.length) return;
    this.positions = new Map(ids.map((id, i) => [id, [xy[2 * i], xy[2 * i + 1]]]));
    this.built = ids.length;
  }

  // Positions for every fingerprinted asset, or null while the map is being
  // built (a build starts if needed). `status` says how far along it is.
  async get() {
    await this.load();
    const { size } = this.similarity.vectors;
    if (size && (!this.positions || this.built < size * (1 - STALE))) this.build();
    if (!this.positions) return null;
    this.placeNewcomers();
    return this.positions;
  }

  status() {
    return { building: Boolean(this.building), photos: this.similarity.vectors.size, error: this.lastError };
  }

  // Fingerprinted since the last build: beside the closest photo already placed.
  placeNewcomers() {
    const missing = [...this.similarity.vectors.keys()].filter((id) => !this.positions.has(id));
    if (!missing.length) return;
    const placed = [...this.positions.keys()].filter((id) => this.similarity.vectors.has(id));
    for (const id of missing) {
      const v = this.similarity.vectors.get(id);
      let best = null;
      let bestScore = -Infinity;
      for (const other of placed) {
        const w = this.similarity.vectors.get(other);
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * w[i];
        if (s > bestScore) [best, bestScore] = [other, s];
      }
      if (!best) continue;
      const [x, y] = this.positions.get(best);
      this.positions.set(id, [x + (Math.random() - 0.5) * 0.05, y + (Math.random() - 0.5) * 0.05]);
    }
  }

  build() {
    if (this.building) return this.building;
    const ids = [...this.similarity.vectors.keys()];
    const vectors = ids.map((id) => this.similarity.vectors.get(id));
    const started = Date.now();
    this.building = this.arrange(vectors)
      .then(async (xy) => {
        const rounded = xy.map((v) => Math.round(v * 1000) / 1000);
        this.adopt({ ids, xy: rounded });
        this.lastError = null;
        this.log.info(`Arranged ${ids.length} photos on the visual map in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        await this.store.update((data) => {
          data.ids = ids;
          data.xy = rounded;
          data.builtAt = new Date().toISOString();
        });
      })
      .catch((err) => {
        this.lastError = err.message;
        this.log.error(`Could not arrange the visual map: ${err.message}`);
      })
      .finally(() => { this.building = null; });
    return this.building;
  }

  arrange(vectors) {
    // Too few photos for UMAP: a line is as good a map as any.
    if (vectors.length < 4) return Promise.resolve(vectors.flatMap((_, i) => [i, 0]));
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.worker, { workerData: { vectors } });
      worker.once('message', ({ xy }) => resolve(xy));
      worker.once('error', reject);
      worker.once('exit', (code) => code && reject(new Error(`map worker exited with ${code}`)));
    });
  }
}

module.exports = { MapLayout };
