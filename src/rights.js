'use strict';

const { authedFetch } = require('./google');

const STATUSES = new Set(['cleared', 'restricted']);

// Usage-rights flags keyed by Drive file or folder ID:
//   { [id]: { status: 'cleared' | 'restricted', note, updatedAt } }
// Kept in memory, and persisted as one JSON object in a Cloud Storage bucket
// when a bucket is configured.
class RightsStore {
  constructor({ auth, bucket, object = 'rights.json', log = console } = {}) {
    this.auth = auth;
    this.bucket = bucket;
    this.object = object;
    this.log = log;
    this.flags = {};
    this.generation = '0';
  }

  get persistent() {
    return Boolean(this.bucket);
  }

  objectUrl() {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}` +
      `/o/${encodeURIComponent(this.object)}`;
  }

  async load() {
    if (!this.persistent) {
      if (!this.warned) this.log.warn('RIGHTS_BUCKET is not set: usage-rights flags are kept in memory only.');
      this.warned = true;
      return;
    }
    const res = await authedFetch(this.auth, `${this.objectUrl()}?alt=media`);
    if (res.status === 404) {
      this.flags = {};
      this.generation = '0';
      return;
    }
    if (!res.ok) throw new Error(`Cloud Storage ${res.status}: ${await res.text()}`);
    this.generation = res.headers.get('x-goog-generation') || '0';
    this.flags = (await res.json()).flags || {};
  }

  async save() {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', this.object);
    url.searchParams.set('ifGenerationMatch', this.generation);
    const res = await authedFetch(this.auth, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flags: this.flags }, null, 1),
    });
    if (res.status === 412) return false;
    if (!res.ok) throw new Error(`Cloud Storage ${res.status}: ${await res.text()}`);
    this.generation = String((await res.json()).generation);
    return true;
  }

  get(id) {
    return this.flags[id] || null;
  }

  // status 'inherit' removes the flag, so the item falls back to its folder.
  async set(id, status, note = '') {
    if (status !== 'inherit' && !STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const apply = () => {
      if (status === 'inherit') delete this.flags[id];
      else this.flags[id] = { status, note: String(note).slice(0, 500), updatedAt: new Date().toISOString() };
    };
    apply();
    if (!this.persistent) return;
    // Optimistic concurrency: if another instance wrote first, reload and reapply.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.save()) return;
      await this.load();
      apply();
    }
    throw new Error('Could not save rights flags: too many concurrent edits');
  }

  // The flag that applies to an asset: its own, else the nearest flagged
  // folder above it, else cleared by default.
  resolve(asset) {
    if (this.flags[asset.id]) return { ...this.flags[asset.id], source: { scope: 'file' } };
    for (let i = asset.ancestors.length - 1; i >= 0; i--) {
      const folder = asset.ancestors[i];
      if (this.flags[folder.id]) {
        return { ...this.flags[folder.id], source: { scope: 'folder', id: folder.id, name: folder.name } };
      }
    }
    return { status: 'cleared', note: '', source: { scope: 'default' } };
  }
}

module.exports = { RightsStore };
