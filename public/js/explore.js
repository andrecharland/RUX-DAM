import { $, api, el, state } from './core.js';
import { load } from './grid.js';
import { thumbUrl } from './previews.js';
import { displayName } from './titles.js';

// Ways to explore beyond search: browse by color, and "more like this" as a
// trail (each photo you pick steers the feed, Pinterest-style) that words can
// steer further ("more snow", "less people").

// --- color ---------------------------------------------------------------------

export const SWATCHES = [
  ['Red', '#c0392b'], ['Orange', '#e07b28'], ['Yellow', '#e8c547'], ['Green', '#4a7a3a'],
  ['Olive', '#6f7046'], ['Teal', '#2a8582'], ['Blue', '#2f62b8'], ['Sky', '#9cc0e0'],
  ['Purple', '#74509e'], ['Pink', '#e08aa8'], ['Brown', '#7a5230'], ['Tan', '#c8a97e'],
  ['Black', '#151515'], ['Grey', '#8a8a8a'], ['White', '#f1f1ef'],
];
export const colorName = (hex) => SWATCHES.find(([, h]) => h === hex)?.[0] || hex;

export function setColor(hex) {
  state.color = state.color === hex ? '' : hex;
  renderSwatches();
  load(true);
}

export function renderSwatches() {
  const custom = state.color && !SWATCHES.some(([, h]) => h === state.color);
  $('swatches').replaceChildren(
    ...SWATCHES.map(([name, hex]) => el('button', {
      type: 'button', class: 'swatch', style: `--c: ${hex}`, title: name, 'aria-label': name,
      'aria-pressed': String(state.color === hex), onclick: () => setColor(hex),
    })),
    el('label', { class: `swatch custom${custom ? ' on' : ''}`, title: 'Any color', style: custom ? `--c: ${state.color}` : '' }, [
      el('input', {
        type: 'color', 'aria-label': 'Pick any color', value: custom ? state.color : '#4a7a3a',
        onchange: (e) => setColor(e.target.value),
      }),
    ]),
  );
}

// A photo's main colors, in the viewer: each one browses by that color.
export function renderPalette(asset, goTo) {
  const palette = asset.palette || [];
  $('d-palette').hidden = !palette.length;
  $('d-palette').replaceChildren(...palette.map(([hex, share]) => el('button', {
    type: 'button', class: 'swatch', style: `--c: ${hex}; flex: ${share} 1 0`,
    title: `${share}% · find photos with this color`, 'aria-label': `Find photos with this color (${share}% of the photo)`,
    onclick: () => goTo(hex),
  })));
}

// --- the trail ------------------------------------------------------------------

const MAX_TRAIL = 8;
const trailAssets = new Map(); // id -> asset, for the trail's thumbnails
export const trail = () => (state.like ? state.like.split(',') : []);

// Starts a trail from `asset`, or adds it to the one being followed.
export function exploreFrom(asset) {
  trailAssets.set(asset.id, asset);
  const ids = trail().filter((id) => id !== asset.id);
  state.like = [...ids, asset.id].slice(-MAX_TRAIL).join(',');
  state.likeName = displayName(asset);
  load(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function endTrail() {
  state.like = state.likeName = '';
  state.more = [];
  state.less = [];
}

// "more snow" / "+snow" / "snow" pull toward a word; "less people" / "-people" away.
export function addWord(text) {
  const t = text.trim().toLowerCase();
  const less = /^(less|fewer|no|without)\s+|^-\s*/.test(t);
  const word = t.replace(/^(more|less|fewer|no|without|with)\s+|^[+-]\s*/, '').trim();
  if (!word) return;
  const list = less ? 'less' : 'more';
  const other = less ? 'more' : 'less';
  state[other] = state[other].filter((w) => w !== word);
  if (!state[list].includes(word)) state[list] = [...state[list], word].slice(-3);
  load(true);
}

function wordChip(list, word) {
  return el('span', { class: `fchip word ${list}` }, [
    el('span', { class: 'k', text: list === 'more' ? 'More' : 'Less' }),
    el('span', { class: 'v', text: word }),
    el('button', {
      type: 'button', text: '×', 'aria-label': `Remove “${list} ${word}”`,
      onclick: () => { state[list] = state[list].filter((w) => w !== word); load(true); },
    }),
  ]);
}

// Words to try: the most common tag values in the current results that aren't
// already steering it.
function suggestions() {
  const used = new Set([...state.more, ...state.less]);
  const values = [];
  for (const key of ['activity', 'location', 'season', 'concept', 'vehicle', 'color']) {
    for (const [value, n] of Object.entries(state.facets[key] || {})) {
      if (!used.has(value.toLowerCase())) values.push([value.toLowerCase(), n]);
    }
  }
  return [...new Map(values.sort((a, b) => b[1] - a[1])).keys()].slice(0, 6);
}

// The bar above the results while following a trail.
export async function renderExplore() {
  const box = $('explore');
  const ids = trail();
  box.hidden = !ids.length;
  if (!ids.length) return;
  const missing = ids.filter((id) => !trailAssets.has(id));
  if (missing.length) {
    await Promise.all(missing.map((id) => api(`/api/assets/${encodeURIComponent(id)}`)
      .then((a) => trailAssets.set(id, a)).catch(() => {})));
  }
  const steps = ids.map((id, i) => {
    const a = trailAssets.get(id);
    const last = i === ids.length - 1;
    return el('button', {
      type: 'button', class: `trail-step${last ? ' current' : ''}`, 'aria-current': last ? 'step' : false,
      title: last ? 'Where you are' : 'Go back to here', 'aria-label': `${last ? 'Current: ' : 'Back to '}${a ? displayName(a) : 'photo'}`,
      style: a?.color ? `background-color: ${a.color}` : '',
      onclick: () => {
        if (last) return;
        state.like = ids.slice(0, i + 1).join(',');
        state.likeName = a ? displayName(a) : '';
        load(true);
      },
    }, [a?.hasThumbnail ? el('img', { src: thumbUrl(a, 96), alt: '' }) : '']);
  });
  const visual = state.similarMode === 'visual';
  const words = [...state.more.map((w) => wordChip('more', w)), ...state.less.map((w) => wordChip('less', w))];
  const ideas = visual ? suggestions().map((w) => el('button', {
    type: 'button', class: 'idea', text: `+ ${w}`, title: `More ${w}`, onclick: () => addWord(w),
  })) : [];
  box.replaceChildren(
    el('div', { class: 'explore-head' }, [
      el('strong', { text: ids.length > 1 ? 'Your trail' : 'More like' }),
      el('div', { class: 'trail' }, steps),
      el('span', { class: 'explore-hint', text: 'Pick “Similar” on any photo to keep going.' }),
      el('button', { type: 'button', class: 'link', text: 'Done', onclick: () => { endTrail(); load(true); } }),
    ]),
    visual ? el('div', { class: 'refine' }, [
      el('form', {
        class: 'refine-form',
        onsubmit: (e) => {
          e.preventDefault();
          const input = e.target.elements.word;
          addWord(input.value);
          input.value = '';
        },
      }, [el('input', {
        name: 'word', type: 'text', maxlength: 40, autocomplete: 'off', 'aria-label': 'Steer with a word',
        placeholder: 'Steer it: “more snow”, “less people”',
      })]),
      ...words,
      ideas.length ? el('span', { class: 'ideas' }, ideas) : '',
    ]) : el('p', { class: 'explore-hint', text: 'Matched by shared tags, shoot and date until visual fingerprints are ready.' }),
  );
}
