'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');
const { JsonStore } = require('./store');

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_FIELDS = ['product', 'activity', 'color', 'vehicle', 'season', 'tags'];
// USD per million input/output tokens, for the running cost estimate.
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
// Models that accept the server-side `fallbacks: "default"` option.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1']);
const MAX_PER_FIELD = 10;
const MAX_VOCAB = 200;

const FIELD_GUIDE = {
  product: 'RUX products or other gear clearly visible (e.g. Duffel, Gear Box, Cooler, Roof Rack, Strap).',
  activity: 'What people are doing, or the activity the scene is about (e.g. Mountain Biking, Camping, Skiing, Overlanding, Road Trip, Fishing). Use Studio for plain product shots.',
  color: 'Main colors of the featured product(s), not the background.',
  vehicle: 'Vehicle make and model when clearly identifiable from badging or design (e.g. Toyota Tacoma, Rivian R1T); otherwise the type (Pickup Truck, SUV, Van). Empty if no vehicle.',
  season: 'Spring, Summer, Fall or Winter, only when the scene makes it evident (snow, autumn leaves...).',
  location: 'The kind of place (e.g. Mountains, Desert, Beach, Forest, City, Studio). Never guess a specific named place unless it is written in the image or folder path.',
  event: 'Only an event named in the folder path or file name.',
  people: 'Only names given in the folder path or file name. Never identify people from their appearance.',
  tags: 'A few other keywords someone would search for: shot type (Lifestyle, Detail, Studio, Action, Landscape), setting, mood.',
};

const SYSTEM = `You tag photos and video stills for RUX, an outdoor gear and carry brand, so the marketing team can find assets later.

For each image you get its file name, its Google Drive folder path, the tags it already has, and the vocabulary of values already in use for each field.

Rules:
- Only suggest values the image (or its folder path or file name) clearly supports. Leave a field empty rather than guess.
- Reuse a value from the vocabulary whenever one fits, spelled exactly as listed. Otherwise use a short Title Case value.
- Don't repeat values the asset already has.
- Never identify a real person from their appearance.
- "description" is one plain sentence describing the image, for search.`;

function emptySuggestions() {
  return { items: {} };
}

// Claude's suggestions per asset, stored as suggestions.json:
//   { items: { [assetId]: { fields: { key: [values] }, description, model, createdAt, error? } } }
// Accepting a value turns it into a tag; dismissing removes it from `fields`.
class SuggestionStore {
  constructor({ auth, bucket, object = 'suggestions.json', log = console } = {}) {
    this.store = new JsonStore({ auth, bucket, object, empty: emptySuggestions, log });
    this.pending = [];
    this.flushing = null;
    this.log = log;
  }

  get items() {
    return this.store.data.items;
  }

  get(id) {
    return this.items[id] || null;
  }

  async load() {
    await this.flush();
    await this.store.load();
  }

  // Applies a change now and saves it in the background, batching writes
  // (a run over a big folder produces many results a second).
  change(mutate) {
    mutate(this.store.data);
    this.pending.push(mutate);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.pending.length >= 25 ? 0 : 3000);
    this.timer.unref?.();
  }

  flush() {
    if (this.flushing) return this.flushing.then(() => this.flush());
    if (!this.pending.length) return Promise.resolve();
    const batch = this.pending.splice(0);
    this.flushing = this.store.update((data) => { for (const fn of batch) fn(data); })
      .catch((err) => this.log.error(`Failed to save suggestions: ${err.message}`))
      .finally(() => { this.flushing = null; });
    return this.flushing;
  }

  set(id, entry) {
    this.change((data) => { data.items[id] = entry; });
  }

  dismiss(id, key, value) {
    this.change((data) => {
      const entry = data.items[id];
      if (!entry?.fields?.[key]) return;
      entry.fields[key] = entry.fields[key].filter((v) => v.toLowerCase() !== value.toLowerCase());
    });
  }

  dismissAll(id) {
    this.change((data) => {
      if (data.items[id]) data.items[id].fields = {};
    });
  }

  // Suggested values the asset doesn't already have, given its effective tags.
  remaining(id, tags) {
    const entry = this.items[id];
    const out = {};
    for (const [key, values] of Object.entries(entry?.fields || {})) {
      const have = new Set((tags[key] || []).map((t) => t.value.toLowerCase()));
      const left = values.filter((v) => !have.has(v.toLowerCase()));
      if (left.length) out[key] = left;
    }
    return out;
  }

  resolve(id, tags) {
    const entry = this.items[id];
    if (!entry) return null;
    const pending = this.remaining(id, tags);
    return {
      pending,
      count: Object.values(pending).reduce((n, v) => n + v.length, 0),
      description: entry.description || '',
      model: entry.model,
      createdAt: entry.createdAt,
      error: entry.error || null,
    };
  }
}

// Sends asset thumbnails to Claude and records its suggested metadata.
// Runs a background queue with a few requests in flight.
class Suggester {
  constructor({ library, drive, apiKey, model = DEFAULT_MODEL, fields = DEFAULT_FIELDS, concurrency = 4, client, log = console }) {
    this.library = library;
    this.drive = drive;
    this.model = model;
    this.fieldKeys = fields;
    this.concurrency = concurrency;
    this.log = log;
    this.client = client || (apiKey ? new Anthropic({ apiKey, maxRetries: 5 }) : null);
    this.queue = [];
    this.queued = new Set();
    this.active = 0;
    this.stats = { done: 0, failed: 0, inputTokens: 0, outputTokens: 0, lastError: null };
  }

