/* ============================================================================
   matchmaker.js — the Cloudflare Durable Object that owns a Mini Tank Legends
   match.

   WHY A DURABLE OBJECT AND NOT A PLAIN WORKER
   ------------------------------------------
   A plain Worker cannot run a lobby. Its isolates are independent and get
   evicted when idle, so two players who queue at the same moment can land on
   two different isolates and never meet. That is precisely the "I press play
   and it just searches forever" failure. A Durable Object is one object with
   one serialised event stream: the queue is consistent by construction.

   WHY THE STATE IS PERSISTED
   --------------------------
   With the WebSocket Hibernation API the object is evicted from memory while
   sockets stay open — that is the whole point of hibernation, and it is what
   stops you paying for an idle match. But an evicted object has forgotten its
   queues and its matches. So everything durable (queues, players, matches,
   votes) lives in DO storage and is written back on each mutation, and the
   pure-relay traffic never touches storage. On wake, `_ready` reloads it once.

   WHY ALARMS, NOT TIMERS
   ----------------------
   The bot-fill window is 15 seconds. A DO is evicted well before that, and a
   pending setTimeout dies with the isolate, so the match would never be formed
   — a queue that waits forever. `ctx.storage.setAlarm` is durable and
   exactly this use case: the object is woken to run it.

   THE PROTOCOL IS IDENTICAL TO server/mpserver.js
   -----------------------------------------------
   Deliberately byte-for-byte the same message shapes, so js/net.js talks to
   either backend unchanged and the two can be A/B tested.
   ========================================================================== */

'use strict';

/* ---- tunables (overridable per environment in wrangler.toml) -------------- */

const BOT_FILL_DELAY_MS = 15000;   /* the "15 seconds" rule                  */
const MATCH_SIZE        = 16;      /* 8 a side; bots make up the shortfall   */
const QUEUE_STALE_MS    = 20000;   /* a queued socket that goes quiet         */

/* A player whose socket went away keeps their identity, their roster slot and
   their tank for this long, so a closed tab or a reload can be undone by coming
   back. Until they do, their tank is ASLEEP on the other clients and the hole is
   NOT backfilled with a bot — a bot would be spawned on top of the tank they are
   coming back to.

   Durable storage is what makes this survive an eviction, which a timer would
   not: the object is evicted from memory while sockets stay open, and a pending
   setTimeout dies with the isolate. An alarm is scheduled per player and the
   earliest is re-armed on every mutation. */
/* CLOUD WORKERS HAVE NO `process`.
   This line used to read process.env.RECONNECT_GRACE_MS. `process` is a Node
   global and does not exist on the Workers runtime, so it did not fail when the
   file was read or unit-tested locally — it failed at DEPLOY time, from the
   platform, as "process is not defined" pointing at this exact line.

   So the default lives here as a plain `let`, and the Durable Object overrides
   it from its own `env` in the constructor, which is the only place `env`
   exists at runtime. To change the grace period, set it as a Wrangler var or
   secret; nothing else needs editing. */
let RECONNECT_GRACE_MS = 90000;
const SWEEP_MS          = 5000;    /* housekeeping cadence                    */
const MATCH_REAP_MS     = 60000;

/* THE HOST GETS A DIFFERENT, MUCH SHORTER GRACE.

   RECONNECT_GRACE_MS above is the right number for an ordinary player: they
   closed a tab, lost signal, or backgrounded their phone, and ninety seconds
   of holding their slot is generous and cheap.

   It was catastrophically wrong for the HOST. The host is the only machine
   simulating the battle — everybody else just receives snapshots from it — so
   while the host was asleep there was nobody to broadcast. Every remaining
   player watched a frozen arena for ninety seconds: no movement, no shells, no
   respawns, and a ping counter that had stopped meaning anything because
   nothing was being sent. Then the host either came back or was replaced.

   Two seconds is chosen because the failure this fixes is not "the host blinked
   and lost", it is "the host is gone". A browser tab that is about to come back
   reconnects in well under two seconds; anything slower is a real departure and
   is handled as one. Promoting early is cheap and harmless in the rare race: if
   the host does return, resumePlayer puts them back in as a client and the
   promoted host carries on. */
let HOST_GRACE_MS = 2000;

/* A client that cannot keep up must not be allowed to grow an unbounded send
   buffer: at 20 snapshots a second a slow link would otherwise pile up until
   the object runs out of memory. Past this many queued bytes the snapshot is
   dropped for that one socket. Skipping is correct — the next one carries
   fresher truth anyway. */
const MAX_BUFFERED_BYTES = 512 * 1024;

/* ------------------------------------------------------------------ utils */

const nowMs = () => Date.now();

function rid(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, n);
}

/* I, O, 0 and 1 are excluded: players read these off each other's screens. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCodeFromSeed(seed) {
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < 6; i++) {
    /* xorshift so consecutive letters do not correlate */
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out += CODE_ALPHABET[s % CODE_ALPHABET.length];
  }
  return out;
}

/* ============================================================================
   THE OBJECT
   ========================================================================== */

export class Lobby {
  /* (state, env). The FIRST argument is the DurableObjectState, and it carries
     everything this object needs: storage, blockConcurrencyWhile, AND the
     WebSocket registry (acceptWebSocket / getWebSockets). The second argument
     is `env` — the bindings — and has none of those.

     Getting that backwards is invisible until the runtime throws
     "ctx.acceptWebSocket is not a function", because storage and
     blockConcurrencyWhile do live on the state and keep working, so health
     checks pass and only the first real connection fails. */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /* Pick up the reconnect grace period from the bindings, now that `env` is
       in hand. Done per instance rather than at module scope because module
       scope runs before any bindings exist. A bad or missing value leaves the
       baked-in default alone rather than becoming NaN, which would silently
       compare false against every timestamp and expire every player instantly. */
    const grace = parseInt(env && env.RECONNECT_GRACE_MS, 10);
    if (Number.isFinite(grace) && grace > 0) RECONNECT_GRACE_MS = grace;

