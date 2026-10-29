import { $, api, plural, state } from './core.js';
import { DPR, thumbUrl } from './previews.js';
import { queryParams } from './url.js';
import { open } from './viewer.js';

// The visual map: every photo in the current results on one zoomable sheet,
// arranged so photos that look alike sit together. Zoomed out, each photo is a
// square of its color; zoom in and the photos load. The server works out where
// each photo goes (UMAP over the visual fingerprints); here they're packed into
// a grid of squares, rows by the map's y and each row by its x.

const canvas = $('map-canvas');
const ctx = canvas.getContext('2d');
const PHOTO_AT = 44; // squares at least this many css px show their photo
const MAX_LOADS = 12;
const MAX_IMAGES = 900;

const ui = {
  items: [], // { id, name, x, y, color, ..., col, row }
  cols: 0, rows: 0,
  cam: { x: 0, y: 0, s: 1 }, // world point at the canvas's top-left, css px per square
  fitted: true,
  images: new Map(), // id -> { img, size, loading }, oldest first
  loading: 0,
  seq: 0,
  poll: null,
  frame: 0,
  hover: null,
};

const size = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });

function pack(items) {
  const { w, h } = size();
  const cols = Math.max(1, Math.round(Math.sqrt(items.length * ((w || 4) / (h || 3)))));
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let r = 0; r * cols < sorted.length; r++) {
    sorted.slice(r * cols, (r + 1) * cols).sort((a, b) => a.x - b.x).forEach((it, c) => {
      it.col = c;
      it.row = r;
    });
  }
  ui.cols = cols;
  ui.rows = Math.ceil(sorted.length / cols);
  ui.grid = new Map(sorted.map((it) => [`${it.col},${it.row}`, it]));
}

export function fit() {
  const { w, h } = size();
  const s = Math.max(1, Math.min(w / (ui.cols || 1), h / (ui.rows || 1)));
  ui.cam = { s, x: -(w / s - ui.cols) / 2, y: -(h / s - ui.rows) / 2 };
  ui.fitted = true;
  draw();
}

function zoomAt(factor, px, py) {
  const { cam } = ui;
  const minS = Math.min(size().w / (ui.cols || 1), size().h / (ui.rows || 1)) * 0.8;
  const s = Math.min(Math.max(cam.s * factor, minS), 640);
  cam.x += px / cam.s - px / s;
  cam.y += py / cam.s - py / s;
  cam.s = s;
  ui.fitted = false;
  draw();
}

function pan(dx, dy) {
  ui.cam.x -= dx / ui.cam.s;
  ui.cam.y -= dy / ui.cam.s;
  ui.fitted = false;
  draw();
}

const at = (px, py) => ui.grid?.get(`${Math.floor(ui.cam.x + px / ui.cam.s)},${Math.floor(ui.cam.y + py / ui.cam.s)}`);

// --- drawing --------------------------------------------------------------------

export function draw() {
  if (!ui.frame) ui.frame = requestAnimationFrame(paint);
}

function paint() {
  ui.frame = 0;
  const { w, h } = size();
  if (canvas.width !== Math.round(w * DPR) || canvas.height !== Math.round(h * DPR)) {
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const { x, y, s } = ui.cam;
  const gap = s > 6 ? Math.min(3, s * 0.05) : 0;
  const c0 = Math.max(0, Math.floor(x));
  const r0 = Math.max(0, Math.floor(y));
  const c1 = Math.min(ui.cols - 1, Math.floor(x + w / s));
  const r1 = Math.min(ui.rows - 1, Math.floor(y + h / s));
  const photos = s >= PHOTO_AT;
  const wanted = [];
  const fallback = getComputedStyle(canvas).getPropertyValue('--map-empty').trim() || '#d9d8d2';
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const it = ui.grid.get(`${c},${r}`);
      if (!it) continue;
      const px = (c - x) * s + gap / 2;
      const py = (r - y) * s + gap / 2;
      const side = s - gap;
      const image = photos && ui.images.get(it.id);
      if (image?.img) {
        const { naturalWidth: iw, naturalHeight: ih } = image.img;
        const crop = Math.min(iw, ih);
        ctx.drawImage(image.img, (iw - crop) / 2, (ih - crop) / 2, crop, crop, px, py, side, side);
      } else {
        ctx.fillStyle = it.color || fallback;
        ctx.fillRect(px, py, side, side);
      }
      if (photos && (!image || image.size < want(s))) wanted.push([it, Math.hypot(px - w / 2, py - h / 2)]);
      if (ui.hover === it && s >= 12) {
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 3;
        ctx.strokeRect(px + 1.5, py + 1.5, side - 3, side - 3);
      }
    }
  }
  wanted.sort((a, b) => a[1] - b[1]);
  for (const [it] of wanted) {
    if (ui.loading >= MAX_LOADS) break;
    loadImage(it, want(s));
  }
}

const want = (s) => [256, 512, 1024].find((px) => px >= s * DPR) || 1024;

