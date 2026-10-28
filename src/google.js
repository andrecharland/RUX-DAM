'use strict';

const { GoogleAuth } = require('google-auth-library');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/devstorage.read_write',
];

// Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON), or else Application
// Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, or the Cloud Run service account).
function createAuth(env = process.env) {
  const opts = { scopes: SCOPES };
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    opts.credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  return new GoogleAuth(opts);
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// fetch() with Google auth headers, retrying rate limits and transient errors.
async function authedFetch(auth, url, init = {}, { retries = 4 } = {}) {
  const client = await auth.getClient();
  const authHeaders = Object.fromEntries(new Headers(await client.getRequestHeaders()));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...authHeaders, ...init.headers } });
    if (!RETRYABLE.has(res.status) || attempt >= retries) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 2 ** attempt * 500 + Math.random() * 250));
  }
}

module.exports = { createAuth, authedFetch };
