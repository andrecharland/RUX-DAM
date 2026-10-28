'use strict';

const { JsonStore } = require('./store');

const STATUSES = new Set(['cleared', 'restricted']);

// Usage-rights flags keyed by Drive file or folder ID, stored as rights.json:
//   { flags: { [id]: { status: 'cleared' | 'restricted', note, updatedAt } } }
class RightsStore {
  constructor({ auth, bucket, object = 'rights.json', log = console } = {}) {
    this.store = new JsonStore({ auth, bucket, object, empty: () => ({ flags: {} }), log });
  }

  get persistent() {
    return this.store.persistent;
  }

  get flags() {
    return this.store.data.flags;
  }

  load() {
    return this.store.load();
  }

  get(id) {
    return this.flags[id] || null;
  }

  // status 'inherit' removes the flag, so the item falls back to its folder.
  async set(id, status, note = '') {
    if (status !== 'inherit' && !STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const updatedAt = new Date().toISOString();
    await this.store.update(({ flags }) => {
      if (status === 'inherit') delete flags[id];
      else flags[id] = { status, note: String(note).slice(0, 500), updatedAt };
    });
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
