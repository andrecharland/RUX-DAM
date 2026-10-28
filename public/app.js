'use strict';

const PAGE = 120;
const FACET_LIMIT = 8;
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const viewer = $('viewer');
const state = {
  q: '', kind: '', rights: '', folder: '', tags: new Set(),
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const fieldLabel = (key) => state.fields.find((f) => f.key === key)?.label || key;

function queryParams(extra = {}) {
  const params = new URLSearchParams({ q: state.q, kind: state.kind, rights: state.rights, folder: state.folder });
  for (const t of state.tags) params.append('tag', t);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params;
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
        el('button', { type: 'button', class: 'label', title: f.path || f.name, onclick: () => selectFolder(f.id) }, [
          el('span', { text: f.name }),
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
      parts.push(el('button', { type: 'button', text: a.name, onclick: () => selectFolder(a.id) }));
    }
  }
  $('crumbs').replaceChildren(...parts);
}

function renderFolderPanel() {
  const folder = state.folders.get(state.folder);
  $('folder-tags').hidden = !folder;
  if (!folder) return;
  $('folder-count').textContent = folder.count.toLocaleString();
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
      el('div', { class: 'name', text: asset.name, title: asset.name }),
      el('div', { class: 'path', text: [asset.collection, asset.path].filter(Boolean).join(' / ') }),
      values.length ? el('div', { class: 'chips-line', text: values.join(' · '), title: values.join(', ') }) : '',
    ]),
  ]);
}

function renderMeta() {
  $('meta').textContent = `${state.total.toLocaleString()} asset${state.total === 1 ? '' : 's'}`;
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
  try {
    const data = await api(`/api/assets?${queryParams({ offset: state.offset, limit: PAGE })}`);
    state.total = data.total;
    state.offset += data.items.length;
    for (const a of data.items) {
      state.items.set(a.id, a);
      grid.append(card(a));
    }
    state.facets = data.facets;
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
    renderViewerTags(fresh);
    renderRights(fresh);
  }
  renderBulk();
}

// ---------- filters ----------

function renderFacets() {
  const groups = [];
  for (const f of state.fields) {
    const counts = { ...state.facets[f.key] };
    for (const t of state.tags) {
      const [key, ...rest] = t.split(':');
      if (key === f.key && !(rest.join(':') in counts)) counts[rest.join(':')] = 0;
    }
    const values = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!values.length) continue;
    const open = state.facetsOpen.has(f.key);
    const shown = open ? values : values.slice(0, FACET_LIMIT);
    groups.push(el('div', { class: 'facet' }, [
      el('h3', { text: f.label }),
      ...shown.map(([value, count]) => {
        const id = `${f.key}:${value}`;
        return el('label', {}, [
          el('input', {
            type: 'checkbox', checked: state.tags.has(id),
            onchange: (e) => { state.tags[e.target.checked ? 'add' : 'delete'](id); load(true); },
          }),
          el('span', { text: value }),
          el('span', { class: 'count', text: count }),
        ]);
      }),
      values.length > FACET_LIMIT ? el('button', {
        type: 'button', class: 'link more',
        text: open ? 'Show less' : `Show ${values.length - FACET_LIMIT} more`,
        onclick: () => { state.facetsOpen[open ? 'delete' : 'add'](f.key); renderFacets(); },
      }) : '',
    ]));
  }
  $('facets').replaceChildren(...(groups.length ? groups
    : [el('p', { class: 'empty-note', text: 'No tags here yet. Tag a folder above, open an asset, or select several to tag them together.' })]));
  $('clear-filters').hidden = !state.tags.size;
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
  $('stage').replaceChildren(asset.kind === 'video'
    ? el('video', { src: fileUrl, controls: true, autoplay: true, playsinline: true })
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
  renderViewerTags(asset);
  renderRights(asset);
  viewer.showModal();
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
viewer.addEventListener('close', () => $('stage').replaceChildren());
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
$('clear-filters').addEventListener('click', () => { state.tags.clear(); load(true); });
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

(async () => {
  await Promise.all([loadFields(), loadFolders()]);
  await load(true);
})();
