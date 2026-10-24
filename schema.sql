-- ============================================================================
--  Mini Tank Legends — D1 schema for accounts
-- ============================================================================
--
--  WHY D1 AND NOT KV
--  -----------------
--  The account system used to live in Workers KV. KV on the free plan allows
--  1,000 writes per DAY, and a single account registration costs three writes
--  (user record, email index, session token). That is roughly 333 signups a day
--  before the quota is gone, with nothing left over for progress saves or
--  logins. D1 on the same free plan allows 100,000 rows written per day.
--
--  WHY THIS FILE IS IDEMPOTENT
--  ---------------------------
--  Every statement is IF NOT EXISTS and every migration is recorded in
--  schema_migrations, so `applySchema()` can run on every single request without
--  ever touching existing rows. Deploying a new version can never drop a table,
--  never clear a table, and never lose an account. That is the whole point of
--  putting the migrations in a versioned table rather than in a one-off script
--  somebody has to remember to run.
-- ============================================================================

-- Which migrations have already run. The app reads this and applies only the
-- ones it is missing, so an old deployment and a new one can share a database
-- during a rolling deploy.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
--  users
-- ---------------------------------------------------------------------------
--  username_lower and email_lower exist because Cloudflare D1's default
--  collation is case-SENSITIVE. Without them, "Nojus" and "nojus" would be two
--  different accounts with the same name, and neither login form would resolve.
--
--  The password is stored as PBKDF2-SHA256 with a per-user salt and an
--  iterations count stored PER USER. Storing the iteration count alongside the
--  hash is what lets the work factor be raised later: old hashes keep verifying
--  with their own (lower) count and are silently re-hashed on next login.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT    PRIMARY KEY,
  username          TEXT    NOT NULL,
  username_lower    TEXT    NOT NULL UNIQUE,
  email             TEXT    NOT NULL,
  email_lower       TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  password_salt     TEXT    NOT NULL,
  iterations        INTEGER NOT NULL,
  profile           TEXT    NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  email_verified_at INTEGER,
  disabled_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(username_lower);
CREATE INDEX IF NOT EXISTS idx_users_email_lower    ON users(email_lower);

-- ---------------------------------------------------------------------------
--  sessions
-- ---------------------------------------------------------------------------
--  The client is handed a random token; the DATABASE only ever stores its
--  SHA-256. That way a dump of the database does not hand an attacker live
--  sessions — the same reason the reset tokens below are hashed too.
--
--  expires_at is absolute and checked on every read, so "log out everywhere"
--  and "expire" are the same mechanism and neither needs a cleanup job to be
--  trusted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent   TEXT,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash  ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at  ON sessions(expires_at);

-- ---------------------------------------------------------------------------
--  password_resets
-- ---------------------------------------------------------------------------
--  used_at is set the first time the token is redeemed, so a link that is
--  opened twice fails the second time. expires_at is short (1 hour) because a
--  mailbox is a much less trustworthy place to keep a password reset than it
--  is to keep a game session.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_user       ON password_resets(user_id);

-- ---------------------------------------------------------------------------
--  email_verifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_token_hash ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user       ON email_verifications(user_id);

-- ---------------------------------------------------------------------------
--  rate_limits
-- ---------------------------------------------------------------------------
--  A fixed window per bucket. Buckets are things like "login:<ip>" and
--  "reset:<email>", so this covers BOTH password guessing and using the reset
--  endpoint to flood somebody's inbox. Without this, the reset endpoint is an
--  open email gun pointed at any address a stranger types in.
--
--  Deliberately in the database rather than in memory: a Worker isolate is
--  evicted at will, so an in-memory counter is a counter that resets itself
--  every time an attacker waits a few seconds.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT    PRIMARY KEY,
  attempts      INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,
  blocked_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_blocked_until ON rate_limits(blocked_until);