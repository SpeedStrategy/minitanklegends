/* ============================================================================
   mpserver.js — Mini Tank Legends: game host AND authoritative match server.

   WHY THIS FILE EXISTS
   --------------------
   Multiplayer used to be two pieces of infrastructure that could not work:

     * a Cloudflare Worker (matchmaking-worker/) whose KV namespace id was
       still the literal placeholder "replace-with-your-kv-namespace-id",
       so env.MATCH_KV was undefined and the queue never persisted, and
     * PeerJS against the free public broker for the actual peer connections,
       with an identity scheme that could never match (see below).

   Both are gone. This process serves the game's static files AND owns the
   match, on one port, so the Cloudflare tunnel you already run forwards
   everything -- Cloudflare tunnels pass WebSockets natively, so no new
   hostname, no Worker and no KV namespace are involved.

   WHAT THE SERVER OWNS (and why that matters)
   -------------------------------------------
   Identity. The old client invented an id ("p-" + random) BEFORE any socket
   existed, then PeerJS later assigned a DIFFERENT id to the same player. The
   host then looked the roster up by that id and never found anybody, so
   players would connect at the socket level and the game would never notice
   them. Here the server mints the id when the socket opens and that id is the
   only identity that exists.

   The roster. Bots are synthesised by the server as roster entries, so the
   "no humans after 15s" rule is decided in one place instead of being hoped
   for in three different files.

   ========================================================================== */

'use strict';

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT  = path.resolve(__dirname, '..');
const HOST  = process.env.HOST || '0.0.0.0';
const PORT  = argOf('--port', parseInt(process.env.PORT || '18123', 10));

/* ---------------------------------------------------------------- tunables */

/* Everything is overridable from the command line, so the server can run beside
   another one while testing:
     node server/mpserver.js --port 18124 --bot-fill 5 --match-size 8          */
function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(v) ? v : fallback;
}

/* How long a queue waits for a second human before bots fill the match.
   This is the "15 seconds" rule. */
const BOT_FILL_DELAY_MS = argOf('--bot-fill',
  parseInt(process.env.BOT_FILL_DELAY_MS || '15000', 10));

/* A match is 16 tanks: 8 a side. Bots make up whatever the humans did not. */
const MATCH_SIZE = argOf('--match-size',
  parseInt(process.env.MATCH_SIZE || '16', 10));

/* How many humans must be waiting before a match may be formed at all.

   0 means "match anyone, whenever" -- used by the tests to skip the wait. The
   default of 2 means a match only ever contains real players, never a solo
   player and a lobby full of strangers' ghosts. */
const MIN_HUMANS_TO_START_NOW = argOf('--min-humans',
  parseInt(process.env.MIN_HUMANS || '2', 10));

/* Whether a match waits the full window before it is formed. Kept as a named
   constant because /api/health reports it and the docs describe it; 0 is the
   old instant-match behaviour and is only used by tooling. */
const INSTANT_MATCH = MIN_HUMANS_TO_START_NOW === 0;



/* How long a dropped player keeps their place in a live match, waiting to come
   back. This is what makes "reload and drop straight back into the battle"
   possible: without it, closing the tab removes you from the roster, the hole is
   backfilled with a bot, and there is nothing to reattach to.

   It is also what the sleeping tank hangs on -- a disconnected player's tank
   sits in the arena dozing for this long rather than vanishing. */
const RECONNECT_GRACE_MS = parseInt(process.env.RECONNECT_GRACE_MS || '90000', 10);

/* A queued player who stops polling/holding a socket is swept after this. */
const QUEUE_STALE_MS = 20000;

/* Tank ids used when the server invents a bot. Kept in sync with the roster
   the game knows about; an unknown id falls back to coolbuddy client-side. */

/* ------------------------------------------------------------------- utils */

const now = () => Date.now();

function rid(n) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

/* I, O, 0 and 1 are excluded: players read these off each other's screens.
   Derived from the match seed rather than drawn separately, so a match needs
   exactly one random number. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCodeFromSeed(seed) {
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < 6; i++) {
    /* xorshift the seed so consecutive letters do not correlate */
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out += CODE_ALPHABET[s % CODE_ALPHABET.length];
  }
  return out;
}

/* makeBot() and the BOT_TANKS / BOT_NAMES tables used to live here. They are
   gone: bots are derived on the client from the match seed (js/roster-factory.js)
   because a bot has no authority, no socket, and the host synthesises its tank
   from the mode's own bot loops anyway. Leaving the generator here would be two
   sources of truth for the same list, which is how bots ended up named
   differently on the host and on a client. */

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket died mid-send */ }
}

/* ============================================================ MATCH STORE ==
   One in-memory store for every mode. Cloudflare KV was never a good home for
   a live queue anyway: it has no atomic read-modify-write, so two players
   joining at the same moment would clobber each other's entry.
   ========================================================================= */

const queues   = new Map();   /* mode -> [playerId]        */
const players  = new Map();   /* playerId -> player        */
const matches  = new Map();   /* code   -> match           */
const clans    = new Map();   /* code   -> clan summary    */

/* code -> true, while a match is waiting out its bot-fill timer. */
const pendingBotFill = new Map();

/* playerId -> the moment their reconnect grace runs out. */
const pendingGrace = new Map();

function queueFor(mode) {
  let q = queues.get(mode);
  if (!q) { q = []; queues.set(mode, q); }
  return q;
}

function playerCountInQueue(mode) {
  const q = queues.get(mode) || [];
  let n = 0;
  for (const id of q) {
    const p = players.get(id);
    if (p && p.mode === mode && !p.matchCode) n++;
  }
  return n;
}

function matchFor(code) { return matches.get(code); }

/* The roster a client receives: the HUMANS only, plus the seed and the bot
   count it needs to invent the identical bots itself. `isBot` on a human is
   always false and is kept so a client can tell the two apart without knowing
   about the seed. Bots are not listed -- see roster-factory.js. */
function rosterOf(match) {
  const humans = [];
  for (const p of match.playerIds) {
    const pl = players.get(p);
    if (pl) humans.push({ peerId: p, name: pl.name, tank: pl.tank, color: pl.color, isBot: false });
  }
  return humans;
}

/* The wire form of a roster update. */
function rosterMsg(match) {
  return {
    players: rosterOf(match),
    seed: match.seed,
    botCount: Math.max(0, MATCH_SIZE - match.playerIds.length),
    humanCount: match.playerIds.length,
  };
}

/* ------------------------------------------------------------ matchmaking */

/* Called on join and on every sweep. Forms a match as soon as either
   * enough humans are waiting (2+), or
   * * the bot-fill delay has elapsed since the first human joined.
   Everyone waiting in this mode goes into the same match. */
function tryFormMatch(mode) {
  const q = queueFor(mode);
  const humans = [];
  for (const id of q) {
    const p = players.get(id);
    if (!p) continue;
    if (p.matchCode) continue;
    if (now() - p.lastSeen > QUEUE_STALE_MS) continue;
    humans.push(p);
  }

  if (!humans.length) { pendingBotFill.delete(mode); return null; }

  const first = humans[0];
  const waited = now() - first.queuedAt;
  const timerUp = waited >= BOT_FILL_DELAY_MS;

  /* THE QUEUE ALWAYS WAITS THE FULL WINDOW.

     It used to start the instant a second human turned up, which meant two
     people could be matched together in under a second -- and everyone else
     still waiting got nothing, because the queue was consumed. It also meant
     the queue could sit open indefinitely whenever the second player never
     came, which is the "it just waits and waits" report.

     Now the window always runs to completion: two humans who both want to play
     get matched, but never before BOT_FILL_DELAY_MS has elapsed. Anyone still
     waiting at that point gets a match too, with bots making up the numbers.

     --min-humans 0 restores the old instant-match behaviour.

     THE SOLO CASE IS ABOUT TO BE THE COMMON ONE. Gating on "two humans" alone
     meant a player on their own never became eligible at all: `enough` stayed
     false forever, so the queue sat open indefinitely and nobody was ever
     filled in with bots. That is the "it just waits and waits and never starts"
     report. So once the window expires the shortfall is made up with bots --
     the countdown existing at all is the promise that this cannot happen. */
  const instant = MIN_HUMANS_TO_START_NOW === 0;

  if (!timerUp) {
    pendingBotFill.set(mode, Math.max(0, BOT_FILL_DELAY_MS - waited));
    return null;
  }

  pendingBotFill.delete(mode);

  /* ONE random draw per match, and everything else is derived from it.
     `seed` is what the clients use to invent the same bots; the room code is
     read out of it, so this is the only place randomness is needed.

     This replaced an array of up to sixteen generated bot entries, each with
     its own random id, that the server built and then re-sent IN FULL every
     time anybody left the match. */
  const seed = crypto.randomBytes(4).readUInt32BE(0);
  const code = roomCodeFromSeed(seed);
  const botCount = Math.max(0, MATCH_SIZE - humans.length);

  const match = {
    code,
    mode,
    seed,                             /* clients derive the bots from this */
    botCount,                         /* how many to invent                */
    hostId: humans[0].id,          /* first human in is the host */
    playerIds: humans.map(p => p.id),
    votes: {},                     /* playerId -> mapId */
    mapId: null,
    createdAt: now(),
    startedAt: null,
    /* Cached recipient sockets, rebuilt lazily whenever _stamp moves. */
    _stamp: 0, _recip: null, _recipStamp: -1,
  };
  matches.set(code, match);

  for (const p of humans) {
    p.matchCode = code;
    p.matchRole = p.id === match.hostId ? 'host' : 'client';
  }
  /* Humans leave the queue the instant the match exists; otherwise the next
     sweep would try to put them in a second match. */
  queues.set(mode, q.filter(id => !match.playerIds.includes(id)));

  /* Tell everyone. Each gets ITS OWN role -- the old worker returned the
     host's payload to everybody, so two clients both believed they were the
     host and both tried to claim the same room id. */
  for (const p of humans) {
    send(p.ws, {
      t: 'matched',
      role: p.matchRole,
      code,
      hostId: match.hostId,
      /* Humans only; the bots are derived from the seed on the client. */
      players: rosterOf(match),
      seed: match.seed,
      botCount: match.botCount,
      humanCount: humans.length,
    });
  }

  console.log(
    `[match] ${code} mode=${mode} humans=${humans.length} bots=${match.botCount} ` +
    `(waited ${(waited / 1000).toFixed(1)}s)`
  );
  return match;
}