    /* Same treatment for the host's window, so it can be tuned without a code
       change. It must stay SMALLER than the ordinary grace: the whole point is
       that a missing host stops costing the other players immediately. */
    const hGrace = parseInt(env && env.HOST_GRACE_MS, 10);
    if (Number.isFinite(hGrace) && hGrace > 0) HOST_GRACE_MS = hGrace;

    /* Working copy. Loaded from storage once per instance; `state` above is
       the blockConcurrencyWhile handle, so every event waits for this. */
    this.db = null;
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const raw = (await this.state.storage.get('db')) || null;
      this.db = raw || {
        queues: {},        /* mode -> [playerId]              */
        players: {},       /* playerId -> player               */
        matches: {},       /* code   -> match                 */
        clans: {},         /* code   -> clan summary          */
        botCursor: 0,
        startedAt: nowMs(),
      };
      await this.ensureAlarm();
    });
  }

  /* ------------------------------------------------------------- persistence */

  async persist() {
    await this.state.storage.put('db', this.db);
  }

  /* An alarm is the only durable timer available, and it is what wakes the
     object to run the bot fill. Keep at least one pending at all times. */
  async ensureAlarm() {
    const at = this.nextDeadline();
    if (at != null) await this.state.storage.setAlarm(at);
    else await this.state.storage.deleteAlarm();
  }

  /* Soonest thing worth waking up for: the end of a queue window, or the next
     sweep. Never further out than SWEEP_MS, so dead sockets are always reaped. */
  nextDeadline() {
    let soonest = nowMs() + SWEEP_MS;
    /* A sleeping player's grace is a hard deadline: if nothing else wakes the
       object, this is what turns "asleep" into "gone". */
    for (const id in this.db.players) {
      const p = this.db.players[id];
      if (!p.disconnectedAt) continue;
      const end = this.reconnectDeadline(p);
      if (end && end < soonest) soonest = end;
    }
    for (const mode in this.db.queues) {
      const q = this.db.queues[mode] || [];
      for (const id of q) {
        const p = this.db.players[id];
        if (!p || p.matchCode) continue;
        const end = p.queuedAt + BOT_FILL_DELAY_MS;
        if (end < soonest) soonest = end;
      }
    }
    for (const code in this.db.matches) {
      const m = this.db.matches[code];
      if (m.closedAt && m.closedAt + MATCH_REAP_MS < soonest) soonest = m.closedAt + MATCH_REAP_MS;
    }
    return soonest;
  }

  /* ======================================================================== */
  /*  HTTP / WebSocket entry                                                  */
  /* ======================================================================== */

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === '/api/health') return this.health();
    if (url.pathname === '/api/match/status') return this.matchStatus(url);
    if (url.pathname === '/api/match/vote' && request.method === 'POST') return this.restVote(request);
    if (url.pathname === '/api/clans') return this.restClans(request, url);

    /* The client opens the socket at the page's own origin, /mp. */
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Mini Tank Legends match server. Connect a WebSocket to /mp.', {
        status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    /* acceptWebSocket is the Hibernation API: the socket outlives this instance
       and the object may be evicted between messages. */
    this.state.acceptWebSocket(server);

    /* `let`, not `const`: a `hello` carrying a valid resume id REPLACES this
       with the player who was asleep, and the close handler resolves the player
       from the socket attachment — which is rewritten on resume — so both paths
       have to reach the same person. */
    let p = this.addPlayer({}, server);
    /* An ID, not the player: see the resume path below. */
    server.serializeAttachment({ id: p.id });
    /* Identity is minted HERE, by the server, and this is the only identity
       that exists. The client used to invent its own id before connecting and
       the host then looked the roster up by that other id, so players were
       connected at the socket level and the game never noticed them. */
    this.send(server, { t: 'welcome', playerId: p.id });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ======================================================================== */
  /*  REST — same store as the sockets, so a vote posted here is visible to a  */
  /*  WebSocket client and vice versa. map-voting.js reads the tally over     */
  /*  fetch(), and these endpoints make the object debuggable with curl.      */
  /* ======================================================================== */

  json(obj, code) {
    return new Response(JSON.stringify(obj), {
      status: code || 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  async health() {
    const queues = {};
    for (const k in this.db.queues) queues[k] = (this.db.queues[k] || []).length;
    return this.json({
      ok: true,
      runtime: 'cloudflare-durable-object',
      uptime: Math.round((nowMs() - this.db.startedAt) / 1000),
      players: Object.keys(this.db.players).length,
      matches: Object.keys(this.db.matches).length,
      queues,
      botFillDelayMs: BOT_FILL_DELAY_MS,
      matchSize: MATCH_SIZE,
    });
  }

  async matchStatus(url) {
    const code = url.searchParams.get('code');
    const m = code && this.db.matches[code];
    if (!m) return this.json({ error: 'no such match' }, 404);
    return this.json({
      status: 'matched', code: m.code, mapVote: this.tallyOf(m),
      mapId: m.mapId,
      /* Same shape the socket sends: humans plus the seed and count a client
         needs to derive the bots. Humans-only here would make this endpoint
         disagree with `matched` — a second source of truth, which is how the map
         desync happened in the first place. */
      players: this.rosterOf(m),
      seed: m.seed,
      botCount: Math.max(0, MATCH_SIZE - m.playerIds.length),
      humanCount: m.playerIds.length,
    });
  }

  async restVote(request) {
    const body = await request.json().catch(() => ({}));
    const m = body.code && this.db.matches[body.code];
    if (!m) return this.json({ error: 'no such match' }, 404);
    if (!body.map) return this.json({ error: 'missing map' }, 400);
    const who = String(body.playerId || 'unknown');
    m.votes[who] = String(body.map);
    m.mapId = String(body.map);
    const tally = this.tallyOf(m);
    this.broadcast(m, null, { t: 'votes', votes: tally, mapId: m.mapId });
    await this.persist();
    return this.json({ ok: true, votes: tally, mapId: m.mapId });
  }

  async restClans(request, url) {
    if (request.method === 'GET') return this.json({ clans: Object.values(this.db.clans) });
    const body = await request.json().catch(() => ({}));
    if (request.method === 'DELETE') {
      if (body && body.code) delete this.db.clans[body.code];
    } else if (body && body.code) {
      this.db.clans[body.code] = body;
    }
    await this.persist();
    return this.json({ ok: true });
  }

  /* ======================================================================== */
  /*  Hibernation handlers. Each one may be the first code to run after the   */
  /*  object was evicted, so each must await `ready` before touching state.   */
  /* ======================================================================== */

  async webSocketMessage(ws, raw) {
    await this.ready;

    /* HOT PATH FIRST: checked before any parsing, so the common case costs one
       short string compare instead of parsing a 1.3 KB snapshot. */
    if (Lobby.looksLikeState(raw)) { await this.handleStateVerbatim(ws, raw); return; }

    const att = ws.deserializeAttachment();
    if (!att) { try { ws.close(1008, 'no identity'); } catch (e) {} return; }

    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); }
    catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    /* `let`: a `hello` carrying a valid resume id REPLACES this with the player who
       was asleep, and the socket's attachment is rewritten to match — otherwise
       the close handler would resolve the id this connection was given, find
       nothing in the store, and quietly do nothing when the player leaves
       again. */
    let p = this.db.players[att.id];
    if (!p) { try { ws.close(1008, 'unknown player'); } catch (e) {} return; }
    p.lastSeen = nowMs();

    switch (msg.t) {
      case 'hello': {
        if (msg.name) p.name = String(msg.name).slice(0, 24);
        if (msg.tank) p.tank = String(msg.tank).slice(0, 32);
        if (Number.isFinite(msg.color)) p.color = msg.color;

        /* RESUME. The client keeps the id this object gave it and offers it back
           on the next connection. If that id belongs to a player who is asleep in
           a live match, this socket BECOMES that player: same id, same roster
           slot, same tank, same room. That is what lets a reload drop someone
           straight back into the battle they were in.

           Refused unless the id is genuinely in a match AND asleep AND inside
           the grace, so a stale id from a finished match cannot walk back into
           it, and an id the client invented matches nothing. The "asleep" test
           is also what stops a SECOND TAB from hijacking a live session: it can
           only ever resume someone who has already gone. */
        if (msg.resume) {
          const prior = this.db.players[String(msg.resume)];
          const m = prior && prior.matchCode ? this.db.matches[prior.matchCode] : null;
          const asleep = !!(prior && prior.disconnectedAt);
          const withinGrace = asleep && nowMs() < this.reconnectDeadline(prior);
          if (m && withinGrace) {
            const tmp = p.id;
            this.db.players[tmp] = undefined;   /* retire the id for this socket */
            delete this.db.players[tmp];
            this.wsById.delete(tmp);
            p = prior;
            /* The socket now belongs to the resumed player. Without this the
               attachment still names the retired id, so the next close would be
               attributed to a player who no longer exists.

               The attachment holds an ID and nothing else, deliberately: storing
               the player object would put a live socket handle in it (resumePlayer
               sets p.ws), and both structured clone and any JSON of that
               attachment would then hit a cycle. */
            ws.serializeAttachment({ id: p.id });
            this.resumePlayer(p, ws);
            await this.persist();
            await this.ensureAlarm();
            return;
          }
        }
        this.send(ws, { t: 'welcome', playerId: p.id });
        await this.persist();
        return;
      }
      case 'queue':
        await this.queuePlayer(p, msg.mode);
        /* Normally the window has not expired yet and this is a no-op. It
           matters when somebody joins a queue whose window ALREADY ran out but
           whose alarm has not fired yet: that player must not be left waiting
           for a timer that is about to be re-armed past their own deadline. */
        this.tryFormMatch(p.mode);
        this.send(ws, {
          t: 'queued',
          mode: p.mode,
          queueSize: this.playerCountInQueue(p.mode),
          botFillInMs: Math.max(0, BOT_FILL_DELAY_MS - (nowMs() - p.queuedAt)),
          botFillDelayMs: BOT_FILL_DELAY_MS,
        });
        await this.persist();
        await this.ensureAlarm();
        return;
      case 'unqueue':
        this.leaveQueue(p);
        this.send(ws, { t: 'unqueued' });
        await this.persist();
        await this.ensureAlarm();
        return;
      case 'clan.upsert':
        if (msg.clan && msg.clan.code) this.db.clans[msg.clan.code] = msg.clan;
        this.send(ws, { t: 'clans', clans: Object.values(this.db.clans) });
        await this.persist();
        return;
      case 'clan.remove':
        if (msg.code) delete this.db.clans[msg.code];
        await this.persist();
        return;
      case 'clan.list':
        this.send(ws, { t: 'clans', clans: Object.values(this.db.clans) });
        return;

      /* ---- PRIVATE ROOMS --------------------------------------------------
         Private rooms never existed on this object at all. A match was created
         by exactly one path — the queue — so a host who pressed "Start
         Hosting" got a socket and a locally generated code the SERVER had
         never heard of: its relays ('join', 'rtc-*' and everyone else) look up
         the sender's matchCode and silently drop anything addressed to a match
         that does not exist. A client could dial nothing, and nothing the host
         sent ever arrived. Both sides sat in an empty arena.

         Two message types close the gap:

           host-room  the host declares its room (code + capacity + visibility)
                      and the room becomes a real match keyed by that code;
           join-room  a client attaches to a room by code and is told the
                      host's id, which is what lets it dial the direct link.

         Membership after that is the SAME mechanism the queue uses -- p.
         matchCode -- so every later relay, roster update, sleep/wake,
         host-change and rejoin works for a private room without a single new
         line of relay code. A room with no members reaps itself in the alarm
         pass like the queue matches do. */
      case 'host-room': {
        const wanted = String(msg.code || '').trim().toUpperCase().slice(0, 8);
        if(!/^[A-Z0-9]{4,8}$/.test(wanted)){
          this.send(ws, { t: 'reject', reason: 'Bad room code' });
          await this.persist();
          return;
        }
        let m = this.db.matches[wanted];
        if(m && m.hostId !== p.id){
          this.send(ws, { t: 'reject', reason: 'That room code is already in use' });
          await this.persist();
          return;
        }
        if(!m){
          m = {
            code: wanted,
            mode: 'room',         /* never in a queue; not touched by any matchmaker */
            seed: 0,
            botCount: 0,
            hostId: p.id,
            playerIds: [p.id],
            maxPlayers: Math.max(1, Math.min(20, Number(msg.maxPlayers) || 8)),
            votes: {},
            mapId: null,
            mapLocked: false,
            cursor: {},
            createdAt: nowMs(),
            startedAt: null,
            closedAt: null,
            _stamp: 0, _recip: null, _recipStamp: -1,
          };
          this.db.matches[wanted] = m;
        } else {
          m.maxPlayers = Math.max(1, Math.min(20, Number(msg.maxPlayers) || 8));
        }
        p.matchCode = wanted;
        p.matchRole = 'host';
        p.lastSeen = nowMs();
        this.touchMembership(m);
        this.send(ws, { t: 'room-opened', code: wanted });
        console.log(`[room] ${wanted} opened by ${p.id} (max ${m.maxPlayers})`);
        await this.persist();
        return;
      }
      case 'join-room': {
        const wanted = String(msg.code || '').trim().toUpperCase().slice(0, 8);
        const m = this.db.matches[wanted];
        if(!m || m.closedAt){
          this.send(ws, { t: 'reject', reason: 'No such room' });
          await this.persist();
          return;
        }
        if(p.matchCode && p.matchCode !== wanted){
          this.send(ws, { t: 'reject', reason: 'Already in another room' });
          await this.persist();
          return;
        }
        if(!m.playerIds.includes(p.id)){
          const max = Math.max(1, Math.min(20, m.maxPlayers || 20));
          if(m.playerIds.length >= max){
            this.send(ws, { t: 'reject', reason: 'Room is full' });
            await this.persist();
            return;
          }
          m.playerIds.push(p.id);
        }
        p.matchCode = wanted;
        p.matchRole = 'client';
        p.lastSeen = nowMs();
        this.touchMembership(m);
        /* hostId is what the client dials its direct link to. The JOIN INFO it
           sends next is relayed as 'peerjoin' by the normal path, which is what
           makes the host spawn the new tank. */
        this.send(ws, { t: 'joined-room', code: wanted, hostId: m.hostId });
        console.log(`[room ] ${wanted} joined by ${p.id}`);
        await this.persist();
        return;
      }
      default:
        await this.handleRelay(ws, p, msg);
        return;
    }
  }

  async webSocketClose(ws) { await this.ready; await this.onSocketGone(ws, 'closed'); }
  async webSocketError(ws) { await this.ready; await this.onSocketGone(ws, 'error'); }

  /* The socket for a player went away. In a match they are put to SLEEP rather
     than removed, so a closed tab can be undone by reopening it. Out of a match
     there is nothing to come back to, so they leave immediately.

     Resolved from the socket's attachment rather than from a captured variable,
     because a resumed socket's attachment points at the ORIGINAL player, not at
     the id this connection happened to be given. */
  async onSocketGone(ws, why) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    const p = this.db.players[att.id];
    if (!p || p.disconnectedAt) return;
    this.wsById.delete(att.id);
    p.ws = null;
    this.suspendPlayer(p, why);
    await this.persist();
    await this.ensureAlarm();
  }

  /* ======================================================================== */
  /*  ALARM — the durable timer that forms bot-filled matches                */
  /* ======================================================================== */

  async alarm() {
    await this.ready;

    /* 1. a match formed? */
    const modes = new Set(Object.keys(this.db.queues));
    let mutated = false;
    for (const mode of modes) {
      const before = (this.db.queues[mode] || []).length;
      if (!before) continue;
      const m = await this.tryFormMatch(mode);
      if (m) mutated = true;
    }

    /* 2. reap sockets that vanished without a clean close.
          Membership comes from the attachments the runtime holds, never from the
          store: the store cannot hold a socket handle. */
    const live = new Set();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.id) live.add(att.id);
    }
    for (const id in this.db.players) {
      const p = this.db.players[id];
      if (!live.has(id) && !p.matchCode) { delete this.db.players[id]; mutated = true; }
    }
    const t = nowMs();
    for (const mode in this.db.queues) {
      const kept = (this.db.queues[mode] || []).filter((id) => {
        const p = this.db.players[id];
        return p && t - p.lastSeen <= QUEUE_STALE_MS && !p.matchCode;
      });
      if (kept.length !== (this.db.queues[mode] || []).length) {
        this.db.queues[mode] = kept; mutated = true;
      }
      if (!kept.length) delete this.db.queues[mode];
    }

    /* 3. reap finished matches */
    for (const code in this.db.matches) {
      const m = this.db.matches[code];
      if (m.closedAt && t - m.closedAt > MATCH_REAP_MS) { delete this.db.matches[code]; mutated = true; }
    }

    /* 4. expire players whose reconnect grace has run out. Until this fires they
          keep their roster slot and their sleeping tank; after it they are a real
          departure and the hole is backfilled with a bot. */
    for (const id in this.db.players) {
      const p = this.db.players[id];
      if (!p.disconnectedAt) continue;
      if (t < this.reconnectDeadline(p)) continue;      /* still asleep, not gone */
      this.dropPlayer(id, 'grace expired');
      mutated = true;
    }

    if (mutated) await this.persist();
    await this.ensureAlarm();
  }

  /* ======================================================================== */
  /*  PLAYERS + QUEUE                                                        */
  /* ======================================================================== */

  addPlayer(info, ws) {
    const id = 'p-' + rid(9);
    /* The socket handle is deliberately NOT part of `db` — it must never be
       serialised into storage. It is looked up through wsFor(). */
    const p = {
      id,
      name: String(info.name || 'Player').slice(0, 24),
      tank: String(info.tank || 'coolbuddy').slice(0, 32),
      color: Number.isFinite(info.color) ? info.color : 0x888888,
      mode: null,
      matchCode: null,
      matchRole: null,
      queuedAt: 0,
      lastSeen: nowMs(),
    };
    this.db.players[id] = p;
    if (ws) { if (!this.wsById) this.wsById = new Map(); this.wsById.set(id, ws); }
    return p;
  }

  /* Sockets live in a Map, not in storage. Rebuilt by scanning
     ctx.getWebSockets(), which survives eviction. */
  wsFor(id) {
    if (!this.wsById) this.wsById = new Map();
    const known = this.wsById.get(id);
    if (known) return known;
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.id === id) { this.wsById.set(id, ws); return ws; }
    }
    return null;
  }

  send(ws, obj) {
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket died mid-send */ }
  }

  sendTo(id, obj) { this.send(this.wsFor(id), obj); }

  playerCountInQueue(mode) {
    const q = this.db.queues[mode] || [];
    let n = 0;
    for (const id of q) {
      const p = this.db.players[id];
      if (p && p.mode === mode && !p.matchCode) n++;
    }
    return n;
  }

  leaveQueue(p) {
    if (!p || !p.mode) return;
    const q = this.db.queues[p.mode] || [];
    this.db.queues[p.mode] = q.filter((id) => id !== p.id);
    if (!this.db.queues[p.mode].length) delete this.db.queues[p.mode];
    p.mode = null;
    p.queuedAt = 0;
  }

  queuePlayer(p, mode) {
    this.leaveQueue(p);
    p.mode = String(mode || 'random-battle').slice(0, 32);
    p.queuedAt = nowMs();
    p.lastSeen = nowMs();
    if (!this.db.queues[p.mode]) this.db.queues[p.mode] = [];
    this.db.queues[p.mode].push(p.id);
    /* Deliberately NOT forming the match here. The window always runs to
       completion — see tryFormMatch. */
  }

  /* ======================================================================== */
  /*  MATCHMAKING — ported verbatim in behaviour from server/mpserver.js      */
  /* ======================================================================== */

  /* makeBot() and the BOT_TANKS / BOT_NAMES tables used to live here and are gone:
     bots are derived on the client from the match seed (js/roster-factory.js).
     Keeping a second generator would be two sources of truth for one list, which
     is how bots ended up named differently on the host and on a client. */

  /* The HUMANS only. Bots are derived on the client from `seed` and `botCount`
     (js/roster-factory.js), so they are never stored or transmitted. */
  rosterOf(match) {
    const humans = [];
    for (const id of match.playerIds) {
      const pl = this.db.players[id];
      if (pl) humans.push({ peerId: id, name: pl.name, tank: pl.tank, color: pl.color, isBot: false });
    }
    return humans;
  }

  /* WHEN DOES THIS ASLEEP PLAYER STOP COUNTING?

     Every grace check reads this rather than adding RECONNECT_GRACE_MS to the
     disconnect time, because the window is no longer one number. It is decided
     per player at the moment they drop, stashed on the record, and every
     reader -- the alarm scheduler, the reconnect admission check, the expiry
     sweep and the `until` shown to peers -- asks this. One source of truth, so
     the four can never disagree about when somebody is gone.

     The fallback matters: a player record written before this field existed has
     no deadline on it, and reading undefined would make `t < undefined` false,
     which would expire every such player instantly on the first sweep. */
  reconnectDeadline(p) {
    if (!p) return 0;
    if (p.reconnectBy) return p.reconnectBy;
    return p.disconnectedAt ? (p.disconnectedAt + RECONNECT_GRACE_MS) : 0;
  }

  /* Move the host role to somebody else, and tell everyone.

     Shared by the two ways it can happen: a clean departure (dropPlayer) and a
     host going to sleep (suspendPlayer). They used to be written separately,
     which is how the second one came to be missing — the clean-leave path
     promoted a host and nobody thought about the asleep one, because "host
     disconnected" is not the same sentence as "host left" and it reads like it
     has already been handled. */
  promoteHost(m, why) {
    if (!m) return;
    const idx = m.playerIds.indexOf(m.hostId);
    /* Still somebody in the room who is awake. */
    if (idx >= 0) {
      const still = this.db.players[m.hostId];
      if (still && !still.disconnectedAt) return;
    }
    /* Prefer someone already connected, so we do not promote another sleeping
       player and hand the match to somebody who is not there either. */
    let next = null;
    for (const pid of m.playerIds) {
      const other = this.db.players[pid];
      if (other && !other.disconnectedAt) { next = pid; break; }
    }
    if (!next) next = m.playerIds[0];
    if (!next) return;
    m.hostId = next;
    for (const pid of m.playerIds) {
      const other = this.db.players[pid];
      if (!other) continue;
      other.matchRole = other.id === m.hostId ? 'host' : 'client';
      this.sendTo(pid, Object.assign({
        t: 'hostchange', hostId: m.hostId, role: other.matchRole,
      }, this.rosterMsg(m)));
    }
    console.log(`[match] ${m.code} host ${why}, ${m.hostId} promoted`);
  }

  /* The wire form of a roster update. botCount is DERIVED from how many humans
     are left rather than stored, so a departure that backfills with a bot is a
     subtraction on the client instead of "append a random bot, rebuild all
     sixteen entries, re-send them to everyone". */
  rosterMsg(match) {
    return {
      players: this.rosterOf(match),
      seed: match.seed,
      botCount: Math.max(0, MATCH_SIZE - match.playerIds.length),
      humanCount: match.playerIds.length,
    };
  }

  tallyOf(m) {
    const out = {};
    for (const id in m.votes) out[id] = m.votes[id];
    return out;
  }

  tryFormMatch(mode) {
    const q = this.db.queues[mode] || [];
    const humans = [];
    for (const id of q) {
      const p = this.db.players[id];
      if (!p || p.matchCode) continue;
      if (nowMs() - p.lastSeen > QUEUE_STALE_MS) continue;
      humans.push(p);
    }
    if (!humans.length) { delete this.db.queues[mode]; return null; }

    const first = humans[0];
    const waited = nowMs() - first.queuedAt;

    /* THE QUEUE ALWAYS WAITS THE FULL WINDOW, THEN BOTS FILL THE SHORTFALL.

       It used to start the instant a second human appeared, which meant two
       people could be matched in under a second and everyone else waiting got
       nothing. Gating on "two humans" instead meant a SOLO player was never
       eligible at all, so the queue waited forever — the "it just waits and
       waits" report. So: the window always runs out, and bots make up the
       numbers. That is what the countdown promises. */
    if (waited < BOT_FILL_DELAY_MS) return null;

    /* ONE random draw per match; the room code and every bot derive from it.
       The object used to build up to sixteen bot entries, each with its own
       random id, and re-send ALL of them whenever anybody left. Bots have no
       authority and no socket, and the host synthesises their tanks from the
       mode's own bot loops anyway -- so the object sends a seed and a count and
       the clients derive the identical list (js/roster-factory.js).

       That matters most here of all: every mutation rewrites the whole store, so
       sixteen generated entries made every queue change and every departure
       write considerably more than it needed to. */
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const code = roomCodeFromSeed(seed);
    const botCount = Math.max(0, MATCH_SIZE - humans.length);

    const match = {
      code, mode,
      seed,
      botCount,
      hostId: humans[0].id,          /* first human in hosts */
      playerIds: humans.map((p) => p.id),
      votes: {},
      mapId: null,
      mapLocked: false,
      cursor: {},
      createdAt: nowMs(),
      startedAt: null,
      closedAt: null,
      /* Cached recipient sockets, rebuilt lazily whenever _stamp moves. */
      _stamp: 0, _recip: null, _recipStamp: -1,
    };
    this.db.matches[code] = match;

    for (const p of humans) {
      p.matchCode = code;
      p.matchRole = p.id === match.hostId ? 'host' : 'client';
    }
    this.db.queues[mode] = q.filter((id) => !match.playerIds.includes(id));
    if (!this.db.queues[mode].length) delete this.db.queues[mode];

    /* Each player gets ITS OWN role. Returning one payload to everybody is how
       two clients both come back believing they are the host. */
    for (const p of humans) {
      this.sendTo(p.id, Object.assign({
        t: 'matched',
        role: p.matchRole,
        code,
        hostId: match.hostId,
      }, this.rosterMsg(match)));
    }

    console.log(`[match] ${code} mode=${mode} humans=${humans.length} bots=${match.botCount} (waited ${(waited / 1000).toFixed(1)}s)`);
    return match;
  }

  /* ---- A PLAYER WHOSE SOCKET WENT AWAY -------------------------------------
     They keep their place in the match for RECONNECT_GRACE_MS. A queued player
     has nothing to come back to — no match, no tank — so they leave at once,
     which is also what stops the queue waiting on a ghost. */
  suspendPlayer(p, why) {
    if (!p || p.disconnectedAt) return;
    p.disconnectedAt = nowMs();
    p.lastSeen = p.disconnectedAt;
    if (!p.matchCode) { this.dropPlayer(p.id, why); return; }

    const m = this.db.matches[p.matchCode];
    if (m) {
      p.matchState = 'disconnected';

      /* THE HOST'S SLOT IS HELD FOR TWO SECONDS, NOT NINETY.

         And the promotion happens NOW rather than when the grace expires,
         because the freeze is caused by the absence of a host, not by the
         presence of an old one. Waiting the full window to promote meant the
         remaining players spent that window with nobody simulating at all. */
      const wasHost = m.hostId === p.id;
      const grace = wasHost ? HOST_GRACE_MS : RECONNECT_GRACE_MS;
      p.reconnectBy = p.disconnectedAt + grace;

      /* Everybody is told, so a client's roster view and nameplate grey out the
         same way on every machine, not just the host's. The `until` is this
         player's own deadline, not the global constant, or a host's peers would
         grey him out for ninety seconds and then be surprised when he was
         replaced after two. */
      for (const pid of m.playerIds) {
        if (pid === p.id) continue;
        this.sendTo(pid, { t: 'peersleep', peerId: p.id, until: p.reconnectBy });
      }

      if (wasHost) this.promoteHost(m, 'fell asleep');
    }
    console.log(`[sleep] ${p.id} disconnected, holding place for ${this.reconnectDeadline(p) - p.disconnectedAt}ms (${why || ''})`);
  }

  /* Back in, with a new socket. The identity is preserved, so the host maps the
     same peerId to the same tank and the client recognises its own slot. */
  resumePlayer(p, ws) {
    const wasAsleep = !!p.disconnectedAt;
    p.ws = ws;
    p.lastSeen = nowMs();
    p.disconnectedAt = 0;
    p.reconnectBy = 0;
    if (wasAsleep) p.matchState = 'connected';
    this.wsById.set(p.id, ws);

    const m = p.matchCode ? this.db.matches[p.matchCode] : null;
    this.send(ws, Object.assign({
      t: 'welcome',
      playerId: p.id,
      /* Tells the client this is a resume rather than a fresh join, so it puts
         the player back where they were instead of into the menu. */
      resumed: true,
      code: m ? m.code : null,
      role: p.matchRole || null,
      hostId: m ? m.hostId : null,
      seed: m ? m.seed : null,
      mapId: m ? m.mapId : null,
    }, m ? this.rosterMsg(m) : {}));

    if (m) {
      for (const pid of m.playerIds) {
        if (pid === p.id) continue;
        this.sendTo(pid, { t: 'peerwake', peerId: p.id });
      }
    }
    console.log(`[wake ] ${p.id} reconnected${m ? ' into ' + m.code : ''}`);
    return p;
  }

  /* THE REAL GOODBYE. Backfill the hole with a bot and tell the host, which is
     what the game needs to keep the arena consistent. */
  dropPlayer(id, why) {
    const p = this.db.players[id];
    if (!p) return;
    this.leaveQueue(p);

    if (p.matchCode) {
      const m = this.db.matches[p.matchCode];
      if (m) {
        /* Tell the host so it can drop the tank. */
        this.sendTo(m.hostId, { t: 'peerleave', peerId: id });

        const idx = m.playerIds.indexOf(id);
        if (idx >= 0) m.playerIds.splice(idx, 1);
        /* The cached recipient list just became wrong. */
        this.touchMembership(m);

        /* The hole is backfilled with a bot whether or not the battle started:
           clients get the roster at match time and spawn from it, so a human who
           leaves during the vote would otherwise be spawned as a tank that does
           not exist. The object does NOT create that bot — botCount is derived
           from how many humans are left, so the client derives one more than
           before and the bots already in the arena keep their identities. */
        for (const pid of m.playerIds) {
          this.sendTo(pid, Object.assign({ t: 'roster' }, this.rosterMsg(m)));
        }

        if (!m.playerIds.length) { m.closedAt = nowMs(); delete this.db.matches[m.code]; }
        else if (m.hostId === id) {
          /* Same promotion the asleep path uses, so the two cannot drift. The
             departing host is already off playerIds by this point, which is
             exactly the state promoteHost treats as "nobody here is host". */
          this.promoteHost(m, 'left');
        }
      }
      p.matchCode = null;
      p.matchRole = null;
    }
    delete this.db.players[id];
    this.wsById && this.wsById.delete(id);
    console.log(`[bye  ] ${id} ${why || ''}`);
  }

  /* ======================================================================== */
  /*  RELAY — the host is authoritative for the simulation. The object moves   */
  /*  payloads between sockets and never inspects or rewrites them.           */
  /* ======================================================================== */

  membersOf(match, exceptId) {
    const out = [];
    for (const id of match.playerIds) {
      if (id === exceptId) continue;
      if (this.db.players[id]) out.push(id);
    }
    return out;
  }

  broadcast(match, exceptId, obj) {
    for (const id of this.membersOf(match, exceptId)) this.sendTo(id, obj);
  }

  /* ---- THE HOT PATH -----------------------------------------------------
     Snapshots are the bulk of everything this object carries, at 20 Hz per
     client. Three things used to happen to each one for no reason: the whole
     message was parsed only to read `t`, membersOf() allocated an array per
     message, and the object was re-serialised into an equivalent one.

     This matters more for a Durable Object than for a normal server. An object
     is single-threaded and has a CPU budget per request, so every microsecond
     saved on the busiest path is headroom for every other player in the match.

       * recipients() caches the socket list and rebuilds it only when
         membership actually changes (touchMembership), and
       * a snapshot is forwarded as the host's own bytes — no parse, no
         re-encode. `_stamp` is a counter rather than the array length, because
         swapping one player for another keeps the length identical and would
         leave a stale cache pointing at a socket that has gone.
     -------------------------------------------------------------------- */
  recipients(match) {
    if (match._recipStamp === match._stamp && match._recip) return match._recip;
    const list = [];
    for (const id of match.playerIds) {
      const ws = this.wsFor(id);
      if (ws) list.push(ws);
    }
    match._recip = list;
    match._recipStamp = match._stamp;
    return list;
  }

  touchMembership(match) {
    match._stamp = (match._stamp || 0) + 1;
    match._recip = null;
    match._recipStamp = -1;
  }

  sendRaw(ws, raw) {
    if (!ws) return;
    try { ws.send(raw); } catch (e) { /* socket died mid-send */ }
  }

  /* Forward already-serialised bytes to everyone but the sender. Allocates
     nothing on the way: this is the busiest line in the object. */
  relayRaw(match, exceptId, raw) {
    const list = this.recipients(match);
    for (let i = 0; i < list.length; i++) {
      const ws = list[i];
      if (exceptId != null && match.playerIds[i] === exceptId) continue;
      /* A slow client must not grow an unbounded send buffer: at 20 snapshots a
         second a bad link would pile up until the object ran out of memory.
         Skipping is correct — the next snapshot carries fresher truth. */
      if (ws.bufferedAmount != null && ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      this.sendRaw(ws, raw);
    }
  }

  /* Snapshots go out at 20Hz per client. A client that cannot drain its send
     buffer is skipped rather than allowed to buffer without bound; the next
     snapshot supersedes anything dropped.

     `skip` is the set of players the host has a DIRECT WebRTC link to. They
     are about to receive this exact frame over that link, so sending it over
     the WebSocket as well would pay the Durable Object's request budget for the
     whole match twice over and hand the client two copies of one frame.

     It is optional and defaults to nothing, so a match with no WebRTC links at
     all behaves exactly as it always has — same loop, same allocation. */
  broadcastState(match, fromId, obj, skip) {
    for (const id of this.membersOf(match, fromId)) {
      if (skip && skip.has(id)) continue;
      const ws = this.wsFor(id);
      if (!ws) continue;
      try {
        if (ws.bufferedAmount != null && ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
        ws.send(JSON.stringify(obj));
      } catch (e) { /* ignore */ }
    }
  }

  /* The host sends `{ t: 'state', s: ... }` and net.js builds that object
     literally, so `t` is always the first key and the bytes it produced are
     already exactly the bytes we would emit. That is what makes forwarding them
     verbatim safe — no parse, no re-encode, on the busiest path there is.

     This is only a fast path, never a correctness requirement: if the prefix does
     not match, the frame falls through to the ordinary parse and behaves exactly
     as before. */
  static looksLikeState(raw) {
    return typeof raw === 'string' && raw.charCodeAt(0) === 123 /* { */ &&
           raw.startsWith('{"t":"state"');
  }

  async handleStateVerbatim(ws, raw) {
    const att = ws.deserializeAttachment();
    const p = att && this.db.players[att.id];
    /* Members only. Without this the socket would be an open broadcast to
       whoever happened to be in a match. */
    if (!p || !p.matchCode) return;
    const m = this.db.matches[p.matchCode];
    if (!m || m.playerIds.indexOf(p.id) < 0) return;
    p.lastSeen = nowMs();
    this.relayRaw(m, p.id, raw);
  }

  handleRelay(ws, p, msg) {
    const m = p.matchCode ? this.db.matches[p.matchCode] : null;
    if (!m) return Promise.resolve();

    switch (msg.t) {
      /* Shared cursor for the map-vote screen. A plain relay: the object does
         not care what the numbers mean, and it goes to everyone because both
         players are looking at a DOM overlay here, not at the 3D world.

         KEEP THE FRACTION. The client sends a NORMALISED position (0..1) and
         multiplies by the viewport on the way out, so rounding to an integer
         destroys the coordinate — every cursor arrives as 0 or 1 and renders as
         the far corner of the vote screen instead of following the player's
         hand. Clamped to 0..1 so a bogus client cannot place one off-screen. */
      case 'cursor': {
        const unit = (v) => Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 1e4) / 1e4)) : 0;
        m.cursor[p.id] = { x: unit(Number(msg.x)), y: unit(Number(msg.y)), at: nowMs() };
        this.broadcast(m, null, { t: 'cursors', cursors: m.cursor });
        return Promise.resolve();
      }

      /* client -> host */
      case 'join':
        /* NEVER echo a player's own join back to itself. The host announces
           itself with the same message; without this guard the host runs
           _onClientJoin() for ITSELF and registers a tank it owns but must not
           simulate as a remote player. */
        if (p.id === m.hostId) return Promise.resolve();
        this.sendTo(m.hostId, {
          t: 'peerjoin', peerId: p.id, name: p.name,
          tank: msg.tank || p.tank,
          color: msg.color != null ? msg.color : p.color,
        });
        return Promise.resolve();

      case 'input':
        this.sendTo(m.hostId, { t: 'input', from: p.id, input: msg.input });
        return Promise.resolve();

      /* ---- P2P id exchange (client <-> host) --------------------------
         The host's P2P id is what each client dials its direct WebRTC link to,
         and each client's P2P id is what the host addresses that client by. This
         is the one message that must go over the relay, because the channel those
         peers will use is the thing that would otherwise carry it.

         Two shapes, both relayed exactly as sent so js/net.js can decide what
         they mean:

           client -> host:  { t:'p2p-id', p2pId }
           host -> client:  { t:'p2p-id', to: peerId, p2pId }

         The object does not care what the ids mean — it just carries them, like
         input and cursor positions. Membership is load-bearing: both peers must be
         in THIS match, and the sender must be in it too. Anything else is dropped
         silently. */
      case 'p2p-id': {
        if (msg.to) {
          /* host -> client */
          const target = this.db.players[msg.to];
          if (target && target.matchCode === m.code) {
            this.sendTo(target.id, msg);
          }
        } else if (msg.p2pId) {
          /* client -> host */
          if (p.id !== m.hostId) {
            this.sendTo(m.hostId, msg);
          }
        }
        return Promise.resolve();
      }

      /* ---- WebRTC SIGNALLING ----------------------------------------------
         THE OBJECT IS A SWITCHBOARD, NOT A PARTICIPANT.

         Two browsers cannot find each other on their own. Something has to
         carry the WebRTC handshake — the offer, the answer, the ICE candidates
         — from one to the other. That is all this does: three message types,
         forwarded verbatim, and the object never looks inside an SDP blob or a
         candidate.

         Why this is worth having at all. Everything above it — `input` at once
         per frame per client, `state` twelve times a second — is bulk traffic
         that a Durable Object counts against its daily request budget. Once a
         direct link exists between two players, none of that has to arrive here
         any more. The handshake is a few dozen messages ONCE per match; the
         traffic it removes is hundreds per second for the whole battle.

         THE MEMBERSHIP CHECK IS LOAD-BEARING.

         Without it this is a message router with a user-supplied destination:
         any client could name any player id in any match and have the server
         deliver to them. Both players must be in THIS match, and the sender
         must be in it too. Anything else is refused silently — a relay that
         answers "who is that?" to a stranger is worse than one that stays
         quiet.

         Nothing is persisted. Signalling is worthless ten seconds later, and
         writing it to storage would cost more than it saves. */
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice': {
        const target = msg.to && this.db.players[msg.to];
        if (!target || target.matchCode !== m.code) return Promise.resolve();
        if (target.id === p.id) return Promise.resolve();   /* no loop to yourself */

        const out = { t: msg.t, from: p.id };
        if (msg.t === 'rtc-ice') out.cand = msg.cand;
        else out.sdp = msg.sdp;
        this.sendTo(target.id, out);
        return Promise.resolve();
      }

      case 'ping':
        this.send(ws, { t: 'pong', ts: msg.ts });
        return Promise.resolve();

      /* host -> clients */
      case 'state': {
        /* `rtc` names the players the host has a direct link to. Anything that
           is not a list of ids in THIS match is ignored rather than trusted, so
           a hand-edited client cannot use this field to make the server skip a
           real recipient and quietly stop feeding somebody snapshots. */
        let skip = null;
        if (Array.isArray(msg.rtc) && msg.rtc.length) {
          skip = new Set();
          for (const id of msg.rtc) {
            if (typeof id === 'string' && m.playerIds.indexOf(id) >= 0) skip.add(id);
          }
          if (!skip.size) skip = null;
        }
        this.broadcastState(m, p.id, { t: 'state', s: msg.s }, skip);
        return Promise.resolve();
      }

      case 'spawn': {
        const target = msg.to && this.db.players[msg.to];
        if (target) this.sendTo(target.id, { t: 'spawn', data: msg.data });
        return Promise.resolve();
      }
      case 'fullstate': {
        const target = msg.to && this.db.players[msg.to];
        if (target) this.sendTo(target.id, { t: 'fullstate', state: msg.state });
        return Promise.resolve();
      }
      case 'matchstart':
        m.startedAt = nowMs();
        this.broadcast(m, p.id, { t: 'started' });
        return this.persist();

      /* shared map vote */
      case 'vote': {
        const mapId = String(msg.map || '').slice(0, 32);
        if (!mapId) return Promise.resolve();
        m.votes[p.id] = mapId;
        this.broadcast(m, null, { t: 'votes', votes: this.tallyOf(m), mapId });
        return Promise.resolve();
      }

      /* THE MAP IS DECIDED ONCE, BY THE HOST, AND IS NOT A VOTE.
         Every client used to run its own winner-picker over its own copy of
         the tally, the copies disagreed, and two players ended up on two
         different maps — fatal in Capture the Circle, where the halves have
         different geometry, spawns and cover. The host decides once and
         announces; the object records it and pushes it to everyone. */
      case 'map': {
        const mapId = String(msg.map || '').slice(0, 32);
        if (!mapId) return Promise.resolve();
        if (m.hostId !== p.id) return Promise.resolve();   /* only the host may call it */
        m.mapId = mapId;
        m.mapLocked = true;
        this.broadcast(m, null, { t: 'map', mapId });
        console.log(`[match] ${m.code} host chose map ${mapId}`);
        return this.persist();
      }

      default:
        return Promise.resolve();
    }
  }
}

export default { fetch: () => new Response('use Lobby', { status: 404 }) };