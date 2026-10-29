'use strict';

const express = require('express');
const { who, idsFrom } = require('./helpers');

// Team ratings, personal favorites and team collections.
function curationRoutes({ library }) {
  const router = express.Router();
  const { curation } = library;

  // One team rating per asset: { ids, rating: 0-5 } (0 clears).
  router.post('/api/rate', express.json({ limit: '1mb' }), async (req, res) => {
    const ids = idsFrom(library, req, res);
    if (!ids) return;
    await curation.rate(ids, req.body.rating);
    res.json({ updated: ids.length });
  });

  // The signed-in person's favorites: { ids, on: true | false }.
  router.post('/api/favorite', express.json({ limit: '1mb' }), async (req, res) => {
    const ids = idsFrom(library, req, res);
    if (!ids) return;
    await curation.favorite(who(req), ids, req.body.on !== false);
    res.json({ updated: ids.length });
  });

  // A collection as the app shows it: only items still in the index, with up
  // to three covers.
  const summary = (c) => {
    const items = c.items.filter((id) => library.has(id));
    return {
      id: c.id, name: c.name, description: c.description, createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
      count: items.length,
      items,
      covers: items.map((id) => library.byId.get(id)).filter((a) => a.hasThumbnail).slice(0, 3)
        .map((a) => ({ id: a.id, modifiedTime: a.modifiedTime })),
    };
  };
  const known = (list) => (list || []).map(String).filter((id) => library.has(id));

  router.get('/api/collections', (req, res) => {
    res.json({
      favorites: { count: known([...curation.favorites(who(req))]).length },
      collections: curation.collections().map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    });
  });

  // { name, description?, ids? }
  router.post('/api/collections', express.json({ limit: '1mb' }), async (req, res) => {
    res.json(summary(await curation.createCollection({ ...req.body, ids: known(req.body?.ids) }, who(req))));
  });

  // { name?, description?, add?: [ids], remove?: [ids] } or { delete: true }
  router.post('/api/collections/:id', express.json({ limit: '1mb' }), async (req, res) => {
    const { id } = req.params;
    if (!curation.collection(id)) return res.sendStatus(404);
    if (req.body?.delete) {
      await curation.deleteCollection(id);
      return res.json({ deleted: id });
    }
    const remove = (req.body?.remove || []).map(String);
    res.json(summary(await curation.updateCollection(id, { ...req.body, add: known(req.body?.add), remove })));
  });

  return router;
}

module.exports = { curationRoutes };
