'use strict';

const { JsonStore } = require('./store');

const HEX = /^#[0-9a-f]{6}$/;
const FLUSH_MS = 30_000;

// Each asset's colors, stored as colors.json:
//   { colors: { [assetId]: '#rrggbb' }, palettes: { [assetId]: [['#rrggbb', percent], ...] } }
// `colors` is the average, shown behind a tile while its preview loads; the
// first one recorded is kept. Browsers work it out from previews they've loaded
// and send it in, and the server works it out along with each palette (the
// main colors, for browsing by color; see palette.js).
class ColorStore {
  constructor({ auth, bucket, object = 'colors.json', log = console } = {}) {
    this.store = new JsonStore({ auth, bucket, object, empty: () => ({ colors: {}, palettes: {} }), log });
    this.log = log;
    this.pending = { colors: {}, palettes: {} };
    this.timer = null;
  }

  async load() {
    await this.store.load();
    this.store.data.palettes ||= {};
  }

  get(id) {
    return Object.hasOwn(this.store.data.colors, id) ? this.store.data.colors[id] : null;
  }

  palette(id) {
    const { palettes } = this.store.data;
    return palettes && Object.hasOwn(palettes, id) ? palettes[id] : null;
  }

  // Adds colors for assets that have none yet; returns how many were new.
  // Saving is batched, since colors arrive a few at a time while people browse.
  add(colors, known = () => true) {
    let added = 0;
    for (const [id, color] of Object.entries(colors || {})) {
      const c = String(color).toLowerCase();
      if (!HEX.test(c) || !known(id) || this.get(id)) continue;
      this.pending.colors[id] = c;
      this.store.data.colors[id] = c;
      added++;
    }
    if (added) this.later();
    return added;
  }

  // A palette worked out on the server, and its average if there's no color yet.
  addPalette(id, palette, average) {
    (this.store.data.palettes ||= {})[id] = palette;
    this.pending.palettes[id] = palette;
    if (average) this.add({ [id]: average });
    this.later();
  }

  later() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending;
    this.pending = { colors: {}, palettes: {} };
    if (!Object.keys(batch.colors).length && !Object.keys(batch.palettes).length) return;
    try {
      await this.store.update((data) => {
        data.colors = { ...batch.colors, ...data.colors };
        data.palettes = { ...data.palettes, ...batch.palettes };
      });
    } catch (err) {
      this.log.error(`Failed to save colors: ${err.message}`);
    }
  }
}

module.exports = { ColorStore };