  get enabled() {
    return Boolean(this.client);
  }

  status() {
    const [inPrice, outPrice] = PRICES[this.model] || [];
    return {
      enabled: this.enabled,
      model: this.model,
      queued: this.queue.length,
      running: this.active,
      ...this.stats,
      costUsd: inPrice == null ? null
        : (this.stats.inputTokens * inPrice + this.stats.outputTokens * outPrice) / 1e6,
      // Rough per-image cost: ~2,000 input tokens (image + prompt) and ~600 output tokens.
      estimatePerImage: inPrice == null ? null : (2000 * inPrice + 600 * outPrice) / 1e6,
    };
  }

  // Queues assets for suggestions. Skips assets without a preview and, unless
  // `force`, ones that already have suggestions. Returns how many were queued.
  enqueue(ids, { force = false } = {}) {
    let added = 0;
    for (const id of ids) {
      const asset = this.library.byId.get(id);
      if (!asset?.hasThumbnail || this.queued.has(id)) continue;
      if (!force && this.library.suggestions.get(id) && !this.library.suggestions.get(id).error) continue;
      this.queue.push(id);
      this.queued.add(id);
      added++;
    }
    this.pump();
    return added;
  }

  cancel() {
    for (const id of this.queue) this.queued.delete(id);
    this.queue = [];
  }

  pump() {
    while (this.enabled && this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      this.active++;
      this.run(id).catch(() => {}).finally(() => {
        this.active--;
        this.queued.delete(id);
        this.pump();
      });
    }
  }

  fields() {
    return this.library.tags.fields().filter((f) => this.fieldKeys.includes(f.key));
  }

  schema(fields) {
    const properties = { description: { type: 'string' } };
    for (const f of fields) properties[f.key] = { type: 'array', items: { type: 'string' } };
    return {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }

  prompt(asset, fields, tags) {
    const lines = [
      `File name: ${asset.name}`,
      `Folder: ${[asset.collection, asset.path].filter(Boolean).join(' / ') || '(top level)'}`,
      '',
      'Fields:',
      ...fields.map((f) => `- ${f.key} (${f.label}): ${FIELD_GUIDE[f.key] || `Values for "${f.label}".`}`),
      '',
      'Tags it already has:',
      ...fields.map((f) => `- ${f.key}: ${(tags[f.key] || []).map((t) => t.value).join(', ') || '(none)'}`),
      '',
      'Vocabulary in use:',
      ...fields.map((f) => `- ${f.key}: ${f.values.slice(0, MAX_VOCAB).join(', ') || '(none yet)'}`),
    ];
    return lines.join('\n');
  }

  async thumbnail(id) {
    const res = await this.drive.thumbnail(id, 1024);
    if (!res || !res.ok) throw new Error('No preview available from Google Drive');
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const mediaType = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type) ? type : 'image/jpeg';
    return { mediaType, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
  }

  // Suggests metadata for one asset and stores the result.
  async run(id) {
    const asset = this.library.byId.get(id);
    if (!asset) throw new Error('Unknown asset');
    try {
      const fields = this.fields();
      const tags = this.library.tags.resolve(asset);
      const image = await this.thumbnail(id);
      const request = {
        model: this.model,
        max_tokens: 8000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: this.schema(fields) } },
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
            { type: 'text', text: this.prompt(asset, fields, tags) },
          ],
        }],
      };
      if (FALLBACK_MODELS.has(this.model)) {
        request.betas = ['server-side-fallback-2026-07-01'];
        request.fallbacks = 'default';
      }
      const response = await this.client.beta.messages.create(request);
      this.stats.inputTokens += response.usage.input_tokens || 0;
      this.stats.outputTokens += response.usage.output_tokens || 0;
      if (response.stop_reason === 'refusal') {
        throw new Error(`Claude declined this image${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`);
      }
      if (response.stop_reason === 'max_tokens') throw new Error('Response was cut off');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const result = JSON.parse(text);

      const out = {};
      for (const f of fields) {
        const known = new Map(f.values.map((v) => [v.toLowerCase(), v]));
        const values = [];
        for (const raw of Array.isArray(result[f.key]) ? result[f.key] : []) {
          const v = String(raw).trim().slice(0, 80);
          const canon = known.get(v.toLowerCase()) || v;
          if (v && !values.some((x) => x.toLowerCase() === canon.toLowerCase())) values.push(canon);
        }
        if (values.length) out[f.key] = values.slice(0, MAX_PER_FIELD);
      }
      this.library.suggestions.set(id, {
        fields: out,
        description: String(result.description || '').slice(0, 300),
        model: response.model,
        createdAt: new Date().toISOString(),
      });
      this.stats.done++;
    } catch (err) {
      this.stats.failed++;
      this.stats.lastError = err.message;
      this.log.error(`Suggestion failed for ${id}: ${err.message}`);
      this.library.suggestions.set(id, {
        fields: {}, description: '', model: this.model, createdAt: new Date().toISOString(), error: err.message,
      });
      throw err;
    }
  }
}

module.exports = { Suggester, SuggestionStore, DEFAULT_MODEL };