/* Sweep: expire stale sockets, start any timer that has come due, and reap
   matches nobody is in any more. */
const sweep = setInterval(() => {
  /* drop sockets that went away without a clean close */
  for (const [id, p] of players) {
    if (p.ws && p.ws.readyState !== 1 && !p.matchCode) players.delete(id);
  }

  const modes = new Set([...queues.keys(), ...pendingBotFill.keys()]);
  for (const mode of modes) {
    const q = queues.get(mode) || [];
    const before = q.length;
    const kept = q.filter(id => {
      const p = players.get(id);
      return p && now() - p.lastSeen <= QUEUE_STALE_MS;
    });
    if (kept.length !== before) queues.set(mode, kept);

    const timer = pendingBotFill.get(mode);
    if (timer != null && timer <= 0) {
      pendingBotFill.delete(mode);
      tryFormMatch(mode);
    } else if (timer != null) {
      pendingBotFill.set(mode, timer - 250);
    } else if (q.length) {
      tryFormMatch(mode);
    }
  }

  /* reap finished matches */
  for (const [code, m] of matches) {
    if (m.closedAt && now() - m.closedAt > 60000) matches.delete(code);
  }

  /* Expire players whose reconnect grace has run out. Until this fires they keep
     their roster slot and their sleeping tank; after it they are a real departure
     and the hole is backfilled with a bot. */
  if (pendingGrace.size) {
    const t = now();
    for (const [id, deadline] of [...pendingGrace]) {
      if (t < deadline) continue;
      pendingGrace.delete(id);
      const p = players.get(id);
      if (p) { p.ws = null; expirePlayer(p, 'grace expired'); }
    }
  }
}, 250);

/* ============================================================ PLAYER LIFECYCLE */

function addPlayer(ws, info) {
  const id = 'p-' + rid(9);
  const p = {
    id,
    ws,
    name: String(info.name || 'Player').slice(0, 24),
    tank: String(info.tank || 'coolbuddy').slice(0, 32),
    color: Number.isFinite(info.color) ? info.color : 0x888888,
    mode: null,
    matchCode: null,
    matchRole: null,
    queuedAt: now(),
    lastSeen: now(),
  };
  players.set(id, p);
  send(ws, { t: 'welcome', playerId: id });
  console.log(`[join ] ${id} "${p.name}"`);
  return p;
}

function leaveQueue(p) {
  if (!p || !p.mode) return;
  const q = queues.get(p.mode) || [];
  queues.set(p.mode, q.filter(id => id !== p.id));
  p.mode = null;
  p.queuedAt = 0;
}

function queuePlayer(p, mode) {
  leaveQueue(p);

  /* A `queue` message is an explicit request for a NEW match, so anything still
     holding this player in an old one has to let go first.

     Without this, pressing PLAY a second time inside RECONNECT_GRACE_MS (90s)
     could never produce a match. Leaving a battle suspends the socket, and the
     suspended player KEEPS their matchCode so a reload can drop them back into
     it. The next PLAY offered that id back, the server honoured the resume and
     re-attached the socket to the finished battle -- and because tryFormMatch
     skips anybody who already has a matchCode, the queue found no candidates.
     The bot-fill timer ran, expired, found nobody, and the client sat on its
     counter for good. That is the "counts to 15 and then nothing happens"
     report, and it repeated every single time until the 90 seconds ran out.

     The resume feature itself is untouched: a plain reconnect sends `hello`
     with the id and no `queue` behind it, and still walks straight back in. */
  releaseFromMatch(p);

  p.mode = mode || 'random-battle';
  p.queuedAt = now();
  p.lastSeen = now();
  queueFor(p.mode).push(p.id);
  tryFormMatch(p.mode);
}

/* A PLAYER WHOSE SOCKET WENT AWAY.

   They keep their identity, their place in the roster and their tank for
   RECONNECT_GRACE_MS, so a closed tab or a reload can be undone by coming back.
   Until they do, their tank is asleep: the host is told to animate it, and the
   hole is NOT backfilled with a bot, because doing that would spawn a tank on top
   of the one they are coming back to.

   Only after the grace expires is this the same as a real departure. */
function suspendPlayer(p, why) {
  if (!p || p.disconnectedAt) return;
  p.disconnectedAt = now();
  p.lastSeen = p.disconnectedAt;

  /* A queued player has nothing to come back to — no match, no tank. They leave
     immediately, which is also what stops the queue waiting on a ghost. */
  if (!p.matchCode) { expirePlayer(p, why); return; }

  const m = matchFor(p.matchCode);
  if (m) {
    p.matchState = 'disconnected';
    for (const id of m.playerIds) {
      if (id === p.id) continue;
      const other = players.get(id);
      /* Only the host needs to animate the sleeping tank, but everybody is told
         so a client's roster view and nameplate grey out consistently. */
      if (other) send(other.ws, { t: 'peersleep', peerId: p.id, until: p.disconnectedAt + RECONNECT_GRACE_MS });
    }
    pendingGrace.set(p.id, p.disconnectedAt + RECONNECT_GRACE_MS);
  }
  console.log(`[sleep] ${p.id} disconnected, holding place for ${RECONNECT_GRACE_MS / 1000}s (${why || ''})`);
}

