'use strict';

// Production start-up: builds every service from environment variables (see
// the README's Configure table) and serves the app.

const crypto = require('node:crypto');
const { createAuth } = require('./google');
const { DriveClient } = require('./drive');
const { Library } = require('./library');
const { RightsStore } = require('./rights');
const { TagStore } = require('./tags');
const { CurationStore } = require('./curation');
const { ColorStore } = require('./colors');
const { Suggester, SuggestionStore, DEFAULT_MODEL } = require('./suggest');
const { JsonStore } = require('./store');
const { googleSignIn } = require('./auth');
const { VertexEmbedder, EmbeddingIndex } = require('./embeddings');
const { ThumbCache } = require('./thumbcache');

const list = (v) => (v || '').split(/[\s,]+/).filter(Boolean);

// Bare IDs or full Drive folder URLs, comma or whitespace separated.
function parseFolderIds(value = '') {
  return list(value).map((v) => v.match(/folders\/([\w-]+)/)?.[1] || v);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function signInFrom(env) {
  if (!env.GOOGLE_CLIENT_ID) return null;
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set: everyone is signed out whenever the service restarts.');
  }
  if (!list(env.ALLOWED_DOMAINS).length && !list(env.ALLOWED_EMAILS).length) {
    console.warn('Google sign-in is on but ALLOWED_DOMAINS and ALLOWED_EMAILS are empty: nobody can sign in.');
  }
  return googleSignIn({
    clientId: env.GOOGLE_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET?.trim(),
    sessionSecret,
    allowedDomains: list(env.ALLOWED_DOMAINS),
    allowedEmails: list(env.ALLOWED_EMAILS),
  });
}

function start(env = process.env) {
  // Required here, not at the top: server.js requires this file.
  const { createApp } = require('./server');
  const folderIds = parseFolderIds(env.DRIVE_FOLDER_IDS);
  if (!folderIds.length) fail('Set DRIVE_FOLDER_IDS to one or more Google Drive folder IDs or URLs.');
  const signIn = signInFrom(env);
  if (!signIn && !env.DAM_PASSWORD) {
    if (env.ALLOW_ANONYMOUS !== '1') {
      fail('No access control: set up Google sign-in (GOOGLE_CLIENT_ID) or DAM_PASSWORD, ' +
        'or set ALLOW_ANONYMOUS=1 to run the DAM open to anyone with the link.');
    }
    console.warn('ALLOW_ANONYMOUS=1: the DAM is open to anyone with the link.');
  }

  const auth = createAuth();
  const drive = new DriveClient(auth, { concurrency: Number(env.SYNC_CONCURRENCY) || 8 });
  const bucket = env.DATA_BUCKET || env.RIGHTS_BUCKET;
  const library = new Library(drive, folderIds, {
    refreshMs: (Number(env.REFRESH_MINUTES) || 10) * 60 * 1000,
    rights: new RightsStore({ auth, bucket }),
    tags: new TagStore({ auth, bucket }),
    suggestions: new SuggestionStore({ auth, bucket }),
    curation: new CurationStore({ auth, bucket }),
    colors: new ColorStore({ auth, bucket }),
    // The last synced asset list, so restarts don't start from an empty grid.
    index: bucket ? new JsonStore({ auth, bucket, object: 'index.json', empty: () => ({ assets: [], folders: [] }) }) : null,
  });
  const suggester = new Suggester({
    library,
    drive,
    apiKey: env.ANTHROPIC_API_KEY?.trim(),
    model: env.SUGGEST_MODEL || DEFAULT_MODEL,
    fields: env.SUGGEST_FIELDS ? list(env.SUGGEST_FIELDS) : undefined,
    concurrency: Number(env.SUGGEST_CONCURRENCY) || 4,
  });
  if (!suggester.enabled) console.warn('ANTHROPIC_API_KEY is not set: tag suggestions are off.');

  // Visual similarity and search by description, from Vertex AI multimodal
  // embeddings. Fingerprints are kept in the data bucket; new assets are
  // fingerprinted after each sync.
  const vertexOn = /^(1|true|on|yes)$/i.test(env.VERTEX_EMBEDDINGS || '');
  const similarity = new EmbeddingIndex({
    library, drive, auth, bucket,
    rpm: Number(env.VERTEX_RPM) || 100,
    embedder: vertexOn ? new VertexEmbedder({
      auth, project: env.GOOGLE_CLOUD_PROJECT, location: env.VERTEX_LOCATION || 'us-central1',
    }) : null,
  });
  const fingerprintsLoaded = similarity.load().catch((err) => console.error(`Could not load fingerprints: ${err.message}`));
  library.on('synced', () => fingerprintsLoaded.then(() => similarity.queueMissing()));
  // Each sync reloads the rights flags and tags too. Saves are conditional on the stored
  // object's generation, so a failed load can't cause an edit to overwrite them.
  // Once loaded, collect results of batches submitted before a restart and keep checking.
  library.start().then(() => suggester.startPolling());

  const app = createApp({
    library, drive, suggester, signIn, similarity, thumbs: new ThumbCache({ auth, bucket }), password: env.DAM_PASSWORD,
  });
  const port = Number(env.PORT) || 8080;
  return app.listen(port, () => console.log(`RUX DAM listening on :${port}`));
}

module.exports = { start, parseFolderIds };
