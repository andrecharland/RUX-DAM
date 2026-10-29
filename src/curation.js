'use strict';

const crypto = require('node:crypto');
const { JsonStore } = require('./store');

const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_ITEMS = 5000;

// Team curation, stored as curation.json:
//   { ratings: { [assetId]: 1-5 },
//     favorites: { [email]: [assetId, …] },
//     collections: { [id]: { id, name, description, items: [assetId, …], createdBy, createdAt, updatedAt } } }
// One rating per asset for the whole team; favorites are per person (email, or
// '' when sign-in is off); collections are hand-picked sets anyone can edit,
// kept in the order assets were added.
class CurationStore {
  constructor({ auth, bucket, object = 'curation.json', log = console } = {}) {
    this.store = new JsonStore({ auth, bucket, object, log,
      empty: () => ({ ratings: {}, favorites: {}, collections: {} }) });
  }

  get persistent() {
    return this.store.persistent;
  }

  get data() {
    return this.store.data;
  }

  load() {
    return this.store.load();
  }

  rating(id) {
    return this.data.ratings[id] || 0;
  }

  // rating 0 clears it.
  async rate(ids, rating) {
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 0 || n > 5) throw new RangeError('Rating must be 0 to 5 stars');
    await this.store.update(({ ratings }) => {
      for (const id of ids) {
        if (n) ratings[id] = n;
        else delete ratings[id];
      }
    });
  }

  favorites(user = '') {
    return new Set(this.data.favorites[user] || []);
  }

  // How many people favorited each asset: Map(id -> count).
  favoriteCounts() {
    const counts = new Map();
    for (const list of Object.values(this.data.favorites)) {
      for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }

  async favorite(user = '', ids, on) {
    await this.store.update(({ favorites }) => {
      const set = new Set(favorites[user] || []);
      for (const id of ids) {
        if (on) set.add(id);
        else set.delete(id);
      }
      if (set.size) favorites[user] = [...set].slice(-MAX_ITEMS);
      else delete favorites[user];
    });
  }

  collections() {
    return Object.values(this.data.collections);
  }

  collection(id) {
    return this.data.collections[id] || null;
  }

  // Collections an asset is in.
  collectionsOf(assetId) {
    return this.collections().filter((c) => c.items.includes(assetId)).map((c) => ({ id: c.id, name: c.name }));
  }

  async createCollection({ name, description = '', ids = [] }, user = '') {
    name = String(name || '').trim().slice(0, MAX_NAME);
    if (!name) throw new RangeError('A collection needs a name');
    const now = new Date().toISOString();
    const c = {
      id: crypto.randomBytes(6).toString('base64url'),
      name,
      description: String(description || '').trim().slice(0, MAX_DESCRIPTION),
      items: [...new Set(ids)].slice(0, MAX_ITEMS),
      createdBy: user,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.update(({ collections }) => { collections[c.id] = c; });
    return this.collection(c.id);
  }

  // { name?, description?, add?: [ids], remove?: [ids] }; added assets go last.
  async updateCollection(id, { name, description, add = [], remove = [] }) {
    if (!this.collection(id)) return null;
    if (name !== undefined && !String(name).trim()) throw new RangeError('A collection needs a name');
    await this.store.update(({ collections }) => {
      const c = collections[id];
      if (!c) return;
      if (name !== undefined) c.name = String(name).trim().slice(0, MAX_NAME);
      if (description !== undefined) c.description = String(description).trim().slice(0, MAX_DESCRIPTION);
      const drop = new Set(remove);
      const items = c.items.filter((x) => !drop.has(x));
      for (const x of add) if (!items.includes(x)) items.push(x);
      c.items = items.slice(0, MAX_ITEMS);
      c.updatedAt = new Date().toISOString();
    });
    return this.collection(id);
  }

  async deleteCollection(id) {
    await this.store.update(({ collections }) => { delete collections[id]; });
  }
}

module.exports = { CurationStore };
