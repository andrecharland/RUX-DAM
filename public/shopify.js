'use strict';

// Reads a Shopify "Products → Export" CSV and returns product names and color
// option values, for the DAM's Product and Color vocabularies. Runs in the
// browser (window.ShopifyImport) and in Node tests (require).
(function (root) {
  // RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim()));
  }

  const COLOR_OPTION = /^(colou?rs?|colorway|colourway)$/i;

  // Shopify writes one row per variant; the title, status and option names are
  // only on a product's first row, so they're carried over by Handle.
  function fromShopifyCsv(text) {
    const [header, ...rows] = parseCsv(text);
    const col = (name) => (header || []).findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    const handleCol = col('Handle');
    const titleCol = col('Title');
    if (handleCol < 0 || titleCol < 0) {
      throw new Error("This doesn't look like a Shopify products export (no Handle and Title columns).");
    }
    const statusCol = col('Status');
    const options = [1, 2, 3].map((n) => ({ name: col(`Option${n} Name`), value: col(`Option${n} Value`) }));

    const products = new Map();
    for (const r of rows) {
      const handle = (r[handleCol] || '').trim();
      if (!handle) continue;
      if (!products.has(handle)) products.set(handle, { title: '', status: '', optionNames: [], colors: new Set() });
      const p = products.get(handle);
      if (r[titleCol]?.trim()) p.title = r[titleCol].trim();
      if (statusCol >= 0 && r[statusCol]?.trim()) p.status = r[statusCol].trim().toLowerCase();
      options.forEach((o, i) => {
        if (o.name >= 0 && r[o.name]?.trim()) p.optionNames[i] = r[o.name].trim();
        const value = o.value >= 0 ? r[o.value]?.trim() : '';
        if (value && COLOR_OPTION.test(p.optionNames[i] || '')) p.colors.add(value);
      });
    }

    // Without a Status column every product counts; otherwise only active ones.
    const kept = [...products.values()].filter((p) => p.title && (!p.status || p.status === 'active'));
    const sort = (set) => [...set].sort((a, b) => a.localeCompare(b));
    const uniq = (values) => {
      const seen = new Map();
      for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
      return seen.values();
    };
    return {
      products: sort(uniq(kept.map((p) => p.title))),
      colors: sort(uniq(kept.flatMap((p) => [...p.colors]))),
      skipped: products.size - kept.length,
    };
  }

  const api = { parseCsv, fromShopifyCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShopifyImport = api;
})(this);
