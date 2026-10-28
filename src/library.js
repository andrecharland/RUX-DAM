'use strict';

// In-memory index of every asset across the configured Drive folders,
// refreshed on an interval. Fine for tens of thousands of assets.
class Library {
  constructor(drive, folderIds, { refreshMs = 10 * 60 * 1000, log = console } = {}) {
    this.drive = drive;
    this.folderIds = folderIds;
    this.refreshMs = refreshMs;
    this.log = log;
    this.assets = [];
    this.byId = new Map();
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
      const assets = [];
      const errors = [];
      for (const id of this.folderIds) {
        try {
          assets.push(...await this.drive.crawl(id));
        } catch (err) {
          errors.push({ folderId: id, message: err.message });
          this.log.error(`Failed to sync folder ${id}: ${err.message}`);
        }
      }
      assets.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
      this.assets = assets;
      this.byId = new Map(assets.map((a) => [a.id, a]));
      this.errors = errors;
      this.lastSync = new Date().toISOString();
      this.log.info(`Synced ${assets.length} assets from ${this.folderIds.length} folder(s)`);
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  has(id) {
    return this.byId.has(id);
  }

  collections() {
    const counts = new Map();
    for (const a of this.assets) counts.set(a.collection, (counts.get(a.collection) || 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
  }

  search({ q = '', kind = '', collection = '', offset = 0, limit = 100 } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.assets.filter((a) => {
      if (kind && a.kind !== kind) return false;
      if (collection && a.collection !== collection) return false;
      const haystack = `${a.name} ${a.path} ${a.collection}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
    return {
      total: matches.length,
      items: matches.slice(offset, offset + limit),
    };
  }

  status() {
    return {
      assets: this.assets.length,
      folders: this.folderIds.length,
      lastSync: this.lastSync,
      syncing: Boolean(this.syncing),
      errors: this.errors,
    };
  }
}

module.exports = { Library };
