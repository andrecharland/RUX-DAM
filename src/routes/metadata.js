'use strict';

const express = require('express');
const { idsFrom } = require('./helpers');

// Metadata fields and their preset values, tags on files and folders, and
// usage-rights flags.
function metadataRoutes({ library }) {
  const router = express.Router();

  router.get('/api/fields', (req, res) => res.json(library.tags.fields()));

  router.post('/api/fields', express.json(), async (req, res) => {
    res.json(await library.tags.addField(req.body?.label));
  });

  // Replace a field's preset values: { values: [...] }
  router.post('/api/fields/:key/presets', express.json({ limit: '1mb' }), async (req, res) => {
    res.json({ presets: await library.tags.setPresets(req.params.key, req.body?.values) });
  });

  // Add/remove metadata on indexed files and folders:
  // { ids: [...], add: { field: [values] }, remove: { field: [values] } }
  router.post('/api/tags', express.json(), async (req, res) => {
    const ids = idsFrom(library, req, res, { folders: true });
    if (!ids) return;
    const { add, remove } = req.body;
    await library.tags.apply(ids, { add, remove });
    res.json({ updated: ids.length });
  });

  // Set usage rights on an indexed file or folder. status: cleared | restricted | inherit
  router.post('/api/rights/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!library.has(id) && !library.folders.has(id)) return res.sendStatus(404);
    const { status, note } = req.body || {};
    if (!['cleared', 'restricted', 'inherit'].includes(status)) {
      return res.status(400).json({ error: 'status must be cleared, restricted or inherit' });
    }
    await library.rights.set(id, status, note || '');
    const asset = library.byId.get(id);
    res.json(asset ? library.view(asset) : { id, flag: library.rights.get(id) });
  });

  return router;
}

module.exports = { metadataRoutes };