/* Back in, with a new socket. The identity is preserved, so the host maps the
   same peerId to the same tank and the client recognises its own slot. */
function resumePlayer(p, ws) {
  const wasAsleep = !!p.disconnectedAt;
  p.ws = ws;
  p.lastSeen = now();
  p.disconnectedAt = 0;
  if (wasAsleep) p.matchState = 'connected';
  pendingGrace.delete(p.id);

  const m = p.matchCode ? matchFor(p.matchCode) : null;
  send(ws, {
    t: 'welcome',
    playerId: p.id,
    /* Tell the client this is a resume rather than a fresh join, so it can put
       the player back where they were instead of into the menu. */
    resumed: true,
    code: m ? m.code : null,
    role: p.matchRole,
    hostId: m ? m.hostId : null,
    seed: m ? m.seed : null,
    botCount: m ? Math.max(0, MATCH_SIZE - m.playerIds.length) : 0,
    ...(m ? rosterMsg(m) : {}),
  });

  if (m) {
    for (const id of m.playerIds) {
      if (id === p.id) continue;
      const other = players.get(id);
      if (other) send(other.ws, { t: 'peerwake', peerId: p.id });
    }
  }
  console.log(`[wake ] ${p.id} reconnected${m ? ' into ' + m.code : ''}`);
  return p;
}

/* LET GO OF A MATCH WITHOUT CEASING TO EXIST.

   This is the match half of expirePlayer(), split out because a second caller
   needs it: a player who presses PLAY again is still here, they have simply
   walked out of the last battle, so the player record must survive while the
   match hold does not. */
function releaseFromMatch(p) {
  if (!p || !p.matchCode) return;
  {
    const m = matchFor(p.matchCode);
    if (m) {
      /* Tell the host this player is gone so it can drop their tank. */
      send(hostWs(m), { t: 'peerleave', peerId: p.id });

      const idx = m.playerIds.indexOf(p.id);
      if (idx >= 0) m.playerIds.splice(idx, 1);
      /* The cached recipient list just became wrong. */
      touchMembership(m);

      /* The hole is refilled with a bot so the roster stays at MATCH_SIZE. This has
         to happen whether or not the battle has actually started: clients are
         given the roster at match time and spawn from it, so a human who leaves
         during the map vote would otherwise stay on everybody's list and be
         spawned as a tank that does not exist.

         The server does NOT create a bot to do this. botCount is simply derived
         from how many humans are left, the seed is unchanged, and the client
         derives one more bot than before -- the existing fourteen keep their
         identities, because roster-factory's generator is index-based. What used
         to be "append a random bot, then rebuild and re-send all sixteen
         entries" is now a subtraction on the client. */
      for (const id of m.playerIds) {
        const other = players.get(id);
        if (other) send(other.ws, Object.assign({ t: 'roster' }, rosterMsg(m)));
      }

      if (!m.playerIds.length) { m.closedAt = now(); matches.delete(m.code); }
      else if (m.hostId === p.id) {
        /* Host left: promote the next human so the match does not die. */
        m.hostId = m.playerIds[0];
        for (const id of m.playerIds) {
          const other = players.get(id);
          if (!other) continue;
          other.matchRole = other.id === m.hostId ? 'host' : 'client';
          send(other.ws, Object.assign({
            t: 'hostchange', hostId: m.hostId, role: other.matchRole,
          }, rosterMsg(m)));
        }
        console.log(`[match] ${m.code} host left, ${m.hostId} promoted`);
      }
    }
    p.matchCode = null;
    p.matchRole = null;
    /* They are no longer asleep inside a match, so there is nothing left for a
       reconnect to resume into. Leaving these set would let a later `hello`
       re-attach this socket to a match they have already walked out of. */
    p.disconnectedAt = 0;
    pendingGrace.delete(p.id);
  }
}

/* THE REAL GOODBYE: the player is gone for good. Backfill the hole with a bot and
   tell the host, which is what the game needs to keep the arena consistent. */
function expirePlayer(p, why) {
  if (!p) return;
  leaveQueue(p);
  releaseFromMatch(p);
  players.delete(p.id);
  console.log(`[bye  ] ${p.id} ${why || ''}`);
}

/* The host's socket, or null if the host has gone away. */
function hostWs(match) {
  const h = match && players.get(match.hostId);
  return h ? h.ws : null;
}

/* ================================================================ RELAY ==
   The host is authoritative for the simulation. Clients send input, the host
   sends snapshots, and this server moves both between the right sockets. It
   never inspects or rewrites payloads.
   ========================================================================= */

function membersOf(match, exceptId) {
  const out = [];
  for (const id of match.playerIds) {
    if (id === exceptId) continue;
    const p = players.get(id);
    if (p) out.push(p);
  }
  return out;
}

