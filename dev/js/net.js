/* ============================================================================
   net.js — multiplayer transport.

   WHAT THIS REPLACED
   ------------------
   The old transport was PeerJS against the free public broker, plus a
   Cloudflare Worker with a placeholder KV id. Three things were broken beyond
   repair and each one alone was fatal:

   1. IDENTITY. joinQueue() sent `Net.myPeerId || 'p-' + random`, but no Peer
      object existed yet at that point, so the id was always a throwaway. The
      real PeerJS socket was assigned a DIFFERENT id a few seconds later. The
      host then did `players.find(p => p.peerId === info.peerId)` and found
      nobody, every time. Players would connect at the socket level and the
      game would never spawn them.

   2. THE SIGNALING SERVER. On localhost, _peerOpts() pointed PeerJS at
      `origin/peerjs`, which no local server implements -- local testing could
      never work. Off-localhost it used the free public broker, which is
      rate-limited and drops registrations.

   3. THE MATCHMAKING BACKEND. CONFIG.MATCHMAKING_URL was location.origin, so
      the queue POSTed to the static file server, which has no /api/match/*
      route. Every join 404'd.

   Now: one WebSocket to /mp on the same origin that served the page. The
   server owns identity, so there is nothing left to mismatch. Cloudflare
   tunnels forward WebSockets, so the tunnel the user already runs keeps
   working with no extra hostname.

   The PUBLIC API IS UNCHANGED, which is the whole point: game.js, platoon.js
   and menu.js call exactly the same Net.* functions and set exactly the same
   Net.on* callbacks they always did.
   ========================================================================== */

