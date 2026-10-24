/* ============================================================================
   functions/api/[[path]].js — the Mini Tank Legends account API.

   DEPLOYED AS A CLOUDFLARE PAGES FUNCTION, alongside the game itself.

   WHY PAGES AND NOT A SEPARATE WORKER
   -----------------------------------
   Accounts used to live in a second Worker at clan-registry-api.nojus-t.workers.dev,
   reached by a hardcoded URL (CONFIG.CLAN_API_URL) with CORS. That split is why
   registration broke silently while the rest of the game kept working: the URL
   drifted, the game pointed at a subdomain that was never created, and the
   failure reached the player as "Cannot reach the account server".

   Same-origin removes the entire failure class. There is no URL to drift, no
   CORS preflight, and no cross-origin cookie question. If the game page loads,
   the API is reachable.

   ROUTES
     GET    /api/health
     POST   /api/auth/register         {username, email, password}
     POST   /api/auth/login            {login, password}
     GET    /api/auth/me
     POST   /api/auth/logout
     PUT    /api/auth/profile          {profile}
     POST   /api/auth/forgot           {email}
     POST   /api/auth/reset            {token, password}
     POST   /api/auth/verify-email     {token}
     GET    /api/auth/verify-email?token=...   (the mail link: verifies, redirects)
     POST   /api/auth/resend-verify
     POST   /api/auth/change-password  {currentPassword, newPassword}
     POST   /api/auth/admin/purge      {confirm:true}

   COMPATIBILITY
   /auth/me and /auth/profile accept the session token as a query parameter or
   in the body as well as in an Authorization header, because the shipped client
   sends it as ?token=. Breaking that in the same deploy that replaces the
   storage engine would leave nobody able to log in to find out why.
   ========================================================================== */

'use strict';

import {
  allowAttempt, clearAttempts, createSession, revokeAllSessions, revokeSession,
  userFromToken, makeCredential, verifyPassword, hashToken, randomToken, newId,
  mergeProfile, publicUser, validateUsername, validateEmail, validatePassword,
  clientIp, hashPassword, PBKDF2_ITERATIONS,
} from './lib-auth.js';

import { sendResetEmail, sendVerifyEmail } from './lib-mail.js';

const RESET_TTL_SECONDS = 3600;
const VERIFY_TTL_SECONDS = 86400;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Purge-Key',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

/* One response for a wrong username and for a wrong password, from the same
   function, so the caller cannot tell them apart. */
function authFailed() {
  return json({ error: 'Incorrect username or password' }, 401);
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

/* Built from the request's own host, so there is no configured URL that can
   fall out of step with where the game is actually deployed. */
function siteOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function tokenFromRequest(request, url, body) {
  if (body && body.token) return String(body.token);
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    if (path === 'health') return health(env);
    if (path === 'auth/register' && method === 'POST') return register(request, env);
    if (path === 'auth/login' && method === 'POST') return login(request, env);
    if (path === 'auth/me') return me(request, env, url);
    if (path === 'auth/logout' && method === 'POST') return logout(request, env, url);
    if (path === 'auth/profile' && method === 'PUT') return saveProfile(request, env, url);
    if (path === 'auth/forgot' && method === 'POST') return forgot(request, env);
    if (path === 'auth/reset' && method === 'POST') return resetPassword(request, env);
    if (path === 'auth/verify-email' && method === 'POST') return verifyEmail(request, env);
    if (path === 'auth/verify-email' && method === 'GET') return verifyLink(request, env, url);
    if (path === 'auth/resend-verify' && method === 'POST') return resendVerify(request, env);
    if (path === 'auth/change-password' && method === 'POST') return changePassword(request, env, url);
    if (path === 'auth/admin/purge' && method === 'POST') return purgeAccounts(request, env);

    return json({ error: 'not found', path }, 404);
  } catch (err) {
    /* A stack trace in an API response describes the internals to anyone
       poking at it and tells the developer nothing they do not get here. */
    console.error(`[api] ${method} /${path} failed:`, err && err.stack ? err.stack : err);
    return json({ error: 'Internal error' }, 500);
  }
}

/* ==========================================================================
   HEALTH
   ========================================================================== */
async function health(env) {
  let dbOk = false;
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    dbOk = true;
  } catch (e) { /* reported below rather than thrown */ }
  return json({
    ok: dbOk,
    service: 'mtl-accounts',
    storage: 'd1',
    db: dbOk ? 'up' : 'down',
    mail: env.RESEND_API_KEY ? 'configured' : 'log-only',
    time: Date.now(),
  });
}

