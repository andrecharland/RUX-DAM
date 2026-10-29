import { $, api, copyText, downloadZip, el, grid, plural, state, viewer } from './core.js';
import { DPR, thumbUrl } from './previews.js';
import { clearAllFilters } from './filters.js';
import { restoreEach, toast } from './toast.js';
import { renderCrumbs, renderFolderPanel, renderTree, selectFolder } from './folders.js';
import { load, reloadInPlace } from './grid.js';
import { renderBulk, setSelected } from './selection.js';

// Team ratings, personal favorites and collections.

export async function loadCollections() {
  try {
    const data = await api('/api/collections');
    state.collections = data.collections;
    state.favCount = data.favorites.count;
  } catch {
    state.collections = [];
  }
  renderCollections();
  renderCollectionPanel();
  renderCollectionCards();
  renderCrumbs();
}

// Sidebar: My favorites, then the team's collections, most recently changed first.
export function renderCollections() {
  const item = (active, text, count, onclick, title) => el('li', {}, [el('div', { class: `node${active ? ' active' : ''}` }, [
    el('span', { class: 'caret empty' }),
    el('button', { type: 'button', class: 'label', title: title || text, onclick }, [
      el('span', { text }), el('span', { class: 'count', text: count.toLocaleString() }),
    ]),
  ])]);
  $('collections').replaceChildren(
    item(state.fav, '♥ My favorites', state.favCount, () => selectCollection('', true), 'Only you see your favorites'),
    ...state.collections.map((c) => item(state.collection === c.id, c.name, c.count, () => selectCollection(c.id),
      c.description || c.name)),
  );
}

// Opening a collection (or My favorites) starts from all of it: any search or
// filter from before is cleared, so nothing in it is unexpectedly hidden.
export function selectCollection(id, fav = false) {
  clearAllFilters();
  state.folder = '';
  state.collection = id;
  state.fav = fav ? '1' : '';
  state.showAllFolders = false;
  document.body.classList.remove('side-open');
  renderTree();
  renderCollections();
  renderCrumbs();
  renderFolderPanel();
  renderCollectionPanel();
  load(true);
}

// The header above an open collection (or My favorites).
export function renderCollectionPanel() {
  const box = $('collection-panel');
  const c = state.collections.find((x) => x.id === state.collection);
  box.hidden = !c && !state.fav;
  if (state.fav) {
    box.replaceChildren(el('div', { class: 'ft-head' }, [
      el('div', {}, [el('strong', { text: '♥ My favorites' }), el('p', { class: 'hint', text: 'Only you see your favorites. Press F in the viewer, or click ♥ on a photo.' })]),
      el('div', { class: 'ft-actions' }, [
        state.favCount ? el('button', { type: 'button', class: 'btn ghost small', text: 'Download all', onclick: () => downloadAll('My favorites') }) : '',
      ]),
    ]));
    return;
  }
  if (!c) return;
  const updated = new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const url = `/api/collections/${encodeURIComponent(c.id)}`;
  // Name and description are edited in place: saved on Enter or when leaving
  // the field; Escape puts the old text back.
  const field = (tag, key, attrs) => {
    const input = el(tag, { ...attrs, value: c[key] || '' });
    if (tag === 'textarea') input.value = c[key] || '';
    const save = async () => {
      const value = input.value.trim();
      if (value === (c[key] || '') || (key === 'name' && !value)) {
        input.value = c[key] || '';
        return;
      }
      await api(url, { [key]: value });
      toast(key === 'name' ? `Renamed to “${value}”` : 'Description saved');
      await loadCollections();
      renderCrumbs();
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = c[key] || '';
        input.blur();
      } else if (e.key === 'Enter' && (tag === 'input' || !e.shiftKey)) {
        e.preventDefault();
        input.blur();
      }
    });
    return input;
  };
  box.replaceChildren(
    el('div', { class: 'ft-head' }, [
      el('div', { class: 'col-title' }, [
        field('input', 'name', { class: 'col-name', 'aria-label': 'Collection name', maxlength: 80 }),
        el('span', { class: 'ft-summary' }, [
          el('span', { text: plural(c.count, 'item') }),
          c.createdBy ? el('span', { text: `made by ${c.createdBy.split('@')[0]}` }) : '',
          el('span', { text: `updated ${updated}` }),
        ]),
      ]),
      el('div', { class: 'ft-actions' }, [
        c.count ? el('button', { type: 'button', class: 'btn ghost small', text: 'Download all', onclick: () => downloadZip(c.items, c.name) }) : '',
        el('button', { type: 'button', class: 'btn ghost small', text: 'Copy link', onclick: (e) => copyText(e.target, `${location.origin}/?collection=${encodeURIComponent(c.id)}`) }),
        el('button', { type: 'button', class: 'btn ghost small danger', text: 'Delete', onclick: async () => {
          if (!confirm(`Delete the collection “${c.name}”? The photos and videos themselves aren’t affected.`)) return;
          await api(url, { delete: true });
          await loadCollections();
          selectFolder('');
          toast(`Deleted “${c.name}”`);
        } }),
      ]),
    ]),
    field('textarea', 'description', {
      class: 'col-desc', rows: 1, maxlength: 500, 'aria-label': 'Description',
      placeholder: 'Add a description: who it’s for, what it’s for…',
    }),
    el('p', { class: 'hint col-hint', text: canReorder() ? 'Drag photos to change the order.' : '' }),
  );
}