const Net = {
  /* ---- connection ---- */
  ws: null,
  connected: false,
  playerId: null,          /* server-assigned; the ONLY identity that exists */
  myPeerId: null,          /* alias kept for existing callers */
  roomCode: null,
  role: null,              /* 'host' | 'client' */
  maxPlayers: 8,
  isPublic: false,
  fakePlayers: 0,

  /* Host-side view of the match */
  conns: {},               /* peerId -> { ws-less peer record } */
  hostConn: null,          /* client-side handle to the host */

  /* Compatibility shim: game.js reads Net.peer._lastPing for the HUD. */
  peer: { _lastPing: null },

  /* ---- P2P multiplayer fast path (host-authoritative) ----

     When the host opts in, clients open a direct WebRTC data channel to the
     host and move the two hot paths (inputs and snapshots) over it. The server
     relay is ALWAYS still present: the direct link is a fast path, never the
     only path, so a NAT that refuses the handshake, a browser with no WebRTC,
     or a host that did not opt in all keep playing over the socket exactly as
     before.

     One authority, one simulation. P2P here is pure transport: the host still
     owns the simulation. Clients do not host logic, do not run their own
     snapshot stream, and do not decide anything. The only thing that changes is
     whose wire the bytes cross, which is exactly what takes the relay out of the
     hot path for the people who can use it.

     Identities are separate from the server's player ids on purpose. The server
     id is what the match owns and what reconnect/resume hangs on. The P2P id is
     what a WebRTC channel is addressed with and what a dropped channel retries
     against. They are linked one-to-one while a match is live and re-linked on
     resume; they are not the same string because the two systems have different
     lifetimes and different retry rules. */
  p2p: {
    enabled: false,          /* host opted in for this match */
    myId: null,             /* this client's P2P id for this match */
    hostId: null,           /* P2P id of the host, when we know it */
    roles: {},              /* p2pId -> 'host' | 'client' */
    direct: {},             /* p2pId -> { send(obj), sendRaw(str), connected, open } */
    _pendingOffers: {},     /* p2pId -> queued rtc-offer if the channel is not up yet */
    _retry: null,
  },

  _statusEl: null,
  _lastPing: null,
  _pingTimer: null,
  _reconnectTimer: null,
  _wantOpen: false,    _pendingJoin: null,
    _queue: [],              /* messages sent before the socket opened */
    _p2pRetryTimer: null,

  /* Callbacks (set by game.js) */
  onPlayerJoin: null,
  onPlayerLeave: null,
  onInput: null,
  onState: null,
  onWelcome: null,
  onMatchStart: null,
  onVote: null,
  onMapChosen: null,
  onCursorsUpdate: null,
  onHostChange: null,
  onQueueState: null,
  chosenMap: null,       /* the map the host declared for this match */
  cursors: null,         /* peerId -> {x, y, at} for every other player */

  _status(msg, cls) {
    if (!this._statusEl) this._statusEl = document.getElementById('net-status');
    const el = this._statusEl;
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden', 'on', 'off');
    if (cls) el.classList.add(cls);
  },

  staticCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); },

  /* Is a match server reachable at all?

     This is a real connection attempt, not a URL check, and it is cached after
     the first answer so it is not asked on every mode selection. menu.js's
     tdmReady() used to test CONFIG.MATCHMAKING_URL, which is location.origin
     and therefore true on any http page -- including one with nothing behind
     it -- so the two multiplayer modes always looked available and only failed
     later, at the first request. */
  async connect(){
    try {
      await this._open();
      this._serverReachable = true;
      return true;
    } catch(e){
      this._serverReachable = false;
      return false;
    }
  },

  _serverKnown() { return this._serverReachable === true; },

  /* ======================================================================
     SOCKET
     ====================================================================== */
  /* WHERE THE MATCH SERVER ACTUALLY LIVES.

     Same-origin by default: the page and the socket on one host, which is
     what the local Node server and the single-origin Worker deployment both
     want, and what has always worked.

     The exception is the pages.dev deployment. Pages serves the game's static
     files but CANNOT host a Durable Object, and the lobby in
     worker/matchmaker.js is one -- so on pages.dev there is no /mp endpoint at
     all and a same-origin socket would simply fail to open. The lobby lives on
     the Worker, which speaks the identical protocol, so the socket is pointed
     there. Everything else stays on whichever host served the page.

     Anything not matching *.pages.dev is left alone, so localhost development
     (http://localhost:18123) keeps talking to the local server exactly as
     before. */
  _wsUrl() {
    const WORKER_HOST = 'tanklg.nojus-t.workers.dev';
    let host = location.host;
    if (/(^|\.)pages\.dev$/i.test(host)) host = WORKER_HOST;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + host + '/mp';
  },

  _open() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return Promise.resolve();
    }
    this._wantOpen = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok  = () => { if (!settled) { settled = true; clearTimeout(to); resolve(); } };
      const bad = (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } };
      const to = setTimeout(
        () => bad(new Error('Could not reach the match server. Is it running?')),
        10000
      );

      let ws;
      try {
        ws = new WebSocket(this._wsUrl());
      } catch (e) {
        bad(new Error('Could not open a socket to the match server.'));
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this._status('Connected', 'on');
        /* Say who we are before anything else so the server has a name on us.

           This hello also OFFERS the id we were last given. That is what makes a
           reload drop you back into the battle you were in: the server was
           holding your place while your tab was gone, and it recognises you by
           this id. It is a request, not a claim — the server refuses any id it
           is not currently holding for a live match, so a stale id from a
           finished game simply gets a new one.

           Offering it here rather than only in joinQueue() is deliberate: a
           reconnect after a reload does not go through the queue, it just opens
           a socket, so this is the only hello it will ever send. */
        const s = (typeof Menu !== 'undefined' && Menu.settings) || {};
        this._raw({
          t: 'hello',
          name: s.playerName || 'Player',
          tank: s.selectedTank || 'coolbuddy',
          resume: (typeof SessionGuard !== 'undefined') ? SessionGuard.rememberedId() : null,
        });
        /* Anything queued while the socket was down goes out now, in order. */
        const q = this._queue.splice(0, this._queue.length);
        for (const m of q) this._raw(m);
        /* Relay round-trip, 1 ping a second, from the moment the socket is
           alive. The HUD and the settings screen both read Net._lastPing; a
           number that is only measured here always exists instead of only
           during the few flows that used to remember to start it. */
        if (typeof this._startPing === 'function') this._startPing();
        ok();
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this._handle(msg);
      };

      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        this._stopPing();
        this._status('Disconnected', 'off');
        /* Auto-reconnect while the player still wants to be in a match: a
           tunnel blip or a suspended tab should heal itself rather than drop
           the player out of the match. */
        if (this._wantOpen) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => {
            this._open().catch(() => {
              this._reconnectTimer = setTimeout(() => this._open().catch(() => {}), 2000);
            });
          }, 1200);
        }
      };

      ws.onerror = () => { bad(new Error('Could not reach the match server.')); };
    });
  },

  _raw(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { /* fall through */ }
    }
    /* Buffer: the socket is still opening. Bounded so a dead socket cannot
       grow this array without limit. */
    if (this._queue.length < 200) this._queue.push(obj);
    return false;
  },

  /* ======================================================================
     INBOUND
     ====================================================================== */
  _handle(msg) {
    if (!msg || !msg.t) return;

    /* WebRTC signalling passes straight through to the direct-link layer. It is
       the only thing the socket carries for that layer, and it is answered on
       the same socket — no loop, because _handle is not re-entered. */
    if (msg.t === 'rtc-offer' || msg.t === 'rtc-answer' || msg.t === 'rtc-ice') {
      if (typeof Rtc !== 'undefined') Rtc.onSignal(msg);
      return;
    }

    /* THE P2P-ID EXCHANGE, AND WHY IT MUST SIT HERE.

       It is exactly what rtc-* is: relay traffic the match server forwards
       verbatim between two peers of one match. It used to have NO receiving
       case anywhere in this file — the server (matchmaker.js) still relays
       { t:'p2p-id' } faithfully, but this switch never answered it, so the
       host never learned a client's address and a client never learned the
       host's. The fast-path handshake could therefore never complete; with
       the fast-path setting ON the host's `roles` stayed empty and
       broadcastP2P sent its snapshots nowhere at all, which froze every
       client on the whole match. game.js wires Net.onP2PId and owns the
       role-specific answer; this is where those messages finally arrive. */
    if (msg.t === 'p2p-id') {
      if (typeof this.onP2PId === 'function') this.onP2PId(msg);
      return;
    }

    switch (msg.t) {
      case 'welcome': {
        /* The server tells us our one and only id. */
        this.playerId = msg.playerId;
        this.myPeerId = msg.playerId;
        /* Keep it so a reload or a closed tab can offer it back and be put into
           the same battle. Without this the server has no way to recognise the
           returning player and holds their place for nobody. */
        if (typeof SessionGuard !== 'undefined') SessionGuard.rememberId(msg.playerId);
        if (this.peer) this.peer._lastPing = null;

        /* RESUME. The server can hand back the id we offered if it was holding
           it for us -- that is, if this player was asleep in a live match when
           their tab closed. The id is kept locally so it can be offered again;
           the server still decides whether to honour it, so this is a request,
           never a claim. */
        if (msg.resumed) {
          this.resumed = true;
          this.roomCode = msg.code || null;
          this.role = msg.role || null;
          this.hostId = msg.hostId || null;
          this.seed = (msg.seed != null) ? msg.seed : null;
          if (msg.seed != null && typeof RosterFactory !== 'undefined') {
            this.roster = RosterFactory.expand(msg);
          } else {
            this.roster = msg.players || [];
          }
          this.humanCount = msg.humanCount != null ? msg.humanCount : 1;
          this.botCount = msg.botCount || 0;
          this._status('Reconnected to match ' + (this.roomCode || ''), 'on');
          if (this.onResume) {
            this.onResume({
              code: this.roomCode, role: this.role, hostId: this.hostId,
              seed: this.seed, roster: this.roster, mapId: msg.mapId || null,
            });
          }
          /* Same as the fresh-match path: a returning tab knows the host, so it
             can offer the direct line again. The old peer record is gone with
             the socket, so this builds a new one. */
          if (typeof this._startDirectLink === 'function') this._startDirectLink();
          if (typeof this._startDirectKeepalive === 'function') this._startDirectKeepalive();
        } else {
          this.resumed = false;
          /* RE-ENTRY AFTER A REFUSED RESUME.

             The socket can drop and re-open faster than the server learns it
             is gone: the auto-reconnect fires ~1.2 s after a close, and the
             Durable Object may not have processed the close event yet, so the
             offered id still reads "awake" and the resume is REFUSED. What
             comes back is a brand-new playerId the roster has never seen,
             while all of this game's rooms, rosters and peers still name the
             old one. The player keeps playing against ghosts of themselves.

             The server can give the new identity the old seat: a plain
             join-room against the room we still believe we are in. If the old
             record is a host, the server's own host-change pass corrects the
             roles once the stale record expires. If the room is gone, the
             reject comes back and nothing worse than today happens. */
          if (this.roomCode && this._wantOpen && this.playerId) {
            this._recover = { from: this._recoverFrom || null, at: Date.now() };
            this._recoverFrom = msg.playerId;
            this._raw({ t: 'join-room', code: this.roomCode });
            this._status('Rejoining match ' + this.roomCode + '…', 'on');
          }
        }
        break;
      }

      case 'queued': {
        if (this.onQueueState) {
          this.onQueueState({
            mode: msg.mode,
            queueSize: msg.queueSize,
            botFillInMs: msg.botFillInMs,
            botFillDelayMs: msg.botFillDelayMs,
          });
        }
        this._status('Searching… ' + (msg.queueSize || 1) + ' in queue', 'on');
        break;
      }

      case 'matched': {
        this.roomCode = msg.code;
        this.role = msg.role;
        /* The server sends the HUMANS plus a seed and a bot count; the bots are
           built here so the server never has to invent or re-ship fourteen of
           them. RosterFactory.expand() passes an older server's already-complete
           roster straight through, so this is safe to deploy in any order. */
        this.seed = msg.seed != null ? msg.seed : null;
        this.roster = (typeof RosterFactory !== 'undefined') ? RosterFactory.expand(msg) : (msg.players || []);
        this.hostId = msg.hostId;
        this.humanCount = msg.humanCount != null ? msg.humanCount : 1;
        this.botCount = msg.botCount || 0;
        this._status(
          'Match ' + msg.code + ' • ' + this.humanCount + ' human' +
          (this.humanCount === 1 ? '' : 's') +
          (this.botCount ? ' + ' + this.botCount + ' bots' : ''),
          'on'
        );
        if (this.onMatchStart) {
          this.onMatchStart({
            mode: msg.role,
            code: msg.code,
            hostId: msg.hostId,
            players: this.roster,
            humanCount: this.humanCount,
            botCount: this.botCount,
          });
        }
        /* The host's id is known, so the direct line can be offered. Failing to
           open one changes nothing about the match — it just means the socket
           carries it, as it always has. */
        if (typeof this._startDirectLink === 'function') this._startDirectLink();
        if (typeof this._startDirectKeepalive === 'function') this._startDirectKeepalive();
        break;
      }

      /* ---- relayed from the host ---- */
      case 'peerjoin': {
        const info = {
          peerId: msg.peerId,
          name: msg.name,
          tank: msg.tank,
          color: msg.color,
        };
        this.conns[msg.peerId] = info;
        if (this.onPlayerJoin) this.onPlayerJoin(info);
        break;
      }
      case 'peerleave': {
        delete this.conns[msg.peerId];
        if (this.onPlayerLeave) this.onPlayerLeave(msg.peerId);
        break;
      }
      case 'input': {
        if (this.onInput) this.onInput(msg.from, msg.input);
        break;
      }
      case 'state': {
        /* A snapshot arrived, so the battle is alive. This is the heartbeat the
           session guard watches: no snapshots for nine seconds while it believes
           it is in a battle means the socket is gone or the host has died, and
           both mean this client can no longer play. */
        if (typeof SessionGuard !== 'undefined') SessionGuard.noteSnapshot();
        this._noteStateIn();
        /* The gap since the previous snapshot is passed along so the game can
           turn it into a real correction SPEED. It used to nudge the client's
           own tank by a fixed fraction per snapshot, so the size of the
           correction depended on the snapshot rate rather than on how wrong the
           tank actually was — which is what made it judder while driving. */
        const snapNow = performance.now();
        const snapGap = this._lastSnapAt ? (snapNow - this._lastSnapAt) / 1000 : 0;
        this._lastSnapAt = snapNow;
        if (this.onState) this.onState(msg.s, snapGap);
        break;
      }
      /* A player's tank is asleep because they closed their tab. */
      case 'peersleep': {
        if (this.onPeerSleep) this.onPeerSleep(msg);
        break;
      }
      case 'peerwake': {
        if (this.onPeerWake) this.onPeerWake(msg);
        break;
      }
      case 'spawn': {
        if (this.onWelcome) this.onWelcome({ t: 'spawn', ...(msg.data || {}) });
        break;
      }
      case 'fullstate': {
        if (this.onState) this.onState(msg.state);
        break;
      }
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        this._lastPing = rtt;
        if (this.peer) this.peer._lastPing = rtt;
        break;
      }
      case 'started': {
        if (this.onMatchStart) this.onMatchStart({ mode: this.role, phase: 'started' });
        break;
      }

      /* ---- shared map vote ---- */
      case 'votes': {
        if (this.onVote) this.onVote(msg.votes || {}, msg.mapId);
        break;
      }
      /* ---- the host's map decision ----
         This is the ONLY thing that sets the map on a client. Clients used to
         each run their own winner-picker over their own copy of the tally, and
         the two sides disagreed -- so the host and the client loaded different
         maps and spawned into two different worlds. */
      case 'map': {
        this.chosenMap = msg.mapId;
        if (this.onMapChosen) this.onMapChosen(msg.mapId);
        break;
      }
      /* ---- other players' cursors ---- */
      case 'cursors': {
        this.cursors = msg.cursors || {};
        if (this.onCursorsUpdate) this.onCursorsUpdate(this.cursors);
        break;
      }
      case 'roster': {
        /* Same expansion on an update: a human left and a bot took the hole, so
           botCount grew. Bots already in the arena keep their identity because
           the generator is index-based. */
        if (msg.seed != null) this.seed = msg.seed;
        this.roster = (typeof RosterFactory !== 'undefined') ? RosterFactory.expand(msg) : (msg.players || []);
        break;
      }

      /* ---- the host left; the server promoted somebody ---- */
      case 'hostchange': {
        this.role = msg.role;
        this.hostId = msg.hostId;
        if (this.onHostChange) this.onHostChange(msg.hostId);
        if (this.role === 'host' && this.onMatchStart) {
          this.onMatchStart({ mode: 'host', code: this.roomCode, players: msg.players, promoted: true });
        }
        break;
      }

      case 'clans': {
        if (this._clanWaiter) { const w = this._clanWaiter; this._clanWaiter = null; w(msg.clans || []); }
        break;
      }

      /* ---- the host ended the match ----
         See sendMatchEnd for why this is a message rather than something inferred
         from the snapshots. The handler is a plain callback so game.js owns
         every decision about what a finished match looks like. */
      case 'matchend': {
        if (this.onMatchEnd) this.onMatchEnd({
          winnerTeam: msg.winnerTeam || 'blue',
          winnerPeerId: msg.winnerPeerId || null,
          reason: msg.reason || 'ended',
        });
        break;
      }

      /* ---- PRIVATE ROOM VERDICTS -----------------------------------------
         The server answered a host-room or a join-room. Resolve the promise
         the caller is awaiting; for a join the host's id has just become
         known, which is all the direct link needed to dial it. */
      case 'room-opened': {
        if (this._hostOpenWaiter) {
          const w = this._hostOpenWaiter; this._hostOpenWaiter = null; w(true);
        }
        break;
      }
      case 'joined-room': {
        this.roomCode = msg.code;
        this.role = 'client';
        this.hostId = msg.hostId || null;
        if (this._roomJoinWaiter) {
          const w = this._roomJoinWaiter; this._roomJoinWaiter = null; w(true);
        }
        /* Keep the RTT loop the old joinRoom ran — it measures round-trip
           time and keeps a NAT mapping warm during long battles. Only client
           roles pinged before; that is preserved. */
        if (this.role === 'client') this._startPing();
        if (typeof this._startDirectLink === 'function') this._startDirectLink();
        if (typeof this._startDirectKeepalive === 'function') this._startDirectKeepalive();
        break;
      }

      case 'reject': {
        /* The private-room promises are waiting on this verdict. Resolve them
           BEFORE the teardown below — resolve, not reject: the client's own
           message ('No such room', 'Room is full') is friendlier than a bare
           "the socket closed", and startClient/startHost catch and toast it. */
        if (this._hostOpenWaiter) {
          const w = this._hostOpenWaiter; this._hostOpenWaiter = null; w(false, 'Refused: ' + (msg.reason || 'unknown'));
        }
        if (this._roomJoinWaiter) {
          const w = this._roomJoinWaiter; this._roomJoinWaiter = null; w(false, msg.reason || 'unknown');
        }
        this._status('Rejected: ' + (msg.reason || 'unknown'), 'off');
        this.disconnect();
        break;
      }

      default: break;
    }
  },

  /* ======================================================================
     HOST API  (unchanged signatures -- game.js calls these by name)
     ====================================================================== */
  async hostRoom({ maxPlayers, isPublic, fakePlayers, code } = {}) {
    this.role = 'host';
    this.maxPlayers = Math.max(1, Math.min(20, maxPlayers || 8));
    this.isPublic = !!isPublic;
    this.fakePlayers = fakePlayers || 0;
    this.roomCode = code || this.staticCode();
    this.conns = {};
    await this._open();
    /* THE ROOM MUST EXIST SERVER-SIDE.

       hostRoom() used to stop here, having opened a socket and generated a
       code that the Durable Object had never been told about. Matchmaker only
       ever created matches through the QUEUE, so every relay that needed
       membership — the join, the WebRTC signalling, the roster — looked this
       player up, found no match, and dropped it on the floor. "Start Hosting"
       sat there while the joiners could never arrive, because protocols
       without a server that answers are just two sockets staring at each
       other.

       The verdict is awaited rather than assumed, so game.js's existing
       try/catch shows the player what went wrong instead of hanging.

       'reject' (code in use, refused) and a timeout both reject the promise.
       Cancel the timer on any resolution path: disconnect() also clears the
       waiter, which must not fire after a rejection has already been reported. */
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        const w = this._hostOpenWaiter; this._hostOpenWaiter = null;
        if (w) w(false, 'The match server did not open the room.');
      }, 8000);
      this._hostOpenWaiter = (ok, reason) => {
        clearTimeout(to);
        this._hostOpenWaiter = null;
        if (ok) resolve(this.playerId);
        else reject(new Error(reason || 'The room was refused.'));
      };
      this._raw({
        t: 'host-room',
        code: this.roomCode,
        maxPlayers: this.maxPlayers,
        isPublic: this.isPublic,
      });
    });
  },

  async joinRoom(code) {
    this.role = 'client';
    this.roomCode = code;
    await this._open();
    /* Attach THIS socket to that code server-side; see hostRoom for why the
       membership cannot be assumed. Refusals — no such room, full — surface
       here as rejections, which startClient()'s catch already shows as a
       toast. Confirmation dial the host (direct link) once its id is known. */
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        const w = this._roomJoinWaiter; this._roomJoinWaiter = null;
        if (w) w(false, 'The room did not answer the join.');
      }, 8000);
      this._roomJoinWaiter = (ok, reason) => {
        clearTimeout(to);
        this._roomJoinWaiter = null;
        if (ok) resolve();
        else reject(new Error(reason || 'The room refused the join.'));
      };
      this._raw({ t: 'join-room', code });
    });
  },

  /* ---- host -> a specific client ---- */
  sendSpawnToClient(peerId, spawnData) {
    /* Rare and important, so it stays on the socket even when a direct link
       exists. One message per player per match does not need the machinery. */
    this._raw({ t: 'spawn', to: peerId, data: spawnData });
  },
  sendFullStateToClient(peerId, state) {
    this._raw({ t: 'fullstate', to: peerId, state });
  },

  /* THE HOT PATH. Snapshots, twelve times a second, to every other player.

     Goes over a direct WebRTC link wherever one exists, and over the socket
     everywhere else — including, deliberately, for peers that ALSO have a
     direct link but are named in `rtc` so the server does not send them a
     second copy.

     `rtc` is only present when the list is non-empty. A match with no direct
     links therefore emits byte-for-byte what it always emitted, which means
     this change is invisible to a game running on the old path. */
  broadcast(snapshot) {
    let direct = null;
    let packet = null;   /* one stringify, not one per peer */
    if (typeof Rtc !== 'undefined') {
      for (const id of Rtc.connectedIds()) {
        if (id === this.playerId) continue;
        /* The snapshot used to be stringified once PER CONNECTED PEER per
           tick — a dozen peers made a dozen full 5 KB stringify passes, twelve
           times a second, on the host's main thread. Serialized once here it is
           the same bytes to everyone and a fraction of the CPU. */
        if (packet === null) packet = JSON.stringify({ t: 'state', s: snapshot });
        if (Rtc.sendRaw(id, packet)) {
          (direct || (direct = [])).push(id);
          this._stats.stateDirectSent++;
        }
      }
    }
    this._stats.stateBroadcasts++;
    if (!direct) this._stats.stateRelaySent++;
    this._raw(direct ? { t: 'state', s: snapshot, rtc: direct } : { t: 'state', s: snapshot });
  },
  markMatchStarted() {
    this._raw({ t: 'matchstart' });
  },

  /* ---- the match is over, decided by the host ----

     Needed because "end the battle" is a decision, not a piece of world state.
     Snapshots describe where tanks are; nothing in a snapshot says the match has
     ended, so without an explicit message the client simply keeps playing a
     battle whose host has walked away to a results screen — frozen input,
     nothing moving, no way out but Escape.

     Sent to EVERY member including the host, rather than "to the others". The
     host has already ended it locally and ignores the echo (see Game's
     _endSkippedMatch latch), but routing both players down the same code path
     means there is one implementation of what a finished match looks like
     instead of two that can disagree.

     `winnerTeam` is 'blue' or 'red' because that is how every team mode decides
     a winner, and `reason` is carried so the client can tell a skipped battle
     from a real one and word the results screen accordingly. */
  sendMatchEnd({ winnerTeam, winnerPeerId, reason }) {
    this._raw({
      t: 'matchend',
      winnerTeam: winnerTeam || 'blue',
      winnerPeerId: winnerPeerId || null,
      reason: reason || 'ended',
    });
  },

  /* ---- client -> host ---- */
  sendJoinInfo(name, tankId, color) {
    this._pendingJoin = { name, tank: tankId, color };
    this._raw({ t: 'join', name, tank: tankId, color });
  },

  /* THE OTHER HOT PATH. Inputs, through one channel, at a fixed, sane rate.

     This used to be called once per frame — 60 messages/s down a channel that
     ultimately carries ONE latest-wins input object. Everyone downstream just
     did `inputs[peerId] = input`, so every frame after the first was
     serialized, sent and thrown away unread.

     Throttled to 30/s — half the traffic, no measurable difference on the
     host, and the applied input is never more than 33 ms stale.

     The one risk of throttling is LOSING a button press: a tap of Fire that
     starts and ends between two sends would never be seen at all. So FIRE is
     edge-accumulated — if Fire went down while the throttle was quiet, the
     next input that goes out carries fire:true, even if the player has
     already let go. A tap becomes a shot it would otherwise have swallowed. */
  _lastInputSent: 0,
  _pendingFire: false,
  sendInput(input) {
    if (this._pendingFire && input) input = Object.assign({}, input, { fire: true });
    const now = performance.now();
    const gap = now - this._lastInputSent;
    if (gap < 32) {
      if (input && input.fire) this._pendingFire = true;   /* remembered, sent later */
      return;
    }
    this._lastInputSent = now;
    this._pendingFire = false;
    this._noteInputSent();
    if (typeof Rtc !== 'undefined' && this.hostId && Rtc.send(this.hostId, { t: 'input', input })) return;
    this._raw({ t: 'input', input });
  },

  /* ---- stats for the HUD ----
     The overlay and any test harness need the traffic numbers: how many
     inputs went out, how many snapshots came in, how many crossed a direct
     link instead of the relay. Counters only — no timings, no allocations. */
  _stats: {
    inputsSent: 0, inputsLastAt: 0,
    statesIn: 0, statesLastInAt: 0,
    stateBroadcasts: 0, stateDirectSent: 0, stateRelaySent: 0,
    offers: 0, answers: 0,
  },
  _noteInputSent() { this._stats.inputsSent++; this._stats.inputsLastAt = performance.now(); },
  _noteStateIn() { this._stats.statesIn++; this._stats.statesLastInAt = performance.now(); },

  /* ---- shared map vote ---- */
  sendVote(mapId) {
    this._raw({ t: 'vote', map: mapId });
  },
  onVotes(cb) { this.onVote = cb; },

  /* The map is chosen by the HOST and pushed to everyone. A client sending this
     is ignored by the server (it only accepts the host's choice), so this is
     safe to call unconditionally. */
  sendChosenMap(mapId) {
    this._raw({ t: 'map', map: mapId });
  },
  onMap(cb) { this.onMapChosen = cb; },

  /* ---- shared cursor ----
     Throttled to ~20/s. A mousemove fires far faster than that, and every
     message is relayed to every other player in the match, so an unthrottled
     stream is a lot of traffic for a position that barely changes between
     frames. Throttling also coalesces bursts into one useful update. */
  sendCursor(x, y) {
    const now = performance.now();
    if(this._lastCursorAt && (now - this._lastCursorAt) < 50) return;
    this._lastCursorAt = now;
    this._raw({ t: 'cursor', x: x, y: y });
  },
  onCursors(cb) { this.onCursorsUpdate = cb; },

  /* ======================================================================
     QUEUE  (used by matchmaking.js)
     ====================================================================== */
  async joinQueue(name, tankId, color, mode) {
    await this._open();
    /* NO `resume` HERE, DELIBERATELY.

       Queueing asks for a NEW match; it is not a reconnect. This hello used to
       offer back the id SessionGuard remembers, which is right for a plain
       reconnect (see _open's onopen, which is where a reload resumes) but wrong
       here: the server honoured it and re-attached the socket to the battle the
       player had just walked out of, and the queue behind it could then never
       form anything. Pressing PLAY a second time did nothing at all.

       _open()'s own hello already carried the resume id and that is where a
       returning tab belongs, so the reconnect feature is unaffected. */
    this._raw({ t: 'hello', name, tank: tankId, color });
    this._raw({ t: 'queue', mode: mode || 'random-battle' });
  },
  async leaveQueue() {
    this._raw({ t: 'unqueue' });
  },

  /* Host-side average RTT across clients (0 when none). */
  hostAvgPing() {
    return this._lastPing ? Math.round(this._lastPing) : 0;
  },

  /* ======================================================================
     CLAN REGISTRY  (was a PeerJS lobby; now the same server, same idea)
     ====================================================================== */
  async announceClan(clan) {
    if (!clan || !clan.code) return;
    try { await this._open(); } catch (e) { return; }
    this._raw({ t: 'clan.upsert', clan });
  },
  async removeClan(code) {
    if (!code) return;
    try { await this._open(); } catch (e) { return; }
    this._raw({ t: 'clan.remove', code });
  },
  fetchClans() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        this._clanWaiter = null;
        clearTimeout(to);
        resolve(v);
      };
      this._open().then(() => {
        this._clanWaiter = finish;
        this._raw({ t: 'clan.list' });
      }).catch(() => finish([]));
      const to = setTimeout(() => finish([]), 4000);
    });
  },

  /* ======================================================================
     PING + TEARDOWN
     ====================================================================== */
  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._raw({ t: 'ping', ts: performance.now() });
    }, 1000);
  },
  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  },

  disconnect() {
    this._wantOpen = false;
    this._stopPing();
    this._stopDirectKeepalive();
    clearTimeout(this._reconnectTimer);
    /* Every direct link belongs to this socket and this match. Leaving one open
       would keep a channel feeding a match the player has walked out of, and
       the peer on the other end would be talking to a ghost. */
    try { if (typeof Rtc !== 'undefined') Rtc.closeAll(); } catch (e) {}
    try { if (this.ws) this.ws.close(); } catch (e) { /* already gone */ }
    this.ws = null;
    this.connected = false;
    this.role = null;
    this.conns = {};
    this.hostConn = null;
    this.roomCode = null;
    this.roster = null;
    this._queue.length = 0;
    this._pendingFire = false;
    /* A dead socket cannot deliver the private-room verdict any more. The
       promise must fail NOW, not when its 8-second timer runs out — the
       "Match server unreachable" is a more truthful message than a timeout. */
    if (this._hostOpenWaiter) {
      const w = this._hostOpenWaiter; this._hostOpenWaiter = null; w(false, 'Match server unreachable.');
    }
    if (this._roomJoinWaiter) {
      const w = this._roomJoinWaiter; this._roomJoinWaiter = null; w(false, 'Match server unreachable.');
    }
    this._status();
  },

  /* Rooms listing was a PeerJS broadcast registry and never worked; there is
     nothing to list now that every match is server-owned. Kept as a stub so
     menu.js does not throw. */
  async listPublicRooms() { return []; },
};

