'use strict';

const express = require('express');
const { ORDER: FILE_FACET_ORDER } = require('../fileinfo');
const { tagSimilar } = require('../similar');
const { who } = require('./helpers');

const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

// Browsing: search and filters, single assets, "more like this", folders,
// index status and sync.
function assetRoutes({ library, similarity, visualLimit }) {
  const router = express.Router();

  // Assets that look like `id`: by visual fingerprint when it has one,
  // otherwise by shared tags, shoot and date.
  const similarTo = (id, limit) => {
    const visual = similarity?.similar(id, limit);
    return visual ? { mode: 'visual', rank: visual } : { mode: 'tags', rank: tagSimilar(library, id, limit) };
  };

  router.get('/api/assets', async (req, res) => {
    const q = String(req.query.q || '');
    let rank = null;
    let rankMode = '';
    let similarMode;
    const like = String(req.query.like || '');
    if (like && library.has(like)) {
      ({ rank, mode: similarMode } = similarTo(like, 200));
      rankMode = 'only';
    } else if (similarity?.enabled && q.trim().length >= 3 && visualLimit.check(req)) {
      // Search by description: add photos that look like the words.
      try {
        rank = await similarity.searchText(q, 60);
        rankMode = 'append';
      } catch (err) {
        console.error(`Visual search failed: ${err.message}`);
      }
    }
    res.json({ fileOrder: FILE_FACET_ORDER, similarMode, ...library.search({
      q,
      kind: String(req.query.kind || ''),
      folder: String(req.query.folder || ''),
      rights: String(req.query.rights || ''),
      tags: [].concat(req.query.tag || []).map(String),
      suggested: String(req.query.suggested || ''),
      file: [].concat(req.query.f || []).map(String),
      from: isoDay(req.query.from),
      to: isoDay(req.query.to),
      sort: String(req.query.sort || 'modified'),
      offset: Math.max(Number(req.query.offset) || 0, 0),
      limit: Math.min(Number(req.query.limit) || 100, 500),
      rank,
      rankMode,
      rating: Math.min(Math.max(Number(req.query.rating) || 0, 0), 5),
      collection: String(req.query.collection || ''),
      favorites: library.curation.favorites(who(req)),
      favoritesOnly: req.query.fav === '1',
    }) });
  });

  // "More like this" for the viewer.
  router.get('/api/similar/:id', (req, res) => {
    if (!library.has(req.params.id)) return res.sendStatus(404);
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    const { mode, rank } = similarTo(req.params.id, limit);
    res.json({ mode, items: [...rank.keys()].map((id) => library.view(library.byId.get(id))) });
  });

  router.get('/api/assets/:id', (req, res) => {
    const asset = library.byId.get(req.params.id);
    if (!asset) return res.sendStatus(404);
    res.json({
      ...library.view(asset),
      favorite: library.curation.favorites(who(req)).has(asset.id),
      collections: library.curation.collectionsOf(asset.id),
    });
  });

  // Average colors worked out by the browser from loaded previews: { colors: { id: '#rrggbb' } }.
  router.post('/api/colors', express.json({ limit: '100kb' }), (req, res) => {
    const colors = req.body?.colors;
    if (!colors || typeof colors !== 'object' || Object.keys(colors).length > 500) {
      return res.status(400).json({ error: 'colors must be an object of up to 500 ids' });
    }
    res.json({ added: library.colors.add(colors, (id) => library.has(id)) });
  });

  router.get('/api/folders', (req, res) => res.json(library.folderList()));

  router.get('/api/status', (req, res) => res.json({
    ...library.status(),
    similarity: similarity ? similarity.status() : { mode: 'tags' },
  }));

  router.post('/api/sync', async (req, res) => {
    await library.sync();
    res.json(library.status());
  });

  return router;
}

module.exports = { assetRoutes };
