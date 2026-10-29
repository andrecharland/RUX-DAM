'use strict';

const PAGE = 120;
const FACET_LIMIT = 8;
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const viewer = $('viewer');
const state = {
  q: '', kind: '', rights: '', folder: '', tags: new Set(), suggested: '',
  file: new Set(), range: '', from: '', to: '', sort: '', fileFacets: {}, fileOrder: {},
  ai: { enabled: false }, aiWasBusy: false,
  offset: 0, total: 0, loading: false, items: new Map(), facets: {},
  current: null, selected: new Set(), lastPicked: null,
  fields: [], folders: new Map(), expanded: new Set(), facetsOpen: new Set(),
  like: '', likeName: '', similarMode: '', months: null, zoom: 0, showAllFolders: false,
  rating: '', fav: '', collection: '', collections: [], favCount: 0,
};

// ---------- helpers ----------

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
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

async function api(url, body) {
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

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const fieldLabel = (key) => state.fields.find((f) => f.key === key)?.label || key;

// The date filter as from/to (YYYY-MM-DD). Presets are relative to today, so a
// shared "Last 30 days" link stays relative.
function dateRange() {
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

function queryParams(extra = {}) {
  const params = new URLSearchParams({
    q: state.q, kind: state.kind, rights: state.rights, folder: state.folder, suggested: state.suggested,
    sort: state.sort, like: state.like, rating: state.rating, fav: state.fav, collection: state.collection, ...dateRange(),
  });
  for (const t of state.tags) params.append('tag', t);
  for (const f of state.file) params.append('f', f);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params;
}

// ---------- shareable links ----------

// The page URL mirrors the current view (search, filters, folder, open asset),
// so copying it shares exactly what's on screen.
function writeUrl() {
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
function readUrl() {
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

async function copyText(button, text) {
  const label = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = 'Copied!';
  setTimeout(() => { button.textContent = label; }, 1500);
}

// ---------- fields & tag editor ----------

async function loadFields() {
  state.fields = await api('/api/fields');
  // One <datalist> per field powers value autocomplete in every editor.
  for (const f of state.fields) {
    let list = document.getElementById(`dl-${f.key}`);
    if (!list) document.body.append(list = el('datalist', { id: `dl-${f.key}` }));
    list.replaceChildren(...f.values.map((v) => el('option', { value: v })));
  }
}

// Builds a metadata editor. `tags` is { field: [{ value, from }] }; values whose
// `from.scope` is 'folder' are inherited and shown read-only. `apply({ add, remove })`
// performs the change. With `bulk`, only the add/remove row is shown.
// `collapsible`: the add row can be shown with root.openAdd() and hidden with its
// Done button (calling root.onclose); `collapsed` starts it hidden.
function tagEditor({ tags = {}, apply, bulk = false, emptyText = 'No metadata yet.', collapsible = false, collapsed = false }) {
  const root = el('div', { class: 'editor' });
  const msg = el('p', { class: 'msg', role: 'status' });

  const run = async (change, done) => {
    msg.textContent = 'Saving…';
    try {
      await apply(change);
      msg.textContent = '';
      done?.();
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  if (!bulk) {
    const rows = state.fields.filter((f) => tags[f.key]?.length).map((f) => el('div', { class: 'field-row' }, [
      el('span', { text: f.label }),
      el('div', { class: 'chips' }, tags[f.key].map(({ value, from }) => (from.scope === 'folder'
        ? el('span', { class: 'chip inherited', title: `From folder “${from.name}”`, text: value })
        : el('span', { class: 'chip' }, [
          value,
          el('button', {
            type: 'button', title: 'Remove', 'aria-label': `Remove ${value}`, text: '×',
            onclick: () => run({ remove: { [f.key]: [value] } }),
          }),
        ])))),
    ]));
    root.append(...(rows.length ? rows : [el('p', { class: 'empty-note', text: emptyText })]));
  }

  const select = el('select', { 'aria-label': 'Field' }, state.fields.map((f) => el('option', { value: f.key, text: f.label })));
  const input = el('input', { type: 'text', placeholder: 'Value…', 'aria-label': 'Value', maxlength: 80 });
  const syncList = () => {
    input.setAttribute('list', `dl-${select.value}`);
    input.type = { shoot_date: 'date', version: 'number' }[select.value] || 'text';
    if (input.type === 'number') Object.assign(input, { min: 1, max: 999, step: 1 });
  };
  select.addEventListener('change', syncList);
  syncList();
  const submit = (op) => {
    const value = input.value.trim();
    if (!value) return input.focus();
    run({ [op]: { [select.value]: [value] } }, () => { input.value = ''; input.focus(); });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit('add'); });
  const addRow = el('div', { class: 'add-row', hidden: collapsed }, [
    select, input,
    el('button', { class: 'btn', type: 'button', text: 'Add', onclick: () => submit('add') }),
    bulk && el('button', { class: 'btn ghost', type: 'button', text: 'Remove', onclick: () => submit('remove') }),
    collapsible && el('button', { class: 'btn ghost', type: 'button', text: 'Done', onclick: () => { addRow.hidden = true; root.onclose?.(); } }),
  ].filter(Boolean));
  root.append(addRow, msg);
  root.openAdd = () => { addRow.hidden = false; select.focus(); };
  return root;
}

const applyTo = (ids) => async (change) => {
  await api('/api/tags', { ids, ...change });
  await afterEdit();
};

// ---------- folders ----------

async function loadFolders() {
  const list = await api('/api/folders');
  state.folders = new Map(list.map((f) => [f.id, f]));
  if (!state.expanded.size) for (const f of list) if (!f.parentId) state.expanded.add(f.id);
  if (state.folder && !state.folders.has(state.folder)) state.folder = '';
  for (const a of state.folders.get(state.folder)?.ancestors || []) state.expanded.add(a.id);
  renderTree();
  renderCrumbs();
  renderFolderPanel();
  renderFolderCards();
}

function renderTree() {
  const children = new Map();
  for (const f of state.folders.values()) {
    if (!children.has(f.parentId)) children.set(f.parentId, []);
    children.get(f.parentId).push(f);
  }
  const branch = (parentId) => (children.get(parentId) || []).sort(byName).map((f) => {
    const kids = children.get(f.id);
    const open = state.expanded.has(f.id);
    const hasTags = Object.keys(f.tags).length > 0;
    return el('li', {}, [
      el('div', { class: `node${f.id === state.folder ? ' active' : ''}` }, [
        el('button', {
          type: 'button', class: `caret${kids ? '' : ' empty'}`, text: open ? '▼' : '▶',
          'aria-label': open ? 'Collapse' : 'Expand',
          onclick: () => { state.expanded[open ? 'delete' : 'add'](f.id); renderTree(); },
        }),
        el('button', { type: 'button', class: 'label', title: f.label ? `${f.label.name}\nDrive folder: ${f.path || f.name}` : f.path || f.name, onclick: () => selectFolder(f.id) }, [
          el('span', { text: displayName(f) }),
          hasTags && el('span', { class: 'dot', title: 'This folder has tags', text: '●' }),
          el('span', { class: 'count', text: f.count.toLocaleString() }),
        ].filter(Boolean)),
      ]),
      kids && open ? el('ul', {}, branch(f.id)) : '',
    ]);
  });
  const total = [...state.folders.values()].filter((f) => !f.parentId).reduce((n, f) => n + f.count, 0);
  $('tree').replaceChildren(
    el('li', {}, [el('div', { class: `node${state.folder || state.collection || state.fav ? '' : ' active'}` }, [
      el('span', { class: 'caret empty' }),
      el('button', { type: 'button', class: 'label', onclick: () => selectFolder('') }, [
        el('span', { text: 'All assets' }), el('span', { class: 'count', text: total.toLocaleString() }),
      ]),
    ])]),
    ...branch(null),
  );
}

function selectFolder(id) {
  state.folder = id;
  state.collection = state.fav = '';
  const folder = state.folders.get(id);
  if (folder) for (const a of folder.ancestors) state.expanded.add(a.id);
  document.body.classList.remove('side-open');
  renderTree();
  renderCollections();
  renderCrumbs();
  renderFolderPanel();
  renderCollectionPanel();
  load(true);
}

function renderCrumbs() {
  const folder = state.folders.get(state.folder);
  const parts = [el('button', { type: 'button', text: 'All assets', onclick: () => selectFolder('') })];
  const crumb = (text) => parts.push(el('span', { class: 'sep', text: '›' }), el('span', { class: 'here', text }));
  if (state.fav) crumb('♥ My favorites');
  if (state.collection) crumb(state.collections.find((c) => c.id === state.collection)?.name || 'Collection');
  if (folder) {
    for (const a of [...folder.ancestors, folder]) {
      parts.push(el('span', { class: 'sep', text: '›' }));
      parts.push(el('button', { type: 'button', text: displayName(state.folders.get(a.id) || a), onclick: () => selectFolder(a.id) }));
    }
  }
  $('crumbs').replaceChildren(...parts);
}

// The open folder: its title, its tags (which apply to everything inside), and
// Claude's shoot suggestions when there are some to review. Adding tags and
// asking Claude live behind the two buttons in the header.
const folderUi = { addOpen: null, open: false };
try { folderUi.open = localStorage.getItem('rux-dam-folder-details') === 'open'; } catch {}

function setFolderDetails(open) {
  folderUi.open = open;
  try { localStorage.setItem('rux-dam-folder-details', open ? 'open' : 'closed'); } catch {}
  $('ft-body').hidden = !open;
  $('ft-toggle').setAttribute('aria-expanded', String(open));
}

function renderFolderPanel({ background = false } = {}) {
  const folder = state.folders.get(state.folder);
  $('folder-tags').hidden = !folder;
  if (!folder) return;
  const n = folder.count.toLocaleString();
  setFolderDetails(folderUi.open);
  const ownTags = Object.values(folder.tags || {}).flat().length;
  const toReview = folder.suggestions?.count || 0;
  $('ft-summary').replaceChildren(...[
    folder.label ? folder.label.title : '',
    ownTags ? `${ownTags} tag${ownTags === 1 ? '' : 's'}` : 'no tags',
  ].filter(Boolean).map((t) => el('span', { text: t })),
  toReview ? el('span', { class: 'ai-note', text: `✨ ${toReview} to review` }) : '');
  $('folder-label').replaceChildren(...titleRow(folder, () => namingDefaults(folder, {
    media: folder.videos > folder.photos ? 'Video' : 'Photo', date: folder.direct?.date || folder.from,
  }), { showTitle: false }));
  // Background refreshes (AI progress) don't redraw the editor under someone typing in it.
  const editorBox = $('folder-editor');
  const typing = editorBox.contains(document.activeElement);
  if (!(background && typing)) {
    // Effective tags: inherited from enclosing folders, then this folder's own.
    const tags = {};
    const add = (own, from) => {
      for (const [key, values] of Object.entries(own || {})) {
        for (const value of values) {
          const list = (tags[key] ||= []);
          const hit = list.find((t) => t.value.toLowerCase() === value.toLowerCase());
          if (hit) hit.from = from; else list.push({ value, from });
        }
      }
    };
    for (const a of folder.ancestors) add(state.folders.get(a.id)?.tags, { scope: 'folder', id: a.id, name: a.name });
    add(folder.tags, { scope: 'file' });
    const editor = tagEditor({
      tags, apply: applyTo([folder.id]), collapsible: true, collapsed: folderUi.addOpen !== folder.id,
      emptyText: `No folder tags yet. Tags added here apply to all ${n} assets inside.`,
    });
    editor.onclose = () => { folderUi.addOpen = null; };
    editorBox.replaceChildren(editor);
    if (typing && folderUi.addOpen === folder.id) editor.querySelector('.add-row input').focus();
  }
  $('folder-add-tag').title = `Tags on this folder apply to all ${n} assets inside it`;
  $('folder-add-tag').onclick = () => {
    setFolderDetails(true);
    folderUi.addOpen = folder.id;
    editorBox.firstElementChild?.openAdd();
  };

  // Shoot-level suggestions to review (one request from a few samples).
  const folderAi = $('folder-ai');
  if (folder.suggestions) {
    folderAi.replaceChildren(suggestionBox({
      id: folder.id,
      s: folder.suggestions,
      title: '✨ Shoot tags suggested by Claude',
      run: runShootSuggestions(folder),
    }));
  } else {
    folderAi.replaceChildren();
  }

  const menu = $('folder-suggest-menu');
  menu.hidden = !state.ai.enabled;
  $('folder-suggest-shoot-note').textContent = `Claude looks at ${Math.min(6, folder.count)} sample photos`;
  $('folder-suggest-shoot').onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    $('folder-suggest-shoot-note').textContent = 'Asking Claude…';
    try {
      await runShootSuggestions(folder)();
      menu.open = false;
      setFolderDetails(true);
    } catch (err) {
      $('folder-suggest-shoot-note').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };
  $('folder-suggest-note').textContent = `${n} photos` +
    (folder.count > (state.ai.batchMin ?? 50) ? ' · batch, half price' : '');
  $('folder-suggest').onclick = () => {
    menu.open = false;
    queueSuggestions({ folder: folder.id }, folder.count);
  };
}

const runShootSuggestions = (folder) => async () => {
  await api(`/api/suggest/folder/${encodeURIComponent(folder.id)}/run`, {});
  await loadFolders();
  refreshAi();
};

// ---------- grid ----------

// One tile: its width follows the photo's shape (--ar), its height the size slider.
function card(asset) {
  const ar = asset.width && asset.height ? Math.min(Math.max(asset.width / asset.height, 0.4), 3) : 1;
  const restricted = asset.rights.status === 'restricted';
  const selected = state.selected.has(asset.id);
  const values = Object.values(asset.tags).flat().map((t) => t.value);
  const creator = creatorOf(asset);
  const where = [asset.collection, asset.path].filter(Boolean).join(' / ');
  return el('div', {
    class: ['card', restricted && 'restricted', selected && 'selected'].filter(Boolean).join(' '),
    tabindex: 0, role: 'button', 'data-id': asset.id, 'aria-label': displayName(asset), style: `--ar: ${ar.toFixed(3)}`,
  }, [
    el('input', { type: 'checkbox', class: 'pick', 'aria-label': `Select ${displayName(asset)}`, checked: selected }),
    asset.hasThumbnail
      ? el('img', { src: `/api/assets/${asset.id}/thumbnail?size=600`, loading: 'lazy', alt: '' })
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
const DATE_OF = {
  '': (a) => a.modifiedTime,
  added: (a) => a.createdTime,
  taken: (a) => a.takenTime || a.createdTime || a.modifiedTime,
  'taken-asc': (a) => a.takenTime || a.createdTime || a.modifiedTime,
};
const monthName = (key, month = 'long') => new Date(`${key}-01T12:00:00`).toLocaleDateString(undefined, { month, year: 'numeric' });

function groupOf(a) {
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

function appendCards(items) {
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

// ---------- active filter chips ----------

function rangeLabel() {
  if (state.range !== 'custom') return $('date-range').selectedOptions[0]?.text || state.range;
  return `${state.from || '…'} – ${state.to || '…'}`;
}

function clearAllFilters() {
  state.q = state.like = state.likeName = state.kind = state.rights = state.suggested = state.rating = '';
  state.range = state.from = state.to = '';
  state.tags.clear();
  state.file.clear();
  for (const id of ['q', 'kind', 'rights', 'suggested', 'date-range', 'rating']) $(id).value = '';
  $('date-custom').hidden = true;
}

function renderChips() {
  const chips = [];
  const add = (key, value, remove) => chips.push(el('span', { class: 'fchip' }, [
    el('span', { class: 'k', text: `${key}:` }),
    el('span', { class: 'v', text: value, title: value }),
    el('button', { type: 'button', 'aria-label': `Remove ${key} ${value}`, text: '×', onclick: () => { remove(); load(true); } }),
  ]));
  if (state.q) add('Search', `“${state.q}”`, () => { state.q = ''; $('q').value = ''; });
  if (state.like) add('Looks like', state.likeName || 'asset', () => { state.like = state.likeName = ''; });
  if (state.kind) add('Type', state.kind === 'video' ? 'Videos' : 'Images', () => { state.kind = ''; $('kind').value = ''; });
  if (state.rights) add('Rights', state.rights === 'cleared' ? 'Cleared to use' : 'Do not use', () => { state.rights = ''; $('rights').value = ''; });
  if (state.suggested) add('Claude', 'Suggestions to review', () => { state.suggested = ''; $('suggested').value = ''; });
  if (state.rating) add('Rating', `${'★'.repeat(state.rating)}${state.rating < 5 ? ' and up' : ''}`, () => { state.rating = ''; $('rating').value = ''; });
  if (state.range) {
    add('Taken', rangeLabel(), () => {
      state.range = state.from = state.to = '';
      $('date-range').value = '';
      $('date-custom').hidden = true;
    });
  }
  const split = (id) => [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  for (const t of state.tags) {
    const [k, v] = split(t);
    add(fieldLabel(k), v, () => state.tags.delete(t));
  }
  for (const f of state.file) {
    const [k, v] = split(f);
    add(FILE_FACETS.find((x) => x.key === k)?.label || k, v, () => state.file.delete(f));
  }
  if (chips.length > 1) {
    chips.push(el('button', { type: 'button', class: 'link', text: 'Clear all', onclick: () => { clearAllFilters(); load(true); } }));
  }
  $('chips').replaceChildren(...chips);
}

// ---------- jump to date ----------

function renderScrubber() {
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
async function jumpTo(prefix) {
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

// ---------- folder and shoot cards ----------

function dateSpan(from, to) {
  if (!from) return '';
  const d = (x, opts) => new Date(`${x}T12:00:00`).toLocaleDateString(undefined, opts);
  const a = d(from, { month: 'short', year: 'numeric' });
  const b = d(to, { month: 'short', year: 'numeric' });
  if (a === b) return a;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${d(from, { month: 'short' })} – ${b}`;
  return `${from.slice(0, 4)} – ${to.slice(0, 4)}`;
}

function folderCard(f, { where } = {}) {
  const covers = [0, 1, 2].map((i) => el('div', {}, f.covers?.[i]
    ? [el('img', { src: `/api/assets/${f.covers[i]}/thumbnail?size=${i ? 300 : 600}`, alt: '', loading: 'lazy' })] : []));
  const meta = [dateSpan(f.from, f.to), f.photos ? plural(f.photos, 'photo') : '', f.videos ? plural(f.videos, 'video') : '']
    .filter(Boolean).join(' · ');
  const tagValues = Object.values(f.tags || {}).flat().slice(0, 3);
  return el('button', { type: 'button', class: 'fcard', title: f.path || f.name, onclick: () => selectFolder(f.id) }, [
    el('div', { class: 'fcover' }, [
      ...covers,
      f.restricted ? el('span', { class: 'flag', text: 'Do not use' }) : '',
      el('span', { class: 'count', text: f.count.toLocaleString() }),
    ]),
    el('div', { class: 'fbody' }, [
      el('strong', { text: displayName(f) }),
      where ? el('span', { class: 'fpath', text: where }) : '',
      meta ? el('span', { class: 'fmeta', text: meta }) : '',
      tagValues.length ? el('div', { class: 'ftags' }, tagValues.map((v) => el('span', { text: v }))) : '',
      f.suggestions?.count ? el('span', { class: 'fmeta', style: 'color: var(--ai)', text: `✨ ${f.suggestions.count} shoot tags to review` }) : '',
    ]),
  ]);
}

// Folder cards, hidden while searching or filtering. "By date": every folder
// that holds files, at any depth under the open folder, ordered by when its
// files were taken (median, so a few stray old files don't move it), newest
// first, with its own files' counts. "By folder": the open folder's subfolders.
let folderView = 'date';
try { folderView = localStorage.getItem('rux-dam-folder-view') || 'date'; } catch {}

function renderFolderCards() {
  const box = $('folder-cards');
  const filtering = state.q || state.like || state.kind || state.rights || state.suggested || state.range ||
    state.tags.size || state.file.size || state.rating || state.fav || state.collection;
  const folders = [...state.folders.values()];
  // With a single indexed root folder (e.g. Photo/Video), start from its subfolders.
  const roots = folders.filter((f) => !f.parentId);
  const parentId = state.folder || (roots.length === 1 ? roots[0].id : null);
  let cards;
  if (folderView === 'date') {
    const inside = (f) => f.id !== state.folder && (!state.folder || f.ancestors.some((a) => a.id === state.folder));
    cards = folders.filter((f) => f.direct?.count > 0 && inside(f))
      .sort((a, b) => (b.direct.date || '').localeCompare(a.direct.date || '') || byName(a, b))
      .map((f) => {
        const parent = f.parentId && state.folders.get(f.parentId);
        const where = parent && parent.parentId && parent.id !== state.folder ? `in ${displayName(parent)}` : '';
        return [{ ...f, ...f.direct }, { where }];
      });
  } else {
    cards = folders.filter((f) => f.parentId === parentId && f.count > 0)
      .sort((a, b) => (b.to || '').localeCompare(a.to || '') || byName(a, b))
      .map((f) => [f, {}]);
  }
  if (filtering || !cards.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const scope = parentId ? displayName(state.folders.get(parentId)) : '';
  const title = folderView === 'date' ? (state.folder ? `Shoots in ${scope}, newest first` : 'Shoots, newest first')
    : (parentId ? `Folders in ${scope}` : 'Folders');
  const toggle = el('div', { class: 'zoom fview', role: 'group', 'aria-label': 'Folder view' },
    [['date', 'By date'], ['tree', 'By folder']].map(([v, text]) => el('button', {
      type: 'button', text, 'aria-pressed': String(folderView === v),
      onclick: () => {
        folderView = v;
        try { localStorage.setItem('rux-dam-folder-view', v); } catch {}
        renderFolderCards();
      },
    })));
  const shown = state.showAllFolders ? cards : cards.slice(0, 12);
  box.hidden = false;
  box.replaceChildren(
    el('div', { class: 'fhead' }, [el('h2', { text: title }), toggle]),
    el('div', { class: 'fcards' }, shown.map(([f, opts]) => folderCard(f, opts))),
    cards.length > 12 ? el('button', {
      type: 'button', class: 'link more', text: state.showAllFolders ? 'Show fewer' : `Show all ${cards.length}`,
      onclick: () => { state.showAllFolders = !state.showAllFolders; renderFolderCards(); },
    }) : '',
  );
}

function renderMeta() {
  if (state.indexing) {
    $('meta').textContent = 'Indexing Google Drive… the first scan after setup can take a minute.';
    return;
  }
  $('meta').textContent = `${state.total.toLocaleString()} asset${state.total === 1 ? '' : 's'}`;
}

// After a restart the server shows its saved index while it re-checks Drive;
// on a first run it has nothing yet. Either way, refresh once the sync is done.
async function watchSync() {
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
let loadSeq = 0;
async function load(reset = false) {
  if (state.loading && !reset) return;
  if (!reset && state.offset >= state.total && state.offset > 0) return;
  const seq = ++loadSeq;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.items.clear();
    grid.replaceChildren();
    writeUrl();
    renderChips();
    renderFolderCards();
  }
  try {
    const data = await api(`/api/assets?${queryParams({ offset: state.offset, limit: PAGE })}`);
    if (seq !== loadSeq) return;
    state.total = data.total;
    state.offset += data.items.length;
    state.months = data.months;
    state.similarMode = data.similarMode || '';
    for (const a of data.items) state.items.set(a.id, a);
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
async function reloadInPlace() {
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

async function afterEdit() {
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

// ---------- filters ----------

// One filter group: checkboxes with counts. `selected` holds "key:value"
// strings; values selected but absent from the current results still show.
// `order` is a fixed display order, 'desc' sorts values descending (years),
// otherwise the most common values come first.
function facetGroup({ key, label, counts, selected, order, onToggle }) {
  counts = { ...counts };
  for (const id of selected) {
    const i = id.indexOf(':');
    if (id.slice(0, i) === key && !(id.slice(i + 1) in counts)) counts[id.slice(i + 1)] = 0;
  }
  let values = Object.entries(counts);
  if (!values.length) return null;
  if (Array.isArray(order)) values.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  else if (order === 'desc') values.sort((a, b) => b[0].localeCompare(a[0]));
  else values.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const open = state.facetsOpen.has(key);
  const shown = open ? values : values.slice(0, FACET_LIMIT);
  return el('div', { class: 'facet' }, [
    el('h3', { text: label }),
    ...shown.map(([value, count]) => {
      const id = `${key}:${value}`;
      return el('label', {}, [
        el('input', { type: 'checkbox', checked: selected.has(id), onchange: (e) => onToggle(id, e.target.checked) }),
        el('span', { text: value }),
        el('span', { class: 'count', text: count }),
      ]);
    }),
    values.length > FACET_LIMIT ? el('button', {
      type: 'button', class: 'link more',
      text: open ? 'Show less' : `Show ${values.length - FACET_LIMIT} more`,
      onclick: () => { state.facetsOpen[open ? 'delete' : 'add'](key); renderFacets(); },
    }) : '',
  ]);
}

const FILE_FACETS = [
  { key: 'ready', label: 'Ready for' },
  { key: 'year', label: 'Year taken', order: 'desc' },
  { key: 'format', label: 'File type' },
  { key: 'orientation', label: 'Orientation' },
  { key: 'resolution', label: 'Resolution' },
  { key: 'size', label: 'File size' },
  { key: 'duration', label: 'Video length' },
  { key: 'camera', label: 'Camera' },
];

function renderFacets() {
  const toggle = (set) => (id, on) => { set[on ? 'add' : 'delete'](id); load(true); };
  const groups = state.fields.map((f) => facetGroup({
    key: f.key, label: f.label, counts: state.facets[f.key], selected: state.tags, onToggle: toggle(state.tags),
  })).filter(Boolean);
  $('facets').replaceChildren(...(groups.length ? groups
    : [el('p', { class: 'empty-note', text: 'No tags here yet. Tag a folder above, open an asset, or select several to tag them together.' })]));
  $('file-facets').replaceChildren(...FILE_FACETS.map((f) => facetGroup({
    key: f.key, label: f.label, counts: state.fileFacets[f.key], selected: state.file,
    order: state.fileOrder[f.key] || f.order, onToggle: toggle(state.file),
  })).filter(Boolean));
  $('clear-filters').hidden = !state.tags.size && !state.file.size && !state.range;
}

// ---------- selection & bulk editing ----------

function setSelected(id, on) {
  state.selected[on ? 'add' : 'delete'](id);
  const node = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) {
    node.classList.toggle('selected', on);
    node.querySelector('.pick').checked = on;
  }
}

function renderBulk() {
  const n = state.selected.size;
  document.body.classList.toggle('selecting', n > 0);
  $('bulk').hidden = !n;
  if (!n) return;
  $('bulk-count').textContent = `${n} selected`;
  $('bulk-ai').hidden = !state.ai.enabled;
  $('bulk-uncollect').hidden = !state.collection;
  $('bulk-editor').replaceChildren(tagEditor({ bulk: true, apply: applyTo([...state.selected]) }));
}

function pick(id, shift) {
  const on = !state.selected.has(id);
  if (shift && state.lastPicked) {
    const ids = [...grid.querySelectorAll('.card')].map((c) => c.dataset.id);
    const [a, b] = [ids.indexOf(state.lastPicked), ids.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) for (const i of ids.slice(a, b + 1)) setSelected(i, true);
    else setSelected(id, on);
  } else {
    setSelected(id, on);
  }
  state.lastPicked = id;
  renderBulk();
}

// ---------- suggestions from Claude ----------

async function refreshAi() {
  clearTimeout(refreshAi.timer);
  try {
    state.ai = await api('/api/suggest/status');
  } catch {
    state.ai = { enabled: false };
  }
  const ai = state.ai;
  $('suggested').hidden = !ai.enabled && !state.suggested;
  const active = (ai.queued || 0) + (ai.running || 0) > 0 || Boolean(ai.preparing);
  const batches = ai.batches || [];
  const busy = active || batches.length > 0;
  const bar = $('ai-status');
  const cost = ai.costUsd != null ? ` · ≈ $${ai.costUsd.toFixed(2)} so far` : '';
  const stop = el('button', { type: 'button', class: 'link', text: 'Stop', onclick: async () => {
    if (!confirm('Stop suggesting tags? Photos already done keep their suggestions.')) return;
    await api('/api/suggest/cancel', {});
    refreshAi();
  } });
  if (busy) {
    const lines = [];
    if (ai.preparing) lines.push(`Preparing a batch: ${ai.preparing.done} of ${ai.preparing.total} previews`);
    if ((ai.queued || 0) + (ai.running || 0)) lines.push(`Claude is suggesting tags: ${ai.queued + ai.running} to go`);
    for (const b of batches) {
      const done = (b.succeeded || 0) + (b.errored || 0);
      lines.push(`Batch of ${b.count} photos sent ${new Date(b.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` +
        ` (half price${done ? `, ${done} done` : ''}). Results usually arrive within an hour; you can close this page`);
    }
    bar.hidden = false;
    bar.replaceChildren(el('span', { text: `✨ ${lines.join(' · ')}${cost}` }), stop);
    // Show new results as they come in; batches change slowly, so check them less often.
    if (active && ++refreshAi.ticks % 4 === 0) reloadInPlace();
    refreshAi.timer = setTimeout(refreshAi, active ? 3000 : 30000);
  } else if (state.aiWasBusy) {
    bar.hidden = !(ai.done || ai.failed);
    bar.replaceChildren(
      el('span', { text: `✨ Done: ${ai.done} suggested${ai.failed ? `, ${ai.failed} failed (${ai.lastError})` : ''}${cost}.` }),
      el('button', { type: 'button', class: 'link', text: 'Review suggestions', onclick: () => {
        state.suggested = 'pending';
        $('suggested').value = 'pending';
        $('suggested').hidden = false;
        load(true);
      } }),
      el('button', { type: 'button', class: 'link', text: 'Hide', onclick: () => { bar.hidden = true; } }),
    );
    reloadInPlace();
    loadFolders();
  }
  state.aiWasBusy = busy;
  renderFolderPanel({ background: true });
  renderBulk();
}
refreshAi.ticks = 0;

async function queueSuggestions(body, count) {
  const each = state.ai.estimatePerImage;
  const batch = count > (state.ai.batchMin ?? 50);
  const total = each ? each * count * (batch ? 0.5 : 1) : null;
  const estimate = total != null ? ` Estimated cost: about $${total < 0.01 ? total.toFixed(3) : total.toFixed(2)}.` : '';
  const how = batch
    ? 'More than 50 photos run as a batch at half price. Results usually arrive within an hour (at most 24 hours), and you can close this page meanwhile.'
    : 'They run right away.';
  if (!confirm(`Ask Claude to suggest tags for up to ${count.toLocaleString()} photos?${estimate}\n\n${how}\n\nPhotos that already have suggestions are skipped. You review everything before it becomes a tag.`)) return;
  try {
    const res = await api('/api/suggest', body);
    if (!res.added) alert('Nothing to do: these photos already have suggestions (or have no preview).');
    state.aiWasBusy = state.aiWasBusy || res.added > 0;
  } catch (err) {
    alert(err.message);
  }
  refreshAi();
}

const accept = async (body) => { await api('/api/suggest/accept', body); await afterEdit(); };
const dismiss = async (body) => { await api('/api/suggest/dismiss', body); await afterEdit(); };

// Claude's suggestions for an asset or a folder: accept/dismiss each value,
// accept or dismiss all, or ask (again). `run()` makes the request and redraws.
function suggestionBox({ id, s, run, runLabel = 'Suggest tags', title = '✨ Suggested by Claude' }) {
  const runButton = (label) => el('button', {
    class: 'btn ghost', type: 'button', text: label,
    onclick: async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Asking Claude…';
      try {
        await run();
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = err.message;
      }
    },
  });
  const parts = [el('div', { class: 'suggest-head' }, [el('span', { text: title })])];
  if (!s) {
    parts.push(el('div', { class: 'row-actions' }, [runButton(runLabel)]));
  } else if (s.error) {
    parts.push(el('p', { class: 'err', text: s.error }));
    if (state.ai.enabled) parts.push(el('div', { class: 'row-actions' }, [runButton('Try again')]));
  } else {
    if (s.description) parts.push(el('p', { class: 'desc', text: s.description }));
    const rows = state.fields.filter((f) => s.pending[f.key]?.length).map((f) => el('div', { class: 'field-row' }, [
      el('span', { text: f.label }),
      el('div', { class: 'chips' }, s.pending[f.key].map((value) => el('span', { class: 'chip suggested' }, [
        value,
        el('button', { type: 'button', class: 'ok', title: 'Accept', 'aria-label': `Accept ${value}`, text: '✓',
          onclick: () => accept({ ids: [id], field: f.key, value }) }),
        el('button', { type: 'button', title: 'Dismiss', 'aria-label': `Dismiss ${value}`, text: '×',
          onclick: () => dismiss({ id, field: f.key, value }) }),
      ]))),
    ]));
    parts.push(...(rows.length ? rows : [el('p', { class: 'empty-note', text: 'All suggestions reviewed.' })]));
    parts.push(el('div', { class: 'row-actions' }, [
      s.count ? el('button', { class: 'btn', type: 'button', text: 'Accept all', onclick: () => accept({ ids: [id] }) }) : '',
      s.count ? el('button', { class: 'btn ghost', type: 'button', text: 'Dismiss all', onclick: () => dismiss({ ids: [id] }) }) : '',
      state.ai.enabled ? runButton('Ask again') : '',
    ]));
  }
  return el('div', { class: 'suggest' }, parts);
}

// Claude's suggestions for the open asset take space only while some are left
// to review (or failed); asking (again) is a link beside the Metadata heading.
function renderSuggestions(asset) {
  const box = $('d-suggest');
  const s = asset.suggestions;
  const run = async () => {
    const fresh = await api(`/api/suggest/${asset.id}/run`, {});
    state.current = fresh;
    state.items.set(fresh.id, fresh);
    grid.querySelector(`[data-id="${CSS.escape(fresh.id)}"]`)?.replaceWith(card(fresh));
    renderSuggestions(fresh);
    refreshAi();
  };
  box.replaceChildren(s && (s.count || s.error) ? suggestionBox({ id: asset.id, s, run }) : '');
  const ask = $('d-ask');
  ask.hidden = !state.ai.enabled;
  ask.disabled = false;
  ask.textContent = s ? '✨ Ask Claude again' : '✨ Suggest tags';
  ask.onclick = async () => {
    ask.disabled = true;
    ask.textContent = 'Asking Claude…';
    try {
      await run();
    } catch (err) {
      ask.disabled = false;
      ask.textContent = err.message;
    }
  };
}

// ---------- curation: ratings, favorites, collections ----------

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

async function loadCollections() {
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
function renderCollections() {
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

function selectCollection(id, fav = false) {
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
function renderCollectionPanel() {
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
async function curate(url, body) {
  await api(url, body);
  await Promise.all([reloadInPlace(), loadCollections()]);
  if (viewer.open && state.current) {
    const fresh = state.items.get(state.current.id) || await api(`/api/assets/${state.current.id}`);
    state.current = fresh;
    renderCurate(fresh);
  }
  renderBulk();
}

const rate = (ids, rating) => curate('/api/rate', { ids, rating });
const favorite = (ids, on) => curate('/api/favorite', { ids, on });

// Stars, favorite and collections for the open asset.
function renderCurate(asset) {
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
let collectIds = [];
function openCollect(ids) {
  collectIds = ids;
  $('collect-title').textContent = ids.length === 1 ? 'Add to collection' : `Add ${ids.length} items to a collection`;
  $('collect-msg').textContent = '';
  $('collect-name').value = '';
  renderCollectList();
  $('collect-dialog').showModal();
  $('collect-name').focus();
}

function renderCollectList() {
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

// ---------- titles (RUX naming convention) ----------

// Items with naming fields of their own show a title built from them, e.g.
// "Gear Box 70L · Proof · Video · by Cal · Jun 8, 2026" (the server builds it,
// with the RUX_ name used for downloads); others show their Drive name.
const displayName = (item) => item.label?.title || item.name;
// Creator(s) from the asset's own or inherited Creator tag.
const creatorOf = (asset) => (asset.tags?.creator || []).map((t) => t.value).join(', ');

// Naming fields worked out from what Drive knows: the Drive name when it already
// follows the convention, else Photo/Video, the date and (files) the aspect.
function namingDefaults(item, { media, date, width, height }) {
  const parsed = RuxNaming.parse(item.name);
  const fromVocab = (key, written, toToken) => state.fields.find((f) => f.key === key)?.values
    .find((v) => toToken(v) === written) || written;
  const values = parsed ? {
    product: fromVocab('product', parsed.product, RuxNaming.productToken),
    concept: fromVocab('concept', parsed.concept, RuxNaming.token),
    format: fromVocab('format', parsed.format, RuxNaming.token),
    aspect: parsed.aspect,
    creator: fromVocab('creator', parsed.creator, RuxNaming.token),
    shoot_date: parsed.date,
    version: String(parsed.version),
  } : { format: media, shoot_date: (date || '').slice(0, 10), aspect: RuxNaming.aspectOf(width, height) };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v).map(([k, v]) => [k, [v]]));
}

// The line under a heading: the RUX_ name and Drive name of a titled item, or a
// way to start one.
function titleRow(item, defaults, { showTitle = true } = {}) {
  if (item.label) {
    return [
      showTitle ? el('span', { class: 'label-plain', text: item.label.title }) : '',
      item.label.name ? el('code', { text: item.label.name, title: 'File name in the RUX naming convention' }) : '',
      el('span', { class: 'drive-name', text: `Drive name: ${item.name}` }),
    ];
  }
  return [
    el('span', { class: 'hint', text: 'Add Product, Format, Shoot date… to give this a title and a RUX file name.' }),
    el('button', { type: 'button', class: 'link', text: 'Start from file details', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await applyTo([item.id])({ add: defaults() });
      } catch (err) {
        e.target.textContent = err.message;
      }
    } }),
  ];
}

function renderViewerLabel(asset) {
  $('d-name').textContent = displayName(asset);
  $('d-label').replaceChildren(...titleRow(asset, () => namingDefaults(asset, {
    media: asset.kind === 'video' ? 'Video' : 'Photo', date: asset.takenTime || asset.createdTime,
    width: asset.width, height: asset.height,
  }), { showTitle: false }));
}

// ---------- viewer ----------

// The add row stays open from photo to photo once opened, for tagging a run of them.
const viewerUi = { addOpen: false };

function renderViewerTags(asset) {
  const editor = tagEditor({
    tags: asset.tags,
    apply: applyTo([asset.id]),
    emptyText: 'No metadata yet. Dashed tags come from the folder.',
    collapsible: true,
    collapsed: !viewerUi.addOpen,
  });
  editor.onclose = () => { viewerUi.addOpen = false; };
  $('d-tags').replaceChildren(editor);
  $('d-add-tag').onclick = () => {
    viewerUi.addOpen = true;
    editor.openAdd();
  };
}

function folderLabel(ancestors, i) {
  return ancestors.slice(0, i + 1).map((f) => f.name).join(' / ');
}

function renderRights(asset) {
  const r = asset.rights;
  const where = r.source.scope === 'file' ? 'set on this file'
    : r.source.scope === 'folder' ? `set on folder “${r.source.name}”`
      : 'default, no flag set';
  const current = $('r-current');
  current.className = `r-current ${r.status}`;
  current.textContent = `${r.status === 'restricted' ? '⛔ Do not use' : '✓ Cleared'} (${where})` +
    (r.note ? ` — ${r.note}` : '') +
    (r.updatedAt ? ` · ${new Date(r.updatedAt).toLocaleDateString()}` : '');

  for (const radio of document.getElementsByName('r-status')) radio.checked = radio.value === r.status;
  $('r-note').value = r.note || '';

  // Targets: this file, then each enclosing folder from nearest to the root.
  const target = $('r-target');
  target.replaceChildren(el('option', { value: asset.id, text: 'This file only' }));
  for (let i = asset.ancestors.length - 1; i >= 0; i--) {
    const f = asset.ancestors[i];
    target.append(el('option', { value: f.id, text: `Folder: ${folderLabel(asset.ancestors, i)}` }));
  }
  target.value = r.source.scope === 'folder' ? r.source.id : asset.id;
  // The note shown belongs to whichever item the flag is on; start blank for any other target.
  const flaggedId = r.source.scope === 'default' ? null : target.value;
  target.onchange = () => { $('r-note').value = target.value === flaggedId ? r.note : ''; };
  $('r-msg').textContent = '';
}

async function saveRights(status) {
  const asset = state.current;
  const targetId = $('r-target').value;
  const isFolder = targetId !== asset.id;
  $('r-msg').textContent = 'Saving…';
  try {
    await api(`/api/rights/${encodeURIComponent(targetId)}`, {
      status, note: status === 'inherit' ? '' : $('r-note').value,
    });
  } catch (err) {
    $('r-msg').textContent = `Could not save: ${err.message}`;
    return;
  }
  await afterEdit();
  $('r-msg').textContent = isFolder ? 'Saved for the whole folder.' : 'Saved.';
}

function open(asset) {
  state.current = asset;
  const fileUrl = `/api/assets/${asset.id}/file`;
  // Photos show Drive's large preview (a JPG), which works for formats browsers
  // can't display (HEIC, RAW, TIFF, PSD) and loads faster than the original.
  // If there's no preview, fall back to the original file.
  const preview = asset.hasThumbnail ? `/api/assets/${asset.id}/thumbnail?size=2048` : null;
  const image = el('img', { src: preview || fileUrl, alt: asset.name });
  image.addEventListener('error', () => { if (image.getAttribute('src') !== fileUrl) image.src = fileUrl; });
  const media = asset.kind === 'video'
    ? el('video', { src: fileUrl, controls: true, autoplay: true, playsinline: true, poster: preview })
    : image;
  $('stage').replaceChildren(media);
  renderViewerLabel(asset);
  renderCurate(asset);
  const rows = [
    ['Format', `${asset.format || ''} (${asset.mimeType})`.replace(/^ \(/, '(')],
    ['Size', formatBytes(asset.size)],
    ['Dimensions', asset.width ? `${asset.width} × ${asset.height}` : '—'],
    ...(asset.kind === 'video' ? [['Duration', formatDuration(asset.durationMs) || '—']] : []),
    ['Creator', creatorOf(asset) || '— (add one under Metadata)'],
    ['Folder', [asset.collection, asset.path].filter(Boolean).join(' / ')],
    ...(asset.takenTime ? [['Taken', new Date(asset.takenTime).toLocaleString()]] : []),
    ...(asset.camera ? [['Camera', asset.camera]] : []),
    ['Added', asset.createdTime ? new Date(asset.createdTime).toLocaleString() : '—'],
    ['Modified', new Date(asset.modifiedTime).toLocaleString()],
  ];
  $('d-meta').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('d-download').href = `${fileUrl}?download=1`;
  $('d-drive').href = asset.webViewLink;
  $('d-copy').onclick = () => copyText($('d-copy'), location.href);
  renderSuggestions(asset);
  renderViewerTags(asset);
  renderRights(asset);
  setZoom(0);
  renderNav();
  renderRelated(asset);
  if (!viewer.open) viewer.showModal();
  writeUrl();
}

// ---------- viewer: next/previous, filmstrip, zoom, related ----------

const itemList = () => [...state.items.values()];
const viewerIndex = () => itemList().findIndex((a) => a.id === state.current?.id);

// Moves through the current results, loading the next page at the end.
async function step(delta) {
  let list = itemList();
  const i = viewerIndex();
  if (i < 0) return;
  if (delta > 0 && i + 1 >= list.length && state.offset < state.total) {
    await load();
    list = itemList();
  }
  if (list[i + delta]) open(list[i + delta]);
}

function renderNav() {
  const list = itemList();
  const i = viewerIndex();
  $('v-prev').disabled = i <= 0;
  $('v-next').disabled = i < 0 || (i >= list.length - 1 && state.offset >= state.total);
  $('v-pos').textContent = i >= 0 ? `${(i + 1).toLocaleString()} of ${state.total.toLocaleString()}` : '';
  const near = i >= 0 ? list.slice(Math.max(0, i - 7), i + 8) : [state.current];
  $('filmstrip').replaceChildren(...near.map((a) => {
    const ar = a.width && a.height ? Math.min(Math.max(a.width / a.height, 0.4), 3) : 1;
    return el('button', {
      type: 'button', class: a.id === state.current.id ? 'current' : '', style: `width: ${Math.round(52 * ar)}px`,
      'aria-label': `Show ${displayName(a)}`, 'aria-current': a.id === state.current.id ? 'true' : false,
      onclick: () => open(a),
    }, [a.hasThumbnail ? el('img', { src: `/api/assets/${a.id}/thumbnail?size=200`, alt: '', loading: 'lazy' }) : '']);
  }));
  $('filmstrip').querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Zoom 0 = fit, 1 = 100% of the preview, 2 = 200%. Photos only.
function setZoom(level) {
  const stage = $('stage');
  const img = stage.querySelector('img');
  const photo = state.current?.kind !== 'video' && img;
  if (!photo) level = 0;
  state.zoom = level;
  for (const [id, l] of [['z-fit', 0], ['z-100', 1], ['z-200', 2]]) {
    $(id).setAttribute('aria-pressed', String(level === l));
    $(id).disabled = !photo;
  }
  stage.classList.toggle('zoomed', level > 0);
  if (img) {
    img.style.width = level ? `${img.naturalWidth * level}px` : '';
    if (level) {
      const box = stage.getBoundingClientRect();
      stage.scrollLeft = (img.naturalWidth * level - box.width) / 2;
      stage.scrollTop = (img.naturalHeight * level - box.height) / 2;
    }
  }
}

const relatedThumbs = (list) => (list.length
  ? list.map((a) => el('button', { type: 'button', title: displayName(a), 'aria-label': `Open ${displayName(a)}`, onclick: () => open(a) },
    [a.hasThumbnail ? el('img', { src: `/api/assets/${a.id}/thumbnail?size=300`, alt: '', loading: 'lazy' }) : '']))
  : [el('p', { class: 'empty-note', text: 'Nothing else yet.' })]);

// "More from this shoot" (same folder) and "More like this" (visual or tag similarity).
async function renderRelated(asset) {
  const id = asset.id;
  const parent = asset.ancestors[asset.ancestors.length - 1];
  $('d-shoot').replaceChildren();
  $('d-like').replaceChildren();
  $('d-shoot-all').hidden = !parent;
  const [shoot, like] = await Promise.all([
    parent ? api(`/api/assets?folder=${encodeURIComponent(parent.id)}&limit=7`).catch(() => null) : null,
    api(`/api/similar/${encodeURIComponent(id)}?limit=12`).catch(() => null),
  ]);
  if (state.current?.id !== id) return;
  const shootItems = (shoot?.items || []).filter((a) => a.id !== id).slice(0, 6);
  $('d-shoot').replaceChildren(...relatedThumbs(shootItems));
  if (shoot) $('d-shoot-all').textContent = `See all ${shoot.total.toLocaleString()}`;
  if (like) {
    $('d-like-title').textContent = like.mode === 'visual' ? 'More like this' : 'More like this (by tags)';
    const seen = new Set(shootItems.map((a) => a.id));
    $('d-like').replaceChildren(...relatedThumbs(like.items.filter((a) => !seen.has(a.id)).slice(0, 6)));
  }
}

// ---------- events ----------

grid.addEventListener('click', (e) => {
  const target = e.target.closest('.card');
  if (!target) return;
  const id = target.dataset.id;
  if (e.target.classList.contains('heart')) {
    const asset = state.items.get(id);
    favorite([id], !asset.favorite);
    return;
  }
  // While a selection is active, clicking anywhere on a card adds/removes it.
  if (e.target.classList.contains('pick') || state.selected.size || e.shiftKey) {
    if (!e.target.classList.contains('pick')) e.preventDefault();
    pick(id, e.shiftKey);
  } else {
    open(state.items.get(id));
  }
});
grid.addEventListener('keydown', (e) => {
  const target = e.target.closest('.card');
  if (target && e.target === target && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    target.click();
  }
});
$('select-all').addEventListener('click', () => {
  for (const id of state.items.keys()) setSelected(id, true);
  renderBulk();
});
$('bulk-clear').addEventListener('click', () => {
  for (const id of [...state.selected]) setSelected(id, false);
  renderBulk();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewer.open && state.selected.size) $('bulk-clear').click();
});

$('close').addEventListener('click', () => viewer.close());
$('v-prev').addEventListener('click', () => step(-1));
$('v-next').addEventListener('click', () => step(1));
$('z-fit').addEventListener('click', () => setZoom(0));
$('z-100').addEventListener('click', () => setZoom(1));
$('z-200').addEventListener('click', () => setZoom(2));
viewer.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, video, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'z' || e.key === 'Z') setZoom(state.zoom ? 0 : 1);
  else if (/^[0-5]$/.test(e.key) && state.current) rate([state.current.id], Number(e.key));
  else if ((e.key === 'f' || e.key === 'F') && state.current) favorite([state.current.id], !state.current.favorite);
});
// Zoomed photos pan by dragging; a click without dragging toggles fit / 100%.
{
  const stage = $('stage');
  let drag = null;
  let moved = false;
  stage.addEventListener('pointerdown', (e) => {
    moved = false;
    if (!state.zoom) return;
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  });
  const end = () => { drag = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG' && !moved) setZoom(state.zoom ? 0 : 1);
  });
}
$('d-shoot-all').addEventListener('click', () => {
  const parent = state.current?.ancestors.at(-1);
  if (!parent) return;
  viewer.close();
  clearAllFilters();
  selectFolder(parent.id);
});
$('d-like-all').addEventListener('click', () => {
  const asset = state.current;
  if (!asset) return;
  viewer.close();
  state.like = asset.id;
  state.likeName = displayName(asset);
  load(true);
});
// Thumbnail size (kept per browser).
{
  const KEY = 'rux-dam-row-h';
  let rowH = window.innerWidth < 720 ? 140 : 200;
  try { rowH = Number(localStorage.getItem(KEY)) || rowH; } catch { /* storage unavailable */ }
  const apply = (v) => grid.style.setProperty('--row-h', `${v}px`);
  $('size').value = rowH;
  apply(rowH);
  $('size').addEventListener('input', (e) => {
    apply(e.target.value);
    try { localStorage.setItem(KEY, e.target.value); } catch { /* storage unavailable */ }
  });
}
viewer.addEventListener('close', () => {
  $('stage').replaceChildren();
  writeUrl();
});
$('d-download').addEventListener('click', (e) => {
  const r = state.current?.rights;
  if (r?.status === 'restricted' &&
      !confirm(`This asset is marked Do not use${r.note ? `: ${r.note}` : ''}.\n\nDownload anyway?`)) {
    e.preventDefault();
  }
});
$('r-save').addEventListener('click', () => {
  const checked = document.querySelector('input[name="r-status"]:checked');
  saveRights(checked ? checked.value : 'cleared');
});
$('r-reset').addEventListener('click', () => saveRights('inherit'));

// Searches once typing pauses, or right away on Enter.
let debounce;
function search() {
  clearTimeout(debounce);
  const q = $('q').value.trim();
  if (q === state.q) return;
  state.q = q;
  load(true);
}
$('q').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(search, 400);
});
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
$('kind').addEventListener('change', (e) => { state.kind = e.target.value; load(true); });
$('rights').addEventListener('change', (e) => { state.rights = e.target.value; load(true); });
$('suggested').addEventListener('change', (e) => { state.suggested = e.target.value; load(true); });
$('copy-view').addEventListener('click', (e) => copyText(e.target, location.href));
$('bulk-suggest').addEventListener('click', () => queueSuggestions({ ids: [...state.selected] }, state.selected.size));
$('bulk-accept').addEventListener('click', () => accept({ ids: [...state.selected] }));
$('clear-filters').addEventListener('click', () => {
  state.tags.clear();
  state.file.clear();
  state.range = state.from = state.to = '';
  $('date-range').value = '';
  $('date-custom').hidden = true;
  load(true);
});
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; load(true); });
$('date-range').addEventListener('change', (e) => {
  state.range = e.target.value;
  $('date-custom').hidden = state.range !== 'custom';
  load(true);
});
for (const id of ['date-from', 'date-to']) {
  $(id).addEventListener('change', () => {
    state.from = $('date-from').value;
    state.to = $('date-to').value;
    if (state.range === 'custom') load(true);
  });
}
$('add-field').addEventListener('click', async () => {
  const label = prompt('Name of the new field (for example: Campaign, Photographer, Shoot):');
  if (!label?.trim()) return;
  try {
    await api('/api/fields', { label });
    await loadFields();
    renderFacets();
    renderFolderPanel();
    renderBulk();
  } catch (err) {
    alert(err.message);
  }
});
// ---------- field values (presets) ----------

const vocab = { edits: {}, current: '' };
const lines = (text) => text.split('\n').map((v) => v.trim()).filter(Boolean);

function showVocabField(key) {
  if (vocab.current) vocab.edits[vocab.current] = $('v-values').value;
  vocab.current = key;
  const field = state.fields.find((f) => f.key === key);
  $('v-values').value = vocab.edits[key] ?? field.presets.join('\n');
  $('v-field').value = key;
}

$('edit-values').addEventListener('click', () => {
  vocab.edits = {};
  vocab.current = '';
  $('v-field').replaceChildren(...state.fields.map((f) => el('option', { value: f.key, text: f.label })));
  $('v-msg').textContent = '';
  showVocabField(state.fields.some((f) => f.key === 'product') ? 'product' : state.fields[0].key);
  $('vocab').showModal();
});
$('v-field').addEventListener('change', (e) => showVocabField(e.target.value));
$('v-close').addEventListener('click', () => $('vocab').close());
$('v-cancel').addEventListener('click', () => $('vocab').close());

$('v-csv').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { products, colors, skipped } = ShopifyImport.fromShopifyCsv(await file.text());
    vocab.edits[vocab.current] = $('v-values').value;
    // Merge with what's already listed, keeping existing spellings.
    const merge = (key, values) => {
      const field = state.fields.find((f) => f.key === key);
      if (!field) return 0;
      const current = lines(vocab.edits[key] ?? field.presets.join('\n'));
      const have = new Set(current.map((v) => v.toLowerCase()));
      const added = values.filter((v) => !have.has(v.toLowerCase()));
      vocab.edits[key] = [...current, ...added].join('\n');
      return added.length;
    };
    const p = merge('product', products);
    const c = merge('color', colors);
    vocab.current = '';
    showVocabField('product');
    $('v-msg').textContent = `Found ${products.length} products and ${colors.length} colors (${p} and ${c} new)` +
      `${skipped ? `; skipped ${skipped} draft or archived products` : ''}. Review both lists, then Save.`;
  } catch (err) {
    $('v-msg').textContent = err.message;
  }
});

$('v-save').addEventListener('click', async () => {
  vocab.edits[vocab.current] = $('v-values').value;
  $('v-msg').textContent = 'Saving…';
  try {
    for (const [key, text] of Object.entries(vocab.edits)) {
      const field = state.fields.find((f) => f.key === key);
      if (lines(text).join('\n') === field.presets.join('\n')) continue;
      await api(`/api/fields/${encodeURIComponent(key)}/presets`, { values: lines(text) });
    }
    await loadFields();
    renderFacets();
    renderFolderPanel();
    renderBulk();
    $('vocab').close();
  } catch (err) {
    $('v-msg').textContent = err.message;
  }
});

$('toggle-side').addEventListener('click', (e) => {
  e.stopPropagation();
  document.body.classList.toggle('side-open');
});
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('side-open') && !e.target.closest('#side')) {
    document.body.classList.remove('side-open');
  }
});
$('sync').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Syncing…';
  try {
    await fetch('/api/sync', { method: 'POST' });
    await Promise.all([loadFields(), loadFolders()]);
    await load(true);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Sync';
  }
});

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.offset < state.total) load();
}, { rootMargin: '600px' }).observe($('sentinel'));

async function showUser() {
  const user = await api('/api/me').catch(() => null);
  if (!user) return;
  $('user').hidden = false;
  $('user').replaceChildren(
    el('span', { text: user.email, title: user.name || user.email }),
    el('a', { href: '/auth/logout', text: 'Sign out' }),
  );
}

(async () => {
  showUser();
  const assetId = readUrl();
  if (state.like) {
    api(`/api/assets/${encodeURIComponent(state.like)}`)
      .then((a) => { state.likeName = displayName(a); renderChips(); })
      .catch(() => {});
  }
  await Promise.all([loadFields(), loadFolders(), refreshAi(), loadCollections()]);
  watchSync();
  await load(true);
  if (assetId) {
    try {
      open(await api(`/api/assets/${encodeURIComponent(assetId)}`));
    } catch {
      // The asset is gone or the link is stale: just show the grid.
    }
  }
})();

$('ft-toggle').addEventListener('click', () => setFolderDetails(!folderUi.open));

// Close the folder's Suggest menu on a click elsewhere or Escape.
document.addEventListener('click', (e) => {
  const menu = $('folder-suggest-menu');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('folder-suggest-menu').open = false;
});
