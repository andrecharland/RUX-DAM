'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const { createAuth } = require('./google');
const { DriveClient } = require('./drive');
const { Library } = require('./library');
const { RightsStore } = require('./rights');

function parseFolderIds(value = '') {
  // Accept bare IDs or full Drive folder URLs, comma or whitespace separated.
  return value.split(/[\s,]+/).filter(Boolean).map((v) => {
    const m = v.match(/folders\/([\w-]+)/);
    return m ? m[1] : v;
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Optional shared-password gate via HTTP Basic auth (any username).
function basicAuth(password) {
  return (req, res, next) => {
    if (!password) return next();
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
      if (safeEqual(pass, password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="RUX DAM"').status(401).send('Authentication required');
  };
}

async function pipeDrive(driveRes, res, passHeaders) {
  res.status(driveRes.status);
  for (const h of passHeaders) {
    const v = driveRes.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!driveRes.body) return res.end();
  Readable.fromWeb(driveRes.body).on('error', () => res.destroy()).pipe(res);
}

function createApp({ library, drive, password }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (req, res) => res.send('ok'));
  app.use(basicAuth(password));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/assets', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(library.search({
      q: String(req.query.q || ''),
      kind: String(req.query.kind || ''),
      collection: String(req.query.collection || ''),
      rights: String(req.query.rights || ''),
      offset,
      limit,
    }));
  });

  app.get('/api/assets/:id', (req, res) => {
    const asset = library.byId.get(req.params.id);
    if (!asset) return res.sendStatus(404);
    res.json(library.view(asset));
  });

  app.get('/api/collections', (req, res) => res.json(library.collections()));
  app.get('/api/status', (req, res) => res.json(library.status()));

  // Set usage rights on an indexed file or folder. status: cleared | restricted | inherit
  app.post('/api/rights/:id', express.json(), async (req, res, next) => {
    const { id } = req.params;
    if (!library.has(id) && !library.folders.has(id)) return res.sendStatus(404);
    const { status, note } = req.body || {};
    if (!['cleared', 'restricted', 'inherit'].includes(status)) {
      return res.status(400).json({ error: 'status must be cleared, restricted or inherit' });
    }
    try {
      await library.rights.set(id, status, note || '');
      const asset = library.byId.get(id);
      res.json(asset ? library.view(asset) : { id, flag: library.rights.get(id) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/sync', async (req, res, next) => {
    try {
      await library.sync();
      res.json(library.status());
    } catch (err) {
      next(err);
    }
  });

  // Only serve files that are in the index, so the proxy can't be used
  // to read arbitrary Drive files the service account can see.
  const known = (req, res, next) => (library.has(req.params.id) ? next() : res.sendStatus(404));

  app.get('/api/assets/:id/thumbnail', known, async (req, res, next) => {
    try {
      const size = Math.min(Number(req.query.size) || 400, 1600);
      const driveRes = await drive.thumbnail(req.params.id, size);
      if (!driveRes || !driveRes.ok) return res.sendStatus(404);
      res.set('Cache-Control', 'private, max-age=3600');
      await pipeDrive(driveRes, res, ['content-type', 'content-length']);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/assets/:id/file', known, async (req, res, next) => {
    try {
      const asset = library.byId.get(req.params.id);
      const driveRes = await drive.media(req.params.id, req.get('range'));
      if (!driveRes.ok && driveRes.status !== 206) return res.sendStatus(driveRes.status);
      const disposition = req.query.download ? 'attachment' : 'inline';
      res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
      res.set('Cache-Control', 'private, max-age=3600');
      await pipeDrive(driveRes, res, ['content-type', 'content-length', 'content-range', 'accept-ranges']);
    } catch (err) {
      next(err);
    }
  });

  app.use((err, req, res, _next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

if (require.main === module) {
  const folderIds = parseFolderIds(process.env.DRIVE_FOLDER_IDS);
  if (!folderIds.length) {
    console.error('Set DRIVE_FOLDER_IDS to one or more Google Drive folder IDs or URLs.');
    process.exit(1);
  }
  const auth = createAuth();
  const drive = new DriveClient(auth, { concurrency: Number(process.env.SYNC_CONCURRENCY) || 8 });
  const rights = new RightsStore({ auth, bucket: process.env.RIGHTS_BUCKET });
  const library = new Library(drive, folderIds, {
    refreshMs: (Number(process.env.REFRESH_MINUTES) || 10) * 60 * 1000,
    rights,
  });
  // Each sync reloads the rights flags too. Saves are conditional on the stored
  // object's generation, so a failed load can't cause an edit to overwrite them.
  library.start();
  const app = createApp({ library, drive, password: process.env.DAM_PASSWORD });
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => console.log(`RUX DAM listening on :${port}`));
}

module.exports = { createApp, parseFolderIds };
