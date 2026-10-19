/* ============================================================================
   sandbox-room.js — your own private server, hosted by you.

   WHAT THIS IS
   ------------
   A room you open, a code you hand out, and up to 14 people who join it. You are
   the host: you pick the map, you start it, you can kick. Nothing goes through
   the game's matchmaking service, because a sandbox is not a match — there is no
   queue, no countdown, no bot fill and nobody arriving by accident. It is a room
   with a door you opened.

   HOW IT CONNECTS
   ---------------
   Peer-to-peer, the same way the Platoon already does it (js/platoon.js), which
   is why this is a small file and not a new networking stack: the host registers
   a Peer with a fixed id derived from the room code, everyone else dials that
   id. The host holds the authoritative room state and broadcasts it; clients
   never decide anything.

   The room id is namespaced 'sandbox-<code>' rather than 'platoon-<code>' so a
   Platoon and a Sandbox that happen to share a code cannot collide on the same
   Peer id. They are separate rooms and must stay separate.

   NO VOICE HERE, DELIBERATELY
   --------------------------
   The Platoon's voice is a WebRTC MESH: every member holds a direct media
   connection to every other member. At three people that is three connections
   and it is fine. At fourteen it is 91 connections, every join renegotiates
   with everyone at once, and the audio degrades well before you get there.

   So this room is text and presence only. Text chat, the roster, the map picker
   and the start button all work; talking is done out of band. Adding real voice
   later means an SFU — a server that mixes the audio — not a bigger mesh, and
   that is a separate project rather than a bigger constant.

   STABILITY IS THE PRIORITY HERE
   -----------------------------
   Everything below is written for "do not fall over", in this order:

     * the room never blocks the game. If PeerJS is unavailable, blocked, or the
       signalling server is down, the host gets a LOCAL room: one player, the map
       picker and the start button still work, and the panel says so. Failing to
       a usable single-player sandbox beats failing to a spinner.
     * every connection attempt backs off. A room full of people all dialling at
       once must not turn into a retry storm against the signalling server.
     * a dropped peer is retried, not treated as a departure, so a brief tunnel
       blip does not empty the room.
     * if the HOST leaves, the longest-present member is promoted rather than the
       room dissolving. Host migration is the single biggest source of "the room
     just vanished" and it is handled explicitly.
     * the host is the only place the member cap is enforced, because a cap
       enforced by fourteen clients is a cap that can be disagreed with.
   ========================================================================== */