// Every item of the open view (favorites), for "Download all".
async function downloadAll(name) {
  const ids = [];
  for (let total = Infinity; ids.length < total;) {
    const data = await api(`/api/assets?fav=1&limit=500&offset=${ids.length}`);
    total = data.total;
    if (!data.items.length) break;
    ids.push(...data.items.map((a) => a.id));
  }
  downloadZip(ids, name);
}

// Collections show in their own order, which can be changed by dragging, as
// long as no other sort or filter is reordering or hiding items.
export function canReorder() {
  return Boolean(state.collection) && !state.sort && !state.q && !state.kind && !state.rights && !state.suggested &&
    !state.range && !state.rating && !state.tags.size && !state.file.size;
}

let dragged = null;
grid.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.card');
  if (!card || !canReorder()) return;
  dragged = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.id);
});
grid.addEventListener('dragover', (e) => {
  const target = e.target.closest?.('.card');
  if (!dragged || !target || target === dragged) return;
  e.preventDefault();
  // Drop before the tile when over its left half, after it when over the right.
  const box = target.getBoundingClientRect();
  const after = e.clientX > box.left + box.width / 2;
  target.parentElement.insertBefore(dragged, after ? target.nextSibling : target);
});
grid.addEventListener('dragend', async () => {
  if (!dragged) return;
  dragged.classList.remove('dragging');
  dragged = null;
  const c = state.collections.find((x) => x.id === state.collection);
  const before = c?.items || [];
  const order = [...grid.querySelectorAll('.card:not(.ghost)')].map((x) => x.dataset.id);
  if (order.join() === before.slice(0, order.length).join()) return;
  const url = `/api/collections/${encodeURIComponent(state.collection)}`;
  await api(url, { order });
  await loadCollections();
  toast('Order saved', {
    undo: async () => {
      await api(url, { order: before });
      await Promise.all([load(true), loadCollections()]);
    },
  });
});

