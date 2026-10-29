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
    sort: state.sort, ...dateRange(),
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
  for (const key of ['q', 'kind', 'rights', 'suggested', 'folder', 'sort', 'range']) if (state[key]) params.set(key, state[key]);
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
  for (const key of ['q', 'kind', 'rights', 'suggested', 'folder', 'sort', 'range', 'from', 'to']) state[key] = params.get(key) || '';
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
function tagEditor({ tags = {}, apply, bulk = false, emptyText = 'No metadata yet.' }) {
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
  const syncList = () => input.setAttribute('list', `dl-${select.value}`);
  select.addEventListener('change', syncList);
  syncList();
  const submit = (op) => {
    const value = input.value.trim();
    if (!value) return input.focus();
    run({ [op]: { [select.value]: [value] } }, () => { input.value = ''; input.focus(); });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit('add'); });
  root.append(el('div', { class: 'add-row' }, [
    select, input,
    el('button', { class: 'btn', type: 'button', text: 'Add', onclick: () => submit('add') }),
    bulk && el('button', { class: 'btn ghost', type: 'button', text: 'Remove', onclick: () => submit('remove') }),
  ].filter(Boolean)), msg);
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
    el('li', {}, [el('div', { class: `node${state.folder ? '' : ' active'}` }, [
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
  const folder = state.folders.get(id);
  if (folder) for (const a of folder.ancestors) state.expanded.add(a.id);
  document.body.classList.remove('side-open');
  renderTree();
  renderCrumbs();
  renderFolderPanel();
  load(true);
}

function renderCrumbs() {
  const folder = state.folders.get(state.folder);
  const parts = [el('button', { type: 'button', text: 'All assets', onclick: () => selectFolder('') })];
  if (folder) {
    for (const a of [...folder.ancestors, folder]) {
      parts.push(el('span', { class: 'sep', text: '›' }));
      parts.push(el('button', { type: 'button', text: displayName(state.folders.get(a.id) || a), onclick: () => selectFolder(a.id) }));
    }
  }
  $('crumbs').replaceChildren(...parts);
}

function renderFolderPanel() {
  const folder = state.folders.get(state.folder);
  $('folder-tags').hidden = !folder;
  if (!folder) return;
  $('folder-count').textContent = folder.count.toLocaleString();
  $('folder-label').replaceChildren(...labelRow(folder, () => openLabelEditor(folder, {
    kind: 'folder', tags: folderTags(folder),
  })));
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
  $('folder-editor').replaceChildren(tagEditor({
    tags, apply: applyTo([folder.id]), emptyText: 'No tags on this folder yet.',
  }));
  // Shoot-level suggestions (one request from a few samples), then per-photo ones.
  const folderAi = $('folder-ai');
  if (folder.suggestions || state.ai.enabled) {
    folderAi.replaceChildren(suggestionBox({
      id: folder.id,
      s: folder.suggestions,
      title: '✨ Shoot tags suggested by Claude',
      runLabel: `Suggest shoot tags from ${Math.min(6, folder.count)} sample photos`,
      run: async () => {
        await api(`/api/suggest/folder/${encodeURIComponent(folder.id)}/run`, {});
        await loadFolders();
        refreshAi();
      },
    }));
  } else {
    folderAi.replaceChildren();
  }
  const suggest = $('folder-suggest');
  suggest.hidden = !state.ai.enabled;
  suggest.textContent = `✨ Suggest tags for each of the ${folder.count.toLocaleString()} photos` +
    (folder.count > (state.ai.batchMin ?? 50) ? ' (batch, half price)' : '');
  suggest.onclick = () => queueSuggestions({ folder: folder.id }, folder.count);
}

// ---------- grid ----------

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
  const restricted = asset.rights.status === 'restricted';
  if (restricted) thumb.append(el('span', { class: 'flag', text: 'Do not use' }));
  const selected = state.selected.has(asset.id);
  const values = Object.values(asset.tags).flat().map((t) => t.value);
  return el('div', {
    class: ['card', restricted && 'restricted', selected && 'selected'].filter(Boolean).join(' '),
    tabindex: 0, role: 'button', 'data-id': asset.id, 'aria-label': asset.name,
  }, [
    el('input', { type: 'checkbox', class: 'pick', 'aria-label': `Select ${asset.name}`, checked: selected }),
    thumb,
    el('div', { class: 'caption' }, [
      el('div', { class: 'name', text: displayName(asset), title: asset.label ? `${asset.label.name}\nDrive file: ${asset.name}` : asset.name }),
      el('div', { class: 'path', text: [asset.collection, asset.path].filter(Boolean).join(' / ') }),
      values.length ? el('div', { class: 'chips-line', text: values.join(' · '), title: values.join(', ') }) : '',
      asset.suggestions?.count ? el('div', {
        class: 'ai-line',
        text: `✨ ${Object.values(asset.suggestions.pending).flat().join(' · ')}`,
        title: 'Suggested by Claude, not yet accepted',
      }) : '',
    ]),
  ]);
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

async function load(reset = false) {
  if (state.loading) return;
  if (!reset && state.offset >= state.total && state.offset > 0) return;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.items.clear();
    grid.replaceChildren();
    writeUrl();
  }
  try {
    const data = await api(`/api/assets?${queryParams({ offset: state.offset, limit: PAGE })}`);
    state.total = data.total;
    state.offset += data.items.length;
    for (const a of data.items) {
      state.items.set(a.id, a);
      grid.append(card(a));
    }
    state.facets = data.facets;
    state.fileFacets = data.fileFacets || {};
    state.fileOrder = data.fileOrder || {};
    renderMeta();
    renderFacets();
  } finally {
    state.loading = false;
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
  grid.replaceChildren(...data.items.map(card));
  renderMeta();
  renderFacets();
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
    bar.hidden = false;
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
  renderFolderPanel();
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

function renderSuggestions(asset) {
  const box = $('d-suggest');
  if (!asset.suggestions && !state.ai.enabled) return box.replaceChildren();
  box.replaceChildren(suggestionBox({
    id: asset.id,
    s: asset.suggestions,
    run: async () => {
      const fresh = await api(`/api/suggest/${asset.id}/run`, {});
      state.current = fresh;
      state.items.set(fresh.id, fresh);
      grid.querySelector(`[data-id="${CSS.escape(fresh.id)}"]`)?.replaceWith(card(fresh));
      renderSuggestions(fresh);
      refreshAi();
    },
  }));
}

// ---------- labels (RUX naming convention) ----------

const displayName = (item) => item.label?.name || item.name;

// Effective tags of a folder: inherited from enclosing folders, then its own.
function folderTags(folder) {
  const tags = {};
  for (const f of [...folder.ancestors.map((a) => state.folders.get(a.id)), folder]) {
    for (const [key, values] of Object.entries(f?.tags || {})) {
      for (const value of values) (tags[key] ||= []).push({ value });
    }
  }
  return tags;
}

// The label line under a name: the label (or "No label") and an edit button.
// `showName: false` when the label is already the heading above it.
function labelRow(item, onEdit, { showName = true } = {}) {
  return item.label
    ? [
      showName ? el('code', { text: item.label.name, title: 'Label' }) : '',
      el('button', { type: 'button', class: 'link', text: 'Edit label', onclick: onEdit }),
      el('span', { class: 'drive-name', text: `Drive name: ${item.name}` }),
    ]
    : [
      el('span', { class: 'hint', text: 'No label' }),
      el('button', { type: 'button', class: 'link', text: 'Add label', onclick: onEdit }),
    ];
}

function renderViewerLabel(asset) {
  $('d-name').textContent = displayName(asset);
  $('d-label').replaceChildren(...labelRow(asset, () => openLabelEditor(asset, {
    kind: 'file', tags: asset.tags, width: asset.width, height: asset.height, date: asset.takenTime || asset.createdTime,
  }), { showName: false }));
}

const LABEL_INPUTS = ['product', 'concept', 'format', 'aspect', 'creator', 'date', 'version'];
const labelEdit = { item: null };

// Starting values: the current label; else the Drive name if it already follows
// the convention; else the item's tags, its pixel aspect and its date.
function labelDefaults(item, { tags = {}, width, height, date } = {}) {
  if (item.label) return { ...item.label.parts };
  const parsed = RuxNaming.parse(item.name);
  const fromVocab = (key, written, toToken) => state.fields.find((f) => f.key === key)?.values
    .find((v) => toToken(v) === written) || written;
  if (parsed) {
    return {
      ...parsed,
      product: fromVocab('product', parsed.product, RuxNaming.productToken),
      concept: fromVocab('concept', parsed.concept, RuxNaming.token),
      format: fromVocab('format', parsed.format, RuxNaming.token),
      creator: fromVocab('creator', parsed.creator, RuxNaming.token),
    };
  }
  const first = (key) => tags[key]?.[0]?.value || '';
  return {
    product: first('product'),
    concept: first('concept'),
    format: first('format'),
    aspect: first('aspect') || RuxNaming.aspectOf(width, height),
    creator: first('creator'),
    date: (date || new Date().toISOString()).slice(0, 10),
    version: 1,
  };
}

function updateLabelPreview() {
  const parts = Object.fromEntries(LABEL_INPUTS.map((k) => [k, $(`lb-${k}`).value]));
  const { name, errors } = RuxNaming.compose(parts);
  $('lb-preview').textContent = name || 'RUX_…';
  $('lb-msg').textContent = name ? '' : Object.values(errors)[0];
  $('lb-save').disabled = !name;
  return parts;
}

function openLabelEditor(item, context) {
  labelEdit.item = item;
  const values = labelDefaults(item, context);
  for (const k of LABEL_INPUTS) $(`lb-${k}`).value = values[k] ?? '';
  $('lb-for').textContent = `${context.kind === 'folder' ? 'Folder' : 'File'} in Drive: ${item.name}. ` +
    'The label is shown in place of the Drive name and nothing in Drive changes. Its parts are added as tags' +
    (context.kind === 'folder' ? ', so everything in the folder gets them.' : '.');
  $('lb-remove').hidden = !item.label;
  updateLabelPreview();
  $('label-dialog').showModal();
}

for (const k of LABEL_INPUTS) $(`lb-${k}`).addEventListener('input', updateLabelPreview);
for (const id of ['lb-close', 'lb-cancel']) $(id).addEventListener('click', () => $('label-dialog').close());
// Save label is the form's submit button, so Enter in any field saves too.
$('lb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('lb-save').disabled) return;
  try {
    await api(`/api/labels/${encodeURIComponent(labelEdit.item.id)}`, { parts: updateLabelPreview() });
    $('label-dialog').close();
    await afterEdit();
  } catch (err) {
    $('lb-msg').textContent = err.message;
  }
});
$('lb-remove').addEventListener('click', async () => {
  try {
    await api(`/api/labels/${encodeURIComponent(labelEdit.item.id)}`, { remove: true });
    $('label-dialog').close();
    await afterEdit();
  } catch (err) {
    $('lb-msg').textContent = err.message;
  }
});

// ---------- viewer ----------

function renderViewerTags(asset) {
  $('d-tags').replaceChildren(tagEditor({
    tags: asset.tags,
    apply: applyTo([asset.id]),
    emptyText: 'No metadata yet. Dashed tags come from the folder.',
  }));
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
  $('stage').replaceChildren(asset.kind === 'video'
    ? el('video', { src: fileUrl, controls: true, autoplay: true, playsinline: true, poster: preview })
    : image);
  renderViewerLabel(asset);
  const rows = [
    ['Format', `${asset.format || ''} (${asset.mimeType})`.replace(/^ \(/, '(')],
    ['Size', formatBytes(asset.size)],
    ['Dimensions', asset.width ? `${asset.width} × ${asset.height}` : '—'],
    ...(asset.kind === 'video' ? [['Duration', formatDuration(asset.durationMs) || '—']] : []),
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
  viewer.showModal();
  writeUrl();
}

// ---------- events ----------

grid.addEventListener('click', (e) => {
  const target = e.target.closest('.card');
  if (!target) return;
  const id = target.dataset.id;
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

let debounce;
$('q').addEventListener('input', (e) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => { state.q = e.target.value; load(true); }, 200);
});
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
  await Promise.all([loadFields(), loadFolders(), refreshAi()]);
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
