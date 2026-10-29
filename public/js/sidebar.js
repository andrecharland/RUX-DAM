import { $, state } from './core.js';
import { renderTree } from './folders.js';

// Sidebar sections fold away (remembered per browser), and the folder tree can
// be narrowed by typing.

const KEY = 'rux-dam-side-closed';
let closed = new Set();
try { closed = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { /* storage unavailable */ }

function setSection(section, open) {
  section.classList.toggle('closed', !open);
  section.querySelector('.sec-toggle').setAttribute('aria-expanded', String(open));
}

for (const section of document.querySelectorAll('.side-sec')) {
  const name = section.dataset.sec;
  setSection(section, !closed.has(name));
  section.querySelector('.sec-toggle').addEventListener('click', () => {
    const open = section.classList.contains('closed');
    setSection(section, open);
    closed[open ? 'delete' : 'add'](name);
    try { localStorage.setItem(KEY, JSON.stringify([...closed])); } catch { /* storage unavailable */ }
  });
}

$('tree-filter').addEventListener('input', (e) => {
  state.treeFilter = e.target.value.trim().toLowerCase();
  renderTree();
});
