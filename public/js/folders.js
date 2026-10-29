import { $, api, byName, el, plural, state } from './core.js';
import { renderCollectionPanel, renderCollections } from './curation.js';
import { load } from './grid.js';
import { DPR, thumbUrl } from './previews.js';
import { queueSuggestions, refreshAi, suggestionBox } from './suggest.js';
import { applyTo, tagEditor } from './tags.js';
import { displayName, namingDefaults, titleRow } from './titles.js';

// The folder tree, breadcrumbs, the open folder's details panel, and folder/shoot cards.

export async function loadFolders() {
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

export function renderTree() {
  // With text in "Find a folder", only matching folders and the folders above
  // them show, all expanded.
  const term = state.treeFilter || '';
  let visible = null;
  if (term) {
    visible = new Set();
    for (const f of state.folders.values()) {
      if (!`${displayName(f)} ${f.name}`.toLowerCase().includes(term)) continue;
      visible.add(f.id);
      for (const a of f.ancestors) visible.add(a.id);
    }
  }
  const children = new Map();
  for (const f of state.folders.values()) {
    if (visible && !visible.has(f.id)) continue;
    if (!children.has(f.parentId)) children.set(f.parentId, []);
    children.get(f.parentId).push(f);
  }
  const branch = (parentId) => (children.get(parentId) || []).sort(byName).map((f) => {
    const kids = children.get(f.id);
    const open = Boolean(visible) || state.expanded.has(f.id);
    const hasTags = Object.keys(f.tags).length > 0;
    return el('li', {}, [
      el('div', { class: `node${f.id === state.folder ? ' active' : ''}` }, [
        el('button', {
          type: 'button', class: `caret${kids ? '' : ' empty'}`, text: open ? '▼' : '▶',
          'aria-label': open ? 'Collapse' : 'Expand',
          onclick: () => { state.expanded[open ? 'delete' : 'add'](f.id); renderTree(); },
        }),
        el('button', {
          type: 'button', class: 'label', 'aria-current': f.id === state.folder ? 'page' : false,
          title: f.label ? `${f.label.name}\nDrive folder: ${f.path || f.name}` : f.path || f.name, onclick: () => selectFolder(f.id),
        }, [
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
    visible && !visible.size ? el('li', { class: 'empty-note', text: 'No folder matches.' }) : '',
  );
}

export function selectFolder(id) {
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

export function renderCrumbs() {
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
export const folderUi = { addOpen: null, open: false };

try { folderUi.open = localStorage.getItem('rux-dam-folder-details') === 'open'; } catch {}

export function setFolderDetails(open) {
  folderUi.open = open;
  try { localStorage.setItem('rux-dam-folder-details', open ? 'open' : 'closed'); } catch {}
  $('ft-body').hidden = !open;
  $('ft-toggle').setAttribute('aria-expanded', String(open));
}

export function renderFolderPanel({ background = false } = {}) {
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

export const runShootSuggestions = (folder) => async () => {
  await api(`/api/suggest/folder/${encodeURIComponent(folder.id)}/run`, {});
  await loadFolders();
  refreshAi();
};


export function dateSpan(from, to) {
  if (!from) return '';
  const d = (x, opts) => new Date(`${x}T12:00:00`).toLocaleDateString(undefined, opts);
  const a = d(from, { month: 'short', year: 'numeric' });
  const b = d(to, { month: 'short', year: 'numeric' });
  if (a === b) return a;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${d(from, { month: 'short' })} – ${b}`;
  return `${from.slice(0, 4)} – ${to.slice(0, 4)}`;
}

export function folderCard(f, { where } = {}) {
  const covers = [0, 1, 2].map((i) => el('div', {}, f.covers?.[i]
    ? [el('img', { src: thumbUrl(f.covers[i], (i ? 120 : 260) * DPR), alt: '', loading: 'lazy', decoding: 'async' })] : []));
  const meta = [dateSpan(f.from, f.to), f.photos ? plural(f.photos, 'photo') : '', f.videos ? plural(f.videos, 'video') : '']
    .filter(Boolean).join(' · ');
  const tagValues = Object.values(f.tags || {}).flat().slice(0, 3);
  return el('button', { type: 'button', class: 'fcard', title: f.path || f.name, onclick: () => selectFolder(f.id) }, [
    el('div', { class: (f.covers?.length || 0) < 3 ? 'fcover single' : 'fcover' }, [
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
export let folderView = 'date';

try { folderView = localStorage.getItem('rux-dam-folder-view') || 'date'; } catch {}

export function renderFolderCards() {
  const box = $('folder-cards');
  const filtering = state.q || state.like || state.color || state.kind || state.rights || state.suggested || state.range ||
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
