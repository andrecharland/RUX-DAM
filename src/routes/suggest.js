'use strict';

const express = require('express');

// Tag suggestions from Claude: queueing, single runs, accepting and dismissing.
function suggestRoutes({ library, suggester, claudeLimit }) {
  const router = express.Router();

  router.get('/api/suggest/status', (req, res) => {
    res.json(suggester ? suggester.status() : { enabled: false });
  });

  const needSuggester = (req, res, next) => (suggester?.enabled ? next()
    : res.status(503).json({ error: 'Set ANTHROPIC_API_KEY to enable suggestions' }));

  // Queue assets: { ids: [...] } or { folder: id }, optionally { force: true } to redo.
  router.post('/api/suggest', express.json(), needSuggester, claudeLimit, (req, res) => {
    const { ids, folder, force } = req.body || {};
    let targets = [];
    if (Array.isArray(ids)) targets = ids.map(String);
    else if (folder && library.folders.has(folder)) {
      targets = library.assets.filter((a) => a.ancestors.some((f) => f.id === folder)).map((a) => a.id);
    } else {
      return res.status(400).json({ error: 'Pass ids or a known folder' });
    }
    // Re-asking about photos that already have suggestions is for a few at a
    // time, not a whole library by accident.
    if (force && targets.length > 500) return res.status(400).json({ error: 'Ask again for at most 500 photos at a time' });
    // More than 50 photos go to a half-price batch; fewer run right away.
    const { added, batch } = suggester.submit(targets, { force: Boolean(force) });
    res.json({ ...suggester.status(), added, batch });
  });

  router.post('/api/suggest/cancel', needSuggester, async (req, res) => {
    await suggester.cancel();
    res.json(suggester.status());
  });

  // Shoot-level suggestions for a folder, from a few sample photos (one request).
  router.post('/api/suggest/folder/:id/run', needSuggester, claudeLimit, async (req, res) => {
    if (!library.folders.has(req.params.id)) return res.sendStatus(404);
    // A failure is recorded on the folder's suggestions and shown in the folder panel.
    await suggester.runFolder(req.params.id).catch(() => {});
    res.json(library.folderList().find((f) => f.id === req.params.id));
  });

  // Suggest for one asset right away (from the viewer).
  router.post('/api/suggest/:id/run', needSuggester, claudeLimit, async (req, res) => {
    const asset = library.byId.get(req.params.id);
    if (!asset) return res.sendStatus(404);
    // A failure is recorded on the asset's suggestions and shown in the viewer.
    await suggester.run(asset.id).catch(() => {});
    res.json(library.view(asset));
  });

  // Accept suggestions as tags: { ids: [...] } accepts everything pending on
  // those assets; { ids: [id], field, value } accepts one value.
  router.post('/api/suggest/accept', express.json(), async (req, res) => {
    const { ids, field, value } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty list' });
    if (ids.some((id) => !library.has(id) && !library.folders.has(id))) return res.sendStatus(404);
    const changes = ids.map((id) => {
      const item = library.byId.get(id) || library.folders.get(id);
      const pending = library.suggestions.remaining(id, library.tags.resolve(item));
      if (field) {
        const hit = (pending[field] || []).find((v) => v.toLowerCase() === String(value).toLowerCase());
        return { id, add: hit ? { [field]: [hit] } : {} };
      }
      return { id, add: pending };
    }).filter((c) => Object.keys(c.add).length);
    if (changes.length) await library.tags.applyEach(changes);
    res.json({ updated: changes.length });
  });

  // Dismiss: { id, field, value } drops one value; { ids } drops all pending suggestions.
  router.post('/api/suggest/dismiss', express.json(), (req, res) => {
    const { id, ids, field, value } = req.body || {};
    if (id && field && value != null) {
      if (!library.has(id) && !library.folders.has(id)) return res.sendStatus(404);
      library.suggestions.dismiss(id, field, String(value));
    } else if (Array.isArray(ids)) {
      for (const i of ids) if (library.has(i) || library.folders.has(i)) library.suggestions.dismissAll(i);
    } else {
      return res.status(400).json({ error: 'Pass { id, field, value } or { ids }' });
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { suggestRoutes };
