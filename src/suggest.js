'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');
const { JsonStore } = require('./store');

const DEFAULT_MODEL = 'claude-haiku-5-5';
// Fields Claude fills in per photo, and per shoot (from sample photos of a folder).
const DEFAULT_FIELDS = ['product', 'activity', 'color', 'vehicle', 'season', 'tags'];
const FOLDER_FIELDS = ['activity', 'season', 'location', 'event', 'vehicle', 'tags'];
const FOLDER_SAMPLES = 6;
// Runs bigger than this go through the Message Batches API (half price, results within hours).
const BATCH_MIN = 50;
const BATCH_CHUNK = 400;
const PREVIEW_SIZE = 768;
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
  product: 'RUX products or other gear clearly visible. When a product matches one in the vocabulary (the RUX catalog), use that exact name; otherwise a short generic name (e.g. Duffel, Gear Box, Roof Rack).',
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
- "description" is one plain sentence describing the image (or the shoot), for search.`;

function emptySuggestions() {
  return { items: {}, batches: [] };
}

// Claude's suggestions per asset or folder, stored as suggestions.json:
//   { items: { [id]: { fields: { key: [values] }, description, model, createdAt, error? } },
//     batches: [{ id, ids: [assetIds], createdAt }] }   (batches still running)
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

  get batches() {
    return this.store.data.batches || [];
  }

  addBatch(record) {
    this.change((data) => {
      data.batches = (data.batches || []).filter((b) => b.id !== record.id).concat(record);
    });
    return this.flush();
  }

  removeBatch(id) {
    this.change((data) => { data.batches = (data.batches || []).filter((b) => b.id !== id); });
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

// Sends previews to Claude and records its suggested metadata. Small runs go
// through a background queue; runs over BATCH_MIN photos go through the Message
// Batches API at half price, polled until done (batches survive restarts).
class Suggester {
  constructor({
    library, drive, apiKey, model = DEFAULT_MODEL, fields = DEFAULT_FIELDS, folderFields = FOLDER_FIELDS,
    concurrency = 4, batchMin = BATCH_MIN, pollMs = 60_000, client, log = console,
  }) {
    this.library = library;
    this.drive = drive;
    this.model = model;
    this.fieldKeys = fields;
    this.folderFieldKeys = folderFields;
    this.concurrency = concurrency;
    this.batchMin = batchMin;
    this.pollMs = pollMs;
    this.log = log;
    this.client = client || (apiKey ? new Anthropic({ apiKey, maxRetries: 5 }) : null);
    this.queue = [];
    this.queued = new Set();
    this.active = 0;
    this.preparing = null; // { done, total } while thumbnails for a batch download
    this.batchCounts = new Map(); // batch id -> request_counts
    this.stats = { done: 0, failed: 0, costUsd: 0, lastError: null };
  }

  get enabled() {
    return Boolean(this.client);
  }

  startPolling() {
    if (!this.enabled) return;
    this.pollBatches();
    this.pollTimer = setInterval(() => this.pollBatches(), this.pollMs);
    this.pollTimer.unref?.();
  }

  // Cost of one response, counting cached input at its reduced rates and
  // batch results at half price.
  addCost(usage, { batch = false } = {}) {
    const [inPrice, outPrice] = PRICES[this.model] || [];
    if (inPrice == null) return;
    const cost = ((usage.input_tokens || 0) * inPrice
      + (usage.cache_creation_input_tokens || 0) * inPrice * 1.25
      + (usage.cache_read_input_tokens || 0) * inPrice * 0.1
      + (usage.output_tokens || 0) * outPrice) / 1e6;
    this.stats.costUsd += batch ? cost / 2 : cost;
  }

  status() {
    const [inPrice, outPrice] = PRICES[this.model] || [];
    const batches = this.library.suggestions.batches.map((b) => ({
      id: b.id, count: b.ids.length, createdAt: b.createdAt, ...(this.batchCounts.get(b.id) || {}),
    }));
    return {
      enabled: this.enabled,
      model: this.model,
      queued: this.queue.length,
      running: this.active,
      preparing: this.preparing,
      batches,
      batchMin: this.batchMin,
      ...this.stats,
      costUsd: inPrice == null ? null : this.stats.costUsd,
      // Rough per-photo cost at full price: ~1,500 input tokens (preview + prompt) and ~500 output.
      estimatePerImage: inPrice == null ? null : (1500 * inPrice + 500 * outPrice) / 1e6,
    };
  }

  // Assets worth sending: they have a preview, aren't already in flight, and
  // (unless `force`) don't already have suggestions.
  eligible(ids, { force = false } = {}) {
    const inBatch = new Set(this.library.suggestions.batches.flatMap((b) => b.ids));
    return [...new Set(ids)].filter((id) => {
      const asset = this.library.byId.get(id);
      if (!asset?.hasThumbnail || this.queued.has(id) || inBatch.has(id)) return false;
      const existing = this.library.suggestions.get(id);
      return force || !existing || existing.error;
    });
  }

  // Suggests for many assets: in a batch when there are more than `batchMin`,
  // otherwise through the queue. Returns { added, batch }.
  submit(ids, { force = false } = {}) {
    const targets = this.eligible(ids, { force });
    if (targets.length > this.batchMin) {
      this.submitBatch(targets).catch((err) => {
        this.stats.lastError = err.message;
        this.log.error(`Batch submission failed: ${err.message}`);
      });
      return { added: targets.length, batch: true };
    }
    return { added: this.enqueue(targets, { force }), batch: false };
  }

  enqueue(ids, { force = false } = {}) {
    const targets = this.eligible(ids, { force });
    for (const id of targets) {
      this.queue.push(id);
      this.queued.add(id);
    }
    this.pump();
    return targets.length;
  }

  async cancel() {
    for (const id of this.queue) this.queued.delete(id);
    this.queue = [];
    for (const b of this.library.suggestions.batches) {
      try {
        await this.client.messages.batches.cancel(b.id);
      } catch (err) {
        this.log.error(`Could not cancel batch ${b.id}: ${err.message}`);
      }
    }
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

  fields(keys = this.fieldKeys) {
    return this.library.tags.fields().filter((f) => keys.includes(f.key));
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

  // Instructions, field guide and vocabulary: identical for every request in a
  // run (photo or shoot), so it's cached and later requests read it at ~10% of the price.
  system() {
    const fields = this.fields([...new Set([...this.fieldKeys, ...this.folderFieldKeys])]);
    const text = [
      SYSTEM,
      '',
      'Fields:',
      ...fields.map((f) => `- ${f.key} (${f.label}): ${FIELD_GUIDE[f.key] || `Values for "${f.label}".`}`),
      '',
      'Vocabulary in use:',
      ...fields.map((f) => `- ${f.key}: ${f.values.slice(0, MAX_VOCAB).join(', ') || '(none yet)'}`),
    ].join('\n');
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  existing(fields, tags) {
    return ['Tags it already has:',
      ...fields.map((f) => `- ${f.key}: ${(tags[f.key] || []).map((t) => t.value).join(', ') || '(none)'}`)];
  }

  async thumbnail(id) {
    const res = await this.drive.thumbnail(id, PREVIEW_SIZE);
    if (!res || !res.ok) throw new Error('No preview available from Google Drive');
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const mediaType = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type) ? type : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(await res.arrayBuffer()).toString('base64') } };
  }

  params(content, fields) {
    return {
      model: this.model,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: this.schema(fields) } },
      system: this.system(),
      messages: [{ role: 'user', content }],
    };
  }

  // Request for one photo: its preview, then the per-photo details.
  async photoParams(asset) {
    const fields = this.fields();
    const tags = this.library.tags.resolve(asset);
    const text = [
      `File name: ${asset.name}`,
      `Folder: ${[asset.collection, asset.path].filter(Boolean).join(' / ') || '(top level)'}`,
      `Fill in only these fields: ${fields.map((f) => f.key).join(', ')}.`,
      '',
      ...this.existing(fields, tags),
    ].join('\n');
    return { fields, params: this.params([await this.thumbnail(asset.id), { type: 'text', text }], fields) };
  }

  async create(params) {
    const request = { ...params };
    if (FALLBACK_MODELS.has(this.model)) {
      request.betas = ['server-side-fallback-2026-07-01'];
      request.fallbacks = 'default';
    }
    const response = await this.client.beta.messages.create(request);
    this.addCost(response.usage || {});
    return response;
  }

  // Turns a response into cleaned-up values per field (existing spellings reused).
  parse(response, fields) {
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
    return {
      fields: out,
      description: String(result.description || '').slice(0, 300),
      model: response.model || this.model,
      createdAt: new Date().toISOString(),
    };
  }

  record(id, fn) {
    try {
      this.library.suggestions.set(id, fn());
      this.stats.done++;
    } catch (err) {
      this.fail(id, err);
      throw err;
    }
  }

  fail(id, err) {
    this.stats.failed++;
    this.stats.lastError = err.message;
    this.log.error(`Suggestion failed for ${id}: ${err.message}`);
    this.library.suggestions.set(id, {
      fields: {}, description: '', model: this.model, createdAt: new Date().toISOString(), error: err.message,
    });
  }

  // Suggests metadata for one photo right away and stores the result.
  async run(id) {
    const asset = this.library.byId.get(id);
    if (!asset) throw new Error('Unknown asset');
    let built;
    let response;
    try {
      built = await this.photoParams(asset);
      response = await this.create(built.params);
    } catch (err) {
      this.fail(id, err);
      throw err;
    }
    this.record(id, () => this.parse(response, built.fields));
  }

  // Suggests shoot-level tags for a folder from a few sample photos spread
  // across it, in one request. The result is stored on the folder.
  async runFolder(folderId) {
    const folder = this.library.folders.get(folderId);
    if (!folder) throw new Error('Unknown folder');
    const inside = this.library.assets
      .filter((a) => a.hasThumbnail && a.ancestors.some((f) => f.id === folderId))
      .sort((a, b) => `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`));
    if (!inside.length) throw new Error('No photos with previews in this folder');
    const step = inside.length / Math.min(FOLDER_SAMPLES, inside.length);
    const samples = Array.from({ length: Math.min(FOLDER_SAMPLES, inside.length) }, (_, i) => inside[Math.floor(i * step)]);

    const fields = this.fields(this.folderFieldKeys);
    const tags = this.library.tags.resolve(folder);
    const path = [...folder.ancestors.map((a) => a.name), folder.name].join(' / ');
    const text = [
      `These ${samples.length} photos are samples from one shoot folder: ${path}`,
      `File names: ${samples.map((a) => a.name).join(', ')}`,
      'Suggest values that apply to the whole shoot (true for most of the samples), not ones that vary from photo to photo.',
      `Fill in only these fields: ${fields.map((f) => f.key).join(', ')}. The description should describe the shoot.`,
      '',
      ...this.existing(fields, tags),
    ].join('\n');
    let response;
    try {
      const images = await Promise.all(samples.map((a) => this.thumbnail(a.id)));
      response = await this.create(this.params([...images, { type: 'text', text }], fields));
    } catch (err) {
      this.fail(folderId, err);
      throw err;
    }
    this.record(folderId, () => this.parse(response, fields));
  }

  // Downloads previews and submits them as one or more batches (chunked to
  // stay well under the 256 MB request limit). Batch ids are saved so results
  // are collected even after a restart.
  async submitBatch(ids) {
    this.preparing = { done: 0, total: ids.length };
    try {
      for (let i = 0; i < ids.length; i += BATCH_CHUNK) {
        const chunk = ids.slice(i, i + BATCH_CHUNK);
        const requests = [];
        let next = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (next < chunk.length) {
            const id = chunk[next++];
            try {
              const { params } = await this.photoParams(this.library.byId.get(id));
              requests.push({ custom_id: id, params });
            } catch (err) {
              this.fail(id, err);
            }
            this.preparing.done++;
          }
        }));
        if (!requests.length) continue;
        const batch = await this.client.messages.batches.create({ requests });
        await this.library.suggestions.addBatch({
          id: batch.id, ids: requests.map((r) => r.custom_id), createdAt: new Date().toISOString(),
        });
        this.log.info(`Submitted batch ${batch.id} with ${requests.length} photos`);
      }
    } finally {
      this.preparing = null;
    }
  }

  // Checks running batches and stores the results of finished ones.
  async pollBatches() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      for (const b of [...this.library.suggestions.batches]) {
        try {
          const batch = await this.client.messages.batches.retrieve(b.id);
          this.batchCounts.set(b.id, { status: batch.processing_status, ...batch.request_counts });
          if (batch.processing_status !== 'ended') continue;
          const fields = this.fields();
          const seen = new Set();
          for await (const result of await this.client.messages.batches.results(b.id)) {
            seen.add(result.custom_id);
            if (result.result.type === 'succeeded') {
              this.addCost(result.result.message.usage || {}, { batch: true });
              try {
                this.record(result.custom_id, () => this.parse(result.result.message, fields));
              } catch {
                // Recorded as an error on the asset.
              }
            } else {
              this.fail(result.custom_id, new Error(`Batch request ${result.result.type}`));
            }
          }
          for (const id of b.ids) if (!seen.has(id)) this.fail(id, new Error('Missing from batch results'));
          this.library.suggestions.removeBatch(b.id);
          this.batchCounts.delete(b.id);
          await this.library.suggestions.flush();
          this.log.info(`Collected results of batch ${b.id}`);
        } catch (err) {
          this.log.error(`Could not check batch ${b.id}: ${err.message}`);
        }
      }
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
}

module.exports = { Suggester, SuggestionStore, DEFAULT_MODEL, BATCH_MIN };
