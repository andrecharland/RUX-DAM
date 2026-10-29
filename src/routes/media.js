'use strict';

const express = require('express');
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
    const label = library.tags.label(asset);
    const ext = /\.[A-Za-z0-9]{1,5}$/.exec(asset.name)?.[0] || '';
    const filename = label?.name ? `${label.name}${ext}` : asset.name;
    res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.set('Cache-Control', 'private, max-age=3600');
    // A whole-file response is streamed without a length (chunked), which
    // Cloud Run allows at any size; with a length it caps responses at 32 MB.
    const length = Number(driveRes.headers.get('content-length')) || 0;
    await pipeDrive(driveRes, res, ['content-type', 'content-range', 'accept-ranges',
      ...(length && length < MAX_RESPONSE ? ['content-length'] : [])]);
  });

  return router;
}

module.exports = { mediaRoutes };
