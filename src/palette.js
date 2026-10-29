'use strict';

const jpeg = require('jpeg-js');

// Each photo's main colors, worked out on the server from its smallest preview,
// for browsing by color and for the colored squares on the visual map.

// --- color math ---------------------------------------------------------------

const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const parseHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// CIE L*a*b* (D65), where distances roughly match how different colors look.
function lab([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

// --- palettes -----------------------------------------------------------------

const MERGE = 14; // colors closer than this (in Lab) count as one
const MAX_COLORS = 5;
const MIN_SHARE = 3; // percent

// Up to 5 main colors of an image, as [['#rrggbb', percent], ...], largest first.
// Pixels are binned (4 bits per channel), then similar bins are merged.
function paletteOf({ data, width, height }) {
  const bins = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) || bins.set(key, [0, 0, 0, 0]).get(key);
      bin[0]++;
      bin[1] += r;
      bin[2] += g;
      bin[3] += b;
      total++;
    }
  }
  const clusters = [];
  for (const [n, r, g, b] of [...bins.values()].sort((p, q) => q[0] - p[0])) {
    const rgb = [r / n, g / n, b / n];
    const l = lab(rgb);
    const near = clusters.find((c) => distance(c.lab, l) < MERGE);
    if (near) {
      for (let i = 0; i < 3; i++) near.sum[i] += rgb[i] * n;
      near.n += n;
    } else if (clusters.length < 24) {
      clusters.push({ n, lab: l, sum: rgb.map((v) => v * n) });
    }
  }
  return clusters
    .sort((p, q) => q.n - p.n)
    .slice(0, MAX_COLORS)
    .map((c) => [hex(c.sum.map((v) => v / c.n)), Math.round((100 * c.n) / total)])
    .filter(([, share]) => share >= MIN_SHARE);
}

// The average of a palette, weighted by share (the tile placeholder color).
function averageOf(palette) {
  const sum = [0, 0, 0];
  let n = 0;
  for (const [h, share] of palette) {
    parseHex(h).forEach((v, i) => { sum[i] += v * share; });
    n += share;
  }
  return n ? hex(sum.map((v) => v / n)) : null;
}

// How much of a photo is close to a color: the percent of its palette within
// reach, nearer colors counting more. 0 when nothing is close.
const REACH = 32;
function colorScore(palette, target) {
  let score = 0;
  for (const [h, share] of palette || []) {
    const d = distance(lab(parseHex(h)), target);
    if (d < REACH) score += share * (1 - d / REACH);
  }
  return score;
}

// --- background job -----------------------------------------------------------

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

// Works out palettes for assets that have none, a couple at a time, from their
// 256px previews (which also warms the preview cache). Runs after each sync.
class PaletteFiller {
  constructor({ library, preview, concurrency = 2, log = console }) {
    this.library = library;
    this.preview = preview; // (asset) => Promise<{ body, type } | null>
    this.concurrency = concurrency;
    this.log = log;
    this.failed = new Set();
    this.running = false;
  }

  missing() {
    const { colors } = this.library;
    return this.library.assets.filter((a) => a.hasThumbnail && !colors.palette(a.id) && !this.failed.has(a.id));
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const queue = this.missing();
      if (queue.length) this.log.info(`Working out colors for ${queue.length} assets in the background`);
      const worker = async () => {
        for (let asset = queue.shift(); asset; asset = queue.shift()) await this.fill(asset);
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));
    } finally {
      this.running = false;
      await this.library.colors.flush();
    }
  }

  async fill(asset) {
    try {
      const preview = await this.preview(asset);
      if (!preview || !isJpeg(preview.body)) throw new Error('no JPEG preview');
      const image = jpeg.decode(preview.body, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
      const palette = paletteOf(image);
      if (!palette.length) throw new Error('no colors');
      this.library.colors.addPalette(asset.id, palette, averageOf(palette));
    } catch (err) {
      this.failed.add(asset.id);
      if (this.failed.size <= 5) this.log.error(`Colors failed for ${asset.id}: ${err.message}`);
    }
  }
}

module.exports = { paletteOf, averageOf, colorScore, lab, parseHex, PaletteFiller, REACH };