function loadImage(it, px) {
  const entry = ui.images.get(it.id);
  if (entry?.loading || (entry?.size >= px)) return;
  const img = new Image();
  img.decoding = 'async';
  const next = { img: entry?.img || null, size: entry?.size || 0, loading: true };
  ui.images.delete(it.id);
  ui.images.set(it.id, next);
  ui.loading++;
  const done = (ok) => {
    ui.loading--;
    next.loading = false;
    if (ok) Object.assign(next, { img, size: px });
    else next.size = Infinity; // don't keep retrying a missing preview
    // Forget the least recently loaded photos beyond the limit.
    for (const id of ui.images.keys()) {
      if (ui.images.size <= MAX_IMAGES) break;
      ui.images.delete(id);
    }
    draw();
  };
  img.onload = () => done(true);
  img.onerror = () => done(false);
  img.src = thumbUrl(it, px);
}

// --- loading --------------------------------------------------------------------

export async function loadMap() {
  const seq = ++ui.seq;
  clearTimeout(ui.poll);
  const params = queryParams();
  params.delete('sort');
  let data;
  try {
    data = await api(`/api/map?${params}`);
  } catch (err) {
    if (seq === ui.seq) $('map-status').textContent = `The map isn’t available: ${err.message}`;
    return;
  }
  if (seq !== ui.seq || state.view !== 'map') return;
  if (data.building) {
    $('map-status').textContent = data.error
      ? `Couldn’t arrange the map: ${data.error}. Trying again…`
      : `Arranging ${plural(data.photos, 'photo')} by how they look… the first time takes a minute or two.`;
    ui.poll = setTimeout(loadMap, 3000);
    return;
  }
  ui.items = data.items;
  pack(ui.items);
  const missing = data.unplaced ? ` · ${plural(data.unplaced, 'match')} without a visual fingerprint yet aren’t shown` : '';
  $('map-status').textContent = ui.items.length
    ? `${plural(ui.items.length, 'photo')} arranged by look. Scroll or pinch to zoom, drag to move, click a photo to open it.${missing}`
    : `Nothing to show here.${missing}`;
  ui.hover = null;
  fit();
}

export function showMap(on) {
  $('map-view').hidden = !on;
  document.body.classList.toggle('map-mode', on);
  document.querySelector('.grid-wrap').hidden = on;
  for (const b of document.querySelectorAll('#view-switch button')) {
    b.setAttribute('aria-pressed', String((b.dataset.view || '') === (on ? 'map' : '')));
  }
  if (on) loadMap();
  else clearTimeout(ui.poll);
}

// --- interaction ----------------------------------------------------------------

const pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  gesture = { moved: pointers.size > 1 ? 10 : 0 };
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) {
    const it = at(e.offsetX, e.offsetY);
    if (it !== ui.hover) {
      ui.hover = it;
      canvas.style.cursor = it ? 'pointer' : 'grab';
      draw();
    }
    const tip = $('map-tip');
    tip.hidden = !it || ui.cam.s < 12;
    if (it) {
      tip.textContent = it.name;
      tip.style.transform = `translate(${e.offsetX + 14}px, ${e.offsetY + 14}px)`;
    }
    return;
  }
  const now = { x: e.offsetX, y: e.offsetY };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    pointers.set(e.pointerId, now);
    const [c, d] = [...pointers.values()];
    const after = Math.hypot(c.x - d.x, c.y - d.y);
    if (before) zoomAt(after / before, (c.x + d.x) / 2, (c.y + d.y) / 2);
    gesture.moved += 10;
    return;
  }
  pointers.set(e.pointerId, now);
  gesture.moved += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y);
  pan(now.x - prev.x, now.y - prev.y);
});

const release = (e) => {
  const wasClick = pointers.size === 1 && gesture && gesture.moved < 5;
  pointers.delete(e.pointerId);
  if (!pointers.size) canvas.classList.remove('dragging');
  if (wasClick && e.type === 'pointerup') {
    const it = at(e.offsetX, e.offsetY);
    if (it) openItem(it);
  }
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', () => {
  $('map-tip').hidden = true;
  if (ui.hover) {
    ui.hover = null;
    draw();
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Trackpads: pinch arrives as ctrl+wheel, two-finger scroll as plain wheel.
  const wheel = e.deltaMode || (Math.abs(e.deltaY) >= 40 && !e.deltaX);
  if (e.ctrlKey || wheel) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.offsetX, e.offsetY);
  else pan(-e.deltaX, -e.deltaY);
}, { passive: false });

canvas.addEventListener('dblclick', (e) => zoomAt(2.5, e.offsetX, e.offsetY));

canvas.addEventListener('keydown', (e) => {
  const { w, h } = size();
  const moves = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
  if (moves[e.key]) pan(...moves[e.key]);
  else if (e.key === '+' || e.key === '=') zoomAt(1.5, w / 2, h / 2);
  else if (e.key === '-') zoomAt(1 / 1.5, w / 2, h / 2);
  else if (e.key === '0') fit();
  else if (e.key === 'Enter') {
    const it = at(w / 2, h / 2);
    if (it) openItem(it);
  } else return;
  e.preventDefault();
});

async function openItem(it) {
  try {
    open(await api(`/api/assets/${encodeURIComponent(it.id)}`));
  } catch {
    // Gone since the map loaded.
  }
}

$('map-in').addEventListener('click', () => zoomAt(1.6, size().w / 2, size().h / 2));
$('map-out').addEventListener('click', () => zoomAt(1 / 1.6, size().w / 2, size().h / 2));
$('map-fit').addEventListener('click', fit);

new ResizeObserver(() => {
  if (!ui.items.length) return;
  if (ui.fitted) {
    pack(ui.items);
    fit();
  } else {
    draw();
  }
}).observe(canvas);