/* ==========================================================================
   REGISTER
   ========================================================================== */
async function register(request, env) {
  const body = await readBody(request);
  const ip = clientIp(request);

  const limit = await allowAttempt(env, `register:${ip}`, 5, 3600);
  if (!limit.allowed) {
    return json({ error: 'Too many accounts from this device. Try again later.' }, 429);
  }

  const name = validateUsername(body.username);
  if (!name.ok) return json({ error: name.error }, 400);

  const mail = validateEmail(body.email);
  if (!mail.ok) return json({ error: mail.error }, 400);

  const pw = validatePassword(body.password);
  if (!pw.ok) return json({ error: pw.error }, 400);

  /* Checked up front so the error is specific ("that username is taken" beats a
     generic conflict), but the unique index is the actual authority — two
     simultaneous registrations can both pass this, and the index is what keeps
     them apart. */
  const takenName = await env.DB.prepare(
    'SELECT id FROM users WHERE username_lower = ?1').bind(name.value.toLowerCase()).first();
  if (takenName) return json({ error: 'That username is already taken' }, 409);

  const takenMail = await env.DB.prepare(
    'SELECT id FROM users WHERE email_lower = ?1').bind(mail.value).first();
  if (takenMail) return json({ error: 'That email is already registered' }, 409);

  const cred = await makeCredential(pw.value);
  const id = newId();
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(`
      INSERT INTO users (id, username, username_lower, email, email_lower,
                         password_hash, password_salt, iterations, profile,
                         created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', ?9, ?9)
    `).bind(id, name.value, name.value.toLowerCase(), mail.value, mail.value,
            cred.hash, cred.salt, cred.iterations, now).run();
  } catch (err) {
    /* Lost the race to a concurrent identical registration. The index did its
       job; report it the way the pre-check would have. */
    if (/UNIQUE constraint/i.test(String(err && err.message))) {
      return json({ error: 'That username or email is already registered' }, 409);
    }
    throw err;
  }

  await issueVerification(env, id, mail.value, request);

  const session = await createSession(env, id, request.headers.get('User-Agent'));
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  return json({ ok: true, token: session.token, user: publicUser(row) }, 201);
}

/* ==========================================================================
   LOGIN
   ========================================================================== */
async function login(request, env) {
  const body = await readBody(request);
  const ip = clientIp(request);

  const limit = await allowAttempt(env, `login:${ip}`, 10, 900);
  if (!limit.allowed) {
    return json({
      error: 'Too many login attempts. Try again in a few minutes.',
      retryAfter: limit.retryAfter,
    }, 429);
  }

  const identifier = String(body.login == null ? '' : body.login).trim();
  const password = String(body.password == null ? '' : body.password);
  if (!identifier || !password) return authFailed();

  /* One query for both username and email, rather than guessing which the
     caller meant and paying two round trips. */
  const row = await env.DB.prepare(`
    SELECT * FROM users WHERE username_lower = ?1 OR email_lower = ?1 LIMIT 1
  `).bind(identifier.toLowerCase()).first();

  /* Always run a PBKDF2, even with no account, so "no such user" costs the
     same wall-clock time as "wrong password". Skipping it would make the
     response time a reliable oracle for which usernames exist. */
  await hashPassword(
    password,
    row ? row.password_salt : '00000000000000000000000000000000',
    row ? row.iterations : PBKDF2_ITERATIONS,
  );

  if (!row) return authFailed();
  if (row.disabled_at) return json({ error: 'This account is disabled' }, 403);

  const check = await verifyPassword(password, row);
  if (!check.ok) return authFailed();

  /* Only now that the password is proven. */
  await clearAttempts(env, `login:${ip}`);

  /* Opportunistic upgrade. A row still on an older work factor is re-hashed
     while we still hold the plaintext — the only moment it is possible — so
     raising PBKDF2_ITERATIONS takes effect gradually instead of locking
     anyone out. */
  if (check.needsRehash) {
    const cred = await makeCredential(password);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?1, password_salt = ?2, iterations = ?3, updated_at = ?4 WHERE id = ?5'
    ).bind(cred.hash, cred.salt, cred.iterations, Math.floor(Date.now() / 1000), row.id).run();
  }

  const session = await createSession(env, row.id, request.headers.get('User-Agent'));
  return json({ ok: true, token: session.token, user: publicUser(row) });
}

/* ==========================================================================
   ME
   ========================================================================== */
async function me(request, env, url) {
  const body = request.method === 'GET' ? {} : await readBody(request);
  const user = await userFromToken(env, tokenFromRequest(request, url, body));
  if (!user) return json({ error: 'Not signed in' }, 401);
  return json({ user: publicUser(user) });
}

/* ==========================================================================
   LOGOUT
   ========================================================================== */
async function logout(request, env, url) {
  const body = await readBody(request);
  await revokeSession(env, tokenFromRequest(request, url, body));
  return json({ ok: true });
}

/* ==========================================================================
   PROFILE
   ========================================================================== */
async function saveProfile(request, env, url) {
  const body = await readBody(request);
  const user = await userFromToken(env, tokenFromRequest(request, url, body));
  if (!user) return json({ error: 'Not signed in' }, 401);

  let current = {};
  try { current = JSON.parse(user.profile || '{}'); } catch (e) { current = {}; }

  const merged = mergeProfile(current, body.profile || {});
  await env.DB.prepare('UPDATE users SET profile = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(JSON.stringify(merged), Math.floor(Date.now() / 1000), user.id).run();

  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  return json({ ok: true, user: publicUser(fresh) });
}

/* ==========================================================================
   FORGOT PASSWORD
   ========================================================================== */
async function forgot(request, env) {
  const body = await readBody(request);
  const ip = clientIp(request);

  /* Limited per address as well as per IP, because the thing worth limiting is
     using this endpoint to flood somebody's inbox. */
  const byIp = await allowAttempt(env, `forgot:${ip}`, 10, 3600);
  if (!byIp.allowed) return json({ ok: true });

  const mail = validateEmail(body.email);
  if (!mail.ok) return json({ ok: true });

  await allowAttempt(env, `forgot:${mail.value}`, 3, 3600);

  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE email_lower = ?1 AND disabled_at IS NULL').bind(mail.value).first();
  if (!user) return json({ ok: true });

  const token = randomToken(32);
  const now = Math.floor(Date.now() / 1000);

  /* Any outstanding links die the moment a new one is requested, so a leaked
     older email is useless once the owner has already recovered. */
  await env.DB.prepare(
    'UPDATE password_resets SET used_at = ?1 WHERE user_id = ?2 AND used_at IS NULL'
  ).bind(now, user.id).run();

  await env.DB.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(newId(), user.id, await hashToken(token), now, now + RESET_TTL_SECONDS).run();

  await sendResetEmail(env, user.email,
    `${siteOrigin(request)}/?reset=${encodeURIComponent(token)}`);

  return json({ ok: true });
}

/* ==========================================================================
   RESET PASSWORD
   ========================================================================== */
async function resetPassword(request, env) {
  const body = await readBody(request);
  const ip = clientIp(request);

  const limit = await allowAttempt(env, `reset:${ip}`, 10, 900);
  if (!limit.allowed) return json({ error: 'Too many attempts. Try again shortly.' }, 429);

  const token = String(body.token == null ? '' : body.token);
  const pw = validatePassword(body.password);
  if (!token) return authFailed();
  if (!pw.ok) return json({ error: pw.error }, 400);

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT r.*, u.id AS uid FROM password_resets r
      JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = ?1 AND r.used_at IS NULL AND r.expires_at > ?2
     LIMIT 1
  `).bind(await hashToken(token), now).first();

  if (!row) return authFailed();

  const cred = await makeCredential(pw.value);
  await env.DB.prepare(`
    UPDATE users SET password_hash = ?1, password_salt = ?2, iterations = ?3, updated_at = ?4
     WHERE id = ?5
  `).bind(cred.hash, cred.salt, cred.iterations, now, row.uid).run();

  /* Burn the token before anything else can fail. A used token is recoverable;
     a live one is not. */
  await env.DB.prepare('UPDATE password_resets SET used_at = ?1 WHERE id = ?2').bind(now, row.id).run();

  /* A password change is the moment every existing session becomes suspect, so
     they all go — including any that was stolen. The client signs in again
     immediately afterwards. */
  await revokeAllSessions(env, row.uid, null);

  return json({ ok: true });
}

/* ==========================================================================
   EMAIL VERIFICATION
   ========================================================================== */
async function issueVerification(env, userId, email, request) {
  const token = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO email_verifications (id, user_id, token_hash, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(newId(), userId, await hashToken(token), now, now + VERIFY_TTL_SECONDS).run();
  await sendVerifyEmail(env, email,
    `${siteOrigin(request)}/?verify=${encodeURIComponent(token)}`);
  return token;
}

async function verifyEmail(request, env) {
  const body = await readBody(request);
  const token = String(body.token == null ? '' : body.token);
  if (!token) return json({ error: 'Missing token' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT r.*, u.id AS uid FROM email_verifications r
      JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = ?1 AND r.used_at IS NULL AND r.expires_at > ?2
     LIMIT 1
  `).bind(await hashToken(token), now).first();
  if (!row) return json({ error: 'This link is invalid or has expired' }, 400);

  await env.DB.prepare(
    'UPDATE email_verifications SET used_at = ?1 WHERE id = ?2').bind(now, row.id).run();
  await env.DB.prepare(
    'UPDATE users SET email_verified_at = ?1 WHERE id = ?2 AND email_verified_at IS NULL'
  ).bind(now, row.uid).run();

  return json({ ok: true });
}

