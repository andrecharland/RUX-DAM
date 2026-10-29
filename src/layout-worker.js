'use strict';

// Runs UMAP off the main thread (a few seconds per thousand photos), so the
// app keeps answering while the visual map is arranged. Receives
// { vectors: Float32Array[] } and posts back { xy: number[] } (x, y pairs).

const { parentPort, workerData } = require('node:worker_threads');
const { UMAP } = require('umap-js');

const { vectors, seed = 1 } = workerData;
// A fixed seed, so rebuilding an unchanged library gives the same map.
let s = seed;
const random = () => {
  s = (s * 16807) % 2147483647;
  return (s - 1) / 2147483646;
};
const data = vectors.map((v) => Array.from(v));
const umap = new UMAP({
  nComponents: 2,
  nNeighbors: Math.max(2, Math.min(15, data.length - 1)),
  minDist: 0.15,
  nEpochs: data.length > 5000 ? 200 : 400,
  random,
});
const out = umap.fit(data);
parentPort.postMessage({ xy: out.flat() });