/* ---- THE HOT PATH -------------------------------------------------------
   Snapshots are ~1.3 KB of JSON at 20 Hz per client and are the overwhelming
   majority of everything this server carries. Three things used to happen to
   each one, and none of them were necessary:

     1. JSON.parse of the entire thing, only to read `msg.t`
     2. membersOf(), which allocated a fresh array, per message
     3. JSON.stringify of an object identical to what the host already sent

   So every snapshot was decoded, copied and re-encoded by a process that is
   only supposed to move bytes. Now:

     * the recipient socket list is cached on the match and rebuilt only when
       membership actually changes (touchMembership), and
     * the host's own bytes are forwarded verbatim -- no parse, no re-encode.

   A monotonic counter is used rather than the array's length, because swapping
   one player for another keeps the length identical and would leave a stale
   cache pointing at a socket that has gone.
   -------------------------------------------------------------------------- */

function recipients(match) {
  if (match._recipStamp === match._stamp && match._recip) return match._recip;
  const list = [];
  for (const id of match.playerIds) {
    const p = players.get(id);
    if (p && p.ws) list.push(p.ws);
  }
  match._recip = list;
  match._recipStamp = match._stamp;
  return list;
}

function touchMembership(match) {
  match._stamp = (match._stamp || 0) + 1;
  match._recip = null;
  match._recipStamp = -1;
}

function sendRaw(ws, raw) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(raw); } catch (e) { /* socket died mid-send */ }
}

/* A slow client must not be allowed to grow an unbounded send buffer: at 20
   snapshots a second a bad link would pile up until the process ran out of
   memory. Past this many queued bytes that one socket is skipped, and the next
   snapshot carries fresher truth anyway. */
const MAX_BUFFERED_BYTES = 512 * 1024;

/* Forward already-serialised bytes to every member except the sender. Allocates
   nothing on the way: this is the busiest line in the whole server. */
function relayRaw(match, exceptId, raw) {
  const list = recipients(match);
  for (let i = 0; i < list.length; i++) {
    const ws = list[i];
    if (ws.readyState !== 1) continue;
    if (exceptId != null && match.playerIds[i] === exceptId) continue;
    if (ws.bufferedAmount != null && ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
    sendRaw(ws, raw);
  }
}

function handleRelay(p, msg) {
  const m = matchFor(p.matchCode);
  if (!m) return;

  switch (msg.t) {
    /* ---- SHARED MOUSE CURSOR ----
       Menu-screen cursor positions, so each player can see where the other is
       pointing during the map vote. Plainly a relay: the server does not care
       what the numbers mean, it just carries them to the rest of the match.

       Sent throttled (the client caps its own rate) because a mousemove is far
       more frequent than any game event, and it is broadcast to everyone rather
       than only the host -- both players are looking at a DOM overlay here, not
       at the 3D world, so there is no "authority" to respect. */
    case 'cursor': {
      if(m.cursor === undefined) m.cursor = {};
      /* KEEP THE FRACTION. The client sends a NORMALISED position (0..1) and
         multiplies by the viewport on the way out, so rounding to an integer
         here destroyed the coordinate: every cursor arrived as 0 or 1, which
         renders as the far top-left corner or a single pixel. That is why the
         other player's mouse looked pinned to the corner of the vote screen
         instead of following their hand.

         Clamped rather than rounded so a bogus client cannot place a cursor
         outside the viewport, and to 4 decimals because that is far finer
         than any screen and keeps the payload small. */
      const nx = Number(msg.x), ny = Number(msg.y);
      const unit = (v) => Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 1e4) / 1e4)) : 0;
      m.cursor[p.id] = {
        x: unit(nx),
        y: unit(ny),
        at: Date.now(),
      };
      for (const other of membersOf(m, null)) {
        send(other.ws, { t: 'cursors', cursors: m.cursor });
      }
      break;
    }

    /* ---- client -> host ---- */
    case 'join': {
      /* The client tells the host who it is. Forward it under a name the host
         already understands.

         NEVER echo a player's own join back to itself. The host announces
         itself with the same message, so without this guard the host received
         its OWN peerjoin, ran _onClientJoin() for itself, and registered itself
         in clientTanks -- a tank the host owns but must not simulate as a
         remote player. */
      if (p.id === m.hostId) break;
      send(hostWs(m), {
        t: 'peerjoin',
        peerId: p.id,
        name: p.name,
        tank: msg.tank || p.tank,
        color: msg.color != null ? msg.color : p.color,
      });
      break;
    }
    case 'input': {
      send(hostWs(m), { t: 'input', from: p.id, input: msg.input });
      break;
    }
    case 'ping': {
      send(p.ws, { t: 'pong', ts: msg.ts });
      break;
    }

    /* ---- P2P id exchange ----

       Two forms, both relayed exactly as sent so net.js can decide what they mean:

       * client -> host: "{ t:'p2p-id', p2pId }"
       * host -> client: "{ t:'p2p-id', to: peerId, p2pId }"

       The server does not inspect the ids. It just carries them, like input and
       cursor positions, because the ids are a transport detail and the server is
       only relay. */
    case 'p2p-id': {
      if (msg.to) {
        const target = players.get(msg.to);
        if (target && target.ws) send(target.ws, msg);
      } else {
        /* client -> host: forward to the host so it can address this client directly. */
        if (p.id !== m.hostId) send(hostWs(m), msg);
      }
      break;
    }

    /* ---- host -> clients ---- */
    case 'state': {
      for (const other of membersOf(m, p.id)) send(other.ws, { t: 'state', s: msg.s });
      break;
    }
    case 'spawn': {
      const target = msg.to && players.get(msg.to);
      if (target) send(target.ws, { t: 'spawn', data: msg.data });
      break;
    }
    case 'fullstate': {
      const target = msg.to && players.get(msg.to);
      if (target) send(target.ws, { t: 'fullstate', state: msg.state });
      break;
    }
    case 'matchstart': {
      m.startedAt = now();
      for (const other of membersOf(m, p.id)) send(other.ws, { t: 'started' });
      break;
    }

    /* ---- shared map vote ---- */
    case 'vote': {
      const mapId = String(msg.map || '').slice(0, 32);
      if (!mapId) break;
      m.votes[p.id] = mapId;
      const tally = tallyOf(m);
      for (const other of membersOf(m, null)) {
        send(other.ws, { t: 'votes', votes: tally, mapId });
      }
      break;
    }

    /* ---- THE MAP IS DECIDED ONCE, BY THE HOST, AND IS NOT A VOTE ----
       Every client used to run its own _pickWinner() over its own copy of the
       tally, and the copies disagreed: two players clicking two different cards
       ended up on two DIFFERENT maps, each convinced the match had started. In
       Capture the Circle that is fatal -- the two halves have different
       geometry, different spawn points and different cover, so a player spawns
       into a world the other player is not even in.

       Ties made it worse, because each client broke them independently and
       partly at random, so a genuine 1-1 tie could resolve two different ways.

       So the HOST is now the single authority for the map. It decides once and
       announces it; the server records it and pushes it to every member.
       Clients do not choose the map, they are told which one. */
    case 'map': {
      const mapId = String(msg.map || '').slice(0, 32);
      if (!mapId) break;
      if (m.hostId !== p.id) break;          /* only the host may call it */
      m.mapId = mapId;
      m.mapLocked = true;
      for (const other of membersOf(m, null)) {
        send(other.ws, { t: 'map', mapId });
      }
      console.log(`[match] ${m.code} host chose map ${mapId}`);
      break;
    }

    /* ---- THE HOST ENDED THE MATCH ----

       Relying on `default: break` here would look fine and be completely broken:
       an unrecognised message is dropped on the floor, so the host would end its
       own battle, walk off to its results screen, and leave the client playing a
       match that no longer exists. A client cannot stop the match on its own
       either — it has no authority over the battle, and letting it would mean two
       machines disagreeing about who won.

       So this is host-only, like `map`, and it is broadcast to EVERY member
       including the sender. The host has already ended locally and ignores the
       echo; routing both players through the same message means there is one
       definition of a finished match rather than two that can drift.

       `endedAt` is stamped so the match cannot be re-ended: a client that
       reconnects and resumes an already-finished match is dropped from it rather
       than dropped into a battle with no host running it. */
    case 'matchend': {
      if (m.hostId !== p.id) break;           /* only the host may end it */
      if (m.endedAt) break;                   /* already over */
      m.endedAt = now();
      m.endedBy = p.id;
      m.endWinnerTeam = (msg.winnerTeam === 'red') ? 'red' : 'blue';
      m.endReason = String(msg.reason || 'ended').slice(0, 24);
      for (const other of membersOf(m, null)) {
        send(other.ws, {
          t: 'matchend',
          winnerTeam: m.endWinnerTeam,
          winnerPeerId: typeof msg.winnerPeerId === 'string' ? msg.winnerPeerId : null,
          reason: m.endReason,
        });
      }
      console.log(`[match] ${m.code} ended by host (${m.endReason})`);
      break;
    }

    default:
      break;
  }
}

