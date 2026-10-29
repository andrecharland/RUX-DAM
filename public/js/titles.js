import { el, state } from './core.js';
import { applyTo } from './tags.js';

// Titles and RUX_ names built from naming fields (see the README).

// Items with naming fields of their own show a title built from them, e.g.
// "Gear Box 70L · Proof · Video · by Cal · Jun 8, 2026" (the server builds it,
// with the RUX_ name used for downloads); others show their Drive name.
export const displayName = (item) => item.label?.title || item.name;

// Creator(s) from the asset's own or inherited Creator tag.
export const creatorOf = (asset) => (asset.tags?.creator || []).map((t) => t.value).join(', ');

// Naming fields worked out from what Drive knows: the Drive name when it already
// follows the convention, else Photo/Video, the date and (files) the aspect.
export function namingDefaults(item, { media, date, width, height }) {
  const parsed = RuxNaming.parse(item.name);
  const fromVocab = (key, written, toToken) => state.fields.find((f) => f.key === key)?.values
    .find((v) => toToken(v) === written) || written;
  const values = parsed ? {
    product: fromVocab('product', parsed.product, RuxNaming.productToken),
    concept: fromVocab('concept', parsed.concept, RuxNaming.token),
    format: fromVocab('format', parsed.format, RuxNaming.token),
    aspect: parsed.aspect,
    creator: fromVocab('creator', parsed.creator, RuxNaming.token),
    shoot_date: parsed.date,
    version: String(parsed.version),
  } : { format: media, shoot_date: (date || '').slice(0, 10), aspect: RuxNaming.aspectOf(width, height) };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v).map(([k, v]) => [k, [v]]));
}

// The line under a heading: the RUX_ name and Drive name of a titled item, or a
// way to start one.
export function titleRow(item, defaults, { showTitle = true } = {}) {
  if (item.label) {
    return [
      showTitle ? el('span', { class: 'label-plain', text: item.label.title }) : '',
      item.label.name ? el('code', { text: item.label.name, title: 'File name in the RUX naming convention' }) : '',
      el('span', { class: 'drive-name', text: `Drive name: ${item.name}` }),
    ];
  }
  return [
    el('span', { class: 'hint', text: 'Add Product, Format, Shoot date… to give this a title and a RUX file name.' }),
    el('button', { type: 'button', class: 'link', text: 'Start from file details', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await applyTo([item.id])({ add: defaults() });
      } catch (err) {
        e.target.textContent = err.message;
      }
    } }),
  ];
}
