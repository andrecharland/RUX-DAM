'use strict';

const { authedFetch } = require('./google');

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,' +
  'thumbnailLink,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),' +
  'webViewLink,parents)';

function isMedia(mimeType) {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/');
}

// macOS "AppleDouble" files (`._name.jpg`) are Finder metadata copied alongside
// real files, not images, even though Drive types them by their extension.
function isJunk(name) {
  return name.startsWith('._');
}

// `ancestors` is the folder chain from the configured root down to the file's
// own folder, as [{ id, name }]. It lets rights flags set on a folder apply to
// everything inside it.
function toAsset(file, folderPath, rootName, ancestors = []) {
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
    ancestors,
  };
}

class DriveClient {
  constructor(auth, { concurrency = 8 } = {}) {
    this.auth = auth;
    this.concurrency = concurrency;
  }

  async request(path, { params = {}, headers = {}, raw = false } = {}) {
    const url = new URL(path.startsWith('http') ? path : API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await authedFetch(this.auth, url, { headers });
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

  // Walks a root folder recursively, listing up to `concurrency` folders at once.
  // Returns every image/video and every folder found.
  async crawl(rootId) {
    const root = await this.getFile(rootId);
    const assets = [];
    const folders = [{ id: rootId, name: root.name, path: '', ancestors: [] }];
    const seen = new Set([rootId]);
    const queue = [{ id: rootId, path: '', ancestors: [{ id: rootId, name: root.name }] }];

    const visit = async ({ id, path, ancestors }) => {
      for (const file of await this.listChildren(id)) {
        if (file.mimeType === FOLDER_MIME) {
          if (seen.has(file.id)) continue;
          seen.add(file.id);
          const childPath = path ? `${path}/${file.name}` : file.name;
          folders.push({ id: file.id, name: file.name, path: childPath, ancestors });
          queue.push({
            id: file.id,
            path: childPath,
            ancestors: [...ancestors, { id: file.id, name: file.name }],
          });
        } else if (isMedia(file.mimeType) && !isJunk(file.name)) {
          assets.push(toAsset(file, path, root.name, ancestors));
        }
      }
    };

    await new Promise((resolve, reject) => {
      let active = 0;
      let failed = false;
      const pump = () => {
        if (failed) return;
        if (!queue.length && !active) return resolve();
        while (active < this.concurrency && queue.length) {
          active++;
          visit(queue.shift()).then(() => { active--; pump(); }, (err) => { failed = true; reject(err); });
        }
      };
      pump();
    });

    return { assets, folders };
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

module.exports = { DriveClient, isMedia, toAsset };
