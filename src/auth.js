'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const SESSION_COOKIE = 'dam_session';
const STATE_COOKIE = 'dam_oauth';
const SESSION_DAYS = 7;

function readCookies(req) {
  const out = {};
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Not valid percent-encoding: ignore the cookie.
    }
  }
  return out;
}

// Signed (HMAC) cookie values, so a session can't be forged or edited. Each
// carries its purpose (`typ`), so one kind (the short-lived sign-in state)
// can never be used as another (a session).
function sign(secret, typ, data) {
  const body = Buffer.from(JSON.stringify({ ...data, typ })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(secret, typ, value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.typ === typ && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// Only same-site paths, so the sign-in redirect can't send people elsewhere.
const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#17171a;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e2e2de;border-radius:12px;padding:32px;max-width:420px;margin:16px}h1{font-size:20px;margin:0 0 12px}
a.btn{display:inline-block;margin-top:16px;background:#17171a;color:#fff;border-radius:8px;padding:10px 16px;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#111113;color:#ececef}main{background:#1b1b1f;border-color:#2c2c32}a.btn{background:#ececef;color:#111113}}</style>
</head><body><main>${body}</main></body></html>`;
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// "Sign in with Google", limited to Google Workspace domains (checked with the
// ID token's `hd` claim, which only Workspace accounts carry) and/or specific
// email addresses. Sessions are signed cookies.
function googleSignIn({
  clientId, clientSecret, sessionSecret, allowedDomains = [], allowedEmails = [], client,
}) {
  const oauth = client || new OAuth2Client({ clientId, clientSecret });
  const domains = allowedDomains.map((d) => d.toLowerCase());
  const emails = allowedEmails.map((e) => e.toLowerCase());
  const redirectUri = (req) => `${req.protocol}://${req.get('host')}/auth/callback`;
  const secure = (req) => req.protocol === 'https';
  const cookie = (req, name, value, maxAgeSec) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSec}${secure(req) ? '; Secure' : ''}`;

  const allowed = (payload) => {
    if (!payload?.email || !payload.email_verified) return false;
    if (emails.includes(payload.email.toLowerCase())) return true;
    return Boolean(payload.hd) && domains.includes(payload.hd.toLowerCase());
  };

  const router = express.Router();

  router.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('base64url');
    res.set('Set-Cookie', cookie(req, STATE_COOKIE, sign(sessionSecret, 'state', {
      state, next: safeNext(req.query.next), exp: Date.now() + 10 * 60e3,
    }), 600));
    res.redirect(oauth.generateAuthUrl({
      redirect_uri: redirectUri(req),
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
      // Pre-selects the company account on Google's chooser (not a security check).
      ...(domains.length === 1 && !emails.length ? { hd: domains[0] } : {}),
    }));
  });

  router.get('/auth/callback', async (req, res) => {
    const saved = verify(sessionSecret, 'state', readCookies(req)[STATE_COOKIE]);
    if (!saved || saved.state !== req.query.state || !req.query.code) {
      return res.status(400).send(page('Sign-in expired', '<h1>Sign-in expired</h1><p>Please try again.</p><a class="btn" href="/auth/login">Sign in with Google</a>'));
    }
    let payload;
    try {
      const { tokens } = await oauth.getToken({ code: String(req.query.code), redirect_uri: redirectUri(req) });
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      console.error(`Sign-in failed: ${err.message}`);
      return res.status(502).send(page('Sign-in failed', '<h1>Sign-in failed</h1><p>Google sign-in didn\'t complete. Please try again.</p><a class="btn" href="/auth/login">Sign in with Google</a>'));
    }
    const clear = cookie(req, STATE_COOKIE, '', 0);
    if (!allowed(payload)) {
      res.set('Set-Cookie', clear);
      const who = domains.length ? `an @${domains.join(' or @')} Google account` : 'an approved Google account';
      return res.status(403).send(page('No access', `<h1>No access</h1><p>You're signed in as <strong>${escape(payload?.email || 'unknown')}</strong>. RUX Assets needs ${escape(who)}.</p><a class="btn" href="/auth/login">Use another account</a>`));
    }
    const session = sign(sessionSecret, 'session', {
      email: payload.email, name: payload.name || '', hd: payload.hd || '', exp: Date.now() + SESSION_DAYS * 864e5,
    });
    res.set('Set-Cookie', [clear, cookie(req, SESSION_COOKIE, session, SESSION_DAYS * 86400)]);
    res.redirect(safeNext(saved.next));
  });

  router.get('/auth/logout', (req, res) => {
    res.set('Set-Cookie', cookie(req, SESSION_COOKIE, '', 0));
    res.send(page('Signed out', '<h1>Signed out</h1><a class="btn" href="/auth/login">Sign in again</a>'));
  });

  // Everything else needs a session: pages redirect to sign-in, API calls get 401.
  // The account is checked against the allowed domains and emails on every
  // request, so removing someone from them takes effect straight away.
  const requireUser = (req, res, next) => {
    const user = verify(sessionSecret, 'session', readCookies(req)[SESSION_COOKIE]);
    if (user && typeof user.email === 'string' && allowed({ email: user.email, email_verified: true, hd: user.hd })) {
      req.user = { email: user.email, name: user.name };
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required' });
    res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
  };

  return { router, requireUser };
}

module.exports = { googleSignIn, sign, verify };
