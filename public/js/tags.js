import { $, api, el, state } from './core.js';
import { renderFacets } from './filters.js';
import { renderFolderPanel } from './folders.js';
import { afterEdit } from './grid.js';
import { renderBulk } from './selection.js';

// Metadata fields, the tag editor, and editing field preset values (with CSV import).

export async function loadFields() {
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
export function tagEditor({ tags = {}, apply, bulk = false, emptyText = 'No metadata yet.', collapsible = false, collapsed = false }) {
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
  // Focus goes to the value box (the field list sits just before it).
  root.openAdd = () => { addRow.hidden = false; input.focus(); };
  return root;
}

export const applyTo = (ids) => async (change) => {
  await api('/api/tags', { ids, ...change });
  await afterEdit();
};


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
export const vocab = { edits: {}, current: '' };
export const lines = (text) => text.split('\n').map((v) => v.trim()).filter(Boolean);

export function showVocabField(key) {
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
