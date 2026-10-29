import { $, PAGE, api, el, formatDuration, grid, state, viewer } from './core.js';
import { canReorder, renderCollectionCards, renderCurate } from './curation.js';
import { renderChips, renderFacets } from './filters.js';
import { loadFolders, renderFolderCards } from './folders.js';
import { aspectOf, sampleColor, tileUrl } from './previews.js';
import { renderBulk } from './selection.js';
import { renderSuggestions } from './suggest.js';
import { loadFields } from './tags.js';
import { creatorOf, displayName } from './titles.js';
import { queryParams, writeUrl } from './url.js';
import { renderRights, renderViewerLabel, renderViewerTags } from './viewer.js';

// Loading results and laying out the grid: tiles, month groups, jump-to-date, paging and refreshes.

// One tile: its width follows the photo's shape (--ar), its height the size slider.
export function card(asset) {
  const ar = aspectOf(asset);
  const restricted = asset.rights.status === 'restricted';
  const selected = state.selected.has(asset.id);
  const values = Object.values(asset.tags).flat().map((t) => t.value);
  const creator = creatorOf(asset);
  const where = [asset.collection, asset.path].filter(Boolean).join(' / ');
  return el('div', {
    class: ['card', restricted && 'restricted', selected && 'selected'].filter(Boolean).join(' '),
    tabindex: 0, role: 'button', 'data-id': asset.id, 'aria-label': displayName(asset), draggable: canReorder() ? 'true' : false,
    style: `--ar: ${ar.toFixed(3)}${asset.color ? `; background-color: ${asset.color}` : ''}`,
  }, [
    el('input', { type: 'checkbox', class: 'pick', 'aria-label': `Select ${displayName(asset)}`, checked: selected }),
    asset.hasThumbnail
      ? el('img', { src: tileUrl(asset), loading: 'lazy', decoding: 'async', alt: '', onload: (e) => sampleColor(asset, e.target) })
      : el('div', { class: 'noprev', text: asset.kind === 'video' ? '▶ Video' : 'No preview' }),
    restricted ? el('span', { class: 'flag', text: 'Do not use' }) : '',
    asset.kind === 'video' ? el('span', { class: 'badge', text: `▶ ${formatDuration(asset.durationMs)}`.trim() }) : '',
    asset.suggestions?.count ? el('span', { class: 'ai-dot', text: `✨ ${asset.suggestions.count}`, title: 'Suggestions from Claude to review' }) : '',
    el('button', {
      type: 'button', class: `heart${asset.favorite ? ' on' : ''}`, text: '♥', 'aria-pressed': String(Boolean(asset.favorite)),
      'aria-label': asset.favorite ? 'Remove from my favorites' : 'Add to my favorites',
    }),
    asset.rating ? el('span', { class: 'stars-badge', text: '★'.repeat(asset.rating), title: `${asset.rating} star${asset.rating === 1 ? '' : 's'}` }) : '',
    el('div', { class: 'info' }, [
      el('div', { text: displayName(asset) }),
      el('div', { class: 'sub', text: [creator && `by ${creator}`, where].filter(Boolean).join(' · ') }),
      values.length ? el('div', { class: 'sub', text: values.join(' · ') }) : '',
      asset.suggestions?.count ? el('div', { class: 'ai', text: `✨ ${Object.values(asset.suggestions.pending).flat().join(' · ')}` }) : '',
    ]),
  ]);
}

// Results are grouped under headings: by month when sorted by a date, "Looks
// like …" for similar and visual matches, none for other sorts.
export const DATE_OF = {
  '': (a) => a.modifiedTime,
  added: (a) => a.createdTime,
  taken: (a) => a.takenTime || a.createdTime || a.modifiedTime,
  'taken-asc': (a) => a.takenTime || a.createdTime || a.modifiedTime,
};
export const monthName = (key, month = 'long') => new Date(`${key}-01T12:00:00`).toLocaleDateString(undefined, { month, year: 'numeric' });

export function groupOf(a) {
  if (a.match === 'visual') return { key: 'visual', title: `Looks like “${state.q}”`, meta: 'Matched by what’s in the photo' };
  if (state.like) {
    return {
      key: 'like',
      title: `Looks like ${state.likeName || 'this asset'}`,
      meta: state.similarMode === 'visual' ? 'Most similar first' : 'By shared tags, shoot and date (visual fingerprints aren’t ready yet)',
    };
  }
  const dateOf = DATE_OF[state.sort];
  // A collection's own order (the default sort there) has no date headings.
  if (!dateOf || (state.collection && !state.sort)) return { key: 'all' };
  const month = (dateOf(a) || '').slice(0, 7);
  const n = state.months?.[month || 'undated'];
  return {
    key: month || 'undated',
    title: month ? monthName(month) : 'No date',
    meta: n ? `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}` : '',
  };
}

export function appendCards(items) {
  for (const a of items) {
    const g = groupOf(a);
    let section = grid.lastElementChild;
    if (!section || section.dataset.key !== g.key) {
      section = el('section', { class: 'group', 'data-key': g.key }, [
        g.title ? el('div', { class: 'group-head' }, [el('h2', { text: g.title }), g.meta ? el('span', { class: 'gmeta', text: g.meta }) : '']) : '',
        el('div', { class: 'rows' }),
      ]);
      grid.append(section);
    }
    section.querySelector('.rows').append(card(a));
  }
}


