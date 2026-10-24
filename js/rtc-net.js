/* ============================================================================
   rtc-net.js — the direct line between players.

   WHAT THIS IS
   ------------
   Everything in a match currently travels through the Cloudflare Durable
   Object: every frame of input, every snapshot. That is fine as an architecture
   and terrible as a bill. Each of those messages is a request against a free
   tier that allows about 100,000 a day, and a single match burns roughly 430 a
   second. That is under four minutes of gameplay for the entire game, per day.

   So the traffic moves and the server stays. This file opens a WebRTC data
   channel straight from each player to the host, and from then on:

     inputs      go client  -> host          (direct)
     snapshots   go host    -> client        (direct)
     everything else stays on the WebSocket

   That split is deliberate. Only the two high-rate messages move, because they
   are the only ones that were ever expensive. Signalling, the handshake, and
   the handful of rare control messages stay on a socket that is already open
   and already reliable — which means this file never has to be the thing that
   makes the game work.

   WHY THE WEBSOCKET IS NOT REMOVED
   --------------------------------
   Roughly one connection in seven cannot be made. Symmetric NATs — most mobile
   carriers, some corporate wifi — will not accept a peer-to-peer handshake, and
   clearing them needs a TURN relay, which costs money we do not have.

   So this file is additive and never authoritative. If the direct link fails,
   times out, or the browser has no WebRTC at all, every message keeps going
   exactly as it did before. The worst outcome of this entire file is that
   nothing changes. The best outcome is that the server stops carrying the game.

   NO HOST ROTATION, NO MIGRATION
   ------------------------------
   The host is whoever the matchmaker picked, for the whole match. The question
   of handing authority over mid-battle is a separate and much harder problem
   (the physics engine's state cannot be serialised), and it is deliberately not
   attempted here.

   WHAT IS TRICKY IN HERE, AND WHY
   -------------------------------
   One thing, really: ICE candidates arrive before the answer that gives them
   meaning. `addIceCandidate` against a connection with no remote description is
   an error in most browsers and a silently dead connection in some. They are
   queued in `pending` and flushed the moment the description lands. This is the
   single most common way a hand-rolled WebRTC layer "works on my machine".

   The other is direction. Only the CLIENT ever offers. The host only ever
   answers. Two peers offering at each other simultaneously is the "glare"
   problem, and it is avoided entirely by never letting it happen, rather than
   by the negotiation dance that usually deals with it.

   Run: loaded by net.js. Needs no library and no build step.
   ========================================================================== */

