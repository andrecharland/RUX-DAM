'use strict';

const express = require('express');
const archiver = require('archiver');
const { Readable } = require('node:stream');
const { snapSize, thumbVersion } = require('../thumbcache');
const { limitRange, inlineSafe, MAX_RESPONSE } = require('../security');

async function pipeDrive(driveRes, res, passHeaders) {
  res.status(driveRes.status);
  for (const h of passHeaders) {
    const v = driveRes.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!driveRes.body) return res.end();
  Readable.fromWeb(driveRes.body).on('error', () => res.destroy()).pipe(res);
}

// Previews and original files, proxied from Drive. Only files in the index are
// served, so the proxy can't be used to read other Drive files the service
// account can see.
function mediaRoutes({ library, drive, thumbs }) {
  const router = express.Router();
  const known = (req, res, next) => (library.has(req.params.id) ? next() : res.sendStatus(404));

  // Previews, rounded up to a standard size and cached (see thumbcache.js). With
  // ?v= matching the file's version the browser may keep it for good: a change
  // in Drive changes the version, and so the URL.
  router.get('/api/assets/:id/thumbnail', known, async (req, res) => {
    const asset = library.byId.get(req.params.id);
    const size = snapSize(Number(req.query.size) || 400);
    const v = thumbVersion(asset);
    const preview = await thumbs.fetch(`thumbs/${asset.id}/${v}-${size}`, async () => {
      const driveRes = await drive.thumbnail(asset.id, size);
      if (!driveRes?.ok) {
        await driveRes?.body?.cancel();
        return null;
      }
      return { body: Buffer.from(await driveRes.arrayBuffer()), type: driveRes.headers.get('content-type') || 'image/jpeg' };
    });
    if (!preview) return res.sendStatus(404);
    res.set('Cache-Control', req.query.v === v ? 'private, max-age=31536000, immutable' : 'private, max-age=3600');
    res.type(preview.type).send(preview.body);
  });

  router.get('/api/assets/:id/file', known, async (req, res) => {
    const asset = library.byId.get(req.params.id);
    const driveRes = await drive.media(asset.id, limitRange(req.get('range')));
    if (!driveRes.ok && driveRes.status !== 206) return res.sendStatus(driveRes.status);
    // Only raster images and video open in the browser; anything else (an SVG
    // with a script in it) downloads, and never runs as a page of this site.
    const type = driveRes.headers.get('content-type');
    const disposition = req.query.download || !inlineSafe(type) ? 'attachment' : 'inline';
    res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'");
    // Downloads are named by the asset's RUX_ name, keeping the original extension.
    res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName(library, asset))}`);
    res.set('Cache-Control', 'private, max-age=3600');
    // A whole-file response is streamed without a length (chunked), which
    // Cloud Run allows at any size; with a length it caps responses at 32 MB.
    const length = Number(driveRes.headers.get('content-length')) || 0;
    await pipeDrive(driveRes, res, ['content-type', 'content-range', 'accept-ranges',
      ...(length && length < MAX_RESPONSE ? ['content-length'] : [])]);
  });

  // Several originals as one zip, streamed as it's built (nothing is held in
  // memory or on disk): a form POST with ids (comma separated) and an optional
  // name for the zip. Files are stored as-is (photos and video don't compress).
  router.post('/api/download', express.urlencoded({ extended: false, limit: '1mb' }), async (req, res) => {
    const ids = [...new Set(String(req.body?.ids || '').split(',').filter((id) => library.has(id)))];
    if (!ids.length) return res.status(400).send('Nothing to download');
    if (ids.length > MAX_ZIP_FILES) return res.status(400).send(`Download at most ${MAX_ZIP_FILES} files at a time`);
    const assets = ids.map((id) => library.byId.get(id));
    const bytes = assets.reduce((n, a) => n + (a.size || 0), 0);
    if (bytes > MAX_ZIP_BYTES) {
      return res.status(400).send(`That's ${(bytes / 1e9).toFixed(1)} GB; download at most ${MAX_ZIP_BYTES / 1e9} GB at a time`);
    }
    const zipName = `${String(req.body?.name || 'RUX assets').replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || 'RUX assets'}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.set('Cache-Control', 'no-store');
    const zip = archiver('zip', { store: true });
    zip.on('warning', (err) => console.warn(`Zip: ${err.message}`));
    zip.on('error', (err) => {
      console.error(`Zip failed: ${err.message}`);
      res.destroy(err);
    });
    zip.pipe(res);
    const used = new Set();
    for (const asset of assets) {
      if (res.destroyed) break;
      const driveRes = await drive.media(asset.id);
      if (!driveRes.ok) {
        await driveRes.body?.cancel();
        zip.append(`Couldn't download ${asset.name} from Google Drive (${driveRes.status}).\n`, { name: unique(`${fileName(library, asset)}.error.txt`, used) });
        continue;
      }
      const done = new Promise((resolve) => zip.once('entry', resolve));
      zip.append(Readable.fromWeb(driveRes.body), { name: unique(fileName(library, asset), used), date: asset.modifiedTime ? new Date(asset.modifiedTime) : undefined });
      await done; // one file at a time
    }
    await zip.finalize();
  });

  return router;
}

const MAX_ZIP_FILES = 1000;
const MAX_ZIP_BYTES = 4e9;

// The download name: the RUX_ name (keeping the extension) or the Drive name.
function fileName(library, asset) {
  const label = library.tags.label(asset);
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(asset.name)?.[0] || '';
  return (label?.name ? `${label.name}${ext}` : asset.name).replace(/[\\/:*?"<>|]+/g, '_');
}

// "a.jpg", "a (2).jpg", … so files with the same name don't overwrite each other.
function unique(name, used) {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  used.add(candidate.toLowerCase());
  return candidate;
}

module.exports = { mediaRoutes, fileName };
