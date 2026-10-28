'use strict';

const { authedFetch } = require('./google');

// One JSON document, kept in memory and persisted as an object in a Cloud
// Storage bucket when a bucket is configured. Writes are conditional on the
// object's generation, so concurrent edits from several instances (or a write
// after a failed load) can't overwrite each other: a conflicting update reloads
// the document and reapplies its change.
class JsonStore {
  constructor({ auth, bucket, object, empty = () => ({}), log = console } = {}) {
    this.auth = auth;
    this.bucket = bucket;
    this.object = object;
    this.empty = empty;
    this.log = log;
    this.data = empty();
    this.generation = '0';
  }

  get persistent() {
    return Boolean(this.bucket);
  }

  async load() {
    if (!this.persistent) {
      if (!this.warned) this.log.warn(`No bucket configured: ${this.object} is kept in memory only.`);
      this.warned = true;
      return;
    }
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}` +
      `/o/${encodeURIComponent(this.object)}?alt=media`;
    const res = await authedFetch(this.auth, url);
    if (res.status === 404) {
      this.data = this.empty();
      this.generation = '0';
      return;
    }
    if (!res.ok) throw new Error(`Cloud Storage ${res.status}: ${await res.text()}`);
    this.generation = res.headers.get('x-goog-generation') || '0';
    this.data = { ...this.empty(), ...await res.json() };
  }

  async save() {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', this.object);
    url.searchParams.set('ifGenerationMatch', this.generation);
    const res = await authedFetch(this.auth, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.data, null, 1),
    });
    if (res.status === 412) return false;
    if (!res.ok) throw new Error(`Cloud Storage ${res.status}: ${await res.text()}`);
    this.generation = String((await res.json()).generation);
    return true;
  }

  // Applies `mutate(data)` and persists it.
  async update(mutate) {
    mutate(this.data);
    if (!this.persistent) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.save()) return;
      await this.load();
      mutate(this.data);
    }
    throw new Error(`Could not save ${this.object}: too many concurrent edits`);
  }
}

module.exports = { JsonStore };
