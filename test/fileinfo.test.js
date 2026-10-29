'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fileFacets, parseTakenTime, formatOf } = require('../src/fileinfo');
const { PLACEMENTS } = require('../public/specs');

const ALL = PLACEMENTS.map((p) => p.name);
const { toAsset } = require('../src/drive');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');

const quiet = { info() {}, warn() {}, error() {} };
const root = { id: 'root', name: 'Brand' };
const file = (o) => toAsset({ mimeType: 'image/jpeg', modifiedTime: '2026-10-01T00:00:00Z', createdTime: '2026-10-01T00:00:00Z', ...o }, '', 'Brand', [root]);

const assets = [
  file({ id: 'raw', name: 'R5_0001.CR3', mimeType: 'image/x-canon-cr3', fileExtension: 'CR3', size: '45000000',
    imageMediaMetadata: { width: 8192, height: 5464, time: '2025:07:04 09:00:00', cameraMake: 'Canon', cameraModel: 'Canon EOS R5' } }),
  file({ id: 'vert', name: 'story.jpg', size: '800000', createdTime: '2026-10-20T00:00:00Z',
    imageMediaMetadata: { width: 1080, height: 1920, time: '2026:10:19 18:30:00', cameraMake: 'Apple', cameraModel: 'iPhone 16 Pro' } }),
  file({ id: 'pano', name: 'ridge.jpg', size: '12000000', imageMediaMetadata: { width: 12000, height: 3000, rotation: 0 } }),
  file({ id: 'turned', name: 'turned.jpg', size: '3000000', imageMediaMetadata: { width: 4000, height: 3000, rotation: 1 } }),
  file({ id: 'clip', name: 'clip.mov', mimeType: 'video/quicktime', size: '250000000', createdTime: '2024-03-01T00:00:00Z',
    videoMediaMetadata: { width: 3840, height: 2160, durationMillis: '42000' } }),
];

test('derives format, date, size, shape, resolution, length and camera', () => {
  assert.deepStrictEqual(fileFacets(assets[0]), {
    format: 'RAW', year: '2025', size: '20–100 MB', orientation: 'Landscape', resolution: '24 MP+ (print)', camera: 'Canon EOS R5',
    ready: ALL,
  });
  assert.deepStrictEqual(fileFacets(assets[1]), {
    format: 'JPG', year: '2026', size: 'Under 1 MB', orientation: 'Portrait', resolution: '2–12 MP', camera: 'Apple iPhone 16 Pro',
    // 1080×1920: too narrow for Google landscape and square minimums.
    ready: ['Reels', 'Stories', 'Feed 4:5', 'Feed 1:1', 'Carousel', 'Google portrait'],
  });
  assert.strictEqual(fileFacets(assets[2]).orientation, 'Panorama');
  assert.strictEqual(fileFacets(assets[3]).orientation, 'Portrait', 'EXIF rotation swaps width and height');
  assert.deepStrictEqual(fileFacets(assets[4]), {
    format: 'MOV', year: '2024', size: '100 MB – 1 GB', orientation: 'Landscape', duration: '15–60 s',
    ready: ALL,
  });
  assert.strictEqual(parseTakenTime('0000:00:00 00:00:00'), null);
  assert.strictEqual(formatOf({ name: 'x.jpeg', mimeType: 'application/octet-stream' }), 'JPG');
});

test('filters by file properties and date range, sorts, and counts file facets', async () => {
  const library = new Library({ crawl: async () => ({ assets: assets.map((a) => ({ ...a })), folders: [] }) }, ['root'],
    { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const ids = (r) => r.items.map((a) => a.id);

  assert.deepStrictEqual(ids(library.search({ file: ['format:RAW'] })), ['raw']);
  assert.deepStrictEqual(ids(library.search({ file: ['orientation:portrait', 'orientation:panorama'], sort: 'name' })),
    ['ridge.jpg', 'story.jpg', 'turned.jpg'].map((n) => assets.find((a) => a.name === n).id), 'OR within a facet');
  assert.deepStrictEqual(ids(library.search({ file: ['orientation:Portrait', 'format:JPG', 'size:Under 1 MB'] })), ['vert']);

  // Date taken when known, otherwise date added.
  assert.deepStrictEqual(ids(library.search({ from: '2025-01-01', to: '2025-12-31' })), ['raw']);
  assert.deepStrictEqual(ids(library.search({ from: '2026-10-01', sort: 'taken' })).slice(0, 1), ['vert']);
  assert.deepStrictEqual(ids(library.search({ to: '2024-12-31' })), ['clip']);

  assert.deepStrictEqual(ids(library.search({ sort: 'size' })).slice(0, 2), ['clip', 'raw']);
  assert.deepStrictEqual(ids(library.search({ sort: 'taken-asc' })).slice(0, 1), ['clip']);
  assert.deepStrictEqual(ids(library.search({ kind: 'video', sort: 'duration' })), ['clip']);

  // Search text also matches camera, format and year.
  assert.deepStrictEqual(ids(library.search({ q: 'iphone' })), ['vert']);
  assert.deepStrictEqual(ids(library.search({ q: 'raw 2025' })), ['raw']);

  // A group's counts ignore its own selection; other groups count the matches.
  const portrait = library.search({ file: ['orientation:Portrait'] });
  assert.deepStrictEqual(portrait.fileFacets.orientation, { Landscape: 2, Portrait: 2, Panorama: 1 });
  assert.deepStrictEqual(portrait.fileFacets.format, { JPG: 2 });
  assert.strictEqual(portrait.total, 2);

  const { fileFacets: counts } = library.search({});
  assert.deepStrictEqual(counts.format, { RAW: 1, JPG: 3, MOV: 1 });
  assert.deepStrictEqual(counts.year, { 2025: 1, 2026: 3, 2024: 1 });
  assert.strictEqual(counts.duration['15–60 s'], 1);
});

test('platform readiness: ready, crop or too small for each placement', () => {
  const { check, PLACEMENTS: P, isVertical } = require('../public/specs');
  const by = (id) => P.find((p) => p.id === id);
  assert.deepStrictEqual(check(1080, 1920, by('reels')), { status: 'ready', detail: '1080×1920' });
  assert.deepStrictEqual(check(720, 1280, by('reels')), { status: 'small', detail: 'Needs 1080×1920, has 720×1280' });
  assert.deepStrictEqual(check(1080, 1920, by('feed45')), { status: 'crop', detail: 'Crop to 1080×1350' });
  assert.strictEqual(check(1080, 1920, by('google-landscape')).status, 'small');
  assert.deepStrictEqual(check(1200, 628, by('google-landscape')), { status: 'ready', detail: '1200×628' });
  assert.deepStrictEqual(check(8192, 5464, by('reels')), { status: 'crop', detail: 'Crop to 3074×5464' });
  assert.strictEqual(check(0, 0, by('reels')), null);
  assert.ok(isVertical(1080, 1920));
  assert.ok(!isVertical(1080, 1350));
});

test('Ready for filter', async () => {
  const library = new Library({ crawl: async () => ({ assets: assets.map((a) => ({ ...a })), folders: [] }) }, ['root'],
    { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const ids = (r) => r.items.map((a) => a.id).sort();
  // Everything big enough for a 1.91:1 crop; the 1080-wide story is not.
  assert.deepStrictEqual(ids(library.search({ file: ['ready:Google landscape'] })), ['clip', 'pano', 'raw', 'turned']);
  const counts = library.search({}).fileFacets.ready;
  assert.strictEqual(counts.Reels, 5);
  assert.strictEqual(counts['Google landscape'], 4);
});