(function () {
  'use strict';

  /* Google's public STUN servers. No key, no account, no cost, and they are
     enough to discover a public address for the large majority of pairs. They
     are NOT enough to get through a symmetric NAT — that is what the WebSocket
     fallback is for, not something to try to solve here.

     UPDATE: CONFIG.PEER_ICE also carries a free public TURN relay, which is
     exactly what the STUN-only list above could not do. Direct links were
     silently refused by symmetric NATs (most mobile carriers) because the
     STUN-only handshake could not find a relay path. Sharing the game's one
     ICE list means a direct link can now succeed for those players; where no
     relay is reachable the connection simply falls back to the socket as
     before, so the cost of trying is zero. */
  const ICE = {
    iceServers: (typeof CONFIG !== 'undefined' && CONFIG.PEER_ICE && CONFIG.PEER_ICE.length)
      ? CONFIG.PEER_ICE
      : [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
  };

  /* How long to wait for a direct link before giving up and staying on the
     WebSocket for good. Fifteen seconds is long enough to cover a slow ICE
     gathering on a bad connection and short enough that nobody notices they
     spent it. */
  const DIAL_TIMEOUT_MS = 15000;

  /* A data channel message larger than this is refused rather than parsed.
     A peer is a player on your machine, not a trusted server, and the
     snapshots this carries are around 5 KB. */
  const MAX_MESSAGE_CHARS = 256 * 1024;

  /* The channel carries ONLY the firehose: inputs and snapshots. Both are
     superseded by the next one, so retransmitting a stale frame is worse than
     losing it — it would arrive late and be applied on top of newer truth.
     Unordered and no retransmits is therefore the correct choice here, and it
     is what makes the link cheap rather than merely faster. */
  const CHANNEL_OPTS = { ordered: false, maxRetransmits: 0 };

  const Rtc = {
    _peers: {},        /* peerId -> { pc, ch, open, pending, timer } */
    _enabled: true,

    /* Called by net.js with anything that arrived over the WebSocket. */
    onMessage: null,   /* (peerId, obj) */
    onOpen: null,      /* (peerId) */
    onClose: null,     /* (peerId) */

    supported() {
      return typeof RTCPeerConnection === 'function';
    },

    /* ---- client side: offer ------------------------------------------- */
    dial(peerId) {
      if (!this._enabled) return false;
      if (!this.supported()) return false;
      if (this._peers[peerId]) return true;
      if (!peerId || !Net || typeof Net._raw !== 'function') return false;

      let pc;
      try {
        pc = new RTCPeerConnection(ICE);
      } catch (e) {
        return false;                 /* no WebRTC here; the socket carries on */
      }

      const rec = { pc, ch: null, open: false, pending: [], timer: null, making: true };
      this._peers[peerId] = rec;

      rec.timer = setTimeout(function () { Rtc._giveUp(peerId); }, DIAL_TIMEOUT_MS);

      pc.onicecandidate = function (e) {
        if (e.candidate) Net._raw({ t: 'rtc-ice', to: peerId, cand: e.candidate.toJSON() });
      };

      pc.onconnectionstatechange = function () {
        /* 'failed' is permanent and will not recover on its own. 'disconnected'
           can be transient, so it is left alone to recover by itself. */
        if (pc.connectionState === 'failed') Rtc._giveUp(peerId);
      };

      try {
        const ch = pc.createDataChannel('game', CHANNEL_OPTS);
        this._wireChannel(peerId, rec, ch);
        pc.createOffer()
          .then(function (offer) { return pc.setLocalDescription(offer).then(function () { return offer; }); })
          .then(function (offer) { Net._raw({ t: 'rtc-offer', to: peerId, sdp: offer }); })
          .catch(function () { Rtc._giveUp(peerId); });
      } catch (e) {
        Rtc._giveUp(peerId);
        return false;
      }
      return true;
    },

    /* ---- host side: answer -------------------------------------------- */
    accept(peerId, sdp) {
      if (!this._enabled || !this.supported() || !peerId) return;
      /* Only one offer per peer. A second one means the client restarted its
         dial; the half-built connection is dropped and the new one is built
         from scratch rather than trying to merge two negotiations. */
      if (this._peers[peerId]) this._drop(peerId, true);
      if (!sdp) return;

      let pc;
      try {
        pc = new RTCPeerConnection(ICE);
      } catch (e) {
        return;
      }

      const rec = { pc, ch: null, open: false, pending: [], timer: null, making: false };
      this._peers[peerId] = rec;

      pc.onicecandidate = function (e) {
        if (e.candidate) Net._raw({ t: 'rtc-ice', to: peerId, cand: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'failed') Rtc._giveUp(peerId);
      };
      /* The client created the channel, so on this side it arrives as
         ondatachannel rather than from createDataChannel. */
      pc.ondatachannel = function (e) { Rtc._wireChannel(peerId, rec, e.channel); };

      pc.setRemoteDescription(sdp)
        .then(function () { return Rtc._flush(peerId, rec); })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer).then(function () { return answer; }); })
        .then(function (answer) { Net._raw({ t: 'rtc-answer', to: peerId, sdp: answer }); })
        .catch(function () { Rtc._giveUp(peerId); });
    },

    _wireChannel(peerId, rec, ch) {
      if (!ch) return;
      rec.ch = ch;
      ch.binaryType = 'arraybuffer';
      ch.onopen = function () {
        rec.open = true;
        rec.making = false;
        if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
        if (Rtc.onOpen) Rtc.onOpen(peerId);
      };
      ch.onclose = function () { Rtc._drop(peerId, false); };
      ch.onmessage = function (e) {
        let obj;
        const data = e.data;
        if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) return;
        try { obj = JSON.parse(data); } catch (err) { return; }
        if (!obj || typeof obj !== 'object') return;
        if (Rtc.onMessage) Rtc.onMessage(peerId, obj);
      };
    },

    /* ---- the rest of the handshake ------------------------------------- */
    onSignal(msg) {
      if (!msg || !this._enabled) return;
      if (msg.t === 'rtc-ice') {
        const rec = this._peers[msg.from];
        if (!rec || !msg.cand) return;
        /* THE BUG THIS FILE IS MOST LIKELY TO BE BITTEN BY. A candidate that
           arrives before the answer it belongs to cannot be added yet. It is
           kept and replayed the moment the description is set. Dropping it —
           which is what `return` here used to do — produces a connection that
           looks fine in the console and never carries a byte. */
        if (!rec.pc.remoteDescription) { rec.pending.push(msg.cand); return; }
        rec.pc.addIceCandidate(msg.cand).catch(function () {});
        return;
      }
      if (msg.t === 'rtc-offer') { this.accept(msg.from, msg.sdp); return; }
      if (msg.t === 'rtc-answer') {
        const rec = this._peers[msg.from];
        if (!rec || !msg.sdp) return;
        if (rec.pc.signalingState !== 'have-local-offer') return;  /* stale */
        rec.pc.setRemoteDescription(msg.sdp)
          .then(function () { return Rtc._flush(msg.from, rec); })
          .catch(function () { Rtc._giveUp(msg.from); });
      }
    },

    _flush(peerId, rec) {
      const queued = rec.pending;
      rec.pending = [];
      for (const cand of queued) {
        try { rec.pc.addIceCandidate(cand).catch(function () {}); } catch (e) { /* one bad candidate is not fatal */ }
      }
      return Promise.resolve(peerId);
    },

    /* ---- sending ------------------------------------------------------- */
    isOpen(peerId) {
      const rec = this._peers[peerId];
      return !!(rec && rec.open && rec.ch && rec.ch.readyState === 'open');
    },

    /* Everyone this client has a working direct link to. The host sends this
       list with each snapshot so the server knows who NOT to send the WebSocket
       copy to — which is the entire point of the exercise. */
    connectedIds() {
      const out = [];
      for (const id in this._peers) if (this.isOpen(id)) out.push(id);
      return out;
    },

    /* Returns true when the message went out over the direct link. False is a
       normal, expected answer meaning "no link, use the socket", never an
       error worth handling. */
    send(peerId, obj) {
      if (!this._peers[peerId]) return false;
      const rec = this._peers[peerId];
      if (!rec.open || !rec.ch || rec.ch.readyState !== 'open') return false;
      /* bufferedAmount is the send queue. A peer that cannot drain it must not
         be allowed to grow the queue without bound: a late snapshot is worth
         nothing, and the next one is already on its way. */
      if (rec.ch.bufferedAmount > 262144) return false;
      try {
        rec.ch.send(JSON.stringify(obj));
        return true;
      } catch (e) {
        return false;
      }
    },

    /* Same as send(), for a payload already stringified by the caller.
       The snapshot broadcast used to stringify the WHOLE per-tick state once
       PER PEER — with a dozen players connected that was a dozen 5 KB
       stringify passes per tick, 12 ticks a second, all on the main thread of
       the machine acting as host. One stringify, many sends, is the same bytes
       to everyone and a fraction of the CPU. */
    sendRaw(peerId, str) {
      if (!this._peers[peerId]) return false;
      const rec = this._peers[peerId];
      if (!rec.open || !rec.ch || rec.ch.readyState !== 'open') return false;
      if (rec.ch.bufferedAmount > 262144) return false;
      try {
        rec.ch.send(str);
        return true;
      } catch (e) {
        return false;
      }
    },

    /* ---- teardown ------------------------------------------------------ */
    /* Quiet: the peer may simply be gone. Nothing to report. */
    _drop(peerId, silent) {
      const rec = this._peers[peerId];
      if (!rec) return;
      delete this._peers[peerId];
      try { if (rec.timer) clearTimeout(rec.timer); } catch (e) {}
      try { if (rec.ch) rec.ch.close(); } catch (e) {}
      try { if (rec.pc) rec.pc.close(); } catch (e) {}
      if (!silent && Rtc.onClose) Rtc.onClose(peerId);
    },

    /* The handshake failed or timed out. The game does not notice: every
       caller treats this the same as never having tried, because the WebSocket
       was never let go. */
    _giveUp(peerId) {
      if (!this._peers[peerId]) return;
      this._drop(peerId, true);
    },

    closeAll() {
      for (const id in this._peers) this._drop(id, true);
    },
  };

  window.Rtc = Rtc;
})();