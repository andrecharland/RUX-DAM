'use strict';

const { RightsStore } = require('./rights');
const { TagStore } = require('./tags');
const { SuggestionStore } = require('./suggest');
const { fileFacets, assetDate, formatOf, SORTS } = require('./fileinfo');
const crypto = require('node:crypto');

function hashIndex(assets, folders) {
  return crypto.createHash('sha1').update(JSON.stringify([assets, folders])).digest('hex');
}

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
//
// With an `index` store (a JsonStore in the data bucket), each sync saves the
// asset list, and a restart shows that saved list right away while a fresh
// sync runs in the background. Metadata (tags, rights, suggestions) is kept
// separately, keyed by Drive file ID, and a sync never changes it.
class Library {
  constructor(drive, folderIds, {
    refreshMs = 10 * 60 * 1000,
    rights = new RightsStore(),
    tags = new TagStore(),
    suggestions = new SuggestionStore(),
    index = null,
    log = console,
  } = {}) {
    this.drive = drive;
    this.folderIds = folderIds;
    this.refreshMs = refreshMs;
    this.rights = rights;
    this.tags = tags;
    this.suggestions = suggestions;
    this.index = index;
    this.log = log;
    this.assets = [];
    this.byId = new Map();
    this.folders = new Map();
    this.lastSync = null;
    this.restoredFrom = null;
    this.syncing = null;
    this.errors = [];
    this.savedIndexHash = null;
  }

  start() {
    this.ready = (async () => {
      await this.loadStores([]);
      await this.restore();
    })();
    this.ready.then(() => this.sync());
    this.timer = setInterval(() => this.sync(), this.refreshMs);
    this.timer.unref();
    return this.ready;
  }

  async loadStores(errors) {
    for (const [name, store] of [['rights', this.rights], ['tags', this.tags], ['suggestions', this.suggestions]]) {
      try {
        await store.load();
      } catch (err) {
        errors.push({ store: name, message: err.message });
        this.log.error(`Failed to load ${name}: ${err.message}`);
      }
    }
  }