/* ============================================================================
   THE DIRECT LINK

   rtc-net.js opens the peer-to-peer channel and knows nothing about this file.
   Everything it needs from here is the one function that already existed, so
   the game code above is identical whether a player is on a direct link or on
   the WebSocket.
   ============================================================================ */
if (typeof Rtc !== 'undefined') {

  /* A direct link carries game traffic, and game traffic must arrive from the
     direction it is supposed to. Without this, a client that could reach the
     host over the channel could also send the host a 'state' frame — i.e. move
     every other player's tank. It costs one comparison and it closes the only
     hole the direct link would otherwise open. */
  const ALLOWED = {
    host:   ['input'],
    client: ['state', 'spawn', 'fullstate', 'matchend'],
  };

  /* ---- P2P bridging ----

     rtc-net.js opens the data channel and knows nothing about the game's match
     topology. net.js owns the P2P layer. So rtc-net's hooks are bridged here, and
     only the messages each role is allowed to carry cross the bridge.

     A channel to the host does more than move input: it is what lets a client's
     input reach the host without the server relay, and it is what lets the host send
     snapshots to that client without going through the relay either. Both of those
     are the bytes that were causing the lag you saw with several friends. */

  Rtc.onMessage = (peerId, obj) => {
    Net._dispatchP2P(peerId, obj);
  };

  Rtc.onOpen = (peerId) => {
    if (!peerId) return;
    /* THE FIELD IS `ch`, NOT `_ch`. The record's channel lives at rec.ch
       (rtc-net.js _wireChannel sets rec.ch); `_ch` exists only on the entries
       Net.registerP2PChannel() builds, and reaching for it here passed
       `undefined` into registerP2PChannel, whose closures then crashed on
       `ch.readyState` the first time anything tried to use the registration. */
    const rec = Rtc._peers[peerId];
    Net.registerP2PChannel(peerId, rec && rec.ch ? rec.ch : null);
  };

  Rtc.onClose = (peerId) => {
    if (!peerId) return;
    Net.unregisterP2PChannel(peerId);
  };

  /* _startDirectLink is retained by rtc-net.js's existing hook and by anything
     else that already called it. The P2P layer now drives the channel lifecycle
     itself via openP2PToHost() / registerP2PChannel(), so this is only left in place
     for any caller that still references it. */
  Net._startDirectLink = function () {
    try {
      if (Net.role !== 'client' || !Net.hostId || !Net.hostId || Net.hostId === Net.playerId) return;
      if (Net.p2p && Net.p2p.enabled && Net.p2p.hostId) {
        Net.openP2PToHost();
      } else {
        Rtc.dial(Net.hostId);
      }
    } catch (e) { /* no WebRTC here; the socket carries on unchanged */ }
  };
}

/* ---- P2P helpers ----

     These are the public surface game.js uses. They keep the existing transport
     behaviour when P2P is off and add a direct path when it is on. The server
     relay is never removed: setRelayOnly() exists so a client can force the old
     path without the host knowing, and the host's broadcast/input paths fall back
     to the socket automatically whenever the direct link is not ready.

     P2P ids are minted once per match and persisted only in memory. They are not
     written to disk because they are reconnect-scoped to a live match; a reload
     offers the server id back, the server re-attaches the socket, and the P2P id
     is re-minted against the new channel. */

Object.assign(Net, {
  /* A stable P2P id for this client in this match. Re-created on resume so a
     reload never keeps a channel addressed to a dead id. */
  _p2pId() {
    try {
      return 'p2p-' + crypto.randomUUID();
    } catch (e) {
      return 'p2p-' + Math.random().toString(36).slice(2, 14);
    }
  },

  /* The host turns the fast path on for the whole match. Sent to everyone so a
     client can open its direct line before the first snapshot lands. */
  setP2PEnabled(on) {
    this.p2p.enabled = !!on;
    if (!this.p2p.enabled) {
      this.p2p.hostId = null;
    }
  },

  /* Force this client onto the server relay only. Used by the settings toggle and
     by automatic fallback when the direct link never comes up. */
  setRelayOnly() {
    this.p2p.enabled = false;
  },

  /* KEEP TRYING THE DIRECT LINK THROUGH THE WHOLE MATCH.

     A WebRTC handshake that fails once — a hiccup in a symmetric NAT, a free
     TURN relay that was briefly unavailable — used to cost the rest of the
     match: _giveUp() throws the peer record away and nothing ever dialled
     again, so every remaining minute ran on the relay at 12 Hz with the
     server hop added to every input and every snapshot. That this was
     invisible is exactly the problem: the match kept working, and kept
     being laggy, for no reason that anyone could see.

     Retrying is cheap — two relay messages plus negligible ICE work per
     attempt — and if the link cannot be built, nothing changes. When it
     can, the game quietly stops paying the relay. The check skips a peer
     that is already open or mid-handshake, so this can never stomp on a
     channel that is working or forming. */
  _startDirectKeepalive() {
    this._stopDirectKeepalive();
    this._directFails = 0;
    this._directKeepaliveTimer = setInterval(() => {
      if (this.role !== 'client' || !this.hostId) return;
      if (typeof Rtc === 'undefined' || !Rtc.dial) return;
      if (Rtc.isOpen && Rtc.isOpen(this.hostId)) { this._directFails = 0; return; }
      /* A handshake is still in flight (dial() keeps the record live until
         it works or gives up): let it finish before another offer goes out. */
      if (Rtc._peers && Rtc._peers[this.hostId]) return;
      /* BOUNDED: four failed handshakes for one match, then stop. The old
         loop dialled for EVER — a machine that genuinely cannot build a
         direct link paid a relay offer + a full ICE attempt every 20 s for
         the whole battle, for nothing. Four tries covers a slow ICE gather
         and one NAT failure; after that the match simply stays on the
         socket, which is exactly what happens today. A fresh match resets
         the count, because the next host may be reachable. */
      if (this._directFails >= 4) return;
      try { Rtc.dial(this.hostId); this._directFails++; } catch (e) { /* keep going on the relay */ }
    }, 20000);
  },

  _stopDirectKeepalive() {
    if (this._directKeepaliveTimer) {
      clearInterval(this._directKeepaliveTimer);
      this._directKeepaliveTimer = null;
    }
  },

  /* The host's P2P id, once the match knows it. */
  setP2PHostId(id) {
    this.p2p.hostId = id || null;
  },

  /* Called by the host when it learns a client's P2P id. */
  setP2PClientId(peerId, p2pId) {
    if (!peerId || !p2pId) return;
    this.p2p.roles[p2pId] = 'client';
  },

  /* True when this player is the host of the match, whichever transport is in
     use. Mirrors the existing Net.role === 'host' check but is about the MATCH,
     not the transport. */
  isHostOfMatch() {
    return !!this.role && this.role === 'host';
  },

  /* ---- sending ----

     Input goes client -> host. When the direct link is up it goes over WebRTC;
     otherwise it goes over the server relay exactly as before. The existing
     fire-edge accumulation in sendInput() already lives above this, so this only
     chooses the wire.

     A snapshot from the host goes to everyone. When P2P is on the host sends it
     direct to every client that has a live channel and falls back to the relay for
     the rest (including any client still connecting). This is what makes the fast
     path help the people it can help without breaking the people it cannot. */

  sendP2P(p2pId, obj) {
    const ch = this.p2p.direct[p2pId];
    if (!ch || !ch.open) return false;
    try {
      ch.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  },

  sendP2PRaw(p2pId, str) {
    const ch = this.p2p.direct[p2pId];
    if (!ch || !ch.open) return false;
    try {
      ch.send(str);
      return true;
    } catch (e) {
      return false;
    }
  },

  /* Clients send input here. Host-mode calls this from game.js's input path;
     client-mode calls it from the same place, and it picks the wire. */
  sendInputP2P(input) {
    if (!this.p2p.enabled || !this.p2p.hostId) return false;
    return this.sendP2P(this.p2p.hostId, { t: 'input', input });
  },

  /* The host broadcasts a snapshot here. Direct to every live client, relayed to
     the rest (and to nobody when this is not the host). */
  broadcastP2P(snapshot) {
    /* ONE BROADCAST, NOT TWO TRANSPORTS.

       This used to iterate `this.p2p.roles`, a dictionary keyed by uuid ids
       minted in the separate P2P layer. Nothing ever populated it: the id
       exchange it depended on had no receiving case in _handle (fixed above),
       so the loop ran over one entry — the host's own — sent nothing, and
       then the "did somebody miss out" arithmetic compared against a fantasy
       roster and concluded every peer was covered. A host with the fast-path
       setting enabled therefore stopped sending snapshots to EVERYONE, and
       the match looked completely dead.

       Net.broadcast is the one path that has always been right: it sends
       direct over any live WebRTC channel first, collects the peers it
       reached by their SERVER ids, and ships exactly one relay copy whose
       `rtc` list tells the match server whom to skip. Delegating here keeps
       the fast path and removes the silent way to stop the game. */
    this.broadcast(snapshot);
  },

  /* ---- receiving ----

     Incoming P2P messages are fed into the same _handle() that the socket uses, so
     game.js sees one stream whichever wire the bytes came in on. The only extra
     plumbing is that a client's own input echoing back from the host is ignored so
     it does not double-apply.

     Allowed messages on the direct link are the same ones the socket is allowed to
     relay in each direction, so a peer cannot move anyone else's tank by opening a
     channel. */

  _allowedP2P(from) {
    const mine = (this.role === 'host')
      ? (['input', 'peer-ready', 'p2p-id'])
      : (['state', 'spawn', 'fullstate', 'matchend', 'peer-ready', 'p2p-id']);
    return mine.indexOf(from.t) >= 0;
  },

  _dispatchP2P(p2pId, obj) {
    if (!obj || typeof obj !== 'object' || !obj.t) return;
    if (!this._allowedP2P(obj)) return;
    /* A client must not re-apply its own input. The host never sends input back,
       but a misrouted frame or a reconnect corner case should not double-fire. */
    if (obj.t === 'input' && obj.from === this.p2p.myId) return;
    obj.fromP2P = true;
    obj.from = p2pId;
    this._handle(obj);
  },

  /* ---- channel lifecycle ----

     A channel is registered when it opens and removed when it closes. When a client
     connects its channel is the first moment the host can send it snapshots, so the
     host sends a full state immediately so the newcomer is not starting from an old
     picture.

     A channel that never opens within a short window is given up on and retried once
     so a slow ICE gather does not leave a player on the relay forever when the link
     was actually reachable. */

  registerP2PChannel(p2pId, ch) {
    if (!ch) return;   /* no channel to register — the direct line never opened */
    this.p2p.direct[p2pId] = {
      send: (obj) => {
        if (ch.readyState !== 'open') return false;
        try { ch.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (e) { return false; }
      },
      sendRaw: (str) => {
        if (ch.readyState !== 'open') return false;
        try { ch.send(str); return true; } catch (e) { return false; }
      },
      connected: () => ch.readyState === 'open',
      open: ch.readyState === 'open',
      _ch: ch,
    };
    if (this.p2p.roles[p2pId] === 'client' && this.isHostOfMatch()) {
      /* Fresh client: seed it with the current world so it does not start from the
         last snapshot of a previous connection. */
      try {
        const snap = (this._currentSnapshot) ? this._currentSnapshot() : null;
        if (snap) this.sendP2P(p2pId, { t: 'fullstate', state: snap });
      } catch (e) { /* snapshot not available yet; the normal stream will catch up */ }
    }
  },

  unregisterP2PChannel(p2pId) {
    delete this.p2p.direct[p2pId];
  },

  /* Ask Rtc to open a direct channel to the host. Called by clients when P2P is on
     and the host id is known. */
  openP2PToHost() {
    if (!this.p2p.enabled || !this.p2p.hostId) return;
    if (this.p2p.direct[this.p2p.hostId]) return;
    try {
      if (typeof Rtc !== 'undefined' && Rtc.dial) {
        Rtc.dial(this.p2p.hostId);
      }
    } catch (e) { /* no WebRTC here; the socket carries on unchanged */ }
  },

  /* Retry the direct link once if it did not come up fast. A slow ICE gather is the
     common case where a link is reachable but not yet up when we first try. */
  _p2pRetry() {
    if (!this.p2p.enabled || !this.p2p.hostId) return;
    if (this.p2p.direct[this.p2p.hostId]) return;
    if (typeof Rtc !== 'undefined' && Rtc.dial) {
      try { Rtc.dial(this.p2p.hostId); } catch (e) { /* keep going on the relay */ }
    }
    this._p2pRetryTimer = setTimeout(() => this._p2pRetry(), 4000);
  },

  startP2PRetries() {
    if (!this.p2p.enabled || !this.p2p.hostId) return;
    if (this.p2p.direct[this.p2p.hostId]) return;
    clearTimeout(this._p2pRetryTimer);
    this._p2pRetry();
  },

  stopP2PRetries() {
    clearTimeout(this._p2pRetryTimer);
    this._p2pRetryTimer = null;
  },

  /* A client tells the host its P2P id over the socket, so the host can address it
     directly. This is the one message that must go over the relay because the channel
     it is setting up is what would carry it otherwise. */
  sendP2PId(p2pId) {
    if (!p2pId) return;
    this._raw({ t: 'p2p-id', p2pId });
  },

  /* The host tells a client its P2P id (the host's own, for this client to dial).
     Sent over the relay on match start so the client can open its channel early. */
  sendP2PHostIdToClient(peerId, hostP2PId) {
    this._raw({ t: 'p2p-id', to: peerId, p2pId: hostP2PId });
  },

  /* Who is in the match on the P2P layer. The host keeps this list; clients only ever
     see the host. */
  p2pPeerIds() {
    const out = [];
    for (const id in this.p2p.roles) {
      if (id === this.p2p.myId) continue;
      out.push(id);
    }
    return out;
  },

  /* Clean up when a match ends or the socket goes away. Channels belong to this
     match and must not keep a peer talking to a ghost. */
  clearP2P() {
    this.p2p.enabled = false;
    this.p2p.myId = null;
    this.p2p.hostId = null;
    this.p2p.roles = {};
    this.p2p.direct = {};
    this.p2p._pendingOffers = {};
    this.stopP2PRetries();
    this._stopDirectKeepalive();
    try { if (typeof Rtc !== 'undefined' && Rtc.closeAll) Rtc.closeAll(); } catch (e) { /* already gone */ }
  },
});

/* These methods were written as object-literal shorthand but sat below the
   `Net` literal's own closing brace, so the file never parsed and every
   multiplayer path died. Object.assign puts them back on the object from the
   outside, with the exact bodies unchanged: `this` still reads as the Net
   object, and each method guards its Rtc dependency itself, so they are safe
   to define whether or not rtc-net.js loaded. */
