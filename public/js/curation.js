import { $, api, copyText, el, plural, state, viewer } from './core.js';
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

export function selectCollection(id, fav = false) {
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
    ]));
    return;
  }
  if (!c) return;
  const updated = new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const edit = async (change) => {
    await api(`/api/collections/${encodeURIComponent(c.id)}`, change);
    await loadCollections();
  };
  box.replaceChildren(
    el('div', { class: 'ft-head' }, [
      el('div', { class: 'col-title' }, [
        el('strong', { text: c.name }),
        el('span', { class: 'ft-summary' }, [
          el('span', { text: plural(c.count, 'item') }),
          c.createdBy ? el('span', { text: `made by ${c.createdBy.split('@')[0]}` }) : '',
          el('span', { text: `updated ${updated}` }),
        ]),
      ]),
      el('div', { class: 'ft-actions' }, [
        el('button', { type: 'button', class: 'btn ghost small', text: 'Rename', onclick: () => {
          const name = prompt('Collection name:', c.name);
          if (name?.trim()) edit({ name });
        } }),
        el('button', { type: 'button', class: 'btn ghost small', text: c.description ? 'Edit description' : 'Add description', onclick: () => {
          const description = prompt('Description (who it is for, what it is for):', c.description || '');
          if (description !== null) edit({ description });
        } }),
        el('button', { type: 'button', class: 'btn ghost small', text: 'Copy link', onclick: (e) => copyText(e.target, location.href) }),
        el('button', { type: 'button', class: 'btn ghost small danger', text: 'Delete', onclick: async () => {
          if (!confirm(`Delete the collection “${c.name}”? The photos and videos themselves aren’t affected.`)) return;
          await api(`/api/collections/${encodeURIComponent(c.id)}`, { delete: true });
          await loadCollections();
          selectFolder('');
        } }),
      ]),
    ]),
    c.description ? el('p', { class: 'col-desc', text: c.description }) : '',
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

export const rate = (ids, rating) => curate('/api/rate', { ids, rating });
export const favorite = (ids, on) => curate('/api/favorite', { ids, on });

// Stars, favorite and collections for the open asset.
export function renderCurate(asset) {
  const rating = asset.rating || 0;
  $('d-stars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', {
    type: 'button', class: n <= rating ? 'on' : '', text: '★', 'aria-pressed': String(n <= rating),
    title: n === rating ? 'Clear rating (0)' : `${plural(n, 'star')} (${n})`,
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
        await curate(`/api/collections/${encodeURIComponent(c.id)}`, box.checked ? { add: collectIds } : { remove: collectIds });
        $('collect-msg').textContent = box.checked ? `Added to “${c.name}”.` : `Removed from “${c.name}”.`;
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

$('bulk-rate').addEventListener('change', async (e) => {
  if (e.target.value === '') return;
  await rate([...state.selected], Number(e.target.value));
  e.target.value = '';
});

$('bulk-fav').addEventListener('click', () => favorite([...state.selected], true));

$('bulk-collect').addEventListener('click', () => openCollect([...state.selected]));

$('bulk-uncollect').addEventListener('click', async () => {
  const ids = [...state.selected];
  await curate(`/api/collections/${encodeURIComponent(state.collection)}`, { remove: ids });
  for (const id of ids) setSelected(id, false);
  await load(true);
  renderBulk();
});