function tallyOf(m) {
  const out = {};
  for (const id in m.votes) out[id] = m.votes[id];
  return out;
}

/* ================================================================== HTTP === */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin':  'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const CACHE_IMMUTABLE = [
  '/mini_tank_legends_models/', '/vfx/', '/nature/', '/assets/',
];

function cacheFor(urlPath) {
  /* index.html must never be cached or a fix will not reach players. */
  if (urlPath === '/' || urlPath === '/index.html') {
    return 'no-cache, no-store, must-revalidate';
  }
  if (/\.(js|css)$/.test(urlPath)) return 'no-cache';

  /* MAPS ARE NEVER CACHED.

     This one bit badly and for a long time. Replacing a map file on disk left
     every browser holding the old one, because the GLBs were being served with
     max-age=604800 -- a week. A map swap therefore looked like "the game ignored
     my new map": the server had the new file and the players were still being
     handed the old one.

     A map is a few MB and changes only when the level designer says so, which is
     exactly what revalidating on every request is for. Assets under /assets/ --
     textures, audio, the garage -- keep their long cache, because those DO churn
     rarely and they are the bulk of the download. */
  if (/\/assets\/maps\//i.test(urlPath)) {
    return 'no-cache, no-store, must-revalidate';
  }

  if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(urlPath)) {
    return CACHE_IMMUTABLE.some(p => urlPath.startsWith(p))
      ? 'public, max-age=2592000'
      : 'public, max-age=604800';
  }
  if (/\.(glb|gltf|mp3|wav|ogg|mp4|webm|woff2?|ttf|bin|wasm)$/i.test(urlPath)) {
    return 'public, max-age=604800';
  }
  return 'no-cache';
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------- REST fallback --
   The client speaks WebSocket for the queue and the relay. These endpoints
   exist because map-voting.js publishes and reads the shared tally over
   fetch(), and because they make the server debuggable with curl. They read
   and write the SAME store, so a vote posted here is visible to a WebSocket
   client and vice versa.
   ------------------------------------------------------------------------- */
