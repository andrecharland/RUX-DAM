'use strict';

const { JsonStore } = require('./store');

const DEFAULT_FIELDS = [
  { key: 'product', label: 'Product' },
  { key: 'activity', label: 'Activity' },
  { key: 'color', label: 'Color' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'season', label: 'Season', suggest: ['Spring', 'Summer', 'Fall', 'Winter'] },
  { key: 'event', label: 'Event' },
  { key: 'location', label: 'Location' },
  { key: 'people', label: 'People' },
  { key: 'tags', label: 'Tags' },
];

const MAX_VALUE = 80;
const MAX_VALUES = 50;

function slugify(label) {
  return label.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// Metadata fields and the values set on Drive files and folders, stored as tags.json:
//   { fields: [{ key, label, suggest? }], tags: { [id]: { [fieldKey]: [value, …] } } }
// Values set on a folder apply to everything inside it.
class TagStore {
  constructor({ auth, bucket, object = 'tags.json', log = console } = {}) {
    this.store = new JsonStore({
      auth, bucket, object, log,
      empty: () => ({ fields: DEFAULT_FIELDS.map((f) => ({ ...f })), tags: {} }),
    });
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

  fieldKeys() {
    return new Set(this.data.fields.map((f) => f.key));
  }

  // Fields with every value currently in use plus their preset values, for
  // autocomplete and Claude's vocabulary. `presets` is the editable preset list.
  fields() {
    const used = new Map(this.data.fields.map((f) => [f.key, new Set(f.suggest || [])]));
    for (const tags of Object.values(this.data.tags)) {
      for (const [key, values] of Object.entries(tags)) {
        for (const v of values) used.get(key)?.add(v);
      }
    }
    return this.data.fields.map((f) => ({
      key: f.key,
      label: f.label,
      values: [...used.get(f.key)].sort((a, b) => a.localeCompare(b)),
      presets: f.suggest || [],
    }));
  }

  // Replaces a field's preset values (e.g. the product catalog), which are
  // offered before anything is tagged with them.
  async setPresets(key, values) {
    if (!this.fieldKeys().has(key)) throw new RangeError(`Unknown field: ${key}`);
    if (!Array.isArray(values) || values.length > 2000) throw new RangeError('values must be a list of up to 2000');
    const seen = new Map();
    for (const raw of values) {
      const v = String(raw).trim().slice(0, MAX_VALUE);
      if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    }
    const presets = [...seen.values()];
    await this.store.update((data) => {
      const field = data.fields.find((f) => f.key === key);
      if (field) field.suggest = presets;
    });
    return presets;
  }

  async addField(label) {
    label = String(label || '').trim().slice(0, 40);
    const key = slugify(label);
    if (!key) throw new RangeError('Field name is required');
    if (this.fieldKeys().has(key)) throw new RangeError(`Field "${label}" already exists`);
    await this.store.update((data) => {
      if (!data.fields.some((f) => f.key === key)) data.fields.push({ key, label });
    });
    return { key, label };
  }

  own(id) {
    return this.data.tags[id] || {};
  }

  // Adds and removes the same values on many files/folders at once.
  // `add` and `remove` are { [fieldKey]: [value, …] }.
  apply(ids, { add = {}, remove = {} } = {}) {
    return this.applyEach(ids.map((id) => ({ id, add, remove })));
  }

  // Applies a different change to each item, as one save: [{ id, add, remove }].
  async applyEach(changes) {
    const keys = this.fieldKeys();
    const clean = (obj) => {
      const out = {};
      for (const [key, values] of Object.entries(obj || {})) {
        if (!keys.has(key)) throw new RangeError(`Unknown field: ${key}`);
        if (!Array.isArray(values)) throw new RangeError(`Values for ${key} must be a list`);
        out[key] = values.map((v) => String(v).trim().slice(0, MAX_VALUE)).filter(Boolean);
      }
      return out;
    };
    changes = changes.map(({ id, add, remove }) => ({ id, add: clean(add), remove: clean(remove) }));

    await this.store.update((data) => {
      // Reuse the existing spelling of a value ("duffel" -> "Duffel") so filters stay tidy.
      const canonical = new Map();
      for (const f of this.fields()) {
        for (const v of f.values) canonical.set(`${f.key}\0${v.toLowerCase()}`, v);
      }
      for (const { id, add, remove } of changes) {
        const tags = data.tags[id] || {};
        for (const [key, values] of Object.entries(add)) {
          const current = tags[key] || [];
          for (const raw of values) {
            const v = canonical.get(`${key}\0${raw.toLowerCase()}`) || raw;
            canonical.set(`${key}\0${v.toLowerCase()}`, v);
            if (!current.some((c) => c.toLowerCase() === v.toLowerCase()) && current.length < MAX_VALUES) {
              current.push(v);
            }
          }
          tags[key] = current;
        }
        for (const [key, values] of Object.entries(remove)) {
          const drop = new Set(values.map((v) => v.toLowerCase()));
          tags[key] = (tags[key] || []).filter((v) => !drop.has(v.toLowerCase()));
        }
        for (const key of Object.keys(tags)) if (!tags[key].length) delete tags[key];
        if (Object.keys(tags).length) data.tags[id] = tags;
        else delete data.tags[id];
      }
    });
  }

  // Effective metadata for an asset: values from every enclosing folder plus
  // its own, as { [fieldKey]: [{ value, from }] }. `from` is { scope: 'file' }
  // or { scope: 'folder', id, name } (the nearest folder that set the value).
  resolve(asset) {
    const out = {};
    const add = (tags, from) => {
      for (const [key, values] of Object.entries(tags || {})) {
        const list = (out[key] ||= []);
        for (const value of values) {
          const existing = list.find((e) => e.value.toLowerCase() === value.toLowerCase());
          if (existing) existing.from = from;
          else list.push({ value, from });
        }
      }
    };
    for (const f of asset.ancestors) add(this.data.tags[f.id], { scope: 'folder', id: f.id, name: f.name });
    add(this.data.tags[asset.id], { scope: 'file' });
    return out;
  }
}

module.exports = { TagStore, DEFAULT_FIELDS };
