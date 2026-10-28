'use strict';

const { GoogleAuth } = require('google-auth-library');

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,' +
  'thumbnailLink,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),' +
  'webViewLink,parents)';

// Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON), or else Application
// Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, or the Cloud Run service account).
function createAuth(env = process.env) {
  const opts = { scopes: ['https://www.googleapis.com/auth/drive.readonly'] };
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    opts.credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  return new GoogleAuth(opts);
}

function isMedia(mimeType) {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/');
}

function toAsset(file, folderPath, rootName) {
  const meta = file.imageMediaMetadata || file.videoMediaMetadata || {};
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    kind: file.mimeType.startsWith('video/') ? 'video' : 'image',
    size: file.size ? Number(file.size) : null,
    width: meta.width || null,
    height: meta.height || null,
    durationMs: file.videoMediaMetadata?.durationMillis
      ? Number(file.videoMediaMetadata.durationMillis) : null,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    hasThumbnail: Boolean(file.thumbnailLink),
    webViewLink: file.webViewLink,
    collection: rootName,
    path: folderPath,
  };
}

class DriveClient {
  constructor(auth) {
    this.auth = auth;
  }

  async request(path, { params = {}, headers = {}, raw = false } = {}) {
    const client = await this.auth.getClient();
    const authHeaders = await client.getRequestHeaders();
    const url = new URL(path.startsWith('http') ? path : API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { ...Object.fromEntries(new Headers(authHeaders)), ...headers },
    });
    if (raw) return res;
    if (!res.ok) {
      throw new Error(`Drive API ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  getFile(id) {
    return this.request(`/files/${encodeURIComponent(id)}`, {
      params: { fields: 'id,name,mimeType,thumbnailLink', supportsAllDrives: 'true' },
    });
  }

  async listChildren(folderId) {
    const files = [];
    let pageToken;
    do {
      const params = {
        q: `'${folderId}' in parents and trashed = false`,
        fields: FIELDS,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      };
      if (pageToken) params.pageToken = pageToken;
      const page = await this.request('/files', { params });
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  // Walks a root folder recursively and returns every image/video in it.
  async crawl(rootId) {
    const root = await this.getFile(rootId);
    const assets = [];
    const queue = [{ id: rootId, path: '' }];
    const seen = new Set();
    while (queue.length) {
      const { id, path } = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const file of await this.listChildren(id)) {
        if (file.mimeType === FOLDER_MIME) {
          queue.push({ id: file.id, path: path ? `${path}/${file.name}` : file.name });
        } else if (isMedia(file.mimeType)) {
          assets.push(toAsset(file, path, root.name));
        }
      }
    }
    return assets;
  }

  // Drive thumbnail links need auth, so the server proxies them.
  async thumbnail(id, size = 400) {
    const file = await this.getFile(id);
    if (!file.thumbnailLink) return null;
    const link = file.thumbnailLink.replace(/=s\d+$/, `=s${size}`);
    return this.request(link, { raw: true });
  }

  media(id, range) {
    return this.request(`/files/${encodeURIComponent(id)}`, {
      params: { alt: 'media', supportsAllDrives: 'true' },
      headers: range ? { Range: range } : {},
      raw: true,
    });
  }
}

module.exports = { DriveClient, createAuth, isMedia, toAsset };
