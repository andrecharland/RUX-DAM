'use strict';

const { RightsStore } = require('./rights');
const { TagStore } = require('./tags');

// Parses `field:value` filter strings into a Map of field -> Set(lowercased values).
function parseTagFilters(list = []) {
  const filters = new Map();
  for (const item of list) {
    const i = item.indexOf(':');
    if (i < 1) continue;
    const key = item.slice(0, i);
    if (!filters.has(key)) filters.set(key, new Set());
    filters.get(key).add(item.slice(i + 1).toLowerCase());
  }
  return filters;
}

// In-memory index of every asset across the configured Drive folders,
// refreshed on an interval. Fine for tens of thousands of assets.
class Library {
  constructor(drive, folderIds, {
    refreshMs = 10 * 60 * 1000,
    rights = new RightsStore(),
    tags = new TagStore(),
    log = console,
  } = {}) {
    this.drive = drive;
    this.folderIds = folderIds;
    this.refreshMs = refreshMs;
    this.rights = rights;
    this.tags = tags;
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
      for (const [name, store] of [['rights', this.rights], ['tags', this.tags]]) {
        try {
          await store.load();
        } catch (err) {
          errors.push({ store: name, message: err.message });
          this.log.error(`Failed to load ${name}: ${err.message}`);
        }
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

  // Asset as returned by the API: index data plus its effective rights and metadata.
  view(asset) {
    return {
      ...asset,
      rights: this.rights.resolve(asset),
      tags: this.tags.resolve(asset),
      ownTags: this.tags.own(asset.id),
    };
  }

  // Every folder with its parent and how many assets it contains (recursively).
  folderList() {
    const counts = new Map();
    for (const a of this.assets) {
      for (const f of a.ancestors) counts.set(f.id, (counts.get(f.id) || 0) + 1);
    }
    return [...this.folders.values()].map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      parentId: f.ancestors.length ? f.ancestors[f.ancestors.length - 1].id : null,
      ancestors: f.ancestors,
      count: counts.get(f.id) || 0,
      tags: this.tags.own(f.id),
      rights: this.rights.get(f.id),
    }));
  }

  // Filters: free text (name, folder path, metadata values), type, folder
  // (including subfolders), rights status, and metadata values (`field:value`;
  // values in one field are OR-ed, different fields are AND-ed). Also returns
  // value counts per field across the matches, for the filter sidebar.
  search({ q = '', kind = '', folder = '', rights = '', tags = [], offset = 0, limit = 100 } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const tagFilters = parseTagFilters(tags);
    const matches = [];
    const facets = {};
    for (const a of this.assets) {
      if (kind && a.kind !== kind) continue;
      if (folder && !a.ancestors.some((f) => f.id === folder)) continue;
      const view = this.view(a);
      if (rights && view.rights.status !== rights) continue;
      let ok = true;
      for (const [key, wanted] of tagFilters) {
        if (!(view.tags[key] || []).some((t) => wanted.has(t.value.toLowerCase()))) { ok = false; break; }
      }
      if (!ok) continue;
      if (terms.length) {
        const values = Object.values(view.tags).flat().map((t) => t.value).join(' ');
        const haystack = `${a.name} ${a.collection} ${a.path} ${values}`.toLowerCase();
        if (!terms.every((t) => haystack.includes(t))) continue;
      }
      matches.push(view);
      for (const [key, list] of Object.entries(view.tags)) {
        const counts = (facets[key] ||= {});
        for (const { value } of list) counts[value] = (counts[value] || 0) + 1;
      }
    }
    return {
      total: matches.length,
      items: matches.slice(offset, offset + limit),
      facets,
    };
  }

  status() {
    return {
      assets: this.assets.length,
      folders: this.folders.size,
      roots: this.folderIds.length,
      lastSync: this.lastSync,
      syncing: Boolean(this.syncing),
      storage: this.rights.persistent ? 'cloud-storage' : 'memory',
      errors: this.errors,
    };
  }
}

module.exports = { Library };
