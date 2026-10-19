/* ============================================================
   platoon.js — Platoon lobby v2: real multiplayer room.
   PeerJS mesh: voice (WebRTC media) + presence/chat/vote via
   host-authority data channel. Falls back to local-only mode
   when no network / no host is reachable.

   Host peer id : tankparty-v1-platoon-<CODE>
   Client->host : hello, move, ready, mode, wish, chat, lvl, mic
   Host->client : st (room state), chat, lvl, mic, fm, youmuted,
                  kick, close, host, vote, lock, cd, launch, res
   ============================================================ */
(function(){
  if(window.PlatoonLobby && window.PlatoonLobby.__v2) return;

  var PFX = (window.CONFIG && CONFIG.PEER_PREFIX) || 'tankparty-v1-';
  function voiceId(code){ return PFX + 'platoon-' + code; }

  /* HOW MANY FIT IN A PLATOON.
     Three, host included: you plus two friends. This is the small, deliberate
     room. It is NOT the Sandbox, which takes fourteen -- a bigger room than
     three wants a different lobby, a map picker and no voice, because a voice
     mesh is three connections here and ninety-one there. The two live in
     separate panels for that reason, not because they are two flavours of the
     same screen. */
  var PLATOON_MAX = 3;

  var MODES = {
    gladiator:     { label: 'GLADIATOR',     custom: false },
    sandbox:       { label: 'SANDBOX',       custom: false },
    'platform-king': { label: 'PLATFORM KING', custom: false },
    custom:        { label: 'CUSTOM',        custom: true  }
  };

  var $ = function(id){ return document.getElementById(id); };
  function el(tag, cls, txt){
    var n = document.createElement(tag);
    if(cls) n.className = cls;
    if(txt !== undefined){
      // '<svg...' strings are HTML markup for icons, everything else is text
      if(typeof txt === 'string' && txt.indexOf('<svg') === 0) n.innerHTML = txt;
      else n.textContent = txt;
    }
    return n;
  }
  function myUid(){
    var k = 'mtl_platoon_uid';
    try{
      var base = sessionStorage.getItem(k);
      if(!base){
        base = 'u' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(k, base);
      }
      return base;
    }catch(e){ return 'u' + Math.random().toString(36).slice(2, 10); }
  }
  function myName(){
    // main player nickname placeholder: %trophy% %clan% %nickname%
    try{
      var s = (window.Menu && Menu.settings) || {};
      var parts = [];
      if((s.trophyCount || 0) > 0) parts.push('\u{1F3C6}');
      if(s.playerClan) parts.push('[' + s.playerClan + ']');
      parts.push(s.playerName || 'Player');
      return parts.join(' ');
    }catch(e){ return 'Player'; }
  }

  /* ================= silent profile refresh =================
     Re-reads the saved profile (nickname / clan / trophies) from
     localStorage every few seconds and repaints ONLY the own name
     labels when something changed. Never touches the lobby while a
     battle is running and never rebuilds the room or slots, so bots
     / matches / connections stay completely untouched. */
  function profileMismatch(raw, cur){
    if(typeof raw.playerName === 'string' && raw.playerName !== (cur.playerName || '')) return true;
    if(typeof raw.playerClan === 'string' && (raw.playerClan || '') !== (cur.playerClan || '')) return true;
    if(typeof raw.trophyCount === 'number' && (raw.trophyCount || 0) !== (cur.trophyCount || 0)) return true;
    return false;
  }
  function syncProfile(){
    try{
      if(!window.Menu || !Menu.settings) return;
      var raw = null;
      try{ raw = JSON.parse(localStorage.getItem('tankparty_settings') || 'null'); }catch(e){ raw = null; }
      if(!raw || typeof raw !== 'object') return;
      var cur = Menu.settings;
      if(!profileMismatch(raw, cur)) return;
      if(typeof raw.playerName === 'string') cur.playerName = raw.playerName;
      if(typeof raw.playerClan === 'string') cur.playerClan = raw.playerClan;
      if(typeof raw.trophyCount === 'number') cur.trophyCount = raw.trophyCount;
      if(Menu.refreshProfile) Menu.refreshProfile();
      applyProfilePaint();
    }catch(e){}
  }
  function applyProfilePaint(){
    try{
      var n = myName();
      if(S.youLocal) S.youLocal.name = n;
      if(S.you) S.you.name = n;
      var u = S.you && S.you.uid;
      if(u && S.members[u]) S.members[u].name = n;
      if(window.__PLATOON_BATTLE) return; /* battle running — never touch lobby UI */
      var lobby = document.getElementById('menu-platoon');
      if(!lobby || lobby.classList.contains('hidden')) return;
      var slots = lobby.querySelectorAll('.pl-slot.pl-you');
      for(var i = 0; i < slots.length; i++){
        var nm = slots[i].querySelector('.pl-slot-name');
        if(nm){ nm.textContent = n; nm.title = n; }
      }
      var rows = lobby.querySelectorAll('.pl-vrow');
      for(var j = 0; j < rows.length; j++){
        if(rows[j].dataset.uid === u || rows[j].dataset.uid === S.youLocal.uid){
          var vn = rows[j].querySelector('.pl-vname');
          if(vn) vn.textContent = 'YOU \u00B7 ' + n;
        }
      }
    }catch(e){}
  }
  function peerOpts(){
    var h = window.location.hostname;
    if(h === 'localhost' || h === '127.0.0.1'){
      return { debug: 0, host: h, port: window.location.port || 80, path: '/peerjs', secure: false,
        config: { iceServers: (CONFIG && CONFIG.PEER_ICE) || [{ urls: 'stun:stun.l.google.com:19302' }] } };
    }
    return { debug: 0, config: { iceServers: (CONFIG && CONFIG.PEER_ICE) || [{ urls: 'stun:stun.l.google.com:19302' }] } };
  }

  var S = {
    code: null, mode: 'gladiator', vote: false, votes: {}, lock: false, counting: null,
    host: null, you: null, members: {}, online: false, peer: null, conn: null, retries: 0,
    youLocal: { uid: 'you', name: 'YOU', team: '1', slot: 0, ready: false, host: true },
    voice: { on: false, deafen: false, ptt: false, pttActive: false, stream: null, ctx: null, analyser: null,
             micOn: false, muted: {}, forceMuted: {}, audio: {}, calls: {}, levelTimer: null },
    chat: [], results: null, battle: null
  };
  function youM(){ return S.online ? S.members[S.you.uid] : S.youLocal; }
  function isHostYou(){ var y = youM(); return !!(y && y.host); }
  function arrKey(team){
    if(team === '1') return 'L';
    if(team === '2') return 'R';
    return 'C'; // '0' = shared spectator (watches both teams)
  }
  // 12 slots per team: 0-2 main, 3-9 locked middle, 10-11 spectators.
  // Team '0' = 1 shared spectator slot below the SWITCH TEAM button.
  function slotCount(team){ return team === '0' ? 1 : 12; }
  function isSpecSlot(team, i){ return team === '0' || i >= 10; }
  function isSpecMember(m){ return !!(m && (m.team === '0' || m.slot >= 10)); }
  function isLockedSlot(team, i){
    if(MODES[S.mode].custom) return false;
    if(team === '2') return true;          // team 2: every slot locked until custom
    return i >= 3 && i < 10;               // team 1: 7 locked middle slots
  }
  function emptyArr(team, at){
    var a = [];
    for(var i = 0; i < slotCount(team); i++) a.push(null);
    if(at && isSpecSlot(at.team, at.slot)) at.slot = 0;
    if(at){ a[at.slot] = at; }
    return a;
  }
  function firstOpen(team, source){
    var arr = source || arrOf(team);
    for(var i = 0; i < arr.length; i++){
      if(!arr[i] && !isLockedSlot(team, i)) return i;
    }
    return -1;
  }
  function teamMembers(team){
    var k = arrKey(team), out = [];
    for(var u in S.members){
      var m = S.members[u];
      if(arrKey(m.team) === k) out.push(m);
    }
    return out;
  }
  function arrOf(team){
    var out = [];
    for(var i = 0; i < slotCount(team); i++){
      var f = null;
      for(var u in S.members){
        var m = S.members[u];
        if(m.team === team && m.slot === i){ f = m; break; }
      }
      out.push(f);
    }
    return out;
  }
  function firstEmpty(arr){ return arr.findIndex(function(p){ return !p; }); }
  function status(msg){
    var s = $('pl-status');
    if(!s) return;
    s.textContent = msg;
    s.classList.remove('pl-toast-anim');
    void s.offsetWidth;
    s.classList.add('pl-toast-anim');
  }
  function toast(msg){ if(window.Menu && Menu.toast) Menu.toast(msg); }

  /* ================= render ================= */
  var nodes = { '1': [], '2': [], '0': [] };
  var built = false;

  function sig(m, pos){
    if(!m) return 'o' + (S.lock ? 'L' : '') + S.mode;
    return (m.host ? 'H' : 'P') + (m.ready ? 'R' : '') + (pos === (S.online ? S.host : S.youLocal.uid) ? 'C' : '') + (S.lock ? 'L' : '') + S.mode;
  }

  function buildSlot(pos, t, i){
    var d = el('div', 'pl-slot pl-open' + (t === '0' ? ' pl-slot-mini' : ''));
    d.dataset.pos = pos;
    d.appendChild(el('div', 'pl-crown', '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 2C9.24 2 7 4.24 7 7c0 2.07 1.2 3.82 3 4.65V20h2v-8.35c1.8-.83 3-2.58 3-4.65C13 4.24 10.76 2 12 2zm0 3.5c.83 0 1.5.67 1.5 1.5S12.83 7 12 7s-1.5-.67-1.5-1.5S11.17 4 12 4z"/></svg>'));
    var body = el('div', 'pl-slot-body');
    body.appendChild(el('div', 'pl-plus', '+'));
    body.appendChild(el('div', 'pl-open-label', 'OPEN'));
    body.appendChild(el('div', 'pl-slot-name'));
    body.appendChild(el('div', 'pl-slot-ready'));
    d.appendChild(body);
    var tk = el('div', 'pl-tk');
    tk.appendChild(el('span', 'pl-tk-ico', '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c.4 0 .73.17 1 .44v-3.89c0-.83-.67-1.5-1.5-1.5h-2.41c-.83 0-1.5.67-1.5 1.5v3.89c.27-.27.6-.44 1-.44z"/></svg>'));
    tk.appendChild(el('div', 'pl-tk-bar'));
    d.appendChild(tk);
    d.onclick = function(){ requestMove(t, i); };
    return d;
  }

  function applySlot(d, m, pos){
    var parts = pos.split('-');
    var t = parts[0], i = +parts[1];
    var locked = isLockedSlot(t, i);
    var spec = isSpecSlot(t, i);
    var youUid = S.online ? S.you.uid : S.youLocal.uid;
    var isYou = m && m.uid === youUid;
    d.className = 'pl-slot'
      + (m ? (isYou ? ' pl-you' : ' pl-player') : ' pl-open')
      + (locked ? ' pl-lock' : '')
      + (spec && !m ? ' pl-spec' : '')
      + (t === '0' ? ' pl-slot-mini' : '')
      + (pos === '1-0' ? ' pl-crown-slot' : '')
      + (S.lock ? ' pl-lock' : '');
    var crown = d.querySelector('.pl-crown');
    crown.style.display = (pos === '1-0') ? '' : 'none';
    var plus = d.querySelector('.pl-plus');
    var label = d.querySelector('.pl-open-label');
    var name = d.querySelector('.pl-slot-name');
    var ready = d.querySelector('.pl-slot-ready');
    var tk = d.querySelector('.pl-tk');
    if(!m){
      plus.textContent = locked ? '\uD83D\uDD12' : (spec ? '\uD83C\uDFA5' : '+');
      label.textContent = locked ? 'LOCKED' : (t === '0' ? 'SPEC' : (spec ? 'SPECTATOR' : 'OPEN'));
    }
    plus.style.display = m ? 'none' : '';
    label.style.display = m ? 'none' : '';
    name.style.display = m ? '' : 'none';
    ready.style.display = (m && m.ready) ? '' : 'none';
    name.textContent = m ? m.name : '';
    name.title = m ? m.name : '';
    var muted = m && (S.voice.muted[m.uid] || S.voice.forceMuted[m.uid]);
    tk.style.display = m ? '' : 'none';
    tk.classList.toggle('pl-tk-muted', !!muted);
    tk.style.opacity = (m && muted) ? '1' : (m ? '' : '');
  }

  function renderTalking(uid3, v){
    if(v == null) return;
    var m = S.online ? S.members[uid3] : (uid3 === S.youLocal.uid ? S.youLocal : null);
    if(!m) return;
    var key = m.team;
    var ns = nodes[key];
    if(!ns || !ns[m.slot]) return;
    var n = ns[m.slot];
    var bar = n.el.querySelector('.pl-tk-bar');
    var wrap = n.el.querySelector('.pl-tk');
    if(!bar || !wrap) return;
    if(S.voice.deafen && uid3 !== (S.online ? S.you.uid : S.youLocal.uid)){
      wrap.style.opacity = '1';
      wrap.classList.add('pl-tk-deaf');
      return;
    }
    wrap.classList.remove('pl-tk-deaf');
    if(v > 0.02){
      wrap.style.opacity = '1';
      bar.style.height = Math.max(14, Math.min(100, Math.round(v * 100))) + '%';
      wrap.classList.toggle('pl-tk-live', v > 0.06);
    } else {
      bar.style.height = '14%';
      wrap.classList.remove('pl-tk-live');
      wrap.style.opacity = '0';
    }
  }

  function render(){
    var custom = MODES[S.mode].custom;
    var you = youM();
    var t2 = $('pl-team-2');
    t2.classList.remove('pl-hidden');
    t2.classList.toggle('pl-ghost', !custom);
    $('pl-switch').disabled = !(custom || (you && isSpecMember(you)));
    $('pl-delete').style.display = isHostYou() ? '' : 'none';
    $('pl-ready').disabled = !you;
    $('pl-ready').textContent = (you && you.ready) ? 'READY \u2713' : (you && isSpecMember(you) ? 'READY (SPEC)' : 'READY');
    $('pl-ready').classList.toggle('pl-btn-gold', !!(you && you.ready));
    $('pl-room-code').textContent = S.code;
    $('pl-start').style.display = isHostYou() ? '' : 'none';
    $('pl-start').disabled = false;
    var voteBtn = $('pl-vote');
    voteBtn.classList.toggle('pl-vote-on', S.vote);
    voteBtn.disabled = isHostYou() ? S.vote : true;
    voteBtn.textContent = S.vote ? 'VOTING ON' : (isHostYou() ? 'ENABLE VOTING' : 'VOTING OFF');
    $('pl-mode').disabled = !(isHostYou() || S.vote);
    $('pl-mode').value = S.mode;

    var groups = [['1', 'pl-slots-1', 'pl-c1'], ['2', 'pl-slots-2', 'pl-c2'], ['0', 'pl-slots-0', 'pl-cs0']];
    for(var g = 0; g < groups.length; g++){
      var t = groups[g][0], wrapId = groups[g][1], cntId = groups[g][2];
      var arr = arrOf(t);
      var wrap = $(wrapId);
      if(!built){
        wrap.innerHTML = '';
        nodes[t] = [];
        for(var i = 0; i < arr.length; i++){
          if(i === 10) wrap.appendChild(el('div', 'pl-spec-div', 'SPECTATORS'));
          var d = buildSlot(t + '-' + i, t, i);
          nodes[t].push({ el: d, last: null });
          wrap.appendChild(d);
        }
      }
      $(cntId).textContent = arr.filter(Boolean).length + '/' + arr.length;
      for(var j = 0; j < arr.length; j++){
        var pos = t + '-' + j;
        var n = nodes[t][j];
        var m = arr[j];
        var s = sig(m, pos);
        if(n.last !== s){
          applySlot(n.el, m, pos);
          n.last = s;
          if(m && m.uid === (S.online ? S.you.uid : S.youLocal.uid)){
            n.el.classList.remove('pl-pop');
            void n.el.offsetWidth;
            n.el.classList.add('pl-pop');
          }
        }
      }
    }
    /* The seat count sits next to the game code because that is where somebody
       reads "how many of us are in this" before handing the code to a friend.
       It counts PEOPLE, not team slots -- a platoon is three people who may be
       spread across two teams, so adding up the team arrays would report a
       room that is one player short as a room with space in it. */
    var seatEl = $('pl-seat-count');
    if(seatEl){
      var seated = 0;
      var pool = S.online ? S.members : { [S.youLocal.uid]: S.youLocal };
      for(var q in pool) seated++;
      seatEl.textContent = seated + '/' + PLATOON_MAX;
    }
    built = true;
    renderVoicePanel();
  }

  /* ================= chat ================= */
  function addChat(name, text, self){
    S.chat.push({ name: name, text: text, self: !!self });
    if(S.chat.length > 60) S.chat.shift();
    var list = $('pl-chat-list');
    if(!list) return;
    list.innerHTML = '';
    for(var i = 0; i < S.chat.length; i++){
      var c = S.chat[i];
      var row = el('div', 'pl-chat-row' + (c.self ? ' pl-chat-self' : ''));
      row.appendChild(el('b', '', c.name + ': '));
      row.appendChild(document.createTextNode(c.text));
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
  }

  /* ================= voice panel ================= */
  function renderVoicePanel(){
    var list = $('pl-vlist');
    if(!list) return;
    list.innerHTML = '';
    var youUid = S.online ? S.you.uid : S.youLocal.uid;
    var ids = Object.keys(S.online ? S.members : { [S.youLocal.uid]: S.youLocal });
    ids.sort(function(a, b){
      var ma = S.online ? S.members[a] : S.youLocal;
      var mb = S.online ? S.members[b] : S.youLocal;
      var ka = arrKey(ma.team), kb = arrKey(mb.team);
      if(ka !== kb) return ka < kb ? -1 : 1;
      return ma.slot - mb.slot;
    });
    for(var i = 0; i < ids.length; i++){
      var m = S.online ? S.members[ids[i]] : S.youLocal;
      var row = el('div', 'pl-vrow');
      row.dataset.uid = m.uid;
      var info = el('div', 'pl-vinfo');
      info.appendChild(el('span', 'pl-vname', (m.uid === youUid ? 'YOU \u00B7 ' : '') + m.name));
      info.appendChild(el('span', 'pl-vteam', isSpecMember(m) ? 'SPEC' : 'T' + m.team));
      row.appendChild(info);
      if(m.uid === youUid){
        var mBtn = el('button', 'pl-btn pl-btn-sm pl-btn-gray', S.voice.micOn ? 'MUTE' : 'UNMUTE');
        mBtn.onclick = function(){ toggleMic(); };
        row.appendChild(mBtn);
      } else {
        if(S.voice.deafen){
          row.appendChild(el('span', 'pl-vmuted', 'DEAFENED'));
        } else {
          var locMuted = S.voice.muted[m.uid];
          var fm = S.voice.forceMuted[m.uid];
          var mBtn2 = el('button', 'pl-btn pl-btn-sm ' + (locMuted || fm ? 'pl-btn-orange' : 'pl-btn-gray'),
            fm ? 'HOST MUTED' : (locMuted ? 'UNMUTE' : 'MUTE'));
          if(!fm){
            (function(u){
              mBtn2.onclick = function(){
                S.voice.muted[u] = !S.voice.muted[u];
                applyRemoteVolume(u);
                renderVoicePanel();
              };
            })(m.uid);
          }
          row.appendChild(mBtn2);
          var vol = el('input', 'pl-vvol');
          vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = (S.voice.muted[m.uid] || fm) ? 0 : 100;
          vol.addEventListener('input', function(u, ev){
            var v = ev.target.value / 100;
            var a = S.voice.audio[u];
            if(a) a.volume = v;
            if(v === 0) S.voice.muted[u] = true;
            else S.voice.muted[u] = false;
          });
          row.appendChild(vol);
        }
        if(isHostYou() && S.online && m.uid !== youUid){
          (function(u){
            var fmBtn = el('button', 'pl-btn pl-btn-sm ' + (S.voice.forceMuted[u] ? 'pl-btn-orange' : 'pl-btn-red'),
              S.voice.forceMuted[u] ? 'UNMUTE' : 'MUTE ALL');
            fmBtn.onclick = function(){ hostForceMute(u, !S.voice.forceMuted[u]); };
            row.appendChild(fmBtn);
            var kick = el('button', 'pl-btn pl-btn-sm pl-btn-red', 'KICK');
            kick.onclick = function(){ hostKick(u); };
            row.appendChild(kick);
            var makeHost = el('button', 'pl-btn pl-btn-sm pl-btn-gold', 'MAKE HOST');
            makeHost.onclick = function(){ hostTransfer(u); };
            row.appendChild(makeHost);
          })(m.uid);
        }
      }
      var bar = el('div', 'pl-vbar');
      bar.appendChild(el('span', 'pl-vbar-fill'));
      row.appendChild(bar);
      list.appendChild(row);
    }
  }
  function voiceBarLevel(uid3, v){
    var row = document.querySelector('#pl-vlist .pl-vrow[data-uid="' + uid3 + '"]');
    if(!row) return;
    var fill = row.querySelector('.pl-vbar-fill');
    if(fill) fill.style.width = Math.max(4, Math.min(100, Math.round(v * 100))) + '%';
  }

  /* ================= voice engine ================= */
  function ensureAudioCtx(){
    if(!S.voice.ctx){
      S.voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
      S.voice.analyser = S.voice.ctx.createAnalyser();
      S.voice.analyser.fftSize = 256;
    }
    return S.voice.ctx;
  }
  function micLevel(){
    try{
      var buf = new Uint8Array(S.voice.analyser.fftSize);
      S.voice.analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for(var i = 0; i < buf.length; i++){
        var d = (buf[i] - 128) / 128;
        sum += d * d;
      }
      return Math.sqrt(sum / buf.length);
    }catch(e){ return 0; }
  }
  function toggleMic(){
    var v = S.voice;
    if(v.micOn){ stopMic(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
      var ctx = ensureAudioCtx();
      v.stream = stream;
      v.micOn = true;
      var src = ctx.createMediaStreamSource(stream);
      src.connect(v.analyser);
      ctx.resume();
      $('pl-mic').innerHTML = '\uD83C\uDFA4 VOICE: ON';
      $('pl-mic-tag').style.display = '';
      $('pl-mic-status').textContent = 'Mic live';
      v.levelTimer = setInterval(function(){
        var lv = micLevel();
        if(v.ptt && !v.pttActive) lv = 0;
        var me = S.online ? S.you.uid : S.youLocal.uid;
        renderTalking(me, lv);
        voiceBarLevel(me, lv);
        if(S.conn && S.conn.open) send({ t: 'lvl', v: lv });
      }, 100);
      callEveryone();
      if(S.conn && S.conn.open) send({ t: 'mic', on: true });
      renderVoicePanel();
    }).catch(function(){
      $('pl-mic-status').textContent = 'MIC BLOCKED — allow microphone access';
    });
  }
  function stopMic(){
    var v = S.voice;
    if(!v.micOn){ renderVoicePanel(); return; }
    v.micOn = false;
    if(v.levelTimer){ clearInterval(v.levelTimer); v.levelTimer = null; }
    if(v.stream){ v.stream.getTracks().forEach(function(t){ t.stop(); }); v.stream = null; }
    for(var id in v.calls){ try{ v.calls[id].close(); }catch(e){} }
    v.calls = {};
    var me = S.online ? S.you.uid : S.youLocal.uid;
    renderTalking(me, 0);
    voiceBarLevel(me, 0);
    $('pl-mic').innerHTML = '\uD83C\uDFA4 VOICE: OFF';
    $('pl-mic-tag').style.display = 'none';
    $('pl-mic-status').textContent = 'Voice chat disabled';
    if(S.conn && S.conn.open) send({ t: 'mic', on: false });
    renderVoicePanel();
  }
  function callEveryone(){
    var v = S.voice;
    if(!v.micOn || !v.stream || !S.peer || S.peer.destroyed) return;
    var me = S.online ? S.you.uid : null;
    var list = S.online ? S.members : { [S.youLocal.uid]: S.youLocal };
    for(var uid3 in list){
      if(S.online && uid3 === me) continue;
      var m = list[uid3];
      if(!m.peerId || v.calls[uid3]) continue;
      if(S.online && m.peerId === S.you.peerId) continue;
      try{
        var mc = S.peer.call(m.peerId, v.stream);
        v.calls[uid3] = mc;
        mc.on('close', function(u){ return function(){ delete v.calls[u]; }; }(uid3));
        mc.on('error', function(u){ return function(){ delete v.calls[u]; }; }(uid3));
      }catch(e){}
    }
  }
  function incomingCall(mc){
    var v = S.voice;
    var uid3 = mc.peer;
    if(!v.micOn){
      try{ mc.answer(); }catch(e){}
      mc.on('stream', function(s){ ensureAudioEl(uid3, s); });
      return;
    }
    try{ mc.answer(v.stream); }catch(e){}
    v.calls[uid3] = mc;
    mc.on('stream', function(s){ ensureAudioEl(uid3, s); });
    mc.on('close', function(){ delete v.calls[uid3]; });
    mc.on('error', function(){ delete v.calls[uid3]; });
  }
  function applyRemoteVolume(uid3){
    var a = S.voice.audio[uid3];
    if(!a) return;
    a.volume = (S.voice.muted[uid3] || S.voice.forceMuted[uid3] || S.voice.deafen) ? 0 : 1;
  }
  function ensureAudioEl(uid3, stream){
    var a = S.voice.audio[uid3];
    if(!a){
      a = document.createElement('audio');
      a.autoplay = true;
      a.style.display = 'none';
      document.body.appendChild(a);
      S.voice.audio[uid3] = a;
    }
    a.srcObject = stream;
    applyRemoteVolume(uid3);
  }
  function hostForceMute(uid3, on){
    if(!isHostYou() || !S.online) return;
    S.voice.forceMuted[uid3] = on;
    broadcast({ t: 'fm', uid: uid3, on: on });
    var m = S.members[uid3];
    if(on && m && m.conn){ try{ m.conn.send({ t: 'youmuted', on: true }); }catch(e){} }
    render();
  }

  /* ================= presence ================= */
  function send(msg){
    try{ msg.uid = (S.you ? S.you.uid : S.youLocal.uid); }catch(e){}
    if(S.conn && S.conn.open){ try{ S.conn.send(msg); }catch(e){} }
  }
  function broadcast(msg){
    for(var uid3 in S.members){
      var m = S.members[uid3];
      if(m.conn && m.conn.open && m.uid !== S.you.uid){
        try{ m.conn.send(msg); }catch(e){}
      }
    }
  }
  function roomState(){
    var members = {};
    for(var uid3 in S.members){
      var m = S.members[uid3];
      members[uid3] = { uid: uid3, name: m.name, team: m.team, slot: m.slot, ready: m.ready, host: m.host, peerId: m.peerId };
    }
    return { code: S.code, mode: S.mode, vote: S.vote, votes: S.votes, lock: S.lock, host: S.host, members: members };
  }
  function applyRoom(r){
    S.code = r.code; S.mode = r.mode; S.vote = r.vote; S.votes = r.votes || {};
    S.lock = r.lock; S.host = r.host;
    S.members = {};
    for(var uid3 in r.members){
      var m = r.members[uid3];
      S.members[uid3] = { uid: uid3, name: m.name, team: m.team, slot: m.slot, ready: m.ready, host: m.host, peerId: m.peerId, conn: null };
    }
    built = false;
    render();
  }

  /* ================= HOST side ================= */
  function hostAssign(uid3, name){
    var m = { uid: uid3, name: name, team: '1', slot: 0, ready: false, host: false, peerId: null, conn: null };
    var teams = ['1', '2', '0'];
    for(var i = 0; i < teams.length; i++){
      var t = teams[i];
      var arr = arrOf(t);
      for(var j = 0; j < arr.length; j++){
        if(!arr[j] && !isLockedSlot(t, j)){ m.team = t; m.slot = j; return m; }
      }
    }
    return m;
  }
  function hostMove(uid3, dest, i){
    if(S.lock) return;
    var m = S.members[uid3];
    if(!m) return;
    if(isLockedSlot(dest, i)) return;
    if(i < 0 || i >= slotCount(dest)) return;
    var conflicts = teamMembers(dest).filter(function(x){ return x.slot === i && x.uid !== uid3; });
    if(conflicts.length) return;
    m.team = dest; m.slot = i; m.ready = false;
    broadcast({ t: 'st', room: roomState() });
    render();
  }
  function onHostMessage(conn, msg, uid3){
    var m = S.members[uid3];
    if(!m) return;
    if(msg.t === 'move'){ hostMove(uid3, msg.team, msg.slot); }
    else if(msg.t === 'ready'){
      if(isSpecMember(m)) return;
      m.ready = !m.ready;
      broadcast({ t: 'st', room: roomState() });
      render();
    }
    else if(msg.t === 'mode'){
      if(S.vote){
        S.votes[uid3] = msg.mode;
        status(m.name + ' votes ' + MODES[msg.mode].label);
      }
    }
    else if(msg.t === 'wish'){
      if(!S.vote && msg.mode === 'custom'){
        setMode('custom');
        status(m.name + ' requested CUSTOM — enabled');
      }
    }
    else if(msg.t === 'chat'){
      addChat(m.name, msg.text, false);
      for(var u2 in S.members){
        var mm = S.members[u2];
        if(mm.conn && mm.conn.open && mm.uid !== uid3){
          try{ mm.conn.send({ t: 'chat', name: m.name, text: msg.text }); }catch(e){}
        }
      }
    }
    else if(msg.t === 'lvl'){
      for(var u3 in S.members){
        var m3 = S.members[u3];
        if(m3.conn && m3.conn.open && m3.uid !== uid3){
          try{ m3.conn.send({ t: 'lvl', uid: uid3, v: msg.v }); }catch(e){}
        }
      }
    }
    else if(msg.t === 'mic'){
      for(var u4 in S.members){
        var m4 = S.members[u4];
        if(m4.conn && m4.conn.open && m4.uid !== uid3){
          try{ m4.conn.send({ t: 'mic', uid: uid3, on: msg.on }); }catch(e){}
        }
      }
    }
  }
  function setMode(mode){
    if(!MODES[mode]) return;
    S.mode = mode;
    if(!MODES[mode].custom){
      var open = [];
      var t1 = arrOf('1');
      for(var j = 0; j < t1.length; j++){
        if(!t1[j] && !isLockedSlot('1', j)) open.push(j);
      }
      for(var uid3 in S.members){
        var m = S.members[uid3];
        var lockedNow = m.team === '2' || (m.team === '1' && isLockedSlot('1', m.slot));
        if(lockedNow && open.length){
          m.team = '1'; m.slot = open.shift(); m.ready = false;
        }
      }
    }
    broadcast({ t: 'st', room: roomState() });
    status('Game mode: ' + MODES[mode].label + (MODES[mode].custom ? ' (custom)' : ''));
    render();
  }
  function hostKick(uid3){
    if(!isHostYou() || !S.online) return;
    var m = S.members[uid3];
    if(!m) return;
    try{ if(m.conn) m.conn.send({ t: 'kick' }); }catch(e){}
    try{ if(m.conn) m.conn.close(); }catch(e){}
    delete S.members[uid3];
    broadcast({ t: 'st', room: roomState() });
    status((m.name || 'Player') + ' was kicked');
    render();
  }
  function hostTransfer(uid3){
    if(!isHostYou() || !S.online) return;
    var m = S.members[uid3];
    if(!m) return;
    var full = roomState();
    full.newHost = uid3;
    try{ if(m.conn) m.conn.send({ t: 'host', room: full }); }catch(e){}
    var myUid = S.you.uid;
    for(var k in S.members){
      S.members[k].host = (k === uid3);
      if(k === myUid){ S.members[k].host = false; }
    }
    S.host = uid3;
    var oldPeer = S.peer;
    S.peer = null;
    try{ oldPeer.destroy(); }catch(e){}
    if(S.conn){ try{ S.conn.close(); }catch(e){} S.conn = null; }
    S.online = false;
    setTimeout(function(){ joinAsMember(); }, 900);
  }

  /* ================= CLIENT side ================= */
  function onHostConn(msg){
    if(msg.t === 'st'){
      applyRoom(msg.room);
    }
    else if(msg.t === 'chat'){
      addChat(msg.name, msg.text, false);
    }
    else if(msg.t === 'lvl'){
      renderTalking(msg.uid, msg.v);
      voiceBarLevel(msg.uid, msg.v);
    }
    else if(msg.t === 'mic'){
      if(msg.on) callEveryone();
    }
    else if(msg.t === 'fm'){
      S.voice.forceMuted[msg.uid] = msg.on;
      applyRemoteVolume(msg.uid);
      render();
    }
    else if(msg.t === 'youmuted'){
      if(S.voice.micOn) stopMic();
      status('You were MUTED by the host');
      toast('You were muted by the host');
    }
    else if(msg.t === 'kick'){
      toast('You were removed from the room');
      resetToLocal();
    }
    else if(msg.t === 'close'){
      toast('Host closed the room');
      resetToLocal();
    }
    else if(msg.t === 'host'){
      becomeHost(msg.room);
    }
    else if(msg.t === 'vote'){
      S.vote = msg.on;
      render();
    }
    else if(msg.t === 'lock'){
      S.lock = msg.on;
      if(msg.on) showCountdown(3);
      else stopCountdown();
      render();
    }
    else if(msg.t === 'cd'){
      showCountdown(msg.n);
    }
    else if(msg.t === 'launch'){
      launchBattle(msg);
    }
    else if(msg.t === 'res'){
      S.results = msg.score;
      var hidden = document.getElementById('menu-platoon').classList.contains('hidden');
      if(hidden){ toast('Match ended — results in the platoon lobby'); }
      else renderResults();
    }
    /* The host turned us away because the platoon is full. Without this the
       socket just closes and the guest is left on "Connecting…" forever,
       reading it as a network fault rather than the answer it actually is. */
    else if(msg.t === 'full'){
      S.online = false;
      status('That platoon is full — 3 players is the limit');
      try{ if(S.conn && S.conn.close) S.conn.close(); }catch(e){}
      if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
      S.peer = null; S.conn = null;
      render();
    }
  }

  /* ================= room lifecycle ================= */
  function setupPeerListeners(p, isHost){
    p.on('disconnected', function(){
      if(isHost || (S.conn && !S.conn.open)){
        setTimeout(function(){
          if(S.peer === p && p.disconnected && !p.destroyed){
            try{ p.reconnect(); }catch(e){}
          }
        }, 1500);
      }
    });
  }
  function startHost(){
    if(S.peer && !S.peer.destroyed) return;
    var u = myUid();
    S.host = u; S.online = false;
    S.you = { uid: u, name: myName(), peerId: null, team: '1', slot: 0, ready: false, host: true };
    S.members = {};
    S.members[u] = { uid: u, name: myName(), team: '1', slot: 0, ready: false, host: true, peerId: null, conn: null };
    var p = new Peer(voiceId(S.code), peerOpts());
    S.peer = p;
    setupPeerListeners(p, true);
    p.on('open', function(id){
      S.you.peerId = id;
      S.members[u].peerId = id;
      S.online = true;
      status('Room live • Code: ' + S.code + ' — voice + presence online');
      built = false;
      render();
    });
    p.on('connection', function(conn){
      conn.on('open', function(){
        conn.on('data', function(msg){
          if(msg && msg.t === 'hello'){
            /* A Platoon is you and two friends -- three in the room, counted.

               The cap is enforced HERE, on the host, rather than in the UI. A
               limit that each browser checks for itself is a limit they can
               disagree about: two people refreshing at slightly different
               moments both see "2/3" and both walk in, and the room that
               advertises three seats quietly holds five. The host is the only
               place the number can actually be true.

               The host counts as one of the three, so this admits the two
               friends and no more. */
            if(!S.members[msg.uid]){
              var seated = 0;
              for(var u3 in S.members) seated++;
              if(seated >= PLATOON_MAX){
                try{ conn.send({ t: 'full' }); conn.close(); }catch(e){}
                status('Room is full (' + PLATOON_MAX + ' max) — ' + (msg.name || 'Someone') + ' was turned away');
                return;
              }
              S.members[msg.uid] = hostAssign(msg.uid, msg.name);
            }
            var m = S.members[msg.uid];
            m.peerId = conn.peer; m.conn = conn;
            conn.send({ t: 'st', room: roomState() });
            broadcast({ t: 'st', room: roomState() });
            status(m.name + ' joined the room');
            render();
          } else if(msg && msg.uid){
            onHostMessage(conn, msg, msg.uid);
          }
        });
        conn.on('close', function(){
          for(var uid3 in S.members){
            if(S.members[uid3].conn === conn){
              status(S.members[uid3].name + ' left');
              delete S.members[uid3];
              if(S.counting){ stopCountdown(); S.lock = false; broadcast({ t: 'lock', on: false }); }
              broadcast({ t: 'st', room: roomState() });
              render();
              break;
            }
          }
        });
        conn.on('error', function(){});
      });
    });
    p.on('error', function(err){
      if(err.type === 'unavailable-id'){
        toast('Room already hosted — joining as member');
        setTimeout(function(){ joinAsMember(); }, 300);
      } else if(err.type === 'network' || err.type === 'socket-error' || err.type === 'server-error'){
        status('Signaling unreachable — LOCAL MODE (voice/presence offline)');
        S.host = null; S.online = false;
        try{ p.destroy(); }catch(e){}
        S.peer = null;
        render();
      }
    });
  }
  function joinAsMember(){
    var code = S.code;
    S.online = false; S.host = null;
    if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
    S.peer = null;
    var p = new Peer(peerOpts());
    S.peer = p;
    setupPeerListeners(p, false);
    p.on('open', function(){
      var c = p.connect(voiceId(code), { reliable: true });
      S.conn = c;
      c.on('open', function(){
        S.online = true;
        S.you = { uid: myUid(), name: myName(), peerId: p.id, team: '1', slot: 0, ready: false, host: false };
        S.retries = 0;
        c.send({ t: 'hello', uid: S.you.uid, name: myName() });
        status('Connected to room ' + code + ' — waiting for host');
      });
      c.on('data', onHostConn);
      c.on('close', function(){ onConnLost(); });
      c.on('error', function(){ onConnLost(); });
    });
    p.on('error', function(err){
      if(err.type === 'peer-unavailable' || err.type === 'network' || err.type === 'socket-error' || err.type === 'server-error'){
        if(S.retries++ < 3){
          status('Host offline — retrying…');
          setTimeout(function(){
            if(S.online) return;
            if(S.peer && !S.peer.destroyed){ try{ S.peer.reconnect(); }catch(e){} }
            else { S.peer = null; joinAsMember(); }
          }, 2000);
        } else {
          status('Room not found — LOCAL MODE');
          resetToLocal();
        }
      }
    });
  }
  function onConnLost(){
    if(!S.online) return;
    S.online = false;
    status('Connection to host lost — reconnecting…');
    S.retries = 0;
    setTimeout(function(){
      if(!S.online){ joinAsMember(); }
    }, 1500);
  }
  function becomeHost(room){
    S.host = S.you.uid;
    S.you.host = true;
    S.members = {};
    S.conn = null;
    if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
    S.peer = null;
    var saved = room;
    var tryReg = function(){
      var p = new Peer(voiceId(saved.code), peerOpts());
      S.peer = p;
      setupPeerListeners(p, true);
      p.on('open', function(id){
        S.you.peerId = id;
        S.online = true;
        S.code = saved.code; S.mode = saved.mode; S.vote = saved.vote;
        S.votes = saved.votes || {}; S.lock = saved.lock;
        S.members = {};
        for(var uid3 in saved.members){
          var m = saved.members[uid3];
          S.members[uid3] = { uid: uid3, name: m.name, team: m.team, slot: m.slot, ready: m.ready,
                              host: (uid3 === S.you.uid), peerId: null, conn: null };
        }
        S.members[S.you.uid].peerId = id;
        status('You are now the HOST');
        p.on('connection', function(conn){
          conn.on('open', function(){
            conn.on('data', function(msg){
              if(msg && msg.t === 'hello'){
                if(!S.members[msg.uid]) S.members[msg.uid] = hostAssign(msg.uid, msg.name);
                var m = S.members[msg.uid];
                m.peerId = conn.peer; m.conn = conn;
                conn.send({ t: 'st', room: roomState() });
                broadcast({ t: 'st', room: roomState() });
                render();
              } else if(msg && msg.uid){
                onHostMessage(conn, msg, msg.uid);
              }
            });
            conn.on('close', function(){
              for(var u in S.members){
                if(S.members[u].conn === conn){ delete S.members[u]; broadcast({ t: 'st', room: roomState() }); render(); break; }
              }
            });
          });
        });
        built = false;
        render();
      });
      p.on('error', function(err){
        if(err.type === 'unavailable-id'){
          setTimeout(tryReg, 1200);
        } else {
          status('Host registration failed — local mode');
          resetToLocal();
        }
      });
    };
    tryReg();
  }
  function resetToLocal(){
    if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
    S.peer = null; S.conn = null; S.online = false; S.host = null;
    S.members = {}; S.votes = {}; S.vote = false; S.lock = false;
    stopCountdown();
    stopMic();
    S.youLocal = { uid: 'you', name: myName(), team: '1', slot: 0, ready: false, host: true };
    built = false;
    render();
    status('LOCAL MODE — host a room to play online');
  }

  /* ================= local / move / ready ================= */
  function requestMove(t, i){
    if(S.lock) return;
    if(S.online){
      if(isHostYou()){
        var you = S.members[S.you.uid];
        if(you && you.team === '1' && you.slot === 0 && (t !== '1' || i !== 0)){
          S.pendingMove = { t: t, i: i };
          $('pl-confirm-modal').classList.remove('hidden');
          return;
        }
        hostMove(S.you.uid, t, i); return;
      }
      send({ t: 'move', team: t, slot: i });
      return;
    }
    var you = S.youLocal;
    if(isLockedSlot(t, i)) return;
    if(you.team === t && you.slot === i) return;
    if(S.localArr && S.localArr[t] && S.localArr[t][i]) return;
    if(you.team && S.localArr && S.localArr[you.team]) S.localArr[you.team][you.slot] = null;
    you.team = t; you.slot = i; you.ready = false;
    if(S.localArr) S.localArr[t][i] = you;
    status(you.host ? 'You are the HOST'
      : (isSpecSlot(t, i) ? 'You are now SPECTATING' : 'Moved'));
    render();
  }
  function toggleReady(){
    if(S.online){
      if(isHostYou()){
        var m = S.members[S.you.uid];
        if(!m) return;
        m.ready = !m.ready;
        status(m.ready ? 'READY' : 'NOT ready');
        broadcast({ t: 'st', room: roomState() });
        render();
        return;
      }
      send({ t: 'ready' });
      return;
    }
    var you = S.youLocal;
    you.ready = !you.ready;
    status(you.ready ? 'READY' : 'NOT ready');
    render();
  }
  function switchSide(){
    if(S.online){
      var you = S.members[S.you.uid];
      if(!you) return;
      if(isSpecMember(you)){ var m1 = firstOpen('1'); if(m1 >= 0) requestMove('1', m1); return; }
      var dst = you.team === '1' ? '2' : '1';
      var ix = firstOpen(dst);
      if(ix >= 0) requestMove(dst, ix);
      return;
    }
    var y = S.youLocal;
    if(isSpecMember(y)){ var m2 = firstOpen('1', S.localArr['1']); if(m2 >= 0) requestMove('1', m2); return; }
    var dst2 = y.team === '1' ? '2' : '1';
    var ix2 = firstOpen(dst2, S.localArr[dst2]);
    if(ix2 >= 0) requestMove(dst2, ix2);
  }
  function newRoom(){
    stopCountdown();
    if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
    S.peer = null; S.conn = null;
    S.members = {}; S.votes = {}; S.vote = false; S.lock = false; S.results = null;
    S.youLocal = { uid: 'you', name: myName(), team: '1', slot: 0, ready: false, host: true };
    S.localArr = { '1': emptyArr('1', S.youLocal), '2': emptyArr('2') };
    S.code = rndCode();
    built = false;
    render();
    startHost();
    status('You are HOST — code ' + S.code + ' (offline room)');
  }
  function rndCode(){
    var c = Math.random().toString(36).slice(2, 6).toUpperCase();
    return c.length < 4 ? c + 'X'.repeat(4 - c.length) : c;
  }
  function joinRoom(code){
    stopCountdown();
    if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
    S.peer = null; S.conn = null;
    S.members = {}; S.votes = {}; S.vote = false; S.lock = false; S.results = null;
    S.youLocal = { uid: 'you', name: myName(), team: '1', slot: 0, ready: false, host: false };
    S.localArr = { '1': emptyArr('1', S.youLocal), '2': emptyArr('2') };
    S.code = code;
    built = false;
    render();
    status('Joining room ' + code + '…');
    joinAsMember();
  }

  /* ================= vote / gamemode ================= */
  function setModeLocal(mode){
    if(S.online){
      if(isHostYou()){
        if(S.vote){
          S.votes[S.you.uid] = mode;
          status('Your vote: ' + MODES[mode].label);
        } else {
          setMode(mode);
        }
        render();
        return;
      }
      send({ t: 'mode', mode: mode });
      return;
    }
    if(!isHostYou()) return;
    if(S.vote){
      S.votes[S.youLocal.uid] = mode;
      status('Your vote: ' + MODES[mode].label);
      render();
      return;
    }
    S.mode = mode;
    status('Game mode: ' + MODES[mode].label + (MODES[mode].custom ? ' (custom)' : ''));
    render();
  }
  function toggleVote(){
    if(!isHostYou() || S.vote) return;
    S.vote = true;
    if(S.online) broadcast({ t: 'vote', on: true });
    status('Voting enabled — all players can vote gamemode');
    render();
  }

  /* ================= countdown + launch ================= */
  function tryStart(){
    var you = youM();
    if(!you) return;
    if(S.lock) return;
    if(!you.ready){ status('You must READY first to start'); return; }
    var unready = [];
    var list = S.online ? S.members : { [S.youLocal.uid]: S.youLocal };
    for(var uid3 in list){
      var m = list[uid3];
      if(isSpecMember(m)) continue;
      if(!m.ready && m.uid !== you.uid) unready.push(m.name);
    }
    if(unready.length){ status('Waiting for: ' + unready.join(', ')); return; }
    beginCountdown();
  }
  function beginCountdown(){
    if(S.lock) return;
    S.lock = true;
    S.cdCount = Object.keys(S.members).length;
    if(S.online) broadcast({ t: 'lock', on: true });
    var n = 3;
    showCountdown(n);
    if(S.online) broadcast({ t: 'cd', n: n });
    render();
    S.counting = setInterval(function(){
      if(S.online && Object.keys(S.members).length < S.cdCount){
        stopCountdown();
        S.lock = false;
        if(S.online) broadcast({ t: 'lock', on: false });
        status('Countdown cancelled — a player left');
        render();
        return;
      }
      n--;
      if(n <= 0){
        clearInterval(S.counting); S.counting = null;
        doLaunch();
        return;
      }
      showCountdown(n);
      if(S.online) broadcast({ t: 'cd', n: n });
    }, 1000);
  }
  function showCountdown(n){
    var ov = $('pl-cd');
    if(!ov) return;
    ov.classList.remove('hidden');
    var t = ov.querySelector('.pl-cd-num');
    if(t) t.textContent = n;
  }
  function stopCountdown(){
    if(S.counting){ clearInterval(S.counting); S.counting = null; }
    var ov = $('pl-cd');
    if(ov) ov.classList.add('hidden');
  }
  function resolvedMode(){
    if(!S.vote) return S.mode;
    var tally = {};
    var hostVote = null;
    for(var uid3 in S.votes){
      var v = S.votes[uid3];
      tally[v] = (tally[v] || 0) + 1;
      if(uid3 === (S.online ? S.host : S.youLocal.uid)) hostVote = v;
    }
    var best = null, bestN = 0;
    for(var k in tally){
      if(tally[k] > bestN){ best = k; bestN = tally[k]; }
    }
    if(hostVote && best && tally[best] === tally[hostVote] && best !== hostVote) best = hostVote;
    return best || S.mode;
  }
  function doLaunch(){
    stopCountdown();
    if(S.lock){ S.lock = false; if(S.online) broadcast({ t: 'lock', on: false }); }
    var mode = resolvedMode();
    var you = youM();
    var isSpec = you && isSpecMember(you);
    if(S.online) broadcast({ t: 'launch', mode: mode, code: S.code });
    window.__PLATOON_BATTLE = { code: S.code, mode: mode, score: null, launchedAt: Date.now() };
    var Game = window.__game || window.Game;
    if(!isSpec && Game && Game.startHost){
      stopMic();
      Game.startHost({ maxPlayers: 12, isPublic: false, fakePlayers: 0, code: S.code, gamemode: mode });
    } else if(isSpec){
      stopMic();
      if(Game && Game.startSpectator){
        Game.startSpectator({ code: S.code });
      } else {
        status('SPECTATING — the match is running, stay tuned');
      }
    } else {
      status('Game not ready — try again in a moment');
    }
  }
  function launchBattle(msg){
    var you = youM();
    var isSpec = you && isSpecMember(you);
    window.__PLATOON_BATTLE = { code: msg.code || S.code, mode: msg.mode || S.mode, score: null, launchedAt: Date.now() };
    var Game = window.__game || window.Game;
    if(!isSpec && Game && Game.startClient){
      stopMic();
      Game.startClient(msg.code || S.code);
    } else if(isSpec){
      stopMic();
      if(Game && Game.startSpectator){
        Game.startSpectator({ code: msg.code || S.code });
      } else {
        status('SPECTATING — the match is running');
      }
    }
  }
  function onLobbyShow(){
    if(window.__PLATOON_BATTLE){
      var b = window.__PLATOON_BATTLE;
      if(S.online && isHostYou() && b.score){
        S.results = b.score;
        if(S.results && S.results.length) broadcast({ t: 'res', score: S.results });
        renderResults();
      } else if(S.online && !isHostYou() && S.results){
        renderResults();
      }
      if(S.vote){ S.vote = false; S.votes = {}; if(S.online) broadcast({ t: 'vote', on: false }); }
      var y = youM();
      if(y){
        if(S.online){ y.ready = false; broadcast({ t: 'st', room: roomState() }); }
        else { S.youLocal.ready = false; }
      }
      window.__PLATOON_BATTLE = null;
      render();
      syncProfile();
      applyProfilePaint();
    }
  }
  function renderResults(){
    var box = $('pl-results');
    if(!box) return;
    if(!S.results || !S.results.length){ box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var list = $('pl-results-list');
    list.innerHTML = '';
    var rows = S.results.slice().sort(function(a, b){ return (b.kills || 0) - (a.kills || 0); });
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      var row = el('div', 'pl-rrow');
      row.appendChild(el('b', '', r.name || '?'));
      row.appendChild(el('span', '', 'K: ' + (r.kills || 0) + '  DMG: ' + (r.dd || 0)));
      if(i === 0) row.appendChild(el('span', 'pl-r-mvp', 'MVP'));
      list.appendChild(row);
    }
    var mvpEl = $('pl-results-mvp');
    if(mvpEl) mvpEl.textContent = 'MVP: ' + (rows[0] ? rows[0].name : '-');
  }

  /* ================= wiring ================= */
  function wire(){
    $('pl-mode').addEventListener('change', function(){
      setModeLocal($('pl-mode').value);
    });
    $('pl-vote').addEventListener('click', toggleVote);
    $('pl-switch').addEventListener('click', switchSide);
    $('pl-team-2').addEventListener('click', function(){
      if(MODES[S.mode].custom) return;
      if(S.online){
        if(isHostYou()){ setMode('custom'); status('CUSTOM mode activated — TEAM 2 unlocked'); }
        else send({ t: 'wish', mode: 'custom' });
        return;
      }
      setModeLocal('custom');
      status('CUSTOM mode activated — TEAM 2 unlocked');
    });
    $('pl-ready').addEventListener('click', toggleReady);
    $('pl-start').addEventListener('click', tryStart);
    $('pl-delete').addEventListener('click', function(){
      if(S.online && S.conn && !isHostYou()) return;
      if(S.online && isHostYou()) broadcast({ t: 'close' });
      status('Room closed — creating a new room');
      newRoom();
    });
    $('pl-back').addEventListener('click', function(){
      if(window.Menu){ Menu._platoonReturn = false; Menu.show('menu-main'); }
    });
    $('pl-collections').addEventListener('click', function(){
      if(window.Menu){ Menu._platoonReturn = true; Menu.show('menu-collections'); }
    });
    $('pl-copy').addEventListener('click', function(){
      function done(){ status('Code ' + S.code + ' copied to clipboard'); }
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(S.code).then(done, function(){
          var t = document.createElement('textarea');
          t.value = S.code; document.body.appendChild(t); t.select();
          document.execCommand('copy'); t.remove(); done();
        });
      } else {
        var t = document.createElement('textarea');
        t.value = S.code; document.body.appendChild(t); t.select();
        document.execCommand('copy'); t.remove(); done();
      }
    });
    $('pl-join').addEventListener('click', function(){
      var v = $('pl-join-code').value.trim().toUpperCase();
      if(v.length !== 4){ status('Enter a 4-character game code'); return; }
      joinRoom(v);
    });
    $('pl-join-code').addEventListener('input', function(e){
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });
    $('pl-join-code').addEventListener('keydown', function(e){ if(e.key === 'Enter') $('pl-join').click(); });

    // voice
    $('pl-mic').addEventListener('click', toggleMic);
    $('pl-vopts').addEventListener('click', function(){
      var p = $('pl-vpanel');
      var on = p.classList.toggle('pl-vpanel-on');
      $('pl-vopts').classList.toggle('pl-btn-gold', on);
      renderVoicePanel();
    });
    $('pl-vclose').addEventListener('click', function(){
      $('pl-vpanel').classList.remove('pl-vpanel-on');
      $('pl-vopts').classList.remove('pl-btn-gold');
    });
    $('pl-vdeaf').addEventListener('click', function(){
      S.voice.deafen = !S.voice.deafen;
      for(var u in S.voice.audio) applyRemoteVolume(u);
      $('pl-vdeaf').classList.toggle('pl-btn-gold', S.voice.deafen);
      $('pl-vdeaf').textContent = S.voice.deafen ? 'DEAFEN: ON' : 'DEAFEN: OFF';
      render();
    });
    $('pl-vptt').addEventListener('click', function(){
      S.voice.ptt = !S.voice.ptt;
      $('pl-vptt').classList.toggle('pl-btn-gold', S.voice.ptt);
      $('pl-vptt').textContent = S.voice.ptt ? 'PTT: HOLD TO TALK' : 'PTT: AUTO';
    });
    var pttBtn = $('pl-vptt-hold');
    pttBtn.addEventListener('pointerdown', function(e){ e.preventDefault(); S.voice.pttActive = true; });
    pttBtn.addEventListener('pointerup', function(){ S.voice.pttActive = false; });
    pttBtn.addEventListener('pointerleave', function(){ S.voice.pttActive = false; });
    pttBtn.addEventListener('pointercancel', function(){ S.voice.pttActive = false; });

    // chat
    $('pl-chat-send').addEventListener('click', sendChat);
    $('pl-chat-input').addEventListener('keydown', function(e){ if(e.key === 'Enter') sendChat(); });

    // confirm modal (crown seat)
    $('pl-confirm-yes').addEventListener('click', function(){
      var pending = S.pendingMove;
      if(pending){
        if(S.online && isHostYou()){
          hostMove(S.you.uid, pending.t, pending.i);
        } else {
          requestMove(pending.t, pending.i);
        }
      }
      $('pl-confirm-modal').classList.add('hidden');
      S.pendingMove = null;
    });
    $('pl-confirm-no').addEventListener('click', function(){
      $('pl-confirm-modal').classList.add('hidden');
      S.pendingMove = null;
    });
    function sendChat(){
      var inp = $('pl-chat-input');
      var txt = inp.value.trim();
      if(!txt) return;
      inp.value = '';
      if(S.online){
        send({ t: 'chat', text: txt });
        addChat(myName() + ' (you)', txt, true);
      } else {
        addChat(myName() + ' (you)', txt, true);
      }
    }

    // detect lobby re-show for results + vote reset
    var MenuObj = window.Menu;
    if(MenuObj && MenuObj.show){
      var _show = MenuObj.show.bind(MenuObj);
      MenuObj.show = function(id){
        var r = _show(id);
        if(id === 'menu-platoon') onLobbyShow();
        return r;
      };
    }

    // drag the lobby around by its edges (pointer events: PC + mobile)
    (function(){
      var lobby = document.querySelector('.pl-lobby');
      if(!lobby) return;
      var undocked = false, active = null, dx = 0, dy = 0;
      function undock(){
        if(undocked) return;
        undocked = true; dx = 0; dy = 0;
        lobby.style.position = 'fixed';
        lobby.style.left = '8px'; lobby.style.top = '8px';
        lobby.style.right = ''; lobby.style.bottom = '';
        lobby.style.width = 'calc(100vw - 16px)';
        lobby.style.height = 'calc(100vh - 16px)';
        lobby.style.height = 'calc(100dvh - 16px)';
        lobby.style.transform = '';
      }
      function dock(){
        undocked = false; dx = 0; dy = 0;
        lobby.style.position = '';
        lobby.style.left = ''; lobby.style.top = '';
        lobby.style.right = ''; lobby.style.bottom = '';
        lobby.style.width = ''; lobby.style.height = ''; lobby.style.transform = '';
      }
      document.querySelectorAll('.pl-grip').forEach(function(g){
        g.addEventListener('pointerdown', function(e){
          e.preventDefault();
          active = { x: e.clientX, y: e.clientY };
          try{ g.setPointerCapture(e.pointerId); }catch(err){}
          undock();
        });
        g.addEventListener('pointermove', function(e){
          if(!active) return;
          dx += e.clientX - active.x;
          dy += e.clientY - active.y;
          active = { x: e.clientX, y: e.clientY };
          lobby.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        });
        g.addEventListener('pointerup', function(){ active = null; });
        g.addEventListener('pointercancel', function(){ active = null; });
        g.addEventListener('dblclick', function(e){ e.stopPropagation(); dock(); });
      });
    })();
  }

  window.PlatoonLobby = {
    __v2: true,
    get code(){ return S.code; },
    get mode(){ return S.mode; },
    isOnline: function(){ return S.online; },
    isHost: function(){ return isHostYou(); },
    newRoom: newRoom,
    joinRoom: joinRoom,
    getState: function(){
      return { code: S.code, mode: S.mode, vote: S.vote, lock: S.lock, online: S.online,
               host: isHostYou(), members: Object.keys(S.online ? S.members : { [S.youLocal.uid]: 1 }).length,
               results: !!S.results };
    }
  };

  let profileTimer = null;

  function boot(){
    wire();
    newRoom();
    /* Handle kept so it can be cleared. Every other timer in this file stores
       its id (levelTimer at the level countdown, counting at the match
       countdown) and clears it on cancel; this one did not, so it fired for
       the entire life of the page whether or not the player was in a platoon.
       Six background requests a minute forever, each one a chance to overlap a
       GC pause or a video decode. */
    profileTimer = setInterval(syncProfile, 10000);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