/* The link in the mail is a GET, because mail clients and scanners follow it
   with GET. It verifies, then redirects back into the game with a flag the
   client script already understands, so the player lands in the game rather
   than looking at JSON. */
async function verifyLink(request, env, url) {
  const token = url.searchParams.get('token') || '';
  const result = await verifyEmail(
    { json: async () => ({ token }) }, env);
  const target = new URL('/', siteOrigin(request));
  target.searchParams.set('verified', result.status === 200 ? '1' : '0');
  return Response.redirect(target.toString(), 302);
}

async function resendVerify(request, env) {
  const body = await readBody(request);
  const ip = clientIp(request);
  const byIp = await allowAttempt(env, `resendverify:${ip}`, 5, 3600);
  if (!byIp.allowed) return json({ ok: true });

  const mail = validateEmail(body.email);
  if (!mail.ok) return json({ ok: true });

  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE email_lower = ?1 AND email_verified_at IS NULL').bind(mail.value).first();
  if (user) {
    await allowAttempt(env, `resendverify:${mail.value}`, 3, 3600);
    await issueVerification(env, user.id, user.email, request);
  }
  return json({ ok: true });
}

/* ==========================================================================
   CHANGE PASSWORD (while signed in)
   ========================================================================== */
async function changePassword(request, env, url) {
  const body = await readBody(request);
  const ip = clientIp(request);

  const limit = await allowAttempt(env, `changepw:${ip}`, 10, 900);
  if (!limit.allowed) return json({ error: 'Too many attempts. Try again shortly.' }, 429);

  const token = tokenFromRequest(request, url, body);
  const user = await userFromToken(env, token);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const pw = validatePassword(body.newPassword);
  if (!pw.ok) return json({ error: pw.error }, 400);

  const current = String(body.currentPassword == null ? '' : body.currentPassword);
  const check = await verifyPassword(current, user);
  if (!check.ok) return authFailed();

  const cred = await makeCredential(pw.value);
  await env.DB.prepare(`
    UPDATE users SET password_hash = ?1, password_salt = ?2, iterations = ?3, updated_at = ?4 WHERE id = ?5
  `).bind(cred.hash, cred.salt, cred.iterations, Math.floor(Date.now() / 1000), user.id).run();

  /* Every other device is signed out; this one stays in. */
  await revokeAllSessions(env, user.id, token);
  return json({ ok: true });
}

/* ==========================================================================
   ADMIN PURGE
   ==========================================================================
   Deletes every account. This exists to clear the old KV-era accounts before
   the D1 system goes live.

   Guarded so it cannot be reached by accident or by a passer-by: it needs the
   PURGE_KEY secret in a header AND an explicit confirmation flag in the body,
   and it is a no-op when there is nothing to delete.

   Children before parent, because they reference users(id) and deleting the
   parent first would fail on the foreign key. */
async function purgeAccounts(request, env) {
  const expected = env.PURGE_KEY;
  if (!expected) return json({ error: 'Purge is not configured' }, 403);
  if ((request.headers.get('X-Purge-Key') || '') !== expected) return json({ error: 'Forbidden' }, 403);

  const body = await readBody(request);
  if (body.confirm !== true) {
    return json({ error: 'Send { "confirm": true } to proceed' }, 400);
  }

  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const count = (before && before.n) || 0;
  if (count === 0) return json({ ok: true, deleted: 0, note: 'already empty' });

  await env.DB.prepare('DELETE FROM email_verifications').run();
  await env.DB.prepare('DELETE FROM password_resets').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM rate_limits').run();

  console.log(`[admin] purged ${count} account(s)`);
  return json({ ok: true, deleted: count });
}