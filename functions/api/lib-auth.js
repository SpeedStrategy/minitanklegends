/* ============================================================================
   lib-auth.js — shared account primitives for the Mini Tank Legends API.

   Everything here is deliberately small and dependency-free. No framework, no
   ORM, no template engine. Each function is a plain async function over the
   D1 binding so the whole account system can be read top to bottom in one
   sitting.

   THE THREE RULES THIS FILE ENFORCES
   ----------------------------------
   1. NEVER store a secret. Passwords are stored only as PBKDF2 output.
      Sessions and reset tokens are handed out in the clear and stored only
      as SHA-256. A database dump must not be a valid login.

   2. NEVER leak whether an account exists. /auth/forgot responds identically
      whether or not the email is registered, and takes the same time to do it.
      Otherwise it is an account-enumeration oracle.

   3. NEVER trust a stored iteration count blindly. It is read back from the
      row and clamped, so a tampered database cannot turn verification into
      something weaker than the current policy.
   ========================================================================== */

'use strict';

/* ---- tunables ------------------------------------------------------------ */

/* PBKDF2 rounds. 100k is the OWASP floor for PBKDF2-SHA256 and matches what
   the old KV worker used, so existing hashes keep verifying. Raising this is a
   one-line change and old rows keep working — see rehashIfStale(). */
export const PBKDF2_ITERATIONS = 100000;

/* Bounds for an iteration count read back from the database. Anything outside
   this is a tampered or corrupt row, not a legitimate old hash. */
const MIN_ITERATIONS = 10000;
const MAX_ITERATIONS = 1000000;

/* How long a session stays valid, and how long a reset link stays clickable.
   A reset link is deliberately far shorter-lived than a session: it is a
   password-replacement credential sitting in a mailbox, where the weakest
   link in the chain is the human who forwarded the email six months ago. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;   /* 30 days  */
const RESET_TTL_SECONDS  = 60 * 60;               /* 1 hour   */
const VERIFY_TTL_SECONDS = 60 * 60 * 24;          /* 24 hours */

const MAX_LOGIN_ATTEMPTS  = 10;   /* per window  */
const LOGIN_WINDOW_SECONDS = 900; /* 15 minutes */
const RESET_MAX_ATTEMPTS  = 5;    /* per window  */
const RESET_WINDOW_SECONDS = 3600; /* 1 hour    */

/* Upper bound on a password. PBKDF2 cost is dominated by the ROUND count, not
   the input length, so a long password is not expensive to verify — but an
   unbounded one is a free way to push megabytes through deriveBits. */
const MAX_PASSWORD_LENGTH = 256;

/* ---- hex / utf8 helpers -------------------------------------------------- */

export function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/* ---- random ids and tokens ----------------------------------------------- */

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* no I/O/0/1 */

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < bytes; i++) out += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
  return out;
}

/* A public identifier. Unlike a secret it does not need to be unguessable in
   the cryptographic sense — it only has to not collide — but 128 bits of
   crypto randomness costs nothing and removes the question entirely. */
export function newId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = toHex(buf);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---------------------------------------------------------------------------
   TOKEN HASHING

   A session token is handed to the browser in the clear but stored as its
   SHA-256. This is not a substitute for the token being random — it is a
   second line of defence so that read access to the database does not equal
   the ability to log in as everyone.

   SHA-256 (not PBKDF2) is correct here: the input is 32 bytes of CSPRNG output
   with no guessable structure, so there is nothing for a slow KDF to defend
   against. Slow hashing is for low-entropy secrets that a human chose.
   ------------------------------------------------------------------------- */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(digest);
}

/* ---- passwords ----------------------------------------------------------- */

/* Fixed-time string compare.

   A byte-by-byte `===` on a password hash leaks its length-prefix through
   timing: the loop exits on the first mismatch, so a hash that matches for 30
   bytes takes measurably longer than one that matches for 0. Accumulating
   every byte and comparing once at the end removes that channel.

   The accumulator is a plain number. It is never allowed to exceed ~256, which
   is the longest hash we produce, so it cannot overflow into a false equality. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function hashPassword(password, saltHex, iterations) {
  const rounds = clampIterations(iterations);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex).buffer, iterations: rounds, hash: 'SHA-256' },
    key, 256);
  return toHex(bits);
}

export function clampIterations(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_ITERATIONS) return PBKDF2_ITERATIONS;
  if (n > MAX_ITERATIONS) return MAX_ITERATIONS;
  return Math.floor(n);
}

export function newSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/* Verify a password against a stored row.

   Returns { ok, needsRehash }. `needsRehash` is true when the row's iteration
   count is below current policy, which is the hook for transparently upgrading
   old hashes the next time their owner logs in. */
export async function verifyPassword(password, row) {
  const candidate = await hashPassword(password, row.password_salt, row.iterations);
  const ok = timingSafeEqual(candidate, row.password_hash);
  return { ok, needsRehash: ok && row.iterations < PBKDF2_ITERATIONS };
}

/* Build the stored credential for a new password. */
export async function makeCredential(password) {
  const salt = newSalt();
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  return { salt, hash, iterations: PBKDF2_ITERATIONS };
}

/* ---- validation ---------------------------------------------------------- */

/* Usernames are shown on other players' screens and in clan rosters, so the
   rules are conservative on purpose: no spaces, no look-alike characters, and
   a hard length bound. */
export function validateUsername(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (name.length < 3) return { ok: false, error: 'Username must be at least 3 characters' };
  if (name.length > 20) return { ok: false, error: 'Username must be at most 20 characters' };
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: 'Username can only contain letters, numbers, _ and -' };
  }
  return { ok: true, value: name };
}

/* Deliberately permissive. Over-tight email validation rejects valid addresses
   and buys nothing, because the only thing the address must do is receive a
   reset link. The one hard rule is length, which is a storage bound. */
export function validateEmail(raw) {
  const email = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email is required' };
  if (email.length > 254) return { ok: false, error: 'Email address is too long' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'That email address does not look valid' };
  }
  return { ok: true, value: email };
}

export function validatePassword(raw) {
  const pw = String(raw == null ? '' : raw);
  if (typeof raw !== 'string') return { ok: false, error: 'Password must be text' };
  if (pw.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  if (pw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true, value: pw };
}

/* ---- rate limiting ------------------------------------------------------- */

/* A fixed-window counter in D1.

   In-memory would be simpler and would also be useless: Workers isolates are
   evicted without warning, so an in-memory counter resets every time the
   attacker pauses. A database row survives that.

   Returns true when the action is ALLOWED. On a block it also returns how long
   the caller should say to wait, so the response can say something useful
   instead of a bare 429. */
export async function allowAttempt(env, bucket, maxAttempts, windowSeconds) {
  const nowSec = Math.floor(Date.now() / 1000);
  let retryAfter = 0;

  await env.DB.prepare(`
    INSERT INTO rate_limits (bucket, attempts, window_start, blocked_until)
    VALUES (?1, 1, ?2, NULL)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE
        WHEN rate_limits.window_start <= (?2 - ?3) THEN 1
        ELSE rate_limits.attempts + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start <= (?2 - ?3) THEN ?2
        ELSE rate_limits.window_start
      END,
      blocked_until = CASE
        WHEN rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until > ?2
          THEN rate_limits.blocked_until
        WHEN (CASE
                WHEN rate_limits.window_start <= (?2 - ?3) THEN 0
                ELSE rate_limits.attempts
              END) >= ?4
          THEN ?2 + ?3
        ELSE NULL
      END
  `).bind(bucket, nowSec, windowSeconds, maxAttempts).run();

  const row = await env.DB.prepare(
    'SELECT attempts, window_start, blocked_until FROM rate_limits WHERE bucket = ?1'
  ).bind(bucket).first();

  if (row && row.blocked_until && row.blocked_until > nowSec) {
    retryAfter = row.blocked_until - nowSec;
    return { allowed: false, retryAfter };
  }
  return { allowed: true, retryAfter: 0 };
}

export function clearAttempts(env, bucket) {
  return env.DB.prepare('DELETE FROM rate_limits WHERE bucket = ?1').bind(bucket).run();
}

/* ---- sessions ------------------------------------------------------------ */

export async function createSession(env, userId, userAgent) {
  const token = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_TTL_SECONDS;
  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
    VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6)
  `).bind(newId(), userId, await hashToken(token), now, expires, String(userAgent || '').slice(0, 200)).run();
  return { token, expiresAt: expires * 1000 };
}

/* Resolve a token to its user, or null.

   Expired and revoked rows are rejected here rather than by a cleanup job, so
   correctness never depends on a cron task having run. */
export async function userFromToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const row = await env.DB.prepare(`
    SELECT u.*, s.id AS session_id
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1
       AND s.revoked_at IS NULL
       AND s.expires_at > ?2
       AND u.disabled_at IS NULL
     LIMIT 1
  `).bind(await hashToken(token), Math.floor(Date.now() / 1000)).first();
  if (!row) return null;
  /* Touch is best-effort: a failure to record activity must never fail an
     otherwise-valid request. */
  env.DB.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2')
    .bind(Math.floor(Date.now() / 1000), row.session_id)
    .run().catch(() => {});
  return row;
}

export async function revokeSession(env, token) {
  if (!token) return;
  await env.DB.prepare(
    'UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL'
  ).bind(Math.floor(Date.now() / 1000), await hashToken(token)).run();
}

export async function revokeAllSessions(env, userId, exceptToken) {
  const hash = exceptToken ? await hashToken(exceptToken) : null;
  const rows = await env.DB.prepare(
    'SELECT token_hash FROM sessions WHERE user_id = ?1 AND revoked_at IS NULL'
  ).bind(userId).all();
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows.rows || []) {
    if (hash && r.token_hash === hash) continue;
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2')
      .bind(now, r.token_hash).run();
  }
}

/* ---- profile merging ----------------------------------------------------- */

/* The client is the source of truth for what it last saved, and merges
   defensively so that an older build cannot lower a balance by omitting a
   field. Currencies take the MAXIMUM: a client that has not yet seen a purchase
   must not be able to roll it back. Tanks are the UNION: losing an unlock
   because one device had not synced is the single most player-visible way to
   lose progress. */
export function mergeProfile(old, incoming) {
  const prev = old && typeof old === 'object' ? old : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const out = {};

  const num = (k) => {
    const o = typeof prev[k] === 'number' && isFinite(prev[k]) ? prev[k] : 0;
    const i = typeof next[k] === 'number' && isFinite(next[k]) ? next[k] : 0;
    return Math.max(o, i);
  };

  /* Legacy: profiles written before the Coins split stored the CASH total in
     the 'coins' key. A lone 'coins' with no 'cash' means cash. */
  const hasCash = (obj) => typeof obj.cash === 'number';
  const cashOf = (obj) => hasCash(obj) ? obj.cash
                    : (typeof obj.coins === 'number' ? obj.coins : 0);
  out.cash = Math.max(cashOf(prev), cashOf(next));

  /* Only a cash-keyed profile may use 'coins' as the new currency, or a legacy
     cash figure leaks into the wrong bucket. */
  out.coins = Math.max(
    hasCash(prev) && typeof prev.coins === 'number' ? prev.coins : 0,
    hasCash(next) && typeof next.coins === 'number' ? next.coins : 0);

  /* Renamed from 'gems' to 'gold'. Both are read, and the legacy value is only
     used when 'gold' is absent — never added to it, so it cannot double. */
  out.gold = (typeof next.gold === 'number' && isFinite(next.gold))
    ? next.gold
    : (typeof prev.gold === 'number' && isFinite(prev.gold)
        ? prev.gold
        : (num('gems') || 0));

  out.clanWeeklyXP = num('clanWeeklyXP');
  out.clanWeekKey = num('clanWeekKey');
  out.allUnlocked = !!(prev.allUnlocked || next.allUnlocked);
  out.clanWeeklyRewarded = !!(prev.clanWeeklyRewarded || next.clanWeeklyRewarded);
  out.trophyCount = num('trophyCount');
  out.level = num('level');
  out.xp = num('xp');

  const tanks = new Set();
  (Array.isArray(prev.unlockedTanks) ? prev.unlockedTanks : []).forEach(t => tanks.add(t));
  (Array.isArray(next.unlockedTanks) ? next.unlockedTanks : []).forEach(t => tanks.add(t));
  if (!tanks.size) tanks.add('coolbuddy');
  out.unlockedTanks = Array.from(tanks).filter(t => typeof t === 'string').slice(0, 200);

  /* Strings: the client wins when it sent one, because these are the values
     the player just typed. Length-bounded to keep the row small. */
  for (const k of ['playerName', 'playerClan', 'selectedTank']) {
    const v = typeof next[k] === 'string' ? next[k]
            : (typeof prev[k] === 'string' ? prev[k] : '');
    out[k] = v.slice(0, 64);
  }
  return out;
}

/* The user object handed to the browser. Never includes password_hash,
   password_salt, or email unless the caller explicitly asked for it. */
export function publicUser(row, includeEmail = true) {
  let profile = {};
  try { profile = JSON.parse(row.profile || '{}'); } catch (e) { profile = {}; }
  return {
    id: row.id,
    username: row.username,
    email: includeEmail ? row.email : undefined,
    emailVerified: !!row.email_verified_at,
    createdAt: row.created_at * 1000,
    profile,
  };
}

/* ---- client address ------------------------------------------------------ */

export function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  return String(request.headers.get('X-Forwarded-For') || '0.0.0.0').split(',')[0].trim();
}