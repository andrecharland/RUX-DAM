'use strict';

const express = require('express');
const { ORDER: FILE_FACET_ORDER } = require('../fileinfo');
const { tagSimilar } = require('../similar');
const { who } = require('./helpers');

const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const HEX = /^#[0-9a-f]{6}$/i;

// Up to `max` short strings from a repeatable query parameter.
const words = (v, max = 3) => [].concat(v || []).map((w) => String(w).trim().slice(0, 40)).filter(Boolean).slice(0, max);

// Browsing: search and filters, single assets, "more like this", folders,
// the visual map, index status and sync.
function assetRoutes({ library, similarity, visualLimit, layout }) {
  const router = express.Router();

  // Assets that look like `id`: by visual fingerprint when it has one,
  // otherwise by shared tags, shoot and date.
  const similarTo = (id, limit) => {
    const visual = similarity?.similar(id, limit);
    return visual ? { mode: 'visual', rank: visual } : { mode: 'tags', rank: tagSimilar(library, id, limit) };
  };

  // "More like this", from a trail of assets (`like=a,b,c`, the latest last),
  // steered by words (`more`, `less`) when there are fingerprints; by the latest
  // asset's tags otherwise.
  const explore = async (req, trail) => {
    const more = words(req.query.more);
    const less = words(req.query.less);
    if (similarity?.enabled && ((more.length || less.length) ? visualLimit.check(req) : true)) {
      const rank = await similarity.explore(trail, { more, less, limit: 1000 });
      if (rank) return { mode: 'visual', rank };
    }
    return similarTo(trail[trail.length - 1], 1000);
  };

  // The search and filters shared by the grid and the map.
  const filters = (req) => ({
    q: String(req.query.q || ''),
    kind: String(req.query.kind || ''),
    folder: String(req.query.folder || ''),
    rights: String(req.query.rights || ''),
    tags: [].concat(req.query.tag || []).map(String),
    suggested: String(req.query.suggested || ''),
    file: [].concat(req.query.f || []).map(String),
    from: isoDay(req.query.from),
    to: isoDay(req.query.to),
    sort: String(req.query.sort || 'modified'),
    rating: Math.min(Math.max(Number(req.query.rating) || 0, 0), 5),
    collection: String(req.query.collection || ''),
    color: HEX.test(req.query.color) ? String(req.query.color) : '',
    favorites: library.curation.favorites(who(req)),
    favoritesOnly: req.query.fav === '1',
  });

  // Ranking from "more like this" or a search by description.
  const ranking = async (req) => {
    const trail = String(req.query.like || '').split(',').filter((id) => library.has(id)).slice(-8);
    if (trail.length) {
      const { rank, mode } = await explore(req, trail);
      return { rank, rankMode: 'only', similarMode: mode };
    }
    const q = String(req.query.q || '');
    if (similarity?.enabled && q.trim().length >= 3 && visualLimit.check(req)) {
      // Search by description: add photos that look like the words.
      try {
        return { rank: await similarity.searchText(q, 60), rankMode: 'append' };
      } catch (err) {
        console.error(`Visual search failed: ${err.message}`);
      }
    }
    return { rank: null, rankMode: '' };
  };

  router.get('/api/assets', async (req, res) => {
    const { rank, rankMode, similarMode } = await ranking(req);
    res.json({ fileOrder: FILE_FACET_ORDER, similarMode, ...library.search({
      ...filters(req),
      offset: Math.max(Number(req.query.offset) || 0, 0),
      limit: Math.min(Number(req.query.limit) || 100, 500),
      rank,
      rankMode,
    }) });
  });

  // The visual map: every match with a place on it (x, y from map.json), with
  // what a square needs to draw. While it's first being arranged: { building }.
  router.get('/api/map', async (req, res) => {
    if (!layout || !similarity?.enabled) return res.status(404).json({ error: 'The visual map needs visual fingerprints (Vertex AI) turned on.' });
    const positions = await layout.get();
    if (!positions) return res.json({ ...layout.status(), building: true });
    const { rank, rankMode } = await ranking(req);
    const { items, total } = library.search({ ...filters(req), rank, rankMode, offset: 0, limit: Infinity });
    const placed = items.filter((a) => positions.has(a.id));
    res.json({
      total,
      unplaced: total - placed.length,
      items: placed.map((a) => {
        const [x, y] = positions.get(a.id);
        return { id: a.id, name: a.label?.title || a.name, x, y, color: a.color, modifiedTime: a.modifiedTime, kind: a.kind, width: a.width, height: a.height };
      }),
    });
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