// Collection cards on the home page: the most recently changed, with covers.
export function renderCollectionCards() {
  const box = $('collection-cards');
  const home = !state.folder && !state.collection && !state.fav && !state.like && !state.q && !state.kind && !state.rights &&
    !state.suggested && !state.range && !state.rating && !state.tags.size && !state.file.size;
  const list = state.collections.filter((c) => c.count).slice(0, 8);
  box.hidden = !home || !list.length;
  if (box.hidden) return box.replaceChildren();
  box.replaceChildren(
    el('div', { class: 'fhead' }, [el('h2', { text: 'Collections' })]),
    el('div', { class: 'fcards' }, list.map((c) => {
      const covers = [0, 1, 2].map((i) => el('div', {}, c.covers?.[i]
        ? [el('img', { src: thumbUrl(c.covers[i], (i ? 120 : 260) * DPR), alt: '', loading: 'lazy', decoding: 'async' })] : []));
      return el('button', { type: 'button', class: 'fcard', title: c.description || c.name, onclick: () => selectCollection(c.id) }, [
        el('div', { class: (c.covers?.length || 0) < 3 ? 'fcover single' : 'fcover' }, [...covers, el('span', { class: 'count', text: c.count.toLocaleString() })]),
        el('div', { class: 'fbody' }, [
          el('strong', { text: c.name }),
          el('span', { class: 'fmeta', text: c.description || `updated ${new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` }),
        ]),
      ]);
    })),
  );
}

// Applies a curation change, then refreshes what shows it: the grid, the
// sidebar counts and the open asset.
export async function curate(url, body) {
  await api(url, body);
  await Promise.all([reloadInPlace(), loadCollections()]);
  if (viewer.open && state.current) {
    const fresh = state.items.get(state.current.id) || await api(`/api/assets/${state.current.id}`);
    state.current = fresh;
    renderCurate(fresh);
  }
  renderBulk();
}

const known = (id) => state.items.get(id) || (state.current?.id === id ? state.current : null);
const count = (ids, word = 'photo') => (ids.length === 1 ? `1 ${word}` : plural(ids.length, word));

// Ratings and favorites can be undone from the confirmation, each item back
// to what it had before.
export async function rate(ids, rating, { quiet = false } = {}) {
  const before = ids.map((id) => [id, known(id)?.rating || 0]);
  await curate('/api/rate', { ids, rating });
  if (quiet) return;
  toast(rating ? `Rated ${count(ids)} ${'★'.repeat(rating)}` : `Cleared the rating on ${count(ids)}`, {
    undo: () => restoreEach(before, (group, value) => rate(group, value, { quiet: true })),
  });
}

export async function favorite(ids, on, { quiet = false } = {}) {
  const before = ids.map((id) => [id, Boolean(known(id)?.favorite)]);
  await curate('/api/favorite', { ids, on });
  if (quiet) return;
  toast(on ? `Added ${count(ids)} to your favorites` : `Removed ${count(ids)} from your favorites`, {
    undo: () => restoreEach(before, (group, value) => favorite(group, value, { quiet: true })),
  });
}

// Stars, favorite and collections for the open asset.
export function renderCurate(asset) {
  const rating = asset.rating || 0;
  $('d-stars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', {
    type: 'button', class: n <= rating ? 'on' : '', text: '★', 'aria-pressed': String(n <= rating),
    title: n === rating ? 'Clear rating (0)' : `${plural(n, 'star')} (${n})`,
    'aria-label': n === rating ? `Rated ${plural(n, 'star')}; clear rating` : `Rate ${plural(n, 'star')}`,
    onclick: () => rate([asset.id], n === rating ? 0 : n),
  })));
  const fav = $('d-fav');
  fav.classList.toggle('on', Boolean(asset.favorite));
  fav.setAttribute('aria-pressed', String(Boolean(asset.favorite)));
  fav.onclick = () => favorite([asset.id], !asset.favorite);
  $('d-collect').onclick = () => openCollect([asset.id]);
  const inside = state.collections.filter((c) => c.items.includes(asset.id));
  $('d-in').replaceChildren(...(inside.length ? [
    el('span', { class: 'hint', text: 'In' }),
    ...inside.map((c) => el('button', { type: 'button', class: 'chip', text: c.name, onclick: () => { viewer.close(); selectCollection(c.id); } })),
  ] : []));
}

