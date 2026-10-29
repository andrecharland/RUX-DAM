'use strict';

const { JsonStore } = require('./store');

const HEX = /^#[0-9a-f]{6}$/;
const FLUSH_MS = 30_000;

// Each asset's average color, shown behind its tile while the preview loads.
// Browsers work it out from previews they've already loaded and send it in;
// the first color recorded for an asset is kept. Stored as colors.json:
//   { colors: { [assetId]: '#rrggbb' } }
class ColorStore {
  constructor({ auth, bucket, object = 'colors.json', log = console } = {}) {
    this.store = new JsonStore({ auth, bucket, object, empty: () => ({ colors: {} }), log });
    this.log = log;
    this.pending = {};
    this.timer = null;
  }

  load() {
    return this.store.load();
  }

  get(id) {
    return Object.hasOwn(this.store.data.colors, id) ? this.store.data.colors[id] : null;
  }

  // Adds colors for assets that have none yet; returns how many were new.
  // Saving is batched, since colors arrive a few at a time while people browse.
  add(colors, known = () => true) {
    let added = 0;
    for (const [id, color] of Object.entries(colors || {})) {
      const c = String(color).toLowerCase();
      if (!HEX.test(c) || !known(id) || this.get(id) || this.pending[id]) continue;
      this.pending[id] = c;
      this.store.data.colors[id] = c;
      added++;
    }
    if (added && !this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
    return added;
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending;
    this.pending = {};
    if (!Object.keys(batch).length) return;
    try {
      await this.store.update((data) => { data.colors = { ...batch, ...data.colors }; });
    } catch (err) {
      this.log.error(`Failed to save colors: ${err.message}`);
    }
  }
}

module.exports = { ColorStore };
