'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const { createAuth } = require('./google');
const { DriveClient } = require('./drive');
const { Library } = require('./library');
const { RightsStore } = require('./rights');
const { TagStore } = require('./tags');
const { Suggester, SuggestionStore, DEFAULT_MODEL } = require('./suggest');
const { JsonStore } = require('./store');
const { ORDER: FILE_FACET_ORDER } = require('./fileinfo');
const { googleSignIn } = require('./auth');

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

// Access: Google sign-in (`signIn`, see auth.js) when configured, otherwise the
// optional shared password.
function createApp({ library, drive, password, suggester, signIn }) {
  const app = express();
  app.disable('x-powered-by');

  // Cloud Run terminates HTTPS in front of the app; trust its forwarded headers.
  app.set('trust proxy', true);
  app.get('/healthz', (req, res) => res.send('ok'));
  if (signIn) {
    app.use(signIn.router);
    app.use(signIn.requireUser);
  } else {
    app.use(basicAuth(password));
  }
  app.get('/api/me', (req, res) => res.json(req.user || null));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/assets', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ fileOrder: FILE_FACET_ORDER, ...library.search({
      q: String(req.query.q || ''),
      kind: String(req.query.kind || ''),
      folder: String(req.query.folder || ''),
      rights: String(req.query.rights || ''),
      tags: [].concat(req.query.tag || []).map(String),
      suggested: String(req.query.suggested || ''),
      file: [].concat(req.query.f || []).map(String),
      from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : '',
      to: /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : '',
      sort: String(req.query.sort || 'modified'),
      offset,
      limit,
    }) });
  });

  app.get('/api/assets/:id', (req, res) => {
    const asset = library.byId.get(req.params.id);
    if (!asset) return res.sendStatus(404);
    res.json(library.view(asset));
  });

  app.get('/api/folders', (req, res) => res.json(library.folderList()));
  app.get('/api/fields', (req, res) => res.json(library.tags.fields()));

  app.post('/api/fields', express.json(), async (req, res, next) => {
    try {
      res.json(await library.tags.addField(req.body?.label));
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Set a file's or folder's label from its parts ({ parts: {...} }), or remove it ({ remove: true }).
  app.post('/api/labels/:id', express.json(), async (req, res, next) => {
    const { id } = req.params;
    if (!library.has(id) && !library.folders.has(id)) return res.sendStatus(404);
    try {
      if (req.body?.remove) {
        await library.tags.removeLabel(id);
        return res.json({ label: null });
      }
      res.json({ label: await library.tags.setLabel(id, req.body?.parts || {}) });
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Replace a field's preset values: { values: [...] }
  app.post('/api/fields/:key/presets', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      res.json({ presets: await library.tags.setPresets(req.params.key, req.body?.values) });
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Add/remove metadata on indexed files and folders:
  // { ids: [...], add: { field: [values] }, remove: { field: [values] } }
  app.post('/api/tags', express.json(), async (req, res, next) => {
    const { ids, add, remove } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000) {
      return res.status(400).json({ error: 'ids must be a non-empty list' });
    }
    if (ids.some((id) => !library.has(id) && !library.folders.has(id))) return res.sendStatus(404);
    try {
      await library.tags.apply(ids, { add, remove });
      res.json({ updated: ids.length });
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });
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

  // ----- Suggestions from Claude -----

  app.get('/api/suggest/status', (req, res) => {
    res.json(suggester ? suggester.status() : { enabled: false });
  });

  const needSuggester = (req, res, next) => (suggester?.enabled ? next()
    : res.status(503).json({ error: 'Set ANTHROPIC_API_KEY to enable suggestions' }));

  // Queue assets: { ids: [...] } or { folder: id }, optionally { force: true } to redo.
  app.post('/api/suggest', express.json(), needSuggester, (req, res) => {
    const { ids, folder, force } = req.body || {};
    let targets = [];
    if (Array.isArray(ids)) targets = ids.map(String);
    else if (folder && library.folders.has(folder)) {
      targets = library.assets.filter((a) => a.ancestors.some((f) => f.id === folder)).map((a) => a.id);
    } else {
      return res.status(400).json({ error: 'Pass ids or a known folder' });
    }
    // More than 50 photos go to a half-price batch; fewer run right away.
    const { added, batch } = suggester.submit(targets, { force: Boolean(force) });
    res.json({ ...suggester.status(), added, batch });
  });

  app.post('/api/suggest/cancel', needSuggester, async (req, res) => {
    await suggester.cancel();
    res.json(suggester.status());
  });

  // Shoot-level suggestions for a folder, from a few sample photos (one request).
  app.post('/api/suggest/folder/:id/run', needSuggester, async (req, res) => {
    if (!library.folders.has(req.params.id)) return res.sendStatus(404);
    try {
      await suggester.runFolder(req.params.id);
    } catch (err) {
      // Recorded on the folder's suggestions and shown in the folder panel.
    }
    res.json(library.folderList().find((f) => f.id === req.params.id));
  });

  // Suggest for one asset right away (from the viewer).
  app.post('/api/suggest/:id/run', needSuggester, async (req, res) => {
    const asset = library.byId.get(req.params.id);
    if (!asset) return res.sendStatus(404);
    try {
      await suggester.run(asset.id);
    } catch (err) {
      // The error is recorded on the asset's suggestions and shown in the viewer.
    }
    res.json(library.view(asset));
  });

  // Accept suggestions as tags: { ids: [...] } accepts everything pending on
  // those assets; { ids: [id], field, value } accepts one value.
  app.post('/api/suggest/accept', express.json(), async (req, res, next) => {
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
    try {
      if (changes.length) await library.tags.applyEach(changes);
      res.json({ updated: changes.length });
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  // Dismiss: { id, field, value } drops one value; { ids } drops all pending suggestions.
  app.post('/api/suggest/dismiss', express.json(), (req, res) => {
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
      const size = Math.min(Number(req.query.size) || 400, 2560);
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
      // Downloads are named by the asset's label, keeping the original extension.
      const label = library.tags.label(asset.id);
      const ext = /\.[A-Za-z0-9]{1,5}$/.exec(asset.name)?.[0] || '';
      const filename = label ? `${label.name}${ext}` : asset.name;
      res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
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
  const bucket = process.env.DATA_BUCKET || process.env.RIGHTS_BUCKET;
  const library = new Library(drive, folderIds, {
    refreshMs: (Number(process.env.REFRESH_MINUTES) || 10) * 60 * 1000,
    rights: new RightsStore({ auth, bucket }),
    tags: new TagStore({ auth, bucket }),
    suggestions: new SuggestionStore({ auth, bucket }),
    // The last synced asset list, so restarts don't start from an empty grid.
    index: bucket ? new JsonStore({ auth, bucket, object: 'index.json', empty: () => ({ assets: [], folders: [] }) }) : null,
  });
  const suggester = new Suggester({
    library,
    drive,
    apiKey: process.env.ANTHROPIC_API_KEY?.trim(),
    model: process.env.SUGGEST_MODEL || DEFAULT_MODEL,
    fields: process.env.SUGGEST_FIELDS ? process.env.SUGGEST_FIELDS.split(/[\s,]+/).filter(Boolean) : undefined,
    concurrency: Number(process.env.SUGGEST_CONCURRENCY) || 4,
  });
  if (!suggester.enabled) console.warn('ANTHROPIC_API_KEY is not set: tag suggestions are off.');
  // Each sync reloads the rights flags and tags too. Saves are conditional on the stored
  // object's generation, so a failed load can't cause an edit to overwrite them.
  // Once loaded, collect results of batches submitted before a restart and keep checking.
  library.start().then(() => suggester.startPolling());
  const list = (v) => (v || '').split(/[\s,]+/).filter(Boolean);
  let signIn = null;
  if (process.env.GOOGLE_CLIENT_ID) {
    let sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
      sessionSecret = crypto.randomBytes(32).toString('hex');
      console.warn('SESSION_SECRET is not set: everyone is signed out whenever the service restarts.');
    }
    signIn = googleSignIn({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
      sessionSecret,
      allowedDomains: list(process.env.ALLOWED_DOMAINS),
      allowedEmails: list(process.env.ALLOWED_EMAILS),
    });
    if (!list(process.env.ALLOWED_DOMAINS).length && !list(process.env.ALLOWED_EMAILS).length) {
      console.warn('Google sign-in is on but ALLOWED_DOMAINS and ALLOWED_EMAILS are empty: nobody can sign in.');
    }
  }
  const app = createApp({ library, drive, suggester, signIn, password: process.env.DAM_PASSWORD });
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => console.log(`RUX DAM listening on :${port}`));
}

module.exports = { createApp, parseFolderIds };
