/* ============================================================
   platoon.js — Platoon v3: you and two friends.

   Three seats, one room code, ready up, the host starts. A small chat and
   voice chat run alongside. PeerJS carries everything: the host registers the
   room code as its peer id, friends connect to it, and the host relays chat,
   presence and voice levels. Voice is a direct WebRTC call from every member
   whose mic is on to every other member (at most six calls in a room of three).

   Client -> host : hello, ready, chat, lvl, mic
   Host -> client : st (room state), chat, lvl, mic, kick, close, full, lock,
                    cd, launch, res
   ============================================================ */
(function(){
  if(window.PlatoonLobby && window.PlatoonLobby.__v3) return;

  var PFX = (window.CONFIG && CONFIG.PEER_PREFIX) || 'tankparty-v1-';
  function roomPeerId(code){ return PFX + 'platoon-' + code; }
  var MAX = 3;
  var MODES = {
    gladiator:       'GLADIATOR',
    sandbox:         'SANDBOX',
    'platform-king': 'PLATFORM KING',
    custom:          'CUSTOM'
  };

  var $ = function(id){ return document.getElementById(id); };
  function el(tag, cls, txt){
    var n = document.createElement(tag);
    if(cls) n.className = cls;
    if(txt !== undefined) n.textContent = txt;
    return n;
  }
  function myUid(){
    try{
      var k = 'mtl_platoon_uid', v = sessionStorage.getItem(k);
      if(!v){ v = 'u' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem(k, v); }
      return v;
    }catch(e){ return 'u' + Math.random().toString(36).slice(2, 10); }
  }
  function myName(){
    try{
      var s = (window.Menu && Menu.settings) || {};
      return (s.playerClan ? '[' + s.playerClan + '] ' : '') + (s.playerName || 'Player');
    }catch(e){ return 'Player'; }
  }
  function peerOpts(){
    var h = location.hostname;
    var ice = (window.CONFIG && CONFIG.PEER_ICE) || [{ urls: 'stun:stun.l.google.com:19302' }];
    if(h === 'localhost' || h === '127.0.0.1'){
      return { debug: 0, host: h, port: location.port || 80, path: '/peerjs', secure: false, config: { iceServers: ice } };
    }
    return { debug: 0, config: { iceServers: ice } };
  }
  function toast(m){ if(window.Menu && Menu.toast) Menu.toast(m); }

  var S = {
    code: null, mode: 'gladiator', host: null, uid: myUid(),
    members: {},            /* uid -> {uid, name, ready, host, peerId, mic, conn} */
    online: false, peer: null, conn: null, retries: 0,
    lock: false, counting: null, chat: [], results: null,
    voice: {
      micOn: false, stream: null, ctx: null, analyser: null, timer: null,
      ptt: false, pttDown: false, deafen: false, master: 1, device: '',
      calls: {},            /* peerId -> outgoing call */
      audio: {},            /* peerId -> <audio> */
      vol: {},              /* uid -> 0..1.5 */
      muted: {},            /* uid -> bool */
      levels: {}            /* uid -> 0..1 */
    }
  };
  function me(){ return S.members[S.uid]; }
  function iAmHost(){ var m = me(); return !!(m && m.host); }
  function uidOfPeer(pid){ for(var u in S.members) if(S.members[u].peerId === pid) return u; return null; }

  function status(msg){ var s = $('pl-status'); if(s) s.textContent = msg || ''; }

  /* ================= rendering ================= */
  function render(){
    if(!$('pl-seats')) return;
    $('pl-room-code').textContent = S.code || '----';
    var list = Object.keys(S.members).map(function(k){ return S.members[k]; });
    list.sort(function(a, b){ return (b.host ? 1 : 0) - (a.host ? 1 : 0) || (a.uid === S.uid ? -1 : 1); });
    var seats = $('pl-seats');
    seats.innerHTML = '';
    for(var i = 0; i < MAX; i++){
      var m = list[i];
      var card = el('div', 'pt-seat' + (m ? '' : ' pt-empty') + (m && m.uid === S.uid ? ' pt-you' : '') + (m && m.ready ? ' pt-ready' : ''));
      if(!m){
        card.appendChild(el('div', 'pt-plus', '+'));
        card.appendChild(el('div', 'pt-seat-name', 'INVITE A FRIEND'));
        card.appendChild(el('div', 'pt-seat-sub', 'Share code ' + (S.code || '')));
        card.onclick = copyCode;
      } else {
        var av = el('div', 'pt-avatar');
        av.dataset.uid = m.uid;
        av.appendChild(el('div', 'pt-avatar-ico', '\u{1F6E1}'));
        card.appendChild(av);
        if(m.host) card.appendChild(el('div', 'pt-crown', '\u{1F451}'));
        card.appendChild(el('div', 'pt-seat-name', m.name + (m.uid === S.uid ? ' (you)' : '')));
        card.appendChild(el('div', 'pt-seat-sub', m.ready ? 'READY' : 'NOT READY'));
        var mic = el('div', 'pt-mic-state', m.mic ? '\u{1F3A4}' : '\u{1F507}');
        mic.title = m.mic ? 'Mic on' : 'Mic off';
        card.appendChild(mic);
        if(m.uid !== S.uid){
          var row = el('div', 'pt-seat-ctrl');
          var mute = el('button', 'pt-btn pt-sm ' + (S.voice.muted[m.uid] ? 'pt-btn-red' : 'pt-btn-gray'), S.voice.muted[m.uid] ? 'MUTED' : 'MUTE');
          mute.type = 'button';
          mute.onclick = (function(u){ return function(e){ e.stopPropagation(); S.voice.muted[u] = !S.voice.muted[u]; applyVolumes(); render(); }; })(m.uid);
          row.appendChild(mute);
          var vol = el('input', 'pt-range');
          vol.type = 'range'; vol.min = 0; vol.max = 150;
          vol.value = Math.round((S.voice.vol[m.uid] != null ? S.voice.vol[m.uid] : 1) * 100);
          vol.title = 'Volume';
          vol.oninput = (function(u){ return function(e){ S.voice.vol[u] = e.target.value / 100; applyVolumes(); }; })(m.uid);
          row.appendChild(vol);
          if(iAmHost()){
            var kick = el('button', 'pt-btn pt-sm pt-btn-red', 'KICK');
            kick.type = 'button';
            kick.onclick = (function(u){ return function(e){ e.stopPropagation(); hostKick(u); }; })(m.uid);
            row.appendChild(kick);
          }
          card.appendChild(row);
        }
      }
      seats.appendChild(card);
    }
    var you = me();
    var rb = $('pl-ready');
    rb.textContent = (you && you.ready) ? 'READY ✓' : 'READY';
    rb.classList.toggle('pt-btn-green', !!(you && you.ready));
    rb.classList.toggle('pt-btn-gray', !(you && you.ready));
    $('pl-start').style.display = iAmHost() ? '' : 'none';
    var sel = $('pl-mode');
    if(!sel.options.length){
      for(var k in MODES){ var o = el('option', '', MODES[k]); o.value = k; sel.appendChild(o); }
    }
    sel.value = S.mode;
    sel.disabled = !iAmHost() || S.lock;
    paintLevels();
  }

  function paintLevels(){
    var avs = document.querySelectorAll('#pl-seats .pt-avatar');
    for(var i = 0; i < avs.length; i++){
      var u = avs[i].dataset.uid;
      var lv = S.voice.levels[u] || 0;
      avs[i].classList.toggle('pt-talking', lv > 0.04);
      avs[i].style.setProperty('--lv', Math.min(1, lv * 6).toFixed(2));
    }
  }

  /* ================= chat ================= */
  function addChat(name, text, self){
    S.chat.push({ name: name, text: String(text).slice(0, 140), self: !!self });
    if(S.chat.length > 50) S.chat.shift();
    var list = $('pl-chat-list');
    if(!list) return;
    list.innerHTML = '';
    S.chat.forEach(function(c){
      var row = el('div', 'pt-chat-row' + (c.self ? ' pt-self' : ''));
      row.appendChild(el('b', '', c.name + ': '));
      row.appendChild(document.createTextNode(c.text));
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  }
  function sendChat(){
    var inp = $('pl-chat-input');
    var txt = inp.value.trim();
    if(!txt) return;
    inp.value = '';
    addChat(myName(), txt, true);
    if(!S.online) return;
    if(iAmHost()) broadcast({ t: 'chat', name: myName(), text: txt });
    else send({ t: 'chat', text: txt });
  }

  /* ================= voice ================= */
  function ensureCtx(){
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
      for(var i = 0; i < buf.length; i++){ var d = (buf[i] - 128) / 128; sum += d * d; }
      return Math.sqrt(sum / buf.length);
    }catch(e){ return 0; }
  }
  /* Push to talk mutes the outgoing track itself, so nothing is sent while
     the key is up, not just shown as quiet. */
  function applyPtt(){
    var v = S.voice;
    if(!v.stream) return;
    var live = !v.ptt || v.pttDown;
    v.stream.getAudioTracks().forEach(function(t){ t.enabled = live; });
  }
  function startMic(){
    var v = S.voice;
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ $('pl-mic-status').textContent = 'This browser has no microphone access.'; return; }
    var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if(v.device) audio.deviceId = { exact: v.device };
    navigator.mediaDevices.getUserMedia({ audio: audio }).then(function(stream){
      var ctx = ensureCtx();
      v.stream = stream; v.micOn = true;
      try{ ctx.createMediaStreamSource(stream).connect(v.analyser); ctx.resume(); }catch(e){}
      applyPtt();
      listDevices();
      v.timer = setInterval(function(){
        var lv = (v.ptt && !v.pttDown) ? 0 : micLevel();
        S.voice.levels[S.uid] = lv;
        var mt = $('pl-mic-meter'); if(mt) mt.style.width = Math.min(100, Math.round(lv * 600)) + '%';
        paintLevels();
        if(S.online){ if(iAmHost()) broadcast({ t: 'lvl', uid: S.uid, v: lv }); else send({ t: 'lvl', v: lv }); }
      }, 120);
      if(me()) me().mic = true;
      announceMic(true);
      callEveryone();
      micUi();
      render();
    }).catch(function(){
      $('pl-mic-status').textContent = 'Microphone blocked. Allow it in the browser to talk.';
    });
  }
  function stopMic(){
    var v = S.voice;
    if(v.timer){ clearInterval(v.timer); v.timer = null; }
    if(v.stream){ v.stream.getTracks().forEach(function(t){ t.stop(); }); v.stream = null; }
    for(var id in v.calls){ try{ v.calls[id].close(); }catch(e){} }
    v.calls = {};
    var was = v.micOn;
    v.micOn = false;
    S.voice.levels[S.uid] = 0;
    if(me()) me().mic = false;
    if(was) announceMic(false);
    micUi();
    render();
  }
  function micUi(){
    var v = S.voice, b = $('pl-mic');
    if(!b) return;
    b.innerHTML = v.micOn ? '\u{1F3A4} MIC ON' : '\u{1F3A4} MIC OFF';
    b.classList.toggle('pt-btn-green', v.micOn);
    b.classList.toggle('pt-btn-orange', !v.micOn);
    $('pl-mic-status').textContent = !v.micOn ? 'Voice is off. Turn your mic on to talk.'
      : (v.ptt ? 'Hold V to talk.' : 'Mic is live. Friends hear you.');
    var mt = $('pl-mic-meter'); if(mt && !v.micOn) mt.style.width = '0%';
  }
  function announceMic(on){
    if(!S.online) return;
    if(iAmHost()) broadcast({ t: 'mic', uid: S.uid, on: on, st: roomState() });
    else send({ t: 'mic', on: on });
  }
  function callEveryone(){
    var v = S.voice;
    if(!v.micOn || !v.stream || !S.peer || S.peer.destroyed) return;
    for(var u in S.members){
      var m = S.members[u];
      if(u === S.uid || !m.peerId || v.calls[m.peerId]) continue;
      try{
        var c = S.peer.call(m.peerId, v.stream);
        v.calls[m.peerId] = c;
        c.on('close', (function(p){ return function(){ delete v.calls[p]; }; })(m.peerId));
        c.on('error', (function(p){ return function(){ delete v.calls[p]; }; })(m.peerId));
      }catch(e){}
    }
  }
  /* Every incoming call is answered, mic or not: a friend talking should be
     heard even by someone who has not turned their own mic on. The answer
     carries no stream; our own voice goes out on our own calls. */
  function incomingCall(call){
    try{ call.answer(); }catch(e){ return; }
    call.on('stream', function(stream){
      var a = S.voice.audio[call.peer];
      if(!a){
        a = document.createElement('audio');
        a.autoplay = true; a.style.display = 'none';
        document.body.appendChild(a);
        S.voice.audio[call.peer] = a;
      }
      a.srcObject = stream;
      try{ var p = a.play(); if(p && p.catch) p.catch(function(){}); }catch(e){}
      applyVolumes();
    });
    call.on('close', function(){ dropAudio(call.peer); });
  }
  function dropAudio(pid){
    var a = S.voice.audio[pid];
    if(a){ try{ a.srcObject = null; a.remove(); }catch(e){} delete S.voice.audio[pid]; }
  }
  function applyVolumes(){
    var v = S.voice;
    for(var pid in v.audio){
      var u = uidOfPeer(pid);
      var vol = v.deafen || (u && v.muted[u]) ? 0 : v.master * (u && v.vol[u] != null ? v.vol[u] : 1);
      v.audio[pid].volume = Math.max(0, Math.min(1, vol));
    }
  }
  function listDevices(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function(ds){
      var sel = $('pl-mic-device');
      if(!sel) return;
      var cur = S.voice.device;
      sel.innerHTML = '';
      var d0 = el('option', '', 'Default'); d0.value = ''; sel.appendChild(d0);
      ds.filter(function(d){ return d.kind === 'audioinput'; }).forEach(function(d, i){
        var o = el('option', '', d.label || ('Microphone ' + (i + 1)));
        o.value = d.deviceId; sel.appendChild(o);
      });
      sel.value = cur;
    }).catch(function(){});
  }

  /* ================= network ================= */
  function send(msg){
    msg.uid = S.uid;
    if(S.conn && S.conn.open){ try{ S.conn.send(msg); }catch(e){} }
  }
  function broadcast(msg, except){
    for(var u in S.members){
      var m = S.members[u];
      if(u !== S.uid && u !== except && m.conn && m.conn.open){ try{ m.conn.send(msg); }catch(e){} }
    }
  }
  function roomState(){
    var members = {};
    for(var u in S.members){
      var m = S.members[u];
      members[u] = { uid: u, name: m.name, ready: m.ready, host: m.host, peerId: m.peerId, mic: !!m.mic };
    }
    return { code: S.code, mode: S.mode, lock: S.lock, host: S.host, members: members };
  }
  function applyRoom(r){
    S.code = r.code; S.mode = r.mode; S.lock = r.lock; S.host = r.host;
    var old = S.members;
    S.members = {};
    for(var u in r.members){
      var m = r.members[u];
      S.members[u] = { uid: u, name: m.name, ready: m.ready, host: m.host, peerId: m.peerId, mic: m.mic, conn: old[u] ? old[u].conn : null };
    }
    /* Anyone who left takes their audio with them. */
    for(var pid in S.voice.audio) if(!uidOfPeer(pid)) dropAudio(pid);
    callEveryone();
    render();
  }
  function pushState(){ broadcast({ t: 'st', room: roomState() }); render(); }

  function onHostMessage(msg){
    var m = S.members[msg.uid];
    if(!m) return;
    if(msg.t === 'ready'){ m.ready = !m.ready; pushState(); }
    else if(msg.t === 'chat'){
      addChat(m.name, msg.text, false);
      broadcast({ t: 'chat', name: m.name, text: msg.text }, msg.uid);
    }
    else if(msg.t === 'lvl'){
      S.voice.levels[msg.uid] = msg.v; paintLevels();
      broadcast({ t: 'lvl', uid: msg.uid, v: msg.v }, msg.uid);
    }
    else if(msg.t === 'mic'){
      m.mic = !!msg.on;
      if(msg.on) callEveryone();
      pushState();
    }
  }
  function onClientMessage(msg){
    if(msg.t === 'st') applyRoom(msg.room);
    else if(msg.t === 'chat') addChat(msg.name, msg.text, false);
    else if(msg.t === 'lvl'){ S.voice.levels[msg.uid] = msg.v; paintLevels(); }
    else if(msg.t === 'mic'){ if(msg.st) applyRoom(msg.st); if(msg.on) callEveryone(); }
    else if(msg.t === 'kick'){ toast('You were removed from the platoon'); newRoom(); }
    else if(msg.t === 'close'){ toast('The host closed the platoon'); newRoom(); }
    else if(msg.t === 'full'){ status('That platoon is full (3 players).'); newRoom(); }
    else if(msg.t === 'lock'){ S.lock = msg.on; if(!msg.on) hideCountdown(); render(); }
    else if(msg.t === 'cd') showCountdown(msg.n);
    else if(msg.t === 'launch') launchBattle(msg);
    else if(msg.t === 'res'){ S.results = msg.score; renderResults(); }
  }

  function host(code){
    teardown();
    S.code = code; S.host = S.uid; S.lock = false;
    S.members = {};
    S.members[S.uid] = { uid: S.uid, name: myName(), ready: false, host: true, peerId: null, mic: S.voice.micOn, conn: null };
    render();
    if(typeof Peer === 'undefined'){ status('Offline: voice and friends need an internet connection.'); return; }
    var p = new Peer(roomPeerId(code), peerOpts());
    S.peer = p;
    p.on('open', function(id){
      S.online = true; S.members[S.uid].peerId = id;
      status('Room ' + code + ' is open. Send the code to your friends.');
      render();
    });
    p.on('call', incomingCall);
    p.on('connection', function(conn){
      conn.on('data', function(msg){
        if(!msg || !msg.t) return;
        if(msg.t === 'hello'){
          if(!S.members[msg.uid] && Object.keys(S.members).length >= MAX){
            try{ conn.send({ t: 'full' }); }catch(e){}
            setTimeout(function(){ try{ conn.close(); }catch(e){} }, 300);
            return;
          }
          S.members[msg.uid] = { uid: msg.uid, name: String(msg.name || 'Player').slice(0, 24), ready: false, host: false, peerId: conn.peer, mic: false, conn: conn };
          status(S.members[msg.uid].name + ' joined');
          addChat('•', S.members[msg.uid].name + ' joined', false);
          pushState();
          callEveryone();
        } else if(msg.uid){
          onHostMessage(msg);
        }
      });
      conn.on('close', function(){
        for(var u in S.members){
          if(S.members[u].conn === conn){
            addChat('•', S.members[u].name + ' left', false);
            dropAudio(S.members[u].peerId);
            delete S.members[u];
            if(S.counting){ hideCountdown(); S.lock = false; broadcast({ t: 'lock', on: false }); }
            pushState();
            break;
          }
        }
      });
    });
    /* The signalling socket drops now and then; open calls and chats keep
       working without it. Reconnect a few times, then stop: with no server
       reachable at all (offline, or a local build) it would retry forever. */
    var tries = 0;
    p.on('open', function(){ tries = 0; });
    p.on('disconnected', function(){
      if(tries++ >= 4) return;
      setTimeout(function(){ if(S.peer === p && !p.destroyed){ try{ p.reconnect(); }catch(e){} } }, 1500 * tries);
    });
    p.on('error', function(err){
      if(err.type === 'unavailable-id'){ host(rndCode()); }
      else if(err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'){
        status('Cannot reach the voice server right now. Playing offline.');
        S.online = false;
      }
    });
  }

  function join(code){
    teardown();
    S.code = code; S.host = null; S.lock = false;
    S.members = {};
    S.members[S.uid] = { uid: S.uid, name: myName(), ready: false, host: false, peerId: null, mic: S.voice.micOn, conn: null };
    render();
    status('Joining ' + code + '...');
    if(typeof Peer === 'undefined'){ status('Offline: joining needs an internet connection.'); return; }
    var p = new Peer(peerOpts());
    S.peer = p;
    p.on('call', incomingCall);
    p.on('open', function(){
      var c = p.connect(roomPeerId(code), { reliable: true });
      S.conn = c;
      c.on('open', function(){
        S.online = true; S.retries = 0;
        c.send({ t: 'hello', uid: S.uid, name: myName() });
        status('Joined room ' + code + '.');
        if(S.voice.micOn) setTimeout(function(){ announceMic(true); }, 400);
      });
      c.on('data', function(msg){ if(msg && msg.t) onClientMessage(msg); });
      c.on('close', function(){
        if(!S.online) return;
        S.online = false;
        status('Lost the host. Trying again...');
        setTimeout(function(){ if(S.code === code && !S.online) join(code); }, 1500);
      });
    });
    p.on('error', function(err){
      if(err.type === 'peer-unavailable'){
        if(S.retries++ < 2){ setTimeout(function(){ if(S.code === code) join(code); }, 1500); }
        else { S.retries = 0; status('No room with code ' + code + '.'); toast('Room ' + code + ' not found'); newRoom(); }
      }
    });
  }

  function teardown(){
    hideCountdown();
    for(var pid in S.voice.calls){ try{ S.voice.calls[pid].close(); }catch(e){} }
    S.voice.calls = {};
    for(var a in S.voice.audio) dropAudio(a);
    if(S.peer && !S.peer.destroyed){ try{ S.peer.destroy(); }catch(e){} }
    S.peer = null; S.conn = null; S.online = false;
  }
  function rndCode(){
    var c = Math.random().toString(36).slice(2, 6).toUpperCase();
    return (c + 'XXXX').slice(0, 4);
  }
  function newRoom(){
    if(S.online && iAmHost()) broadcast({ t: 'close' });
    S.results = null;
    host(rndCode());
  }
  function hostKick(u){
    var m = S.members[u];
    if(!m || !iAmHost()) return;
    try{ m.conn && m.conn.send({ t: 'kick' }); }catch(e){}
    setTimeout(function(){ try{ m.conn && m.conn.close(); }catch(e){} }, 200);
    dropAudio(m.peerId);
    delete S.members[u];
    pushState();
  }
  function copyCode(){
    var code = S.code || '';
    var done = function(){ status('Code ' + code + ' copied.'); };
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
    else done();
  }

  /* ================= ready, countdown, launch ================= */
  function toggleReady(){
    var m = me(); if(!m) return;
    if(iAmHost() || !S.online){ m.ready = !m.ready; pushState(); }
    else send({ t: 'ready' });
  }
  function tryStart(){
    if(!iAmHost() || S.lock) return;
    var waiting = [];
    for(var u in S.members) if(!S.members[u].ready && u !== S.uid) waiting.push(S.members[u].name);
    if(waiting.length){ status('Waiting for ' + waiting.join(', ') + ' to be ready.'); return; }
    S.lock = true;
    broadcast({ t: 'lock', on: true });
    var n = 3, people = Object.keys(S.members).length;
    showCountdown(n); broadcast({ t: 'cd', n: n });
    render();
    S.counting = setInterval(function(){
      if(Object.keys(S.members).length < people){
        hideCountdown(); S.lock = false; broadcast({ t: 'lock', on: false });
        status('Someone left, start cancelled.'); render(); return;
      }
      n--;
      if(n <= 0){ hideCountdown(); doLaunch(); return; }
      showCountdown(n); broadcast({ t: 'cd', n: n });
    }, 1000);
  }
  function showCountdown(n){
    var ov = $('pl-cd'); if(!ov) return;
    ov.classList.remove('hidden');
    var t = ov.querySelector('.pt-cd-num');
    t.textContent = n;
    t.classList.remove('pt-pop'); void t.offsetWidth; t.classList.add('pt-pop');
  }
  function hideCountdown(){
    if(S.counting){ clearInterval(S.counting); S.counting = null; }
    var ov = $('pl-cd'); if(ov) ov.classList.add('hidden');
  }
  /* Voice stays on through the match: that is when a platoon talks most. */
  function doLaunch(){
    S.lock = false;
    broadcast({ t: 'launch', mode: S.mode, code: S.code });
    window.__PLATOON_BATTLE = { code: S.code, mode: S.mode, score: null, launchedAt: Date.now() };
    var G = window.__game || window.Game;
    if(G && G.startHost) G.startHost({ maxPlayers: 12, isPublic: false, fakePlayers: 0, code: S.code, gamemode: S.mode });
    else status('The game is still loading, try again in a moment.');
  }
  function launchBattle(msg){
    S.lock = false;
    window.__PLATOON_BATTLE = { code: msg.code || S.code, mode: msg.mode || S.mode, score: null, launchedAt: Date.now() };
    var G = window.__game || window.Game;
    if(G && G.startClient) G.startClient(msg.code || S.code);
  }
  function onLobbyShow(){
    /* The room opens the first time the screen is shown, not at page load:
       nobody holds a peer open for a platoon they never visited. */
    if(!S.code){ newRoom(); return; }
    var mine = me(); if(mine && mine.name !== myName()){ mine.name = myName(); if(iAmHost()) pushState(); }
    var b = window.__PLATOON_BATTLE;
    if(!b) return;
    if(iAmHost() && b.score && b.score.length){ S.results = b.score; broadcast({ t: 'res', score: S.results }); }
    var m = me(); if(m) m.ready = false;
    if(iAmHost()) pushState();
    window.__PLATOON_BATTLE = null;
    renderResults();
    render();
  }
  function renderResults(){
    var box = $('pl-results'); if(!box) return;
    if(!S.results || !S.results.length){ box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var list = $('pl-results-list'); list.innerHTML = '';
    S.results.slice().sort(function(a, b){ return (b.kills || 0) - (a.kills || 0); }).slice(0, 6).forEach(function(r, i){
      var row = el('div', 'pt-rrow' + (i === 0 ? ' pt-mvp' : ''));
      row.appendChild(el('b', '', (i === 0 ? '★ ' : '') + (r.name || '?')));
      row.appendChild(el('span', '', (r.kills || 0) + ' K  ·  ' + (r.dd || 0) + ' DMG'));
      list.appendChild(row);
    });
  }

  /* ================= wiring ================= */
  function wire(){
    if(!$('pl-seats')) return false;
    $('pl-back').onclick = function(){ if(window.Menu){ Menu._platoonReturn = false; Menu.show('menu-main'); } };
    $('pl-copy').onclick = copyCode;
    $('pl-new').onclick = newRoom;
    $('pl-join').onclick = function(){
      var v = $('pl-join-code').value.trim().toUpperCase();
      if(v.length !== 4){ status('A room code has 4 letters or numbers.'); return; }
      if(v === S.code){ status('That is your own room.'); return; }
      join(v);
    };
    $('pl-join-code').oninput = function(e){ e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); };
    $('pl-join-code').onkeydown = function(e){ if(e.key === 'Enter') $('pl-join').click(); };
    $('pl-ready').onclick = toggleReady;
    $('pl-start').onclick = tryStart;
    $('pl-mode').onchange = function(){ if(!iAmHost()) return; S.mode = this.value; pushState(); };
    $('pl-mic').onclick = function(){ if(S.voice.micOn) stopMic(); else startMic(); };
    $('pl-deafen').onclick = function(){
      S.voice.deafen = !S.voice.deafen;
      this.innerHTML = S.voice.deafen ? '\u{1F507} SOUND OFF' : '\u{1F508} SOUND ON';
      this.classList.toggle('pt-btn-red', S.voice.deafen);
      applyVolumes();
    };
    $('pl-ptt').onchange = function(){ S.voice.ptt = this.checked; applyPtt(); micUi(); };
    $('pl-mic-device').onchange = function(){ S.voice.device = this.value; if(S.voice.micOn){ stopMic(); startMic(); } };
    $('pl-master-vol').oninput = function(){ S.voice.master = this.value / 100; applyVolumes(); };
    $('pl-chat-send').onclick = sendChat;
    $('pl-chat-input').onkeydown = function(e){ e.stopPropagation(); if(e.key === 'Enter') sendChat(); };
    /* Hold V to talk, in the lobby and in battle. Not while typing. */
    window.addEventListener('keydown', function(e){
      if(e.code !== 'KeyV' || !S.voice.ptt || e.repeat) return;
      var t = e.target; if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      S.voice.pttDown = true; applyPtt();
    });
    window.addEventListener('keyup', function(e){ if(e.code === 'KeyV' && S.voice.pttDown){ S.voice.pttDown = false; applyPtt(); } });
    window.addEventListener('blur', function(){ if(S.voice.pttDown){ S.voice.pttDown = false; applyPtt(); } });
    if(window.Menu && Menu.show){
      var show = Menu.show.bind(Menu);
      Menu.show = function(id){ var r = show(id); if(id === 'menu-platoon') onLobbyShow(); return r; };
    }
    return true;
  }

  window.PlatoonLobby = {
    __v3: true, __v2: true,
    get code(){ return S.code; },
    get mode(){ return S.mode; },
    isOnline: function(){ return S.online; },
    isHost: function(){ return iAmHost(); },
    newRoom: newRoom,
    joinRoom: join,
    getState: function(){
      return { code: S.code, mode: S.mode, lock: S.lock, online: S.online, host: iAmHost(),
               members: Object.keys(S.members).length, mic: S.voice.micOn, results: !!S.results };
    },
    _debug: function(){ return S; }
  };

  function boot(){
    if(!wire()) return;
    var scr = $('menu-platoon');
    if(scr && !scr.classList.contains('hidden')) onLobbyShow();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
