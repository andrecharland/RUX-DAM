import { $, FACET_LIMIT, el, fieldLabel, state } from './core.js';
import { load } from './grid.js';

// Search box, filter sidebar (tags and file details) and the active-filter chips.

export function rangeLabel() {
  if (state.range !== 'custom') return $('date-range').selectedOptions[0]?.text || state.range;
  return `${state.from || '…'} – ${state.to || '…'}`;
}

export function clearAllFilters() {
  state.q = state.like = state.likeName = state.kind = state.rights = state.suggested = state.rating = '';
  state.range = state.from = state.to = '';
  state.tags.clear();
  state.file.clear();
  for (const id of ['q', 'kind', 'rights', 'suggested', 'date-range', 'rating']) $(id).value = '';
  $('date-custom').hidden = true;
}

export function renderChips() {
  // How many Filter & sort choices are active, on the button in the top bar.
  const active = [state.kind, state.rights, state.suggested].filter(Boolean).length;
  $('filter-count').hidden = !active;
  $('filter-count').textContent = active;
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


// One filter group: checkboxes with counts. `selected` holds "key:value"
// strings; values selected but absent from the current results still show.
// `order` is a fixed display order, 'desc' sorts values descending (years),
// otherwise the most common values come first.
export function facetGroup({ key, label, counts, selected, order, onToggle }) {
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
  const rows = values.map(([value, count], i) => {
    const id = `${key}:${value}`;
    return el('label', { hidden: !open && i >= FACET_LIMIT && !selected.has(id), 'data-value': value.toLowerCase() }, [
      el('input', { type: 'checkbox', checked: selected.has(id), onchange: (e) => onToggle(id, e.target.checked) }),
      el('span', { text: value }),
      el('span', { class: 'count', text: count }),
    ]);
  });
  const more = values.length > FACET_LIMIT ? el('button', {
    type: 'button', class: 'link more',
    text: open ? 'Show less' : `Show ${values.length - FACET_LIMIT} more`,
    onclick: () => { state.facetsOpen[open ? 'delete' : 'add'](key); renderFacets(); },
  }) : '';
  // Long lists get a box that narrows them as you type (in place, so typing
  // isn't interrupted).
  const find = values.length > 12 ? el('input', {
    type: 'search', class: 'side-filter', placeholder: `Find ${label.toLowerCase()}…`, 'aria-label': `Find ${label}`,
    oninput: (e) => {
      const term = e.target.value.trim().toLowerCase();
      rows.forEach((row, i) => {
        row.hidden = term ? !row.dataset.value.includes(term) : !open && i >= FACET_LIMIT && !row.querySelector('input').checked;
      });
      if (more) more.hidden = Boolean(term);
    },
  }) : '';
  return el('div', { class: 'facet' }, [el('h3', { text: label }), find, ...rows, more]);
}

export const FILE_FACETS = [
  { key: 'ready', label: 'Ready for' },
  { key: 'year', label: 'Year taken', order: 'desc' },
  { key: 'format', label: 'File type' },
  { key: 'orientation', label: 'Orientation' },
  { key: 'resolution', label: 'Resolution' },
  { key: 'size', label: 'File size' },
  { key: 'duration', label: 'Video length' },
  { key: 'camera', label: 'Camera' },
];

export function renderFacets() {
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


// Searches once typing pauses, or right away on Enter.
export let debounce;

export function search() {
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
