'use strict';

// The RUX file naming convention (Paid Social Creative Playbook):
//   RUX_[Product]_[ConceptFamily]_[Format]_[Aspect]_[Creator]_[YYYY-MM-DD]_v01
// e.g. RUX_GearBox70L_Proof_Reels_9x16_Cal_2026-06-08_v01
// Builds labels from plain values ("Gear Box 70L" -> "GearBox70L") and reads
// names that already follow it. Runs in the browser (window.RuxNaming) and in Node.
(function (root) {
  const PARTS = [
    { key: 'product', label: 'Product', field: 'product' },
    { key: 'concept', label: 'Concept family', field: 'concept' },
    { key: 'format', label: 'Format', field: 'format' },
    { key: 'aspect', label: 'Aspect', field: 'aspect' },
    { key: 'creator', label: 'Creator', field: 'creator' },
    { key: 'date', label: 'Date' },
    { key: 'version', label: 'Version' },
  ];

  // Common ratios, for reading an aspect off pixel dimensions.
  const ASPECTS = [['9x16', 9 / 16], ['4x5', 4 / 5], ['1x1', 1], ['1.91x1', 1.91], ['16x9', 16 / 9], ['4x1', 4], ['2x3', 2 / 3], ['3x2', 3 / 2]];

  // "Gear Box 70L" -> "GearBox70L"; "Product-in-Context" -> "ProductInContext".
  function token(value) {
    return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .split(/[^A-Za-z0-9]+/).filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  }

  // Products drop a leading "RUX", which the name already starts with.
  const productToken = (value) => token(String(value || '').replace(/^\s*RUX(\s+|_|-)/i, ''));

  // "9:16", "9 x 16", "9x16" -> "9x16"; "1.91:1" -> "1.91x1".
  function aspectToken(value) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[x×:/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(value || ''));
    return m ? `${m[1]}x${m[2]}` : '';
  }

  function aspectOf(width, height) {
    if (!width || !height) return '';
    const ratio = width / height;
    const hit = ASPECTS.find(([, r]) => Math.abs(ratio - r) / r < 0.02);
    return hit ? hit[0] : '';
  }

  // Returns { name, errors } where errors is { partKey: message } (empty when valid).
  // Every part is optional: the name keeps the parts given, in convention order,
  // e.g. "RUX_GearBox70L_Photo_2026-06-08". At least one part is needed.
  function compose(parts = {}) {
    const errors = {};
    const aspect = aspectToken(parts.aspect);
    if (String(parts.aspect || '').trim() && !aspect) errors.aspect = 'Use width x height, e.g. 9x16';
    const date = String(parts.date || '').trim();
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
      errors.date = 'Use a date like 2026-06-08';
    }
    const v = String(parts.version ?? '').trim();
    const version = Number(v);
    if (v && (!Number.isInteger(version) || version < 1 || version > 999)) errors.version = 'Version must be 1 or more';
    const pieces = [productToken(parts.product), token(parts.concept), token(parts.format), aspect, token(parts.creator), date]
      .filter(Boolean);
    if (!pieces.length && !Object.keys(errors).length) errors.product = 'Fill in at least one part';
    const name = Object.keys(errors).length ? ''
      : ['RUX', ...pieces, v ? `v${String(version).padStart(2, '0')}` : ''].filter(Boolean).join('_');
    return { name, errors };
  }

  const PATTERN = /^RUX_([A-Za-z0-9]+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d+(?:\.\d+)?x\d+(?:\.\d+)?)_([A-Za-z0-9]+)_(\d{4}-\d{2}-\d{2})_v(\d+)$/;

  // Reads a name that follows the convention (any file extension is ignored).
  // Values come back as written in the name, e.g. { product: 'GearBox70L', … }.
  function parse(name) {
    const m = PATTERN.exec(String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, ''));
    if (!m) return null;
    return { product: m[1], concept: m[2], format: m[3], aspect: m[4], creator: m[5], date: m[6], version: Number(m[7]) };
  }

  const api = { PARTS, token, productToken, aspectToken, aspectOf, compose, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RuxNaming = api;
})(this);
