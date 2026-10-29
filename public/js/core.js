// Shared state, DOM and network helpers used by every module.

export const PAGE = 120;
export const FACET_LIMIT = 8;
export const $ = (id) => document.getElementById(id);
export const grid = $('grid');
export const viewer = $('viewer');

export const state = {
  q: '', kind: '', rights: '', folder: '', tags: new Set(), suggested: '',
  file: new Set(), range: '', from: '', to: '', sort: '', fileFacets: {}, fileOrder: {},
  ai: { enabled: false }, aiWasBusy: false,
  offset: 0, total: 0, loading: false, items: new Map(), facets: {},
  current: null, selected: new Set(), lastPicked: null,
  fields: [], folders: new Map(), expanded: new Set(), facetsOpen: new Set(),
  like: '', likeName: '', similarMode: '', months: null, zoom: 0, showAllFolders: false,
  rating: '', fav: '', collection: '', collections: [], favCount: 0, treeFilter: '',
};


export function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}


export function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

export async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith('/api/me')) {
    // Session expired: sign in again and come back to the same view.
    location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return new Promise(() => {});
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
export const fieldLabel = (key) => state.fields.find((f) => f.key === key)?.label || key;

export async function copyText(button, text) {
  const label = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = 'Copied!';
  setTimeout(() => { button.textContent = label; }, 1500);
}


export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
