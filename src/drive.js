'use strict';

const { authedFetch } = require('./google');
const { parseTakenTime } = require('./fileinfo');

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Drive's thumbnail links last a few hours; reuse them for up to an hour.
const LINK_TTL = 60 * 60 * 1000;

const FIELDS = 'nextPageToken,files(id,name,mimeType,fileExtension,size,createdTime,modifiedTime,' +
  'thumbnailLink,imageMediaMetadata(width,height,rotation,time,cameraMake,cameraModel),' +
  'videoMediaMetadata(width,height,durationMillis),webViewLink,parents)';

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
  // Drive reports the stored pixel size; a 90°/270° EXIF rotation swaps it as displayed.
  const turned = file.imageMediaMetadata?.rotation % 2 === 1;
  const image = file.imageMediaMetadata || {};
  const camera = [image.cameraMake, image.cameraModel].filter(Boolean).join(' ').trim();
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    kind: file.mimeType.startsWith('video/') ? 'video' : 'image',
    fileExtension: (file.fileExtension || '').toLowerCase() || undefined,
    size: file.size ? Number(file.size) : null,
    width: (turned ? meta.height : meta.width) || null,
    height: (turned ? meta.width : meta.height) || null,
    takenTime: parseTakenTime(image.time) || undefined,
    // "Canon Canon EOS R5" -> "Canon EOS R5"
    camera: camera.replace(/^(\S+) \1\b/i, '$1') || undefined,
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
  constructor(auth, { concurrency = 8, thumbnailConcurrency = 12 } = {}) {
    this.auth = auth;
    this.concurrency = concurrency;
    // Thumbnail links from the last crawl (or a lookup): id -> { url, at }.
    // They are signed URLs that expire after a while, so they're refreshed by
    // every sync and fetched again when one stops working.
    this.links = new Map();
    this.thumbnailSlots = thumbnailConcurrency;
    this.waiting = [];
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
          if (file.thumbnailLink) this.links.set(file.id, { url: file.thumbnailLink, at: Date.now() });
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
  // A preview image at `size` px. Uses the cached link when it's recent, and
  // looks the link up again once if Drive rejects it (expired).
  async thumbnail(id, size = 400) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const link = await this.thumbnailLink(id, attempt > 0);
      if (!link) return null;
      const res = await this.throttle(() => this.request(link.replace(/=s\d+$/, `=s${size}`), { raw: true }));
      if (res.ok || attempt) return res;
      await res.body?.cancel();
    }
    return null;
  }

  async thumbnailLink(id, fresh = false) {
    const hit = this.links.get(id);
    if (!fresh && hit && Date.now() - hit.at < LINK_TTL) return hit.url;
    const file = await this.getFile(id);
    if (file.thumbnailLink) this.links.set(id, { url: file.thumbnailLink, at: Date.now() });
    return file.thumbnailLink || null;
  }

  // Runs at most `thumbnailConcurrency` preview fetches at once, so a page of
  // 120 tiles doesn't hit Drive's rate limits all at the same moment.
  async throttle(fn) {
    if (this.thumbnailSlots > 0) this.thumbnailSlots--;
    else await new Promise((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.thumbnailSlots++;
    }
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
