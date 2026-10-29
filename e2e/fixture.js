'use strict';

// A complete app with a fake Google Drive, fake Claude and fake visual
// fingerprints, for driving the real front end in a headless browser.
// Nothing here talks to Google or Anthropic.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { CurationStore } = require('../src/curation');
const { SuggestionStore, Suggester } = require('../src/suggest');
const { EmbeddingIndex } = require('../src/embeddings');
const { toAsset } = require('../src/drive');

const quiet = { info() {}, warn() {}, error() {} };

let playwright = null;
try {
  playwright = require('playwright');
} catch {
  // Not installed: the browser tests skip themselves.
}

const ROOT = { id: 'root', name: 'Photo/Video' };
const IMAGES = { id: 'fImages', name: '1 - IMAGES' };
const SHOOTS = [
  { id: 'fA', name: 'Bralorne Meager 10.26', month: '2026-10', look: 0, parent: ROOT },
  { id: 'fB', name: 'Roof rack v2', month: '2026-09', look: 1, parent: ROOT },
  { id: 'fC', name: 'Sea Otter 2026', month: '2026-04', look: 2, parent: ROOT },
  { id: 'fN', name: 'Nested shoot', month: '2026-11', look: 0, parent: IMAGES },
];
const SHAPES = [[3, 2], [2, 3], [4, 3], [16, 9], [1, 1], [9, 16], [3, 1]];
const COLORS = ['#5b6b4f', '#8a6f4e', '#3f5562', '#6f7b5a', '#a4704a', '#4c5d6b', '#7d5b45'];

// 60 photos across four shoots (the last 10 dated 2024), plus two videos in
// shoot A: one any browser plays, one that isn't a playable video at all.
function makeFiles() {
  const files = [];
  for (let i = 0; i < 60; i++) {
    const shoot = SHOOTS[i % SHOOTS.length];
    const [w, h] = SHAPES[i % SHAPES.length];
    const day = String(1 + (i % 27)).padStart(2, '0');
    files.push({
      id: `f${i}`, name: `IMG_${7000 + i}.jpg`, shoot, w: w * 1000, h: h * 1000, color: COLORS[i % COLORS.length],
      date: `${i < 50 ? shoot.month : '2024-06'}-${day}`, kind: 'image',
    });
  }
  files.push({ id: 'vOk', name: 'clip.mp4', shoot: SHOOTS[0], w: 640, h: 360, color: '#222', date: '2026-10-02', kind: 'video' });
  files.push({ id: 'vBad', name: 'DJI_0001.MP4', shoot: SHOOTS[0], w: 640, h: 360, color: '#333', date: '2026-10-03', kind: 'video' });
  return files;
}

