'use strict';

const { authedFetch } = require('./google');

// Preview sizes (longest side, px). Requests are rounded up to one of these so
// the grid, viewer and cards share cached images.
const SIZES = [256, 512, 1024, 2048];
const snapSize = (px) => SIZES.find((s) => s >= px) || SIZES[SIZES.length - 1];

// A preview's version: changes when the file changes in Drive, so cached copies
// (here and in browsers) never go stale.
const thumbVersion = (asset) => (Date.parse(asset.modifiedTime) || 0).toString(36);

// Previews fetched from Drive, kept in memory (most recently used, up to
// `maxBytes`) and in the data bucket under thumbs/, so each preview comes from
// Drive once. Without a bucket it's memory only.
class ThumbCache {
  constructor({ auth, bucket, maxBytes = 64 * 1024 * 1024, log = console } = {}) {
    this.auth = auth;
    this.bucket = bucket;
    this.maxBytes = maxBytes;
    this.log = log;
    this.memory = new Map(); // key -> { body, type }, oldest first
    this.bytes = 0;
    this.pending = new Map(); // key -> Promise, so simultaneous requests share one fetch
  }

  // { body: Buffer, type } for `key`, from memory, the bucket, or `load()`
  // (which returns the same shape, or null when there's no preview).
  fetch(key, load) {
    const hit = this.memory.get(key);
    if (hit) {
      this.memory.delete(key);
      this.memory.set(key, hit);
      return Promise.resolve(hit);
    }
    if (!this.pending.has(key)) {
      const p = (async () => {
        let entry = await this.read(key);
        if (!entry) {
          entry = await load();
          if (entry) this.write(key, entry);
        }
        if (entry) this.remember(key, entry);
        return entry;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return this.pending.get(key);
  }

  // An asset's preview at one of SIZES, from the cache or Drive.
  preview(drive, asset, size) {
    return this.fetch(`thumbs/${asset.id}/${thumbVersion(asset)}-${size}`, async () => {
      const res = await drive.thumbnail(asset.id, size);
      if (!res?.ok) {
        await res?.body?.cancel();
        return null;
      }
      return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/jpeg' };
    });
  }

  remember(key, entry) {
    if (entry.body.length > this.maxBytes / 8) return;
    this.memory.set(key, entry);
    this.bytes += entry.body.length;
    for (const [k, e] of this.memory) {
      if (this.bytes <= this.maxBytes) break;
      this.memory.delete(k);
      this.bytes -= e.body.length;
    }
  }

  objectUrl(key) {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
  }

  async read(key) {
    if (!this.bucket) return null;
    try {
      const res = await authedFetch(this.auth, `${this.objectUrl(key)}?alt=media`);
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/jpeg' };
    } catch (err) {
      this.log.error(`Preview cache read failed: ${err.message}`);
      return null;
    }
  }

  // Saved in the background; a failure only means Drive is asked again next time.
  write(key, entry) {
    if (!this.bucket) return;
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', key);
    url.searchParams.set('ifGenerationMatch', '0'); // already saved by another request: leave it
    authedFetch(this.auth, url, { method: 'POST', headers: { 'Content-Type': entry.type }, body: entry.body })
      .then(async (res) => {
        if (!res.ok && res.status !== 412) throw new Error(`Cloud Storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
        await res.body?.cancel();
      })
      .catch((err) => this.log.error(`Preview cache write failed: ${err.message}`));
  }
}

module.exports = { ThumbCache, SIZES, snapSize, thumbVersion };