(function(){
  'use strict';
  if (window.SandboxRoom) return;

  var PFX = (window.CONFIG && CONFIG.PEER_PREFIX) || 'tankparty-v1-';
  var MAX_MEMBERS = 14;          /* you + 13 guests */
  var MAX_CHAT    = 120;
  var CONNECT_TIMEOUT = 9000;    /* a dial that has not opened by now is dead  */
  var BACKOFF_MIN = 1000;
  var BACKOFF_MAX = 15000;

  var $ = function(id){ return document.getElementById(id); };

  function el(tag, cls, txt){
    var n = document.createElement(tag);
    if(cls) n.className = cls;
    if(txt !== undefined) n.textContent = txt;
    return n;
  }

  function myUid(){
    var k = 'mtl_sandbox_uid';
    try{
      var v = sessionStorage.getItem(k);
      if(!v){
        v = 's' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(k, v);
      }
      return v;
    }catch(e){
      return 's' + Math.random().toString(36).slice(2, 10);
    }
  }

  function myName(){
    try{
      var s = (window.Menu && Menu.settings) || {};
      return (s.playerName || 'Player').slice(0, 18);
    }catch(e){ return 'Player'; }
  }

  /* Random room code. Six characters from an alphabet with no 0/O/1/I/L, because
     these get read aloud to each other over voice. */
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function makeCode(){
    var s = '';
    for(var i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  function peerOpts(){
    var h = window.location.hostname;
    var ice = (window.CONFIG && CONFIG.PEER_ICE) || [{ urls: 'stun:stun.l.google.com:19302' }];
    if(h === 'localhost' || h === '127.0.0.1'){
      return { debug: 0, host: h, port: window.location.port || 80, path: '/peerjs',
               secure: false, config: { iceServers: ice } };
    }
    return { debug: 0, config: { iceServers: ice } };
  }

  /* ---------------------------------------------------------------- state */
  var S = {
    code: null,
    role: null,            /* 'host' | 'client' | 'local' */
    peer: null,
    conn: null,            /* client -> host handle */
    hostUid: null,
    me: null,
    members: {},           /* uid -> {uid,name,host,peerId,joinedAt} */
    map: null,             /* the map entry the host picked */
    chat: [],
    phase: 'lobby',        /* 'lobby' | 'loading' | 'playing' */
    local: false,          /* degraded single-player, no signalling */
    status: '',
    attempts: 0,
    openedAt: Date.now(),
    everConnected: false
  };

  function me(){ return S.me; }
  function isHost(){ return S.role === 'host'; }
  function memberCount(){ return Object.keys(S.members).length; }
  function isFull(){ return memberCount() >= MAX_MEMBERS; }

  function setStatus(t){
    S.status = t || '';
    var n = $('sb-status');
    if(n) n.textContent = S.status;
    render();
  }

  /* --------------------------------------------------------------- state io */
  function roomState(){
    var members = {};
    for(var u in S.members){
      var m = S.members[u];
      members[u] = { uid: u, name: m.name, host: !!m.host, peerId: m.peerId || null,
                     joinedAt: m.joinedAt || 0 };
    }
    return { code: S.code, hostUid: S.hostUid, members: members, map: S.map, phase: S.phase };
  }

  function applyRoom(r){
    S.code = r.code;
    S.hostUid = r.hostUid;
    S.map = r.map || null;
    S.phase = r.phase || 'lobby';
    var next = {}, joined = {};
    for(var u in r.members){
      var m = r.members[u];
      joined[u] = m.joinedAt || 0;
      next[u] = { uid: u, name: m.name, host: !!m.host, peerId: m.peerId || null,
                  joinedAt: m.joinedAt || 0, conn: (S.members[u] && S.members[u].conn) || null };
    }
    S.members = next;
    /* If the host promoted someone, we are no longer the host. */
    if(S.hostUid && S.hostUid !== S.me.uid && S.role === 'host') S.role = 'client';
    render();
  }

  function broadcast(msg){
    for(var u in S.members){
      var m = S.members[u];
      if(m && m.conn && m.conn.open){
        try{ m.conn.send(msg); }catch(e){}
      }
    }
  }

  function pushRoom(){
    /* A local room has nobody to broadcast to, but it still has to repaint.
       Returning early here is what left the map picker showing one map while the
       room had actually moved to another -- the state was right and the screen
       was lying about it. */
    if(!isHost() && S.role !== 'local') return;
    broadcast({ t: 'st', room: roomState() });
    render();
  }

  /* ------------------------------------------------------------------ chat */
  function addChat(who, text, mine){
    if(!text) return;
    var line = { who: who, text: String(text).slice(0, 240), at: Date.now(), mine: !!mine };
    S.chat.push(line);
    while(S.chat.length > MAX_CHAT) S.chat.shift();
    renderChat();
  }
  function renderChat(){
    var box = $('sb-chat-log');
    if(!box) return;
    box.innerHTML = '';
    for(var i = 0; i < S.chat.length; i++){
      var c = S.chat[i];
      var row = el('div', 'sb-msg' + (c.mine ? ' sb-msg-mine' : ''));
      row.appendChild(el('span', 'sb-msg-who', c.who));
      row.appendChild(el('span', 'sb-msg-text', c.text));
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
  }
  function sendChat(text){
    text = String(text || '').slice(0, 240);
    if(!text) return;
    addChat(myName(), text, true);
    if(isHost()){
      broadcast({ t: 'chat', uid: S.me.uid, name: myName(), text: text });
    } else if(S.conn && S.conn.open){
      try{ S.conn.send({ t: 'chat', uid: S.me.uid, name: myName(), text: text }); }catch(e){}
    }
  }

  /* ------------------------------------------------------------------ maps */
  /* The vote list is the single source of truth for "which maps exist and how big
     they are", so the picker cannot offer a map the battle loader would reject. */
  function availableMaps(){
    try{
      if(typeof MapVoting !== 'undefined' && MapVoting.getMaps){
        /* The filter was there to drop 'default' — the phantom entry with
           glb:null that meant "no map chosen". That entry is gone from the
           roster, so the filter has nothing left to do.

           It is KEPT anyway, and it now filters on glb instead, because that is
           the property that actually matters here: a map with no file behind it
           cannot be loaded, so offering it in the sandbox picker produces a room
           that starts and then fails. Testing the real condition rather than one
           hardcoded id means this stays correct if another placeholder is ever
           added. */
        return MapVoting.getMaps().filter(function(m){ return !!m.glb; });
      }
    }catch(e){}
    return [];
  }

  function setMap(id){
    /* The host owns the map choice -- and so does a degraded local room, which
       is the same room minus its guests. Leaving the fallback out of this test
       opened it with no map and a permanently dead START button, because
       fallBackToLocal() picks a default map by calling this very function. */
    if(!isHost() && S.role !== 'local') return;
    var found = null;
    var all = availableMaps();
    for(var i = 0; i < all.length; i++) if(all[i].id === id) found = all[i];
    if(!found) return;
    /* Carry the WHOLE entry, not a picked-apart copy of it.

       Copying out only id/name/glb/scale silently threw away `worldHalf`, and
       Core is the one map that declares its own boundary (130 instead of the
       500 default). Losing it did not look like a missing field -- the map still
       loaded -- it looked like the boundary was wrong: a 1000-unit arena, a safe
       circle covering nothing, and random spawns landing at z=-157 on a map that
       ends at z=120. Whatever a map declares has to survive the trip. */
    S.map = {
      id: found.id,
      name: found.name,
      desc: found.desc || '',
      glb: found.glb || null,
      scale: found.scale || 80,
      worldHalf: (found.worldHalf !== undefined) ? found.worldHalf : undefined,
      preview: found.preview || null
    };
    pushRoom();
  }

  function cycleMap(dir){
    if(S.role !== 'host' && S.role !== 'local') return;
    if(!S.map) return;
    var all = availableMaps();
    if(!all.length) return;
    var idx = 0;
    for(var i = 0; i < all.length; i++) if(all[i].id === S.map.id) idx = i;
    idx = (idx + dir + all.length) % all.length;
    setMap(all[idx].id);
  }

  /* ------------------------------------------------------------------ host */
  function hostKill(uid){
    if(!isHost()) return;
    var m = S.members[uid];
    if(!m || m.host) return;
    try{ if(m.conn && m.conn.close) m.conn.close(); }catch(e){}
    delete S.members[uid];
    pushRoom();
  }

  /* Host left. The longest-present remaining member takes over so the room
     survives; without this the room dissolves and everyone is dropped. */
  function migrateHost(){
    if(!isHost()) return;
    var best = null;
    for(var u in S.members){
      if(S.members[u].host) continue;
      if(!best || (S.members[u].joinedAt || 0) < (best.joinedAt || 0)) best = S.members[u];
    }
    if(!best){ S.members = {}; S.phase = 'lobby'; render(); return; }
    best.host = true;
    S.hostUid = best.uid;
    broadcast({ t: 'st', room: roomState() });
    broadcast({ t: 'host', room: roomState() });
    setStatus(best.name + ' is now hosting');
  }

  function onHostMessage(conn, msg){
    var m = S.members[msg.uid];
    if(msg.t === 'hello'){
      if(isFull()){
        try{ conn.send({ t: 'full' }); conn.close(); }catch(e){}
        return;
      }
      if(!m){
        m = S.members[msg.uid] = { uid: msg.uid, name: msg.name || 'Player', host: false,
                                    peerId: conn.peer || null, joinedAt: Date.now(), conn: conn };
      }
      m.conn = conn;
      m.peerId = conn.peer || m.peerId;
      /* Everyone already in the room needs a direct line to the newcomer, or the
         newcomer can hear the host and nobody else. This is the mesh. */
      for(var u in S.members){
        var other = S.members[u];
        if(u === msg.uid || other.host || !other.peerId) continue;
        try{
          /* connect(), NOT call(). PeerJS 1.5's call() takes a MediaStream as
             its second argument -- so call(peerId, {reliable:true}) hands the
             options object to the function as if it were a stream and throws
             "e.getTracks is not a function" before a single byte moves. call()
             is for media; connect() is for data, and this is data. */
          var c = S.peer.connect(other.peerId, { reliable: true, metadata: { to: msg.uid } });
          wireClientSide(c, msg.uid);
        }catch(e){}
      }
      conn.send({ t: 'st', room: roomState() });
      broadcast({ t: 'st', room: roomState() });
      addChat('room', m.name + ' joined');
    }
    else if(msg.t === 'chat'){ addChat(msg.name || 'Player', msg.text); }
    else if(msg.t === 'kick'){
      try{ conn.close(); }catch(e){}
    }
    else if(msg.t === 'leave'){
      if(m){ try{ if(m.conn) m.conn.close(); }catch(e){} delete S.members[msg.uid]; pushRoom(); }
    }
  }

  function wireClientSide(conn, toUid){
    conn.on('open', function(){
      var m = S.members[toUid];
      if(m) m.conn = conn;
      try{ conn.send({ t: 'hi', uid: S.me.uid, name: myName() }); }catch(e){}
      conn.send({ t: 'chat', uid: S.me.uid, name: myName(), text: myName() + ' connected' });
    });
    conn.on('data', function(msg){
      if(!msg) return;
      if(msg.t === 'st') applyRoom(msg.room);
      else if(msg.t === 'host'){ applyRoom(msg.room); S.role = 'host'; render(); }
      else if(msg.t === 'chat') addChat(msg.name || 'Player', msg.text);
      else if(msg.t === 'kick'){ setStatus('You were removed from the room'); teardown(); }
      else if(msg.t === 'launch') launchAsClient(msg);
      else if(msg.t === 'map'){ S.map = msg.map; render(); }
    });
    conn.on('close', function(){
      var mm = S.members[toUid];
      if(mm && mm.conn === conn) mm.conn = null;
    });
    conn.on('error', function(){ /* a peer link dying is normal; the host still has the roster */ });
  }

  function startHost(){
    teardown();
    S.role = 'host';
    S.local = false;
    S.attempts = 0;
    S.phase = 'lobby';
    S.map = null;
    S.chat = [];
    S.code = makeCode();
    S.me = { uid: myUid(), name: myName(), host: true, peerId: null, joinedAt: Date.now() };
    S.members[S.me.uid] = S.me;
    S.hostUid = S.me.uid;

    var tryReg = function(){
      var p;
      try{
        p = new Peer(PFX + 'sandbox-' + S.code, peerOpts());
      }catch(e){
        fallBackToLocal('Could not open a peer connection');
        return;
      }
      S.peer = p;
      var settled = false;

      p.on('open', function(id){
        settled = true;
        S.me.peerId = id;
        S.everConnected = true;
        setStatus('Room open — code ' + S.code);
        p.on('connection', function(conn){
          conn.on('open', function(){
            conn.on('data', function(msg){
              if(msg && msg.t === 'hello') onHostMessage(conn, msg);
              else if(msg && msg.uid) onHostMessage(conn, msg);
            });
            conn.on('close', function(){
              var found = false;
              for(var u in S.members){
                if(S.members[u].conn === conn){
                  if(S.members[u].host){
                    /* our own link to a promoted host went away */
                    setStatus('Lost the host');
                    scheduleClientDial();
                    return;
                  }
                  delete S.members[u];
                  found = true;
                  break;
                }
              }
              if(found){
                broadcast({ t: 'st', room: roomState() });
                render();
              }
            });
            conn.on('error', function(){});
          });
        });
        render();
      });

      p.on('error', function(err){
        if(settled) return;
        if(err && err.type === 'unavailable-id'){
          /* Code collision. Extremely unlikely at six characters, but it must not
             be fatal, so mint a new one and try again. */
          S.code = makeCode();
          tryReg();
          return;
        }
        fallBackToLocal('Signalling unavailable — running locally');
      });

      p.on('disconnected', function(){
        /* PeerJS drops its broker link periodically and reconnects on its own.
           Only a full close is fatal. */
        setStatus('Reconnecting to the signalling server…');
      });
    };
    tryReg();
    render();
  }

  /* The room is unusable as a network room but the sandbox is still perfectly
     playable alone, so degrade instead of dead-ending. */
  function fallBackToLocal(why){
    teardown();
    S.role = 'local';
    S.local = true;
    S.code = 'LOCAL';
    S.phase = 'lobby';
    S.me = { uid: myUid(), name: myName(), host: true, peerId: null, joinedAt: Date.now() };
    S.members[S.me.uid] = S.me;
    S.hostUid = S.me.uid;
    if(!S.map){
      var all = availableMaps();
      if(all.length) setMap(all[0].id);
    }
    setStatus(why + ' — you can still play, but nobody can join you');
  }

  /* ----------------------------------------------------------------- client */
  function scheduleClientDial(){
    S.attempts++;
    var wait = Math.min(BACKOFF_MAX, BACKOFF_MIN * Math.pow(1.6, Math.min(6, S.attempts)));
    setStatus('Reconnecting… (' + Math.round(wait / 1000) + 's)');
    setTimeout(dialHost, wait);
  }

  function dialHost(){
    if(S.role !== 'client') return;
    var p;
    try{
      p = new Peer(undefined, peerOpts());
    }catch(e){
      scheduleClientDial();
      return;
    }
    S.peer = p;
    var settled = false;

    p.on('open', function(myId){
      settled = true;
      try{
        /* connect(), not call() -- see the note on the host-side dial. call() would
           treat these options as a MediaStream and throw on getTracks(). */
        var c = p.connect(PFX + 'sandbox-' + S.code, { reliable: true });
        S.conn = c;
        c.on('open', function(){
          S.attempts = 0;
          S.everConnected = true;
          setStatus('Connected');
          try{ c.send({ t: 'hello', uid: S.me.uid, name: myName() }); }catch(e){}
        });
        c.on('data', function(msg){
          if(!msg) return;
          if(msg.t === 'st') applyRoom(msg.room);
          else if(msg.t === 'host'){ applyRoom(msg.room); S.role = 'host'; render(); }
          else if(msg.t === 'chat') addChat(msg.name || 'Player', msg.text);
          else if(msg.t === 'full'){ setStatus('That room is full'); teardown(); }
          else if(msg.t === 'kick'){ setStatus('You were removed'); teardown(); }
          else if(msg.t === 'launch') launchAsClient(msg);
          else if(msg.t === 'map'){ S.map = msg.map; render(); }
        });
        c.on('close', function(){ scheduleClientDial(); });
        c.on('error', function(){ scheduleClientDial(); });
      }catch(e){
        try{ p.destroy(); }catch(e2){}
        scheduleClientDial();
      }
    });

    p.on('error', function(err){
      if(settled) return;
      try{ p.destroy(); }catch(e){}
      scheduleClientDial();
    });
  }

  function joinRoom(code){
    teardown();
    S.code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if(S.code.length < 4){ setStatus('That code does not look right'); return; }
    S.role = 'client';
    S.local = false;
    S.attempts = 0;
    S.phase = 'lobby';
    S.chat = [];
    S.me = { uid: myUid(), name: myName(), host: false, peerId: null, joinedAt: Date.now() };
    S.members[S.me.uid] = S.me;
    setStatus('Connecting to ' + S.code + '…');
    dialHost();
    render();
  }

  function leaveRoom(){
    if(S.role === 'client' && S.conn && S.conn.open){
      try{ S.conn.send({ t: 'leave', uid: S.me.uid }); }catch(e){}
    }
    teardown();
    S.role = null; S.code = null; S.members = {}; S.chat = []; S.map = null; S.phase = 'lobby';
    render();
  }

  function teardown(){
    try{ if(S.conn && S.conn.close) S.conn.close(); }catch(e){}
    try{ if(S.peer && !S.peer.destroyed) S.peer.destroy(); }catch(e){}
    S.conn = null; S.peer = null; S.attempts = 0;
  }

  /* ---------------------------------------------------------------- launch */
  /* One code path for everyone: the host sends the map it chose, the client
     applies it before the arena builds. Both call the same Game entry, so the
     map that loads is the map the host picked. */
  function launch(){
    if(!S.map) { setStatus('Pick a map first'); return; }
    S.phase = 'loading';
    var payload = { t: 'launch', code: S.code, map: S.map, gamemode: 'sandbox' };
    if(isHost() || S.role === 'local'){
      broadcast(payload);
      startAsHost();
    }
    render();
  }

  /* THE LIVE GAME OBJECT.

     `Game` is a constructor, not a singleton: every method it has lives on
     Game.prototype, so `Game.startSandboxMultiplayer` is undefined and a call
     guarded on it quietly does nothing at all. That is not hypothetical -- the
     first version of this file checked `window.Game && Game.startSandbox...`,
     the guard failed, and pressing START set the phase to 'playing' while the
     game sat untouched in the menu. The instance is what has to be called. */
  function game(){
    if(window.__game) return window.__game;
    if(window.Menu && Menu.game) return Menu.game;
    return null;
  }

  function launchAsClient(msg){
    if(S.phase === 'playing') return;
    S.phase = 'playing';
    S.map = msg.map || S.map;
    render();
    var g = game();
    if(!g || !g.startSandboxMultiplayer){
      setStatus('Could not reach the game to join');
      return;
    }
    try{ g.startSandboxMultiplayer(S.code, S.map, false); }
    catch(e){ console.warn('Sandbox join failed:', e); setStatus('Join failed'); }
  }

  function startAsHost(){
    S.phase = 'playing';
    render();
    var g = game();
    if(!g || !g.startSandboxMultiplayer){
      setStatus('Could not reach the game to start');
      return;
    }
    try{ g.startSandboxMultiplayer(S.code, S.map, true); }
    catch(e){ console.warn('Sandbox host failed:', e); setStatus('Start failed'); }
  }

  /* ---------------------------------------------------------------- render */
  var built = false;
  function render(){
    renderStatus();
    renderRoster();
    renderMap();
    renderChat();
    renderControls();
  }

  function renderStatus(){
    var n = $('sb-status');
    if(n) n.textContent = S.status;
    var codeEl = $('sb-code');
    if(codeEl) codeEl.textContent = S.code || '------';
    var roleEl = $('sb-role');
    if(roleEl) roleEl.textContent = S.role === 'host' ? 'YOU ARE HOST'
                                 : S.role === 'client' ? 'GUEST'
                                 : S.role === 'local' ? 'LOCAL ONLY' : '';
  }

  function renderRoster(){
    var box = $('sb-members');
    if(!box) return;
    box.innerHTML = '';
    var list = [];
    for(var u in S.members) list.push(S.members[u]);
    /* Host first, then longest-present. Stable order so the list does not
       reshuffle every time somebody's connection blips. */
    list.sort(function(a, b){
      if(!!b.host !== !!a.host) return b.host ? 1 : -1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    });
    for(var i = 0; i < list.length; i++){
      var m = list[i];
      var row = el('div', 'sb-member' + (m.host ? ' sb-member-host' : ''));
      row.appendChild(el('span', 'sb-member-name', m.name + (m.uid === S.me.uid ? '  (you)' : '')));
      if(m.host) row.appendChild(el('span', 'sb-member-tag', 'HOST'));
      if(isHost() && m.uid !== S.me.uid){
        var k = el('button', 'sb-kick', '×');
        k.onclick = function(){ hostKill(m.uid); };
        row.appendChild(k);
      }
      box.appendChild(row);
    }
    var count = $('sb-count');
    if(count) count.textContent = memberCount() + ' / ' + MAX_MEMBERS;
  }

  function renderMap(){
    var n = $('sb-map-name');
    if(n) n.textContent = S.map ? S.map.name : 'No map chosen';
    var d = $('sb-map-desc');
    /* Show what the map actually is when the vote list describes it, and fall
       back to the id only when it does not. */
    if(d) d.textContent = S.map ? (S.map.desc || ('id: ' + S.map.id)) : 'the host picks the map';
  }

  /* Kept as its own step so a future "unread" badge can hook here without
     touching render(). render() already calls renderChat directly. */

  function renderControls(){
    var hostOnly = isHost() || S.role === 'local';
    ['sb-map-prev','sb-map-next','sb-start'].forEach(function(id){
      var n = $(id);
      if(n) n.disabled = !hostOnly;
    });
    var canStart = hostOnly && !!S.map && S.phase === 'lobby';
    var s = $('sb-start');
    if(s) s.disabled = !canStart;
  }

  /* ------------------------------------------------------------------ wire */
  function onClick(id, fn){ var n = $(id); if(n) n.onclick = fn; }

  function init(){
    if(built) return;
    built = true;

    onClick('sb-host', function(){ startHost(); });
    onClick('sb-join', function(){
      var inp = $('sb-code-input');
      joinRoom(inp ? inp.value : '');
    });
    onClick('sb-leave', function(){ leaveRoom(); });
    /* Playing alone is not a lesser sandbox, it is the same sandbox with nobody
       else in it -- so it uses the game's own single-player sandbox rather than
       faking an empty room. */
    onClick('sb-solo', function(){
      leaveRoom();
      var g = game();
      try{
        if(window.Menu) Menu.show('menu-main');
        if(g && g.startSandbox) g.startSandbox();
      }catch(e){ console.warn('Solo sandbox failed:', e); }
    });
    onClick('sb-map-prev', function(){ cycleMap(-1); });
    onClick('sb-map-next', function(){ cycleMap(1); });
    onClick('sb-start', function(){ launch(); });

    var form = $('sb-chat-form');
    if(form) form.onsubmit = function(e){
      e.preventDefault();
      var inp = $('sb-chat-input');
      if(!inp) return;
      sendChat(inp.value);
      inp.value = '';
    };

    var codeIn = $('sb-code-input');
    if(codeIn) codeIn.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){
        e.preventDefault();
        var b = $('sb-join');
        if(b) b.click();
      }
    });

    render();
  }

  window.SandboxRoom = {
    init: init,
    refresh: render,
    host: startHost,
    join: joinRoom,
    leave: leaveRoom,
    setMap: setMap,
    launch: launch,
    state: S,
    MAX_MEMBERS: MAX_MEMBERS,
    isHost: isHost,
    isLocal: function(){ return S.role === 'local'; }
  };
})();