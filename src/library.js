'use strict';

const { RightsStore } = require('./rights');
const { TagStore } = require('./tags');
const { SuggestionStore } = require('./suggest');
const { CurationStore } = require('./curation');
const { ColorStore } = require('./colors');
const { fileFacets, assetDate, formatOf, SORTS } = require('./fileinfo');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

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
class Library extends EventEmitter {
  constructor(drive, folderIds, {
    refreshMs = 10 * 60 * 1000,
    rights = new RightsStore(),
    tags = new TagStore(),
    suggestions = new SuggestionStore(),
    curation = new CurationStore(),
    colors = new ColorStore(),
    index = null,
    log = console,
  } = {}) {
    super();
    this.drive = drive;
    this.folderIds = folderIds;
    this.refreshMs = refreshMs;
    this.rights = rights;
    this.tags = tags;
    this.suggestions = suggestions;
    this.curation = curation;
    this.colors = colors;
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
    for (const [name, store] of [['rights', this.rights], ['tags', this.tags], ['suggestions', this.suggestions], ['curation', this.curation], ['colors', this.colors]]) {
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
      this.emit('synced');
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
      label: this.tags.label(asset),
      rights: this.rights.resolve(asset),
      tags,
      ownTags: this.tags.own(asset.id),
      suggestions: this.suggestions.resolve(asset.id, tags),
      rating: this.curation.rating(asset.id),
      color: this.colors.get(asset.id),
    };
  }

