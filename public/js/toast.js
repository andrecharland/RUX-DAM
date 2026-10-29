import { $, el } from './core.js';

// Short confirmations at the bottom of the screen, optionally with Undo.
// One at a time: a new message replaces the last.

let timer = null;

export function toast(message, { undo, ms = 6000 } = {}) {
  const box = $('toast');
  clearTimeout(timer);
  const hide = () => { box.hidden = true; };
  box.replaceChildren(
    el('span', { text: message }),
    undo ? el('button', { type: 'button', class: 'link', text: 'Undo', onclick: async () => {
      hide();
      try {
        await undo();
        toast('Undone.', { ms: 2500 });
      } catch (err) {
        toast(`Couldn't undo: ${err.message}`);
      }
    } }) : '',
    el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', text: '×', onclick: hide }),
  );
  // Shown inside an open dialog (the viewer is modal, so anything outside it is
  // covered), otherwise on the page.
  const host = document.querySelector('dialog[open]') || document.body;
  if (box.parentElement !== host) host.append(box);
  box.hidden = false;
  timer = setTimeout(hide, ms);
}

// Runs `ids` through `apply(ids, value)` once per distinct previous value, to
// put each item back the way it was (e.g. ratings that differed per photo).
export async function restoreEach(previous, apply) {
  const groups = new Map();
  for (const [id, value] of previous) groups.set(value, [...(groups.get(value) || []), id]);
  for (const [value, ids] of groups) await apply(ids, value);
}
