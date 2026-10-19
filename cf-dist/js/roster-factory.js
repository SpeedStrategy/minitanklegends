/* ============================================================================
   roster-factory.js — the bots are built on the client, not sent by the server.

   WHAT MOVED AND WHY
   ------------------
   The server used to invent every bot: name, tank and a fresh random peerId for
   each of the fourteen of them, then ship all sixteen roster entries to every
   player. Measured on a 16-slot match that is 1348 bytes per client for a
   7v7, and the expensive part was not the bytes but the *rebuild*: whenever
   anybody left mid-match the server pushed a whole new 16-entry roster to
   everybody, having regenerated the bot list from scratch.

   A bot has no authority. It cannot vote, it has no socket, and the host
   synthesises its tank anyway from the mode's own bot loops. The only thing the
   roster needs to say about it is "there are N of them, and here is how to name
   them" — so the server now sends a single integer and each client derives the
   identical list from it.

   WHAT THE SERVER SENDS
       seed        one integer, unique per match
       botCount    how many to invent
       players     the humans only

   WHAT MAKES THIS SAFE
   The generator is a PURE FUNCTION of (seed, count). No RNG state, no ordering
   dependence, so every client in the match produces byte-identical bots without
   talking to anyone. And it is INDEX-based, which matters for a subtle reason:
   when a human leaves and a bot takes the hole, botCount goes 14 -> 15 and the
   first fourteen are unchanged. Bots already in the arena do not get renamed or
   re-skinned mid-match, which an RNG-stream approach would have done.

   COMPATIBILITY
   If the server sends no seed — an older backend, or a rollback — expand()
   returns msg.players untouched. So client and server can be deployed in
   either order, and the change can be turned off without breaking the game.
   ========================================================================== */

(function (global) {
  'use strict';

  /* Kept identical to the server's tables so a bot looks the same whether it
     came from the wire or from here. */
  /* Kept identical to the server's tables so a bot looks the same whether it
     came from the wire or from here.

     vortex and shotgun are GONE: vortex was renamed to demolisher (same tank,
     new model and a thrown rather than dropped mine) and the Shotgun slot is
     Burst. A stale id here is not cosmetic — every entry that no longer exists
     in TANKS silently falls back to Cool Buddy, so bots would have quietly kept
     appearing as the tank that was deleted. */
  const BOT_TANKS = [
    'coolbuddy', 'striker', 'sturmratte', 'demolisher', 'predator',
    'double', 'burst', 'grom', 'tankbuster'
  ];
  const BOT_NAMES = [
    'Bolt', 'Rivet', 'Spanner', 'Torque', 'Piston', 'Cog', 'Anvil', 'Sprocket',
    'Gizmo', 'Ratchet', 'Flange', 'Bearing', 'Clutch', 'Flywheel', 'Idler', 'Cam'
  ];

  /* Deterministic bots for `count`, derived from `seed`. */
  function makeBots(seed, count) {
    const n = Math.max(0, count | 0);
    const s = seed >>> 0;
    const out = new Array(n);
    /* Rotate the tank list by the seed so two matches are not eight identical
       tanks, while staying a pure function of the seed. */
    const rot = s % BOT_TANKS.length;
    for (let i = 0; i < n; i++) {
      out[i] = {
        /* Unique per match and per slot, and cannot collide with a server-minted
           human id because those are always "p-...". */
        peerId: 'bot-' + s + '-' + i,
        isBot: true,
        name: BOT_NAMES[i % BOT_NAMES.length],
        tank: BOT_TANKS[(i + rot) % BOT_TANKS.length],
        color: 0,
      };
    }
    return out;
  }

  /* Turn a `matched` or `roster` message into the full roster the rest of the
     game expects: humans first (host always index 0), then bots. */
  function expand(msg) {
    if (!msg) return [];
    const players = Array.isArray(msg.players) ? msg.players : [];
    if (msg.seed == null) return players;          /* old backend: already complete */
    if (msg.botCount == null) return players;

    /* Guard against a server that sent humans AND bots: drop the bots rather
       than doubling them. */
    const humans = players.filter(function (p) { return p && !p.isBot; });
    const bots = makeBots(msg.seed, msg.botCount);
    return humans.concat(bots);
  }

  /* How many humans a roster contains — used for the "2 humans + 14 bots"
     status line and by matchmaking.js. */
  function humanCount(roster) {
    if (!roster) return 0;
    let n = 0;
    for (let i = 0; i < roster.length; i++) if (roster[i] && !roster[i].isBot) n++;
    return n;
  }

  const api = { makeBots: makeBots, expand: expand, humanCount: humanCount,
                BOT_TANKS: BOT_TANKS, BOT_NAMES: BOT_NAMES };

  global.RosterFactory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);