import { $, api, copyText, el, grid, state, viewer } from './core.js';
import { favorite, loadCollections, rate } from './curation.js';
import { clearAllFilters, renderChips } from './filters.js';
import { folderUi, loadFolders, selectFolder, setFolderDetails } from './folders.js';
import { load, watchSync } from './grid.js';
import { tileUrl } from './previews.js';
import { pick, renderBulk, setSelected } from './selection.js';
import { accept, queueSuggestions, refreshAi } from './suggest.js';
import { loadFields } from './tags.js';
import { displayName } from './titles.js';
import { readUrl, writeUrl } from './url.js';
import { open, saveRights, setZoom, showVideo, step } from './viewer.js';

// Wires up events and starts the app.

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
  // When tiles get bigger, swap in larger previews where they're now needed.
  const sizeOf = (url) => Number(new URL(url, location.href).searchParams.get('size')) || 0;
  $('size').addEventListener('change', () => {
    for (const img of grid.querySelectorAll('.card img')) {
      const asset = state.items.get(img.closest('.card').dataset.id);
      const url = asset && tileUrl(asset);
      if (url && sizeOf(url) > sizeOf(img.src)) img.src = url;
    }
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

$('toggle-side').addEventListener('click', (e) => {
  e.stopPropagation();
  document.body.classList.toggle('side-open');
});

document.addEventListener('click', (e) => {
  if (document.body.classList.contains('side-open') && !e.target.closest('#side')) {
    document.body.classList.remove('side-open');
  }
});

$('sync').addEventListener('click', async () => {
  const button = $('sync');
  const label = button.querySelector('span');
  button.disabled = true;
  label.textContent = 'Syncing…';
  try {
    await api('/api/sync', {});
    await Promise.all([loadFields(), loadFolders()]);
    await load(true);
    label.textContent = 'Up to date';
  } catch (err) {
    label.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// Starts loading the next page about two screens before the end.
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.offset < state.total) load();
}, { rootMargin: '200% 0px' }).observe($('sentinel'));

export async function showUser() {
  const user = await api('/api/me').catch(() => null);
  if (!user) return;
  $('avatar').textContent = (user.name || user.email).trim()[0].toUpperCase();
  $('user').hidden = false;
  $('user').replaceChildren(el('strong', { text: user.name || user.email }), el('span', { text: user.email }));
  $('sign-out').hidden = false;
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

$('p-direct').addEventListener('click', () => state.current && showVideo(state.current, 'direct'));

$('p-drive').addEventListener('click', () => state.current && showVideo(state.current, 'drive'));

// Pop-up menus (Filter & sort, account, the folder's Suggest menu) close on a
// click elsewhere or Escape, and only one is open at a time.
const menus = () => document.querySelectorAll('details.menu[open]');
document.addEventListener('click', (e) => {
  for (const menu of menus()) if (!menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const menu of menus()) menu.open = false;
});

// A thumbnail that fails (Drive busy or a link expiring) is retried once after a
// moment; if it fails again the tile shows a plain placeholder, not a broken image.
document.addEventListener('error', (e) => {
  const img = e.target;
  // The viewer's large image has its own fallback (the original file).
  if (!(img instanceof HTMLImageElement) || !img.src.includes('/thumbnail') || img.closest('#stage')) return;
  if (!img.dataset.retried) {
    img.dataset.retried = '1';
    setTimeout(() => { img.src = `${img.src}${img.src.includes('?') ? '&' : '?'}retry=1`; }, 1500 + Math.random() * 1500);
  } else {
    img.classList.add('failed');
    img.alt = 'Preview unavailable';
  }
}, true);
