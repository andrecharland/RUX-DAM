'use strict';

const { assetDate } = require('./fileinfo');

// How much a shared tag value counts toward "similar".
const WEIGHTS = {
  product: 3, concept: 2, color: 2, activity: 2, vehicle: 2, event: 2, format: 1, aspect: 1,
  season: 1, collection: 2, location: 1, creator: 1, people: 1, tags: 1,
};

// Without visual fingerprints: assets ranked by shared tags, the same shoot
// folder, the same shape and a nearby date. Returns Map(id -> score), best first.
function tagSimilar(library, id, limit = 200) {
  const asset = library.byId.get(id);
  if (!asset) return new Map();
  const values = (a) => {
    const tags = library.tags.resolve(a);
    return new Map(Object.entries(tags).map(([k, list]) => [k, new Set(list.map((t) => t.value.toLowerCase()))]));
  };
  const mine = values(asset);
  const parent = asset.ancestors[asset.ancestors.length - 1]?.id;
  const shape = (a) => (a.width && a.height ? Math.round((a.width / a.height) * 10) : null);
  const myShape = shape(asset);
  const myTime = Date.parse(assetDate(asset)) || 0;

  const scored = [];
  for (const other of library.assets) {
    if (other.id === id) continue;
    let score = 0;
    for (const [key, set] of values(other)) {
      const weight = WEIGHTS[key] || 1;
      for (const v of set) if (mine.get(key)?.has(v)) score += weight;
    }
    if (parent && other.ancestors[other.ancestors.length - 1]?.id === parent) score += 3;
    if (myShape && shape(other) === myShape) score += 0.5;
    const t = Date.parse(assetDate(other)) || 0;
    if (myTime && t && Math.abs(t - myTime) < 7 * 864e5) score += 1;
    if (other.kind === asset.kind) score += 0.25;
    if (score >= 1.5) scored.push([other.id, score]);
  }
  scored.sort((x, y) => y[1] - x[1]);
  return new Map(scored.slice(0, limit));
}

module.exports = { tagSimilar };
