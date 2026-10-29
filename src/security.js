'use strict';

// Pages may load scripts, styles and images only from the app itself, and frame
// only Google's Drive video player; nobody may frame the app.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline styles: the sign-in pages' <style> and the grid's per-tile style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  // Drive's player, which may hop through accounts.google.com to sign in.
  'frame-src https://drive.google.com https://*.google.com',
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
].join('; ');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // API answers are per person and change often: never cache them (previews
  // and files set their own caching).
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

// Blocks cross-site requests that change things (CSRF). Browsers send
// Sec-Fetch-Site (and Origin) with POSTs; a page on another site can't fake
// them, and in shared-password mode its forms would otherwise carry the
// browser's saved password. Requests without either header (scripts, curl)
// aren't from a browser page and pass.
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none' ? next() : res.status(403).json({ error: 'Cross-site request refused' });
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Cross-site request refused' });
  next();
}

// A per-person limit on expensive calls (Claude, Vertex AI): at most `max`
// in any `windowMs`. `key(req)` names the person.
function rateLimit({ max, windowMs = 60_000, key = (req) => req.user?.email || req.ip, message = 'Too many requests' }) {
  const hits = new Map();
  // true (and counted) when `req` is within the limit.
  const check = (req) => {
    const now = Date.now();
    const k = key(req);
    const recent = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(k, recent);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
  const middleware = (req, res, next) => (check(req) ? next()
    : res.status(429).set('Retry-After', String(Math.ceil(windowMs / 1000))).json({ error: `${message}. Try again in a minute.` }));
  middleware.check = check;
  return middleware;
}

// Cloud Run refuses responses over 32 MB that declare their length, so video
// playback (which asks for "bytes=0-", the whole file) gets 8 MB pieces; the
// browser asks for the next piece as it plays or seeks. Anything but a plain
// single range is dropped (the whole file is then streamed).
const MAX_RESPONSE = 30 * 1024 * 1024;
const RANGE_CHUNK = 8 * 1024 * 1024;
function limitRange(range) {
  let m = /^bytes=(\d+)-(\d*)$/.exec(range || '');
  if (m) {
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : Infinity, start + RANGE_CHUNK - 1);
    return end >= start ? `bytes=${start}-${end}` : undefined;
  }
  m = /^bytes=-(\d+)$/.exec(range || '');
  if (m) return `bytes=-${Math.min(Number(m[1]), RANGE_CHUNK)}`;
  return undefined;
}

// Files the browser may show inline: raster images and video. Anything else
// (SVG, which can carry scripts, or an unexpected type) is downloaded instead.
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|avif|bmp|tiff|heic|heif)|video\/[\w.+-]+)$/i;
const inlineSafe = (contentType) => INLINE_TYPES.test(String(contentType || '').split(';')[0].trim());

module.exports = { securityHeaders, sameOrigin, rateLimit, limitRange, inlineSafe, MAX_RESPONSE, RANGE_CHUNK, CSP };
