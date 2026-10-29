import { $, api } from './core.js';

// Preview image URLs: standard sizes, versions (so browsers can keep them), and the size each place needs.

// Preview sizes the server keeps (longest side, px); requests round up to one,
// so the same image is reused across the grid, cards and viewer. The version
// (from the file's modified time) lets the browser keep a preview for good.
export const PREVIEW_SIZES = [256, 512, 1024, 2048];
export const DPR = Math.min(window.devicePixelRatio || 1, 2);

export const thumbUrl = (a, px) => `/api/assets/${encodeURIComponent(a.id)}/thumbnail` +
  `?size=${PREVIEW_SIZES.find((s) => s >= px) || 2048}&v=${(Date.parse(a.modifiedTime) || 0).toString(36)}`;
export const aspectOf = (a) => (a.width && a.height ? Math.min(Math.max(a.width / a.height, 0.4), 3) : 1);

// Longest side, in device pixels, of an image cropped to fill a box (w x h css px).
export const fillPx = (a, w, h) => {
  const ar = a.width && a.height ? a.width / a.height : 1;
  return Math.max(w, h * ar, h, w / ar) * DPR;
};

// A grid tile is the row height tall and grows up to ~25% wider to fill its row.
export const rowHeight = () => Number($('size').value) || 200;
export const tileUrl = (a) => thumbUrl(a, fillPx(a, rowHeight() * aspectOf(a) * 1.25, rowHeight()));
export const viewerUrl = (a) => thumbUrl(a, 2048);

// Average colors: tiles show their photo's color while the preview loads. A
// browser that has loaded a preview with no color on record works it out
// (an 8x8 downscale) and sends it in batches, for everyone's next visit.
const colorCanvas = document.createElement('canvas');
colorCanvas.width = colorCanvas.height = 8;
const pendingColors = {};
let colorTimer = null;

export function sampleColor(asset, img) {
  if (asset.color || !img.naturalWidth) return;
  try {
    const ctx = colorCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 8, 8);
    const { data } = ctx.getImageData(0, 0, 8, 8);
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
    asset.color = `#${sum.map((v) => Math.round(v / 64).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return; // e.g. the image couldn't be read; nothing to save
  }
  pendingColors[asset.id] = asset.color;
  if (!colorTimer) {
    colorTimer = setTimeout(() => {
      const colors = { ...pendingColors };
      for (const id of Object.keys(colors)) delete pendingColors[id];
      colorTimer = null;
      api('/api/colors', { colors }).catch(() => {});
    }, 3000);
  }
}
