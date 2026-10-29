'use strict';

const { usableFor, PLACEMENTS } = require('../public/specs');

// File-property facets (date, format, size, shape, length, camera) derived
// from Drive metadata, and the sort orders for search results.

const RAW = new Set(['cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq']);
const FORMAT_BY_MIME = {
  'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'image/heic': 'HEIC',
  'image/heif': 'HEIC', 'image/tiff': 'TIFF', 'image/svg+xml': 'SVG', 'image/bmp': 'BMP',
  'image/vnd.adobe.photoshop': 'PSD', 'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/webm': 'WebM',
  'video/x-msvideo': 'AVI', 'video/x-m4v': 'M4V', 'video/mpeg': 'MPEG',
};

// Bucket labels, in display order.
const SIZE_BUCKETS = [
  ['Under 1 MB', 1e6], ['1–5 MB', 5e6], ['5–20 MB', 20e6], ['20–100 MB', 100e6], ['100 MB – 1 GB', 1e9], ['Over 1 GB', Infinity],
];
const RESOLUTION_BUCKETS = [
  ['Under 2 MP (web)', 2e6], ['2–12 MP', 12e6], ['12–24 MP', 24e6], ['24 MP+ (print)', Infinity],
];
const DURATION_BUCKETS = [
  ['Under 15 s', 15e3], ['15–60 s', 60e3], ['1–5 min', 300e3], ['Over 5 min', Infinity],
];
const ORIENTATIONS = ['Landscape', 'Portrait', 'Square', 'Panorama'];

const bucket = (value, buckets) => buckets.find(([, max]) => value < max)[0];

function extension(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function formatOf(asset) {
  const ext = asset.fileExtension || extension(asset.name);
  if (RAW.has(ext)) return 'RAW';
  return FORMAT_BY_MIME[asset.mimeType] || (ext ? ext.toUpperCase().replace('JPEG', 'JPG') : 'Other');
}

// EXIF capture time from Drive ("2026:09:12 10:22:01") as an ISO-like string.
function parseTakenTime(value) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value || '');
  if (!m || m[1] < '1990' || m[2] === '00') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// The date shown and filtered on: when it was shot if the camera recorded it,
// otherwise when it was added to Drive.
function assetDate(asset) {
  return asset.takenTime || asset.createdTime || asset.modifiedTime || '';
}

function orientationOf(asset) {
  if (!asset.width || !asset.height) return null;
  const ratio = asset.width / asset.height;
  if (ratio > 2.2) return 'Panorama';
  if (ratio > 1.05) return 'Landscape';
  if (ratio < 0.95) return 'Portrait';
  return 'Square';
}

// Facet values for one asset: { key: label }, or a list of labels for `ready`
// (every placement it can be used for); missing info is left out.
function fileFacets(asset) {
  const out = { format: formatOf(asset) };
  const date = assetDate(asset);
  if (date) out.year = date.slice(0, 4);
  if (asset.size) out.size = bucket(asset.size, SIZE_BUCKETS);
  const orientation = orientationOf(asset);
  if (orientation) out.orientation = orientation;
  if (asset.kind === 'image' && asset.width && asset.height) {
    out.resolution = bucket(asset.width * asset.height, RESOLUTION_BUCKETS);
  }
  if (asset.kind === 'video' && asset.durationMs) out.duration = bucket(asset.durationMs, DURATION_BUCKETS);
  if (asset.camera) out.camera = asset.camera;
  const ready = usableFor(asset.width, asset.height);
  if (ready.length) out.ready = ready;
  return out;
}

const SORTS = {
  // Assets are kept newest-modified first, so this is the stored order.
  modified: null,
  taken: (a, b) => assetDate(b).localeCompare(assetDate(a)),
  'taken-asc': (a, b) => assetDate(a).localeCompare(assetDate(b)),
  added: (a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  size: (a, b) => (b.size || 0) - (a.size || 0),
  duration: (a, b) => (b.durationMs || 0) - (a.durationMs || 0),
};

module.exports = {
  fileFacets, formatOf, assetDate, parseTakenTime, SORTS,
  ORDER: {
    size: SIZE_BUCKETS.map(([label]) => label),
    resolution: RESOLUTION_BUCKETS.map(([label]) => label),
    duration: DURATION_BUCKETS.map(([label]) => label),
    orientation: ORIENTATIONS,
    ready: PLACEMENTS.map((p) => p.name),
  },
};
