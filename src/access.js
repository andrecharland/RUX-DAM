'use strict';

const crypto = require('node:crypto');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Optional shared-password gate via HTTP Basic auth (any username).
function basicAuth(password) {
  return (req, res, next) => {
    if (!password) return next();
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
      if (safeEqual(pass, password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="RUX DAM"').status(401).send('Authentication required');
  };
}

module.exports = { basicAuth };
