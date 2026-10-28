'use strict';

const PAGE = 120;
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const viewer = $('viewer');
const state = { q: '', kind: '', collection: '', offset: 0, total: 0, loading: false, items: new Map() };

function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function card(asset) {
  const thumb = el('div', { class: 'thumb' });
  if (asset.hasThumbnail) {
    thumb.append(el('img', { src: `/api/assets/${asset.id}/thumbnail`, loading: 'lazy', alt: asset.name }));
  } else {
    thumb.append(el('span', { text: asset.kind === 'video' ? '▶ Video' : 'No preview' }));
  }
  if (asset.kind === 'video') {
    thumb.append(el('span', { class: 'badge', text: `▶ ${formatDuration(asset.durationMs)}`.trim() }));
  }
  const button = el('button', { class: 'card', type: 'button', 'data-id': asset.id }, [
    thumb,
    el('div', { class: 'caption' }, [
      el('div', { class: 'name', text: asset.name, title: asset.name }),
      el('div', { class: 'path', text: [asset.collection, asset.path].filter(Boolean).join(' / ') }),
    ]),
  ]);
  return button;
}

async function load(reset = false) {
  if (state.loading) return;
  if (!reset && state.offset >= state.total && state.offset > 0) return;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.items.clear();
    grid.replaceChildren();
  }
  const params = new URLSearchParams({
    q: state.q, kind: state.kind, collection: state.collection,
    offset: state.offset, limit: PAGE,
  });
  try {
    const res = await fetch(`/api/assets?${params}`);
    const data = await res.json();
    state.total = data.total;
    state.offset += data.items.length;
    for (const a of data.items) {
      state.items.set(a.id, a);
      grid.append(card(a));
    }
    $('meta').textContent = `${data.total.toLocaleString()} asset${data.total === 1 ? '' : 's'}`;
  } finally {
    state.loading = false;
  }
}

async function loadCollections() {
  const list = await (await fetch('/api/collections')).json();
  const select = $('collection');
  select.replaceChildren(el('option', { value: '', text: 'All folders' }));
  for (const c of list) select.append(el('option', { value: c.name, text: `${c.name} (${c.count})` }));
  select.value = state.collection;
}

function open(asset) {
  const fileUrl = `/api/assets/${asset.id}/file`;
  const stage = $('stage');
  stage.replaceChildren(asset.kind === 'video'
    ? el('video', { src: fileUrl, controls: '', autoplay: '', playsinline: '' })
    : el('img', { src: fileUrl, alt: asset.name }));
  $('d-name').textContent = asset.name;
  const rows = [
    ['Type', asset.mimeType],
    ['Size', formatBytes(asset.size)],
    ['Dimensions', asset.width ? `${asset.width} × ${asset.height}` : '—'],
    ...(asset.kind === 'video' ? [['Duration', formatDuration(asset.durationMs) || '—']] : []),
    ['Folder', [asset.collection, asset.path].filter(Boolean).join(' / ')],
    ['Modified', new Date(asset.modifiedTime).toLocaleString()],
  ];
  $('d-meta').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('d-download').href = `${fileUrl}?download=1`;
  $('d-drive').href = asset.webViewLink;
  $('d-copy').onclick = async () => {
    await navigator.clipboard.writeText(new URL(fileUrl, location.href).href);
    $('d-copy').textContent = 'Copied!';
    setTimeout(() => { $('d-copy').textContent = 'Copy link'; }, 1500);
  };
  viewer.showModal();
}

grid.addEventListener('click', (e) => {
  const target = e.target.closest('.card');
  if (target) open(state.items.get(target.dataset.id));
});
$('close').addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => $('stage').replaceChildren());

let debounce;
$('q').addEventListener('input', (e) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => { state.q = e.target.value; load(true); }, 200);
});
$('kind').addEventListener('change', (e) => { state.kind = e.target.value; load(true); });
$('collection').addEventListener('change', (e) => { state.collection = e.target.value; load(true); });
$('sync').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Syncing…';
  try {
    await fetch('/api/sync', { method: 'POST' });
    await loadCollections();
    await load(true);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Sync';
  }
});

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.offset < state.total) load();
}, { rootMargin: '600px' }).observe($('sentinel'));

loadCollections();
load(true);
