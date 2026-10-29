'use strict';

// Shared pieces of the API routes.

// Whose favorites: the signed-in person, or everyone together without sign-in.
const who = (req) => req.user?.email || '';

// The ids in a request body, if they're a list (1-5000) of items the library
// knows (assets, or with `folders` also folders). Otherwise answers 400/404
// and returns null.
function idsFrom(library, req, res, { folders = false } = {}) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000) {
    res.status(400).json({ error: 'ids must be a non-empty list' });
    return null;
  }
  const known = (id) => library.has(id) || (folders && library.folders.has(id));
  if (ids.some((id) => !known(id))) {
    res.sendStatus(404);
    return null;
  }
  return ids.map(String);
}

// Last in the chain: invalid input (RangeError from a store) is a 400 with
// its message; anything else is logged and a plain 500.
function errorHandler(err, req, res, _next) {
  if (err instanceof RangeError) return res.status(400).json({ error: err.message });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
}

module.exports = { who, idsFrom, errorHandler };
