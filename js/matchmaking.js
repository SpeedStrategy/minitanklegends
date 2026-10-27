/* ============================================================================
   matchmaking.js — client side of the queue.

   This used to talk to a Cloudflare Worker over fetch() and hand the result to
   PeerJS. Both of those are gone (see server/mpserver.js and js/net.js for
   why). The queue is now a WebSocket message and the SERVER decides when a
   match exists, so this file is much thinner: it opens a queue, reports
   progress, and hands the roster to the game.

   The public API is unchanged -- menu.js calls init(), joinQueue(),
   leaveQueue(), humanCount() and sets onMatchStart exactly as before.

   THE 15-SECOND RULE
   ------------------
   The server starts a countdown when the first human joins a mode queue. If a
   second human arrives first, the match starts immediately and nobody waits.
   If the countdown runs out, the server forms the match anyway and fills every
   empty slot with bots up to a full 16-tank roster. The countdown value and
   the current queue size arrive from the server, so the UI shows the real
   number rather than a local guess that can drift.
   ========================================================================== */

const TDMMatchmaker = {
  playerId: null,
  polling: false,
  _queueing: false,
  _joinedAt: 0,

  onMatchStart: null,      /* set by menu.js */
  onQueueUpdate: null,     /* set by menu.js, optional */

  init() {
    /* Nothing to configure any more: the socket is always the page's own
       origin at /mp, so the tunnel that served the page serves the match too.
       Kept as a function because menu.js calls it. */
    this._ensureWired();
  },

  /* ---------------------------------------------------------------------
     JOIN
     Returns as soon as the queue request is on the wire. The match, if one
     forms, arrives later via onMatchStart -- there is nothing to poll for,
     which is why there is no _poll() any more and no way for a poll to
     disagree with the server about who is in the match.
     --------------------------------------------------------------------- */
  async joinQueue(name, tankId, color, mode) {
    if (!this._ensureWired() || typeof Net === 'undefined' || !Net.joinQueue) {
      return { error: 'Multiplayer transport unavailable' };
    }
    this._queueing = true;
    this._joinedAt = Date.now();
    this.lastQueueSize = 0;   /* filled by the 'queued' reply for THIS search */
    this.mode = mode || 'random-battle';

    try {
      await Net.joinQueue(name, tankId, color, this.mode);
      /* The server mints the id; wait briefly for it so callers that need a
         playerId right after this (the map vote) always have one. */
      this.playerId = await this._awaitPlayerId();
      this.lastMatch = null;
      return { ok: true, playerId: this.playerId, waiting: true };
    } catch (e) {
      this._queueing = false;
      return { error: e.message || 'Could not reach the match server' };
    }
  },

  _awaitPlayerId() {
    if (Net.playerId) return Promise.resolve(Net.playerId);
    return new Promise((resolve) => {
      let tries = 0;
      const t = setInterval(() => {
        if (Net.playerId) { clearInterval(t); resolve(Net.playerId); return; }
        if (++tries > 20) { clearInterval(t); resolve(null); }   /* ~2s is plenty */
      }, 100);
    });
  },

  async leaveQueue() {
    this._queueing = false;
    this._ensureWired();
    if (typeof Net !== 'undefined' && Net.leaveQueue) {
      try { await Net.leaveQueue(); } catch (e) { /* socket already gone */ }
    }
  },

  /* ---------------------------------------------------------------------
     THE MATCH ARRIVED
     --------------------------------------------------------------------- */
  _onMatched(matchInfo) {
    this._queueing = false;
    this.polling = false;
    this.lastMatch = matchInfo || null;

    const roster = (matchInfo && matchInfo.players) || [];
    const humans = (matchInfo && matchInfo.humanCount) != null
      ? matchInfo.humanCount
      : this.humanCount(roster);

    if (this.onMatchStart) {
      this.onMatchStart({
        mode: (matchInfo && matchInfo.mode) || 'client',
        code: matchInfo && matchInfo.code,
        hostId: matchInfo && matchInfo.hostId,
        players: roster,
        humanCount: humans,
        botCount: (matchInfo && matchInfo.botCount) || 0,
        promoted: !!(matchInfo && matchInfo.promoted),
      });
    }

    /* The host owns the simulation. It has to actually start the match --
       matchmaking.js used to call game.startTDMHost(), which was never
       defined anywhere in the codebase, so a perfectly good match silently
       did nothing. It exists now. */
    if (matchInfo && matchInfo.mode === 'host') {
      const game = window.game || window._game;
      if (game && typeof game.startTDMHost === 'function') {
        try {
          game.startTDMHost(matchInfo.code, roster, humans);
        } catch (e) {
          console.error('startTDMHost failed:', e);
          if (typeof Menu !== 'undefined') Menu.toast('Could not start the match');
        }
      } else {
        console.error('Host matched but Game.startTDMHost is missing');
      }
    }
  },

  /* Real humans in a roster, i.e. entries the server did not invent as bots.
     Drives the map-vote lock-in window: a bot-filled match has nobody to wait
     for, so picking a map goes straight into the battle. */
  humanCount(players) {
    if (!players || !players.length) return 1;
    let n = 0;
    for (const p of players) {
      if (p && !p.isBot && p.peerId != null) n++;
    }
    return Math.max(1, n);
  },

  /* Bots the server added, for display. */
  botCount(players) {
    if (!players || !players.length) return 0;
    let n = 0;
    for (const p of players) if (p && p.isBot) n++;
    return n;
  },
};

/* Wire the transport's events into this facade.

   Done LAZILY, on first use, rather than at load time. index.html lists
   js/matchmaking.js BEFORE js/net.js, and both are classic scripts, so at the
   moment this file runs `Net` does not exist yet. An IIFE here therefore
   returned early and silently never wired anything -- the queue could fill, a
   match could form, and onMatchStart would never fire.

   Calling this from every entry point makes it independent of script order. */
TDMMatchmaker._ensureWired = function () {
  if (TDMMatchmaker._wired) return true;
  if (typeof Net === 'undefined' || !Net) return false;
  TDMMatchmaker._wired = true;

  Net.onMatchStart = function (info) {
    if (info && info.phase === 'started') return;   /* battle actually began */
    TDMMatchmaker._onMatched(info);
  };

  /* The server's real numbers, kept where the PLAY button can read them.

     The button used to count up to a hardcoded 5 seconds while the queue
     actually waits 15, so it sat on "SEARCHING 5s+" for ten seconds while the
     player was in fact still being matched. It cannot be a local guess: the
     server is the only thing that knows how long its own window is, and it says
     so in every `queued` reply.

     These start at the server's documented 15s so the very first paint is
     already right, before the reply lands. */
  TDMMatchmaker.queueDelayMs = TDMMatchmaker.queueDelayMs || 15000;
  TDMMatchmaker.queueFillMs = TDMMatchmaker.queueFillMs || 15000;

  Net.onQueueState = function (q) {
    TDMMatchmaker.queueDelayMs = (q && q.botFillDelayMs) || TDMMatchmaker.queueDelayMs;
    TDMMatchmaker.queueFillMs = (q && q.botFillInMs) || TDMMatchmaker.queueFillMs;
    if (q && typeof q.queueSize === 'number') TDMMatchmaker.lastQueueSize = q.queueSize;
    if (TDMMatchmaker.onQueueUpdate) TDMMatchmaker.onQueueUpdate(q);
  };
  return true;
};
