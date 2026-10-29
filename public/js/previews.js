import { $ } from './core.js';

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
