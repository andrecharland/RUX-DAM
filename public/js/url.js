import { $, state, viewer } from './core.js';

// The address bar mirrors the current view, so a copied link opens exactly what is on screen.

// The date filter as from/to (YYYY-MM-DD). Presets are relative to today, so a
// shared "Last 30 days" link stays relative.
export function dateRange() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const ago = (days) => iso(new Date(Date.now() - days * 864e5));
  switch (state.range) {
    case '7d': return { from: ago(7), to: '' };
    case '30d': return { from: ago(30), to: '' };
    case '12m': return { from: ago(365), to: '' };
    case 'year': return { from: `${new Date().getFullYear()}-01-01`, to: '' };
    case 'custom': return { from: state.from, to: state.to };
    default: return { from: '', to: '' };
  }
}

export function queryParams(extra = {}) {
  const params = new URLSearchParams({
    q: state.q, kind: state.kind, rights: state.rights, folder: state.folder, suggested: state.suggested,
    sort: state.sort, like: state.like, rating: state.rating, fav: state.fav, collection: state.collection, ...dateRange(),
  });
  for (const t of state.tags) params.append('tag', t);
  for (const f of state.file) params.append('f', f);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params;
}


// The page URL mirrors the current view (search, filters, folder, open asset),
// so copying it shares exactly what's on screen.
export function writeUrl() {
  const params = new URLSearchParams();
  for (const key of ['q', 'kind', 'rights', 'suggested', 'folder', 'sort', 'range', 'like', 'rating', 'fav', 'collection']) {
    if (state[key]) params.set(key, state[key]);
  }
  if (state.range === 'custom') {
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
  }
  for (const t of state.tags) params.append('tag', t);
  for (const f of state.file) params.append('f', f);
  if (viewer.open && state.current) params.set('asset', state.current.id);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// Reads the view from the URL; returns the asset to open, if any.
export function readUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of ['q', 'kind', 'rights', 'suggested', 'folder', 'sort', 'range', 'from', 'to', 'like', 'rating', 'fav', 'collection']) {
    state[key] = params.get(key) || '';
  }
  $('rating').value = state.rating;
  state.tags = new Set(params.getAll('tag'));
  state.file = new Set(params.getAll('f'));
  $('sort').value = state.sort;
  $('date-range').value = state.range;
  $('date-from').value = state.from;
  $('date-to').value = state.to;
  $('date-custom').hidden = state.range !== 'custom';
  $('q').value = state.q;
  $('kind').value = state.kind;
  $('rights').value = state.rights;
  $('suggested').value = state.suggested;
  return params.get('asset');
}