export function renderScrubber() {
  const nav = $('scrubber');
  const keys = state.months ? Object.keys(state.months).filter((k) => k !== 'undated').sort() : [];
  if (state.sort !== 'taken-asc') keys.reverse();
  if (keys.length < 3 || state.like) {
    nav.hidden = true;
    return;
  }
  // The 12 most recent months one by one, older ones by year.
  const items = [];
  let year = '';
  keys.forEach((k, i) => {
    const y = k.slice(0, 4);
    if (y !== year) {
      items.push({ key: y, label: y, year: true });
      year = y;
    }
    if (i < 12) items.push({ key: k, label: monthName(k, 'short').replace(/\s*\d{4}$/, '') });
  });
  nav.hidden = false;
  nav.replaceChildren(...items.map((it) => el('button', {
    type: 'button', class: it.year ? 'year' : '', text: it.label,
    'aria-label': it.year ? it.label : monthName(it.key), onclick: () => jumpTo(it.key),
  })));
}

// Scrolls to a month or year, loading further pages until it's there.
export async function jumpTo(prefix) {
  for (let i = 0; i < 40; i++) {
    const section = [...grid.querySelectorAll('.group')].find((g) => g.dataset.key.startsWith(prefix));
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (state.offset >= state.total) return;
    if (state.loading) await new Promise((r) => setTimeout(r, 100));
    else await load();
  }
}


export function renderMeta() {
  if (state.indexing) {
    $('meta').textContent = 'Indexing Google Drive… the first scan after setup can take a minute.';
    return;
  }
  $('meta').textContent = `${state.total.toLocaleString()} asset${state.total === 1 ? '' : 's'}`;
}

// After a restart the server shows its saved index while it re-checks Drive;
// on a first run it has nothing yet. Either way, refresh once the sync is done.
export async function watchSync() {
  let status;
  try {
    status = await api('/api/status');
  } catch {
    return;
  }
  $('storage-warning').hidden = status.storage !== 'memory';
  if (status.similarity?.mode === 'visual') $('q').placeholder = 'Search names, tags, or describe a photo…';
  const waiting = status.syncing && (!status.lastSync || status.restoredFrom);
  state.indexing = status.syncing && !status.lastSync;
  renderMeta();
  if (waiting) {
    state.watchingSync = true;
    setTimeout(watchSync, 3000);
  } else if (state.watchingSync) {
    state.watchingSync = false;
    await loadFolders();
    await reloadInPlace();
  }
}

// A reset (new search or filter) always runs and supersedes any request still
// in flight, whose response is then dropped; loading more waits its turn.
export let loadSeq = 0;

// Grey placeholder tiles in a few shapes while the first page loads.
const SKELETON_SHAPES = [1.5, 0.67, 1.33, 1.78, 1, 0.75, 1.5, 1.2];
function skeleton() {
  return el('div', { class: 'rows skeleton', 'aria-hidden': 'true' },
    Array.from({ length: 18 }, (_, i) => el('div', { class: 'card ghost', style: `--ar: ${SKELETON_SHAPES[i % SKELETON_SHAPES.length]}` })));
}

export async function load(reset = false) {
  if (state.loading && !reset) return;
  if (!reset && state.offset >= state.total && state.offset > 0) return;
  const seq = ++loadSeq;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.items.clear();
    grid.replaceChildren(skeleton());
    $('meta').textContent = 'Loading…';
    writeUrl();
    renderChips();
    renderFolderCards();
    renderCollectionCards();
  }
  try {
    const data = await api(`/api/assets?${queryParams({ offset: state.offset, limit: PAGE })}`);
    if (seq !== loadSeq) return;
    state.total = data.total;
    state.offset += data.items.length;
    state.months = data.months;
    state.similarMode = data.similarMode || '';
    for (const a of data.items) state.items.set(a.id, a);
    grid.querySelector('.skeleton')?.remove();
    appendCards(data.items);
    state.facets = data.facets;
    state.fileFacets = data.fileFacets || {};
    state.fileOrder = data.fileOrder || {};
    renderMeta();
    renderFacets();
    if (reset) renderScrubber();
  } finally {
    if (seq === loadSeq) state.loading = false;
  }
}

// Re-fetches everything loaded so far and redraws it in place, keeping the scroll position.
export async function reloadInPlace() {
  const limit = Math.min(Math.max(state.offset, PAGE), 500);
  const data = await api(`/api/assets?${queryParams({ offset: 0, limit })}`);
  state.total = data.total;
  state.offset = data.items.length;
  state.items = new Map(data.items.map((a) => [a.id, a]));
  state.facets = data.facets;
  state.fileFacets = data.fileFacets || {};
  state.months = data.months;
  state.similarMode = data.similarMode || '';
  grid.replaceChildren();
  appendCards(data.items);
  renderMeta();
  renderFacets();
  renderScrubber();
}

export async function afterEdit() {
  await Promise.all([loadFields(), loadFolders()]);
  await reloadInPlace();
  if (viewer.open && state.current) {
    const fresh = await api(`/api/assets/${state.current.id}`);
    state.current = fresh;
    renderViewerLabel(fresh);
    renderSuggestions(fresh);
    renderViewerTags(fresh);
    renderRights(fresh);
    renderCurate(fresh);
  }
  renderBulk();
}