const svg = (f, longest) => {
  const scale = longest / Math.max(f.w, f.h);
  const w = Math.round(f.w * scale);
  const h = Math.round(f.h * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${f.color}"/>` +
    `<text x="8" y="24" font-size="18" fill="#fff">${f.name}</text></svg>`;
};

// A short H.264 clip made with ffmpeg (cached between runs), or null.
function testVideo() {
  const file = path.join(os.tmpdir(), 'rux-dam-e2e.mp4');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function fakeDrive(files, { failThumbnails = new Set() } = {}) {
  const byId = Object.fromEntries(files.map((f) => [f.id, f]));
  const video = testVideo();
  const stats = { thumbnails: [], media: [] };
  const ancestorsOf = (shoot) => (shoot.parent === ROOT ? [ROOT, shoot] : [ROOT, IMAGES, shoot]);
  return {
    stats,
    hasVideo: Boolean(video),
    crawl: async () => ({
      assets: files.map((f) => toAsset({
        id: f.id, name: f.name, mimeType: f.mime || (f.kind === 'video' ? 'video/mp4' : 'image/jpeg'), thumbnailLink: f.noThumb ? undefined : 'x',
        modifiedTime: `${f.date}T10:00:00Z`, createdTime: `${f.date}T10:00:00Z`, size: '5000000',
        ...(f.kind === 'video'
          ? { videoMediaMetadata: { width: f.w, height: f.h, durationMillis: '3000' } }
          : f.kind === 'design' ? {} : { imageMediaMetadata: { width: f.w, height: f.h, time: `${f.date.replace(/-/g, ':')} 10:00:00` } }),
      }, ancestorsOf(f.shoot).slice(1).map((a) => a.name).join('/'), ROOT.name, ancestorsOf(f.shoot))),
      folders: [
        { id: ROOT.id, name: ROOT.name, path: '', ancestors: [] },
        { id: IMAGES.id, name: IMAGES.name, path: IMAGES.name, ancestors: [ROOT] },
        ...SHOOTS.map((s) => ({ id: s.id, name: s.name, path: s.name, ancestors: s.parent === ROOT ? [ROOT] : [ROOT, IMAGES] })),
      ],
    }),
    thumbnail: async (id, size) => {
      stats.thumbnails.push({ id, size });
      if (failThumbnails.has(id)) return null;
      return new Response(svg(byId[id], size), { headers: { 'content-type': 'image/svg+xml' } });
    },
    media: async (id, range) => {
      stats.media.push({ id, range: range || '' });
      const f = byId[id];
      if (f.kind !== 'video') return new Response(svg(f, 3000), { headers: { 'content-type': 'image/svg+xml' } });
      const body = id === 'vOk' && video ? video : Buffer.from('not a video');
      const m = /bytes=(\d+)-(\d*)/.exec(range || '');
      if (!m) return new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) } });
      const start = Number(m[1]);
      const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
      return new Response(body.subarray(start, end + 1), {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${body.length}` },
      });
    },
  };
}

// Claude stand-in: suggests the same tags for every photo.
const fakeClaude = {
  beta: {
    messages: {
      create: async (req) => ({
        model: req.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1500, output_tokens: 300 },
        content: [{ type: 'text', text: JSON.stringify({
          description: 'A rider loading gear', product: ['Gear Box 70L'], activity: ['Bikepacking'], color: ['Black'],
          vehicle: [], season: [], tags: ['Outdoor'], creator: [], location: [], event: [],
        }) }],
      }),
    },
  },
};

// Starts the app on a free port. `user` simulates a signed-in Google account.
async function startApp({ user = null, failThumbnails, designs = false } = {}) {
  const files = makeFiles();
  // A logo from Illustrator (Drive previews it) and an InDesign file (it doesn't).
  if (designs) {
    files.push({ id: 'dAi', name: 'RUX logo.ai', mime: 'application/illustrator', shoot: SHOOTS[1], w: 800, h: 400, color: '#ffffff', date: '2026-09-05', kind: 'design' });
    files.push({ id: 'dIndd', name: 'Lookbook.indd', mime: 'application/x-indesign', shoot: SHOOTS[1], w: 1, h: 1, color: '#000', date: '2026-09-06', kind: 'design', noThumb: true });
  }
  const drive = fakeDrive(files, { failThumbnails });
  const library = new Library(drive, [ROOT.id], {
    tags: new TagStore({ log: quiet }), curation: new CurationStore({ log: quiet }),
    suggestions: new SuggestionStore({ log: quiet }), log: quiet,
  });
  await library.sync();
  // Main colors: every third photo mostly blue, the rest mostly green.
  files.forEach((f, i) => library.colors.addPalette(f.id, [[i % 3 ? '#4a7a3a' : '#2f62b8', 70], ['#151515', 30]]));
  const suggester = new Suggester({ library, drive, client: fakeClaude, log: quiet });
  // Fingerprints: each shoot looks alike; a text query with "snow" looks like shoot A.
  const pad = (v) => [...v, ...new Array(252).fill(0)];
  const similarity = new EmbeddingIndex({
    library, drive, log: quiet,
    embedder: { image: async () => pad([1, 0, 0, 0]), text: async (q) => pad(q.includes('snow') ? [1, 0, 0, 0.2] : [0, 0, 0, 1]) },
  });
  for (const f of files) {
    const v = [0, 0, 0, (Number(f.id.slice(1)) || 0) % 5 / 10];
    v[f.shoot.look] = 1;
    const n = Math.hypot(...v);
    similarity.vectors.set(f.id, Float32Array.from(pad(v.map((x) => x / n))));
  }
  const signIn = user && {
    router: (req, res, next) => { req.user = user; next(); },
    requireUser: (req, res, next) => next(),
  };
  const app = createApp({ library, drive, suggester, similarity, signIn });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    library, drive, files,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// One browser per test file; a fresh page per test.
async function launch() {
  const browser = await playwright.chromium.launch();
  return {
    browser,
    page: async (opts = {}) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, ...opts });
      const page = await context.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      return page;
    },
    close: () => browser.close(),
  };
}

// Picks a value in the top bar's Filter & sort menu (opening it if needed).
async function filterBy(page, select, value) {
  if (!(await page.locator('#filter-menu').evaluate((d) => d.open))) await page.click('#filter-menu summary');
  await page.selectOption(select, value);
}

module.exports = { playwright, startApp, launch, filterBy, SHOOTS, quiet };
