'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Library } = require('../src/library');
const { TagStore } = require('../src/tags');
const { googleSignIn } = require('../src/auth');

const quiet = { info() {}, warn() {}, error() {} };

// Stands in for Google: the "code" in the callback names which account signed in.
const ACCOUNTS = {
  staff: { email: 'ana@rux.life', email_verified: true, hd: 'rux.life', name: 'Ana' },
  lookalike: { email: 'someone@rux.life.evil.com', email_verified: true, hd: 'rux.life.evil.com' },
  gmail: { email: 'rux.life.fan@gmail.com', email_verified: true },
  freelancer: { email: 'Pat@Studio.com', email_verified: true },
  unverified: { email: 'bob@rux.life', email_verified: false, hd: 'rux.life' },
};
const fakeGoogle = {
  generateAuthUrl: (opts) => `https://accounts.google.test/auth?${new URLSearchParams({ state: opts.state, hd: opts.hd || '', redirect_uri: opts.redirect_uri })}`,
  getToken: async ({ code }) => ({ tokens: { id_token: code } }),
  verifyIdToken: async ({ idToken }) => ({ getPayload: () => ACCOUNTS[idToken] }),
};

async function setup() {
  const library = new Library({ crawl: async () => ({ assets: [], folders: [] }) }, ['root'], { tags: new TagStore({ log: quiet }), log: quiet });
  await library.sync();
  const signIn = googleSignIn({
    clientId: 'cid', sessionSecret: 'test-secret', allowedDomains: ['rux.life'], allowedEmails: ['pat@studio.com'], client: fakeGoogle,
  });
  const server = createApp({ library, drive: {}, signIn }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const cookies = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

  // Full sign-in as one of the fake accounts; returns the final response and cookies.
  async function signInAs(account, next = '/?folder=x') {
    const start = await get(`/auth/login?next=${encodeURIComponent(next)}`);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const res = await get(`/auth/callback?code=${account}&state=${state}`, cookies(start));
    return { res, cookie: cookies(res) };
  }
  return { server, get, signInAs, cookies };
}

test('pages and API need a session; @rux.life Workspace accounts get one', async () => {
  const t = await setup();
  try {
    const page = await t.get('/?tag=product:Duffel');
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get('location'), `/auth/login?next=${encodeURIComponent('/?tag=product:Duffel')}`);
    assert.strictEqual((await t.get('/api/assets')).status, 401);
    assert.strictEqual((await t.get('/app.js')).status, 302, 'static files are protected too');
    assert.strictEqual((await t.get('/healthz')).status, 200);

    const login = await t.get('/auth/login');
    const google = new URL(login.headers.get('location'));
    assert.strictEqual(google.searchParams.get('redirect_uri').endsWith('/auth/callback'), true);

    const { res, cookie } = await t.signInAs('staff');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/?folder=x', 'returns to the page they wanted');
    assert.match(res.headers.getSetCookie().join(), /HttpOnly; SameSite=Lax/);
    assert.strictEqual((await t.get('/api/assets', cookie)).status, 200);
    assert.deepStrictEqual(await (await t.get('/api/me', cookie)).json(), { email: 'ana@rux.life', name: 'Ana' });

    const out = await t.get('/auth/logout', cookie);
    assert.match(out.headers.getSetCookie()[0], /dam_session=; .*Max-Age=0/);
  } finally {
    t.server.close();
  }
});

test('other accounts are refused; listed emails are allowed', async () => {
  const t = await setup();
  try {
    for (const account of ['lookalike', 'gmail', 'unverified']) {
      const { res, cookie } = await t.signInAs(account);
      assert.strictEqual(res.status, 403, account);
      assert.strictEqual(cookie, '', `${account} gets no session`);
    }
    const { res } = await t.signInAs('freelancer');
    assert.strictEqual(res.status, 302, 'ALLOWED_EMAILS works, case-insensitively');
  } finally {
    t.server.close();
  }
});

test('rejects forged sessions, bad state, and off-site redirects', async () => {
  const t = await setup();
  try {
    const { cookie } = await t.signInAs('staff');
    const [name, value] = cookie.split('=');
    const [body, mac] = decodeURIComponent(value).split('.');
    const forgedBody = Buffer.from(JSON.stringify({ email: 'x@evil.com', exp: Date.now() + 1e9 })).toString('base64url');
    assert.strictEqual((await t.get('/api/assets', `${name}=${forgedBody}.${mac}`)).status, 401);
    assert.strictEqual((await t.get('/api/assets', `${name}=${body}.AAAA`)).status, 401);

    const start = await t.get('/auth/login');
    assert.strictEqual((await t.get('/auth/callback?code=staff&state=wrong', t.cookies(start))).status, 400);
    assert.strictEqual((await t.get('/auth/callback?code=staff&state=x')).status, 400, 'no state cookie');

    const { res } = await t.signInAs('staff', '//evil.com/phish');
    assert.strictEqual(res.headers.get('location'), '/');

    // The sign-in state cookie anyone can get from /auth/login is not a session.
    const state = (await t.get('/auth/login')).headers.getSetCookie()[0].split(';')[0].split('=')[1];
    assert.strictEqual((await t.get('/api/assets', `dam_session=${state}`)).status, 401);
    assert.strictEqual((await t.get('/api/me', `dam_session=${state}`)).status, 401);
    // Malformed cookies are ignored, not errors.
    assert.strictEqual((await t.get('/api/assets', 'dam_session=%E0%A4%A')).status, 401);
  } finally {
    t.server.close();
  }
});

test('sessions end when the account is no longer allowed', async () => {
  const t = await setup();
  const { cookie } = await t.signInAs('freelancer');
  t.server.close();
  // Same secret, but pat@studio.com has been removed from ALLOWED_EMAILS.
  const library = new Library({ crawl: async () => ({ assets: [], folders: [] }) }, ['root'], { tags: new TagStore({ log: quiet }), log: quiet });
  const signIn = googleSignIn({ clientId: 'cid', sessionSecret: 'test-secret', allowedDomains: ['rux.life'], client: fakeGoogle });
  const server = createApp({ library, drive: {}, signIn }).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/assets`, { headers: { cookie } });
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});