// "Add to collection": ticks reflect whether all (or some) of `ids` are in each
// collection; ticking adds, unticking removes, right away.
export let collectIds = [];

export function openCollect(ids) {
  collectIds = ids;
  $('collect-title').textContent = ids.length === 1 ? 'Add to collection' : `Add ${ids.length} items to a collection`;
  $('collect-msg').textContent = '';
  $('collect-name').value = '';
  renderCollectList();
  $('collect-dialog').showModal();
  $('collect-name').focus();
}

export function renderCollectList() {
  $('collect-list').replaceChildren(...(state.collections.length ? state.collections.map((c) => {
    const n = collectIds.filter((id) => c.items.includes(id)).length;
    const box = el('input', { type: 'checkbox', checked: n === collectIds.length });
    box.indeterminate = n > 0 && n < collectIds.length;
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        const ids = collectIds;
        const was = ids.filter((id) => c.items.includes(id));
        const url = `/api/collections/${encodeURIComponent(c.id)}`;
        await curate(url, box.checked ? { add: ids } : { remove: ids });
        $('collect-msg').textContent = box.checked ? `Added to “${c.name}”.` : `Removed from “${c.name}”.`;
        toast(box.checked ? `Added ${count(ids)} to “${c.name}”` : `Removed ${count(ids)} from “${c.name}”`, {
          undo: () => curate(url, box.checked ? { remove: ids.filter((id) => !was.includes(id)) } : { add: was }),
        });
      } catch (err) {
        $('collect-msg').textContent = err.message;
      }
      renderCollectList();
    });
    return el('label', { class: 'collect-item' }, [box, el('span', { text: c.name }), el('span', { class: 'count', text: c.count.toLocaleString() })]);
  }) : [el('p', { class: 'hint', text: 'No collections yet. Name one below to start.' })]));
}

$('collect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('collect-name').value.trim();
  if (!name) return $('collect-name').focus();
  try {
    await curate('/api/collections', { name, ids: collectIds });
    $('collect-name').value = '';
    $('collect-msg').textContent = collectIds.length ? `Created “${name}”.` : `Created “${name}”. Select photos and use Add to collection to fill it.`;
    renderCollectList();
  } catch (err) {
    $('collect-msg').textContent = err.message;
  }
});

$('collect-close').addEventListener('click', () => $('collect-dialog').close());

$('new-collection').addEventListener('click', () => openCollect([...state.selected]));

$('rating').addEventListener('change', (e) => { state.rating = e.target.value; load(true); });

// The selection bar's Rate menu: five stars, and Clear rating.
$('bulk-stars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', {
  type: 'button', text: '★', title: plural(n, 'star'), 'aria-label': plural(n, 'star'),
  onclick: () => {
    $('bulk-rate-menu').open = false;
    rate([...state.selected], n);
  },
})));
$('bulk-unrate').addEventListener('click', () => {
  $('bulk-rate-menu').open = false;
  rate([...state.selected], 0);
});

$('bulk-fav').addEventListener('click', () => favorite([...state.selected], true));

$('bulk-collect').addEventListener('click', () => openCollect([...state.selected]));

$('bulk-uncollect').addEventListener('click', async () => {
  const ids = [...state.selected];
  const c = state.collections.find((x) => x.id === state.collection);
  const url = `/api/collections/${encodeURIComponent(state.collection)}`;
  await curate(url, { remove: ids });
  for (const id of ids) setSelected(id, false);
  await load(true);
  renderBulk();
  // Undo puts them back where they were in the collection's order (the server
  // adds them, then applies the old order, in one step).
  toast(`Removed ${count(ids)} from “${c?.name || 'the collection'}”`, {
    undo: async () => {
      await api(url, { add: ids, order: c?.items || [] });
      await Promise.all([load(true), loadCollections()]);
    },
  });
});

