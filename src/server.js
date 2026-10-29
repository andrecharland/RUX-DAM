'use strict';

const path = require('node:path');
const express = require('express');
const compression = require('compression');
const { ThumbCache } = require('./thumbcache');
const { MapLayout } = require('./layout');
const { securityHeaders, sameOrigin, rateLimit } = require('./security');
const { basicAuth } = require('./access');
const { assetRoutes } = require('./routes/assets');
const { metadataRoutes } = require('./routes/metadata');
const { curationRoutes } = require('./routes/curation');
const { suggestRoutes } = require('./routes/suggest');
const { mediaRoutes } = require('./routes/media');
const { errorHandler } = require('./routes/helpers');
const { start, parseFolderIds } = require('./start');

// The web app: security headers, access control (Google sign-in when
// `signIn` is given, see auth.js, otherwise the optional shared password),
// the front end, and the API (routes/).
function createApp({
  library, drive, password, suggester, signIn, similarity, thumbs = new ThumbCache(),
  layout = similarity ? new MapLayout({ similarity }) : null,
}) {
  const app = express();
  app.disable('x-powered-by');
  // Cloud Run terminates HTTPS in front of the app; trust its forwarded headers.
  app.set('trust proxy', true);
  // Gzip JSON, HTML, CSS and JS (images and video are already compressed and skipped).
  app.use(compression());
  app.use(securityHeaders);
  app.get('/healthz', (req, res) => res.send('ok'));
  if (signIn) {
    app.use(signIn.router);
    app.use(signIn.requireUser);
  } else {
    app.use(basicAuth(password));
  }
  app.use(sameOrigin);
  app.get('/api/me', (req, res) => res.json(req.user || null));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Claude and Vertex AI cost money per call: generous per-person limits stop a
  // runaway script (or a stolen session) from running up a bill.
  const claudeLimit = rateLimit({ max: 30, message: 'Too many Claude requests' });
  const visualLimit = rateLimit({ max: 60 });
  app.use(assetRoutes({ library, similarity, visualLimit, layout }));
  app.use(metadataRoutes({ library }));
  app.use(curationRoutes({ library }));
  app.use(suggestRoutes({ library, suggester, claudeLimit }));
  app.use(mediaRoutes({ library, drive, thumbs }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, parseFolderIds };

if (require.main === module) start();
