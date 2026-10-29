import { $, el } from './core.js';

// In-app replacements for the browser's confirm() and prompt(): one small
// dialog, styled like the app, that resolves a promise.

// true if confirmed. `body` may be a string or a list of paragraphs.
export function ask({ title, body = [], confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return show({ title, body, confirm, cancel, danger }).then((r) => r !== null);
}

// The text entered, or null if cancelled.
export function askText({ title, body = [], label, value = '', placeholder = '', confirm = 'OK' }) {
  return show({ title, body, confirm, input: { label, value, placeholder } });
}

function show({ title, body, confirm, cancel = 'Cancel', danger = false, input }) {
  const dialog = $('ask');
  const field = input ? el('input', { type: 'text', value: input.value, placeholder: input.placeholder, 'aria-label': input.label, maxlength: 80 }) : null;
  const ok = el('button', { type: 'submit', class: `btn${danger ? ' danger-fill' : ''}`, text: confirm });
  const form = el('form', { method: 'dialog', class: 'vocab-body' }, [
    el('h2', { text: title }),
    ...[].concat(body).filter(Boolean).map((p) => el('p', { class: 'hint', text: p })),
    field ? el('label', { class: 'r-field' }, [input.label, field]) : '',
    el('div', { class: 'row-actions ask-actions' }, [
      el('button', { type: 'button', class: 'btn ghost', text: cancel, onclick: () => dialog.close('') }),
      ok,
    ]),
  ]);
  dialog.replaceChildren(form);
  return new Promise((resolve) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (field && !field.value.trim()) return field.focus();
      dialog.close('ok');
    });
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? (field ? field.value.trim() : true) : null);
      dialog.returnValue = '';
    }, { once: true });
    dialog.showModal();
    (field || ok).focus();
  });
}