  // Every folder with what a folder card needs: asset counts (recursive), the
  // date range of what's inside, and up to 3 recent photos for its cover.
  // `direct` is the same for only the files directly in the folder, plus their
  // median date, so shoots can be ordered by when they happened.
  folderList() {
    const blank = () => ({ count: 0, photos: 0, videos: 0, from: '', to: '', covers: [] });
    const stats = new Map();
    const direct = new Map();
    const add = (map, id, a, date) => {
      const s = map.get(id) || blank();
      s.count++;
      s[a.kind === 'video' ? 'videos' : 'photos']++;
      if (date && (!s.from || date < s.from)) s.from = date;
      if (date && date > s.to) s.to = date;
      if (a.hasThumbnail && s.covers.length < 3) s.covers.push({ id: a.id, modifiedTime: a.modifiedTime });
      map.set(id, s);
      return s;
    };
    for (const a of this.assets) {
      const date = assetDate(a).slice(0, 10);
      for (const f of a.ancestors) add(stats, f.id, a, date);
      const parent = a.ancestors[a.ancestors.length - 1];
      if (parent) {
        const s = add(direct, parent.id, a, date);
        if (date) (s.dates ||= []).push(date);
      }
    }
    for (const s of direct.values()) {
      const dates = (s.dates || []).sort();
      s.date = dates[Math.floor(dates.length / 2)] || '';
      delete s.dates;
    }
    const empty = blank();
    return [...this.folders.values()].map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      parentId: f.ancestors.length ? f.ancestors[f.ancestors.length - 1].id : null,
      ancestors: f.ancestors,
      ...(stats.get(f.id) || empty),
      direct: direct.get(f.id) || { ...empty, date: '' },
      tags: this.tags.own(f.id),
      label: this.tags.label(f),
      rights: this.rights.get(f.id),
      restricted: this.rights.resolve(f).status === 'restricted',
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
  //
  // `rank` (Map id -> score) adds similarity: with rankMode 'only' results are
  // limited to ranked assets, best match first unless another sort is chosen
  // ("looks like this"); with 'append', assets the search text doesn't match
  // but that rank highly are added after the text matches, marked
  // `match: 'visual'` (search by description).
  //
  // Curation: `rating` keeps assets with at least that many stars, `collection`
  // those in a collection (in the collection's order unless another sort is
  // chosen), and `favorites` (a Set of ids, the person's favorites) marks items
  // `favorite: true`, or with `favoritesOnly` keeps only those.
  search({
    q = '', kind = '', folder = '', rights = '', tags = [], suggested = '', file = [],
    from = '', to = '', sort = 'modified', offset = 0, limit = 100, rank = null, rankMode = '',
    rating = 0, collection = '', favorites = null, favoritesOnly = false,
  } = {}) {
    const picked = collection ? new Map((this.curation.collection(collection)?.items || []).map((id, i) => [id, i])) : null;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const tagFilters = parseTagFilters(tags);
    const fileFilters = parseTagFilters(file);
    const matches = [];
    const facets = {};
    const fileCounts = {};
    for (const a of this.assets) {
      if (rankMode === 'only' && !rank?.has(a.id)) continue;
      if (picked && !picked.has(a.id)) continue;
      if (favoritesOnly && !favorites?.has(a.id)) continue;
      if (rating && this.curation.rating(a.id) < rating) continue;
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
        // RUX_ names (titles are made of tag values, already in `values`); a
        // folder's counts for everything inside it.
        const labels = [view.label, ...a.ancestors.map((f) => this.folders.has(f.id) && this.tags.label(this.folders.get(f.id)))]
          .filter(Boolean).map((l) => l.name).join(' ');
        const haystack = (`${a.name} ${a.collection} ${a.path} ${values} ${description} ${labels} ` +
          `${props.format} ${props.year || ''} ${props.camera || ''} ${props.orientation || ''}`).toLowerCase();
        if (!terms.every((t) => haystack.includes(t))) {
          if (rankMode === 'append' && rank?.has(a.id)) view.match = 'visual';
          else continue;
        }
      }

      // Tag and file filter groups this asset fails. Each group's counts ignore
      // that group's own selection, so ticking "Portrait" still shows how many
      // Landscape photos there are to add.
      const failed = [];
      for (const [key, wanted] of tagFilters) {
        if (!(view.tags[key] || []).some((t) => wanted.has(t.value.toLowerCase()))) failed.push(`tag:${key}`);
      }
      for (const [key, wanted] of fileFilters) {
        const values = [].concat(props[key] ?? []);
        if (!values.some((v) => wanted.has(String(v).toLowerCase()))) failed.push(`file:${key}`);
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
        for (const v of [].concat(value)) c[v] = (c[v] || 0) + 1;
      }
      if (favorites?.has(a.id)) view.favorite = true;
      if (!failed.length) matches.push(view);
    }
    const score = (v) => rank?.get(v.id) ?? 0;
    const inOrder = picked && (!sort || sort === 'modified');
    if (inOrder) {
      matches.sort((x, y) => picked.get(x.id) - picked.get(y.id));
    } else if (rankMode === 'only' && (!sort || sort === 'modified')) {
      matches.sort((x, y) => score(y) - score(x));
    } else {
      if (SORTS[sort]) matches.sort(SORTS[sort]);
      if (rankMode === 'append') {
        // Text matches first (in the chosen order), then visual matches, best first.
        const text = matches.filter((v) => !v.match);
        const visual = matches.filter((v) => v.match).sort((x, y) => score(y) - score(x));
        matches.splice(0, matches.length, ...text, ...visual);
      }
    }
    // Per-month counts for date headings and jump-to-date, by the sort's date.
    const dateOf = { modified: (v) => v.modifiedTime, added: (v) => v.createdTime, taken: assetDate, 'taken-asc': assetDate }[sort || 'modified'];
    let months = null;
    if (dateOf && rankMode !== 'only' && !inOrder) {
      months = {};
      for (const v of matches) {
        if (v.match) continue;
        const key = (dateOf(v) || '').slice(0, 7) || 'undated';
        months[key] = (months[key] || 0) + 1;
      }
    }
    return {
      total: matches.length,
      // How many matched the search text itself (the rest look like it).
      textTotal: rankMode === 'append' ? matches.filter((v) => !v.match).length : matches.length,
      items: matches.slice(offset, offset + limit),
      facets,
      fileFacets: fileCounts,
      months,
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