  // Sorted deterministically (crawls run in parallel), so an unchanged Drive
  // produces an identical index and isn't saved again.
  setIndex(assets, folders) {
    assets.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '') || a.id.localeCompare(b.id));
    folders.sort((a, b) => a.id.localeCompare(b.id));
    this.assets = assets;
    this.byId = new Map(assets.map((a) => [a.id, a]));
    this.folders = new Map(folders.map((f) => [f.id, f]));
  }

  // Shows the asset list saved by the last sync, until a fresh sync finishes.
  async restore() {
    if (!this.index) return;
    try {
      await this.index.load();
      const { assets = [], folders = [], lastSync = null } = this.index.data;
      if (!assets.length || this.lastSync) return;
      this.setIndex(assets, folders);
      this.lastSync = lastSync;
      this.restoredFrom = lastSync;
      this.savedIndexHash = hashIndex(this.assets, folders);
      this.log.info(`Restored ${assets.length} assets from the index saved at ${lastSync}`);
    } catch (err) {
      this.log.error(`Failed to restore the saved index: ${err.message}`);
    }
  }

  async saveIndex() {
    const folders = [...this.folders.values()];
    const hash = hashIndex(this.assets, folders);
    if (hash === this.savedIndexHash) return; // nothing changed in Drive
    const { assets, lastSync } = this;
    await this.index.update((data) => {
      data.assets = assets;
      data.folders = folders;
      data.lastSync = lastSync;
    });
    this.savedIndexHash = hash;
  }

  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const started = Date.now();
      const assets = [];
      const folders = new Map();
      const errors = [];
      await this.loadStores(errors);
      await Promise.all(this.folderIds.map(async (id) => {
        try {
          const result = await this.drive.crawl(id);
          assets.push(...result.assets);
          for (const f of result.folders) folders.set(f.id, f);
        } catch (err) {
          errors.push({ folderId: id, message: err.message });
          this.log.error(`Failed to sync folder ${id}: ${err.message}`);
          // Keep what we already knew under this folder rather than dropping it.
          const inRoot = (x) => x.id === id || x.ancestors[0]?.id === id;
          assets.push(...this.assets.filter(inRoot));
          for (const f of this.folders.values()) if (inRoot(f)) folders.set(f.id, f);
        }
      }));
      this.setIndex(assets, [...folders.values()]);
      this.errors = errors;
      this.lastSync = new Date().toISOString();
      this.restoredFrom = null;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log.info(`Synced ${assets.length} assets in ${folders.size} folders from ` +
        `${this.folderIds.length} root folder(s) in ${secs}s`);
      if (this.index) {
        try {
          await this.saveIndex();
        } catch (err) {
          this.log.error(`Failed to save the index: ${err.message}`);
        }
      }
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  has(id) {
    return this.byId.has(id);
  }

  // Asset as returned by the API: index data plus its effective rights,
  // metadata, and any of Claude's suggestions not yet accepted or dismissed.
  view(asset) {
    const tags = this.tags.resolve(asset);
    return {
      ...asset,
      format: formatOf(asset),
      rights: this.rights.resolve(asset),
      tags,
      ownTags: this.tags.own(asset.id),
      suggestions: this.suggestions.resolve(asset.id, tags),
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
      suggestions: this.suggestions.resolve(f.id, this.tags.resolve(f)),
    }));
  }

  // Filters: free text (name, folder path, metadata values, Claude's description), type, folder
  // (including subfolders), rights status, and metadata values (`field:value`;
  // values in one field are OR-ed, different fields are AND-ed), and whether
  // there are suggestions to review (`suggested: 'pending'`). File properties
  // filter the same way (`file: ['format:JPG', 'year:2025']`), plus a date range
  // (`from`/`to`, YYYY-MM-DD, on the date taken, else the date added). Also
  // returns value counts per field across the matches, for the filter sidebar.
  search({
    q = '', kind = '', folder = '', rights = '', tags = [], suggested = '', file = [],
    from = '', to = '', sort = 'modified', offset = 0, limit = 100,
  } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const tagFilters = parseTagFilters(tags);
    const fileFilters = parseTagFilters(file);
    const matches = [];
    const facets = {};
    const fileCounts = {};
    for (const a of this.assets) {
      if (kind && a.kind !== kind) continue;
      if (folder && !a.ancestors.some((f) => f.id === folder)) continue;
      const day = assetDate(a).slice(0, 10);
      if (from && (!day || day < from)) continue;
      if (to && (!day || day > to)) continue;
      const props = fileFacets(a);
      const view = this.view(a);
      if (rights && view.rights.status !== rights) continue;
      if (suggested === 'pending' && !view.suggestions?.count) continue;
      if (terms.length) {
        const values = Object.values(view.tags).flat().map((t) => t.value).join(' ');
        const description = view.suggestions?.description || '';
        const haystack = (`${a.name} ${a.collection} ${a.path} ${values} ${description} ` +
          `${props.format} ${props.year || ''} ${props.camera || ''} ${props.orientation || ''}`).toLowerCase();
        if (!terms.every((t) => haystack.includes(t))) continue;
      }

      // Tag and file filter groups this asset fails. Each group's counts ignore
      // that group's own selection, so ticking "Portrait" still shows how many
      // Landscape photos there are to add.
      const failed = [];
      for (const [key, wanted] of tagFilters) {
        if (!(view.tags[key] || []).some((t) => wanted.has(t.value.toLowerCase()))) failed.push(`tag:${key}`);
      }
      for (const [key, wanted] of fileFilters) {
        if (!wanted.has(String(props[key] || '').toLowerCase())) failed.push(`file:${key}`);
      }
      if (failed.length > 1) continue;
      const counts = (group) => !failed.length || failed[0] === group;
      for (const [key, list] of Object.entries(view.tags)) {
        if (!counts(`tag:${key}`)) continue;
        const c = (facets[key] ||= {});
        for (const { value } of list) c[value] = (c[value] || 0) + 1;
      }
      for (const [key, value] of Object.entries(props)) {
        if (!counts(`file:${key}`)) continue;
        const c = (fileCounts[key] ||= {});
        c[value] = (c[value] || 0) + 1;
      }
      if (!failed.length) matches.push(view);
    }
    if (SORTS[sort]) matches.sort(SORTS[sort]);
    return {
      total: matches.length,
      items: matches.slice(offset, offset + limit),
      facets,
      fileFacets: fileCounts,
    };
  }

  status() {
    return {
      assets: this.assets.length,
      folders: this.folders.size,
      roots: this.folderIds.length,
      lastSync: this.lastSync,
      restoredFrom: this.restoredFrom,
      syncing: Boolean(this.syncing),
      storage: this.rights.persistent ? 'cloud-storage' : 'memory',
      errors: this.errors,
    };
  }
}

module.exports = { Library };
