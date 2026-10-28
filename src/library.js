'use strict';

const { RightsStore } = require('./rights');

// In-memory index of every asset across the configured Drive folders,
// refreshed on an interval. Fine for tens of thousands of assets.
class Library {
  constructor(drive, folderIds, { refreshMs = 10 * 60 * 1000, rights = new RightsStore(), log = console } = {}) {
    this.drive = drive;
    this.folderIds = folderIds;
    this.refreshMs = refreshMs;
    this.rights = rights;
    this.log = log;
    this.assets = [];
    this.byId = new Map();
    this.folders = new Map();
    this.lastSync = null;
    this.syncing = null;
    this.errors = [];
  }

  start() {
    this.sync();
    this.timer = setInterval(() => this.sync(), this.refreshMs);
    this.timer.unref();
  }

  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const started = Date.now();
      const assets = [];
      const folders = new Map();
      const errors = [];
      try {
        await this.rights.load();
      } catch (err) {
        errors.push({ rights: true, message: err.message });
        this.log.error(`Failed to load rights flags: ${err.message}`);
      }
      await Promise.all(this.folderIds.map(async (id) => {
        try {
          const result = await this.drive.crawl(id);
          assets.push(...result.assets);
          for (const f of result.folders) folders.set(f.id, f);
        } catch (err) {
          errors.push({ folderId: id, message: err.message });
          this.log.error(`Failed to sync folder ${id}: ${err.message}`);
        }
      }));
      assets.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      this.assets = assets;
      this.byId = new Map(assets.map((a) => [a.id, a]));
      this.folders = folders;
      this.errors = errors;
      this.lastSync = new Date().toISOString();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log.info(`Synced ${assets.length} assets in ${folders.size} folders from ` +
        `${this.folderIds.length} root folder(s) in ${secs}s`);
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  has(id) {
    return this.byId.has(id);
  }

  // Asset as returned by the API: index data plus its effective usage rights.
  view(asset) {
    return { ...asset, rights: this.rights.resolve(asset) };
  }

  collections() {
    const counts = new Map();
    for (const a of this.assets) counts.set(a.collection, (counts.get(a.collection) || 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
  }

  search({ q = '', kind = '', collection = '', rights = '', offset = 0, limit = 100 } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    for (const a of this.assets) {
      if (kind && a.kind !== kind) continue;
      if (collection && a.collection !== collection) continue;
      const haystack = `${a.name} ${a.path} ${a.collection}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;
      const view = this.view(a);
      if (rights && view.rights.status !== rights) continue;
      matches.push(view);
    }
    return {
      total: matches.length,
      items: matches.slice(offset, offset + limit),
    };
  }

  status() {
    return {
      assets: this.assets.length,
      folders: this.folders.size,
      roots: this.folderIds.length,
      lastSync: this.lastSync,
      syncing: Boolean(this.syncing),
      rightsStorage: this.rights.persistent ? 'cloud-storage' : 'memory',
      errors: this.errors,
    };
  }
}

module.exports = { Library };