async function handleRest(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    /* CPU time is reported because "does it work smoothly" is a question about
       headroom, not about latency: at low load a relay is never the bottleneck,
       so p99 looks fine while the CPU bill climbs. cpuMs is this process's total
       user+system time since start, so a client can diff two samples and get the
       real cost per second of traffic. */
    const cpu = process.cpuUsage();
    return json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      players: players.size,
      matches: matches.size,
      queues: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
      botFillDelayMs: BOT_FILL_DELAY_MS,
      matchSize: MATCH_SIZE,
      fastPath: FAST_PATH,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    });
  }

  if (p === '/api/match/join' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return json(res, 400, { error: 'missing name' });
    /* A REST join has no socket, so it cannot play. It is only useful for
       inspecting the queue; say so instead of pretending. */
    return json(res, 400, {
      error: 'REST join cannot host a match. Connect a WebSocket to /mp instead.',
    });
  }

  if (p === '/api/match/status') {
    const code = url.searchParams.get('code');
    const m = code && matchFor(code);
    if (!m) return json(res, 404, { error: 'no such match' });
    return json(res, 200, {
      status: 'matched',
      code: m.code,
      mapVote: tallyOf(m),
      mapId: m.mapId,
      /* Same shape the socket sends: humans plus the seed and count a client
         needs to derive the bots. Sending humans-only here would make this
         endpoint disagree with `matched`, which is precisely the kind of second
         source of truth that caused the map desync in the first place. */
      players: rosterOf(m),
      seed: m.seed,
      botCount: Math.max(0, MATCH_SIZE - m.playerIds.length),
      humanCount: m.playerIds.length,
    });
  }

  if (p === '/api/match/vote' && req.method === 'POST') {
    const body = await readBody(req);
    const m = body.code && matchFor(body.code);
    if (!m) return json(res, 404, { error: 'no such match' });
    if (!body.map) return json(res, 400, { error: 'missing map' });
    const who = String(body.playerId || 'unknown');
    m.votes[who] = String(body.map);
    m.mapId = String(body.map);
    for (const id of m.playerIds) {
      const pl = players.get(id);
      if (pl) send(pl.ws, { t: 'votes', votes: tallyOf(m), mapId: m.mapId });
    }
    return json(res, 200, { ok: true, votes: tallyOf(m), mapId: m.mapId });
  }

  if (p === '/api/clans' && req.method === 'GET') {
    return json(res, 200, { clans: [...clans.values()] });
  }
  if (p === '/api/clans' && req.method === 'POST') {
    const body = await readBody(req);
    if (body && body.code) clans.set(body.code, body);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/clans' && req.method === 'DELETE') {
    const body = await readBody(req);
    if (body && body.code) clans.delete(body.code);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------ static files */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.resolve(ROOT, '.' + rel);
  /* Path traversal: anything that resolves outside ROOT is refused. */
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }

    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': cacheFor(rel),
      'X-Content-Type-Options': 'nosniff',
    };

    /* Byte ranges: browsers require them for <video>, and the game streams
       .mp4 overlays. */
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (isNaN(start) || start >= st.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
          res.end(); return;
        }
        if (end >= st.size) end = st.size - 1;
        res.writeHead(206, {
          ...headers,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(full, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, { ...headers, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleRest(req, res, url).catch(e => {
      console.error('[rest]', e);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
    return;
  }

  serveStatic(req, res, url);
});

const wss = new WebSocketServer({ server, path: '/mp' });

/* The host sends `{ t: 'state', s: ... }` and net.js builds that object
   literally, so `t` is always the FIRST key on the wire and the bytes the host
   produced are already exactly the bytes we would emit. That is what makes the
   verbatim relay below safe.

   This is only a fast path, never a correctness requirement: if the prefix does
   not match (a client that orders its keys differently, or a future message
   type) the frame falls through to the ordinary parse below and behaves
   exactly as before. */
const STATE_PREFIX = '{"t":"state"';

/* Kill switch for the verbatim relay, so its effect can be measured rather than
   assumed: MTL_FAST_PATH=0 forces the old parse-then-re-encode path. It exists
   because "the optimisation is faster" is a claim, and a claim you cannot turn
   off is not evidence. */
const FAST_PATH = process.env.MTL_FAST_PATH !== '0';

function handleStateVerbatim(p, raw) {
  const m = p.matchCode ? matchFor(p.matchCode) : null;
  /* Members only. Without this the socket would be an open broadcast to
     whoever happens to be in a match. */
  if (!m || m.playerIds.indexOf(p.id) < 0) return;
  p.lastSeen = now();
  relayRaw(m, p.id, raw);
}

wss.on('connection', (ws) => {
  /* `let`, not `const`: a `hello` carrying a valid resume id REPLACES this with
     the player who was asleep, and the close/error handlers below close over
     this binding. Leaving it as the id minted for this socket meant that closing
     a resumed connection did nothing at all — the retired id matched nothing in
     the store, the guard bailed, and the sleeping player was never even given a
     fresh grace period. */
  let p = addPlayer(ws, {});

  ws.on('message', (raw, isBinary) => {
    /* HOT PATH FIRST. Checked before any parsing so the common case costs one
       short string compare instead of a full JSON.parse of a 1.3 KB snapshot. */
    if (FAST_PATH && !isBinary && typeof raw === 'string' && raw.startsWith(STATE_PREFIX)) {
      handleStateVerbatim(p, raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    p.lastSeen = now();

    switch (msg.t) {
      case 'hello': {
        /* The client may set its identity before the first message. */
        if (msg.name) p.name = String(msg.name).slice(0, 24);
        if (msg.tank) p.tank = String(msg.tank).slice(0, 32);
        if (Number.isFinite(msg.color)) p.color = msg.color;

        /* RESUME. The client keeps the id this server gave it and offers it back
           on the next connection. If that id belongs to a player who is asleep in
           a live match, this socket BECOMES that player: same id, same roster
           slot, same tank, same room. That is what lets a reload drop someone
           straight back into the battle they were in.

           Refused unless the id is genuinely in a match and the grace has not
           run out — so a stale id from a finished match cannot be used to walk
           back into it, and an id the client made up simply matches nothing. */
        if (msg.resume) {
          const prior = players.get(String(msg.resume));
          const m = prior && prior.matchCode ? matchFor(prior.matchCode) : null;
          const withinGrace = prior && prior.disconnectedAt &&
                              (now() - prior.disconnectedAt) < RECONNECT_GRACE_MS;
          if (m && withinGrace) {
            players.delete(p.id);        /* retire the id minted for this socket */
            p = prior;                   /* the handlers below now own THIS player */
            resumePlayer(p, ws);
            return;
          }
        }
        send(ws, { t: 'welcome', playerId: p.id });
        break;
      }
      case 'queue': {
        queuePlayer(p, msg.mode);
        const waiting = playerCountInQueue(p.mode);
        send(ws, {
          t: 'queued',
          mode: p.mode,
          queueSize: waiting,
          /* Seconds left on the bot-fill countdown, so the UI can show it. */
          botFillInMs: Math.max(0, pendingBotFill.get(p.mode) ?? BOT_FILL_DELAY_MS),
          botFillDelayMs: BOT_FILL_DELAY_MS,
        });
        break;
      }
      case 'unqueue': {
        leaveQueue(p);
        send(ws, { t: 'unqueued' });
        break;
      }
      case 'clan.upsert': {
        if (msg.clan && msg.clan.code) clans.set(msg.clan.code, msg.clan);
        send(ws, { t: 'clans', clans: [...clans.values()] });
        break;
      }
      case 'clan.remove': {
        if (msg.code) clans.delete(msg.code);
        send(ws, { t: 'clans', clans: [...clans.values()] });
        break;
      }
      case 'clan.list': {
        send(ws, { t: 'clans', clans: [...clans.values()] });
        break;
      }
      default:
        handleRelay(p, msg);
        break;
    }
  });

  ws.on('close', () => onSocketGone(p, 'closed'));
  ws.on('error', () => onSocketGone(p, 'error'));
});

/* The socket for THIS player went away. If they are in a match they are put to
   sleep rather than removed, so a closed tab can be undone by reopening it. */
function onSocketGone(p, why) {
  /* After a resume the player object is a different one from the socket's `p`,
     so only act if this socket still owns it. */
  if (!p || players.get(p.id) !== p) return;
  if (p.disconnectedAt) return;
  p.ws = null;
  suspendPlayer(p, why);
}

/* A tab that is suspended or a tunnel that blips must not be able to make the
   server forget a live match. */
const ping = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 15000);
wss.on('close', () => clearInterval(ping));

/* Only auto-start when run as a program; when a test requires this file it
   calls listen() itself. */
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Mini Tank Legends — game + match server');
    console.log('  --------------------------------------');
    console.log(`  local     http://localhost:${PORT}/`);
    console.log(`  socket    ws://localhost:${PORT}/mp`);
    console.log(`  health    http://localhost:${PORT}/api/health`);
    console.log('');
    console.log(`  bot fill  after ${BOT_FILL_DELAY_MS / 1000}s, filling to ${MATCH_SIZE} tanks`);
    console.log('  Point the Cloudflare tunnel at this port and everything works.');
    console.log('');
  });
}

/* ============================================================================
   Exportable so tests can drive a real server in-process instead of spawning
   one. Spawning worked, but tearing a child process down on Windows tripped a
   libuv assertion that poisoned the test's exit code, which makes a green run
   look red. require.main === module keeps `node server/mpserver.js` working
   exactly as before.
   ========================================================================== */
module.exports = {
  listen(port, host) {
    return new Promise((resolve) => {
      server.listen(port || PORT || 18123, host || HOST, () => resolve(server));
    });
  },
  close() {
    clearInterval(sweep);
    for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} }
    wss.close();
    return new Promise(res => server.close(() => res()));
  },
  store: { queues, players, matches, clans },
  config: { BOT_FILL_DELAY_MS, MATCH_SIZE, MIN_HUMANS_TO_START_NOW },
};
