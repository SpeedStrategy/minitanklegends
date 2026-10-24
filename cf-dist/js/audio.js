const Audio = {
  _ctx: null,
  _musicNodes: {},
  _currentMusic: null,
  _currentSrc: null,
  _volume: 0.3,
  _musicVolume: 0.25,
  _muted: false,
  _clickBuffers: {},
  /* Reported-once ledger for audio files the deployment does not actually
     carry. The music files referenced by menu.js are absent on the server, and
     the same missing file is requested again every time its menu is opened —
     without the ledger that was one console warning per menu, per session. */
  _missingReported: {},

  init(){
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e){ return; }
    this._volume = parseFloat(localStorage.getItem('audio_volume') || '0.3');
    this._musicVolume = parseFloat(localStorage.getItem('audio_musicVolume') || '0.25');
    this._muted = localStorage.getItem('audio_muted') === '1';
    this._loadClick('default', 'assets/click.wav');
    this._loadClick('gun', 'assets/sounds/gunshot.mp3');
    this._loadClick('ui', 'assets/ui_click.wav');
  },

  _loadClick(name, url){
    if(!this._ctx) return;
    Audio._decode(this._ctx, url).then(ab => {
      if(ab) this._clickBuffers[name] = ab;
    }).catch(()=>{});
  },

  click(name, vol){
    if(!this._ctx || this._muted || !this._clickBuffers[name]) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const src = this._ctx.createBufferSource();
    src.buffer = this._clickBuffers[name];
    const g = this._ctx.createGain();
    g.gain.value = this._volume * (vol == null ? 1 : vol);
    src.connect(g).connect(this._ctx.destination);
    src.start(0);
  },

  uiClick(){
    if(!this._ctx || this._muted) return;
    this.click('ui', 2.0);
  },

  // Short ticking sound for countdown timer
  tick(){
    if(!this._ctx || this._muted) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const t = this._ctx.currentTime;
    const osc = this._ctx.createOscillator();
    const gain = this._ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.05);
    gain.gain.setValueAtTime(this._volume * 0.6, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(this._ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  },

  hookButtons(){
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn, button, [role="button"], input[type="submit"], .tab-btn, .box-open-btn');
      if(btn) this.uiClick();
    }, true);
  },

  // Procedural flamethrower whoosh (no asset needed): filtered-noise burst
  flame(vol){
    if(!this._ctx || this._muted) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const t = this._ctx.currentTime;
    const dur = 0.32 + Math.random() * 0.18;
    if(!this._flameNoise){
      const len = Math.floor(this._ctx.sampleRate * 2);
      const buf = this._ctx.createBuffer(1, len, this._ctx.sampleRate);
      const d = buf.getChannelData(0);
      for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._flameNoise = buf;
    }
    const src = this._ctx.createBufferSource();
    src.buffer = this._flameNoise;
    const bp = this._ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.5;
    bp.frequency.setValueAtTime(450 + Math.random() * 250, t);
    bp.frequency.exponentialRampToValueAtTime(950 + Math.random() * 450, t + dur);
    const lp = this._ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = this._ctx.createGain();
    const v = this._volume * (vol == null ? 1 : vol) * 0.75;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, v), t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(lp).connect(g).connect(this._ctx.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
  },

  /* -----------------------------------------------------------------------
     RICOCHET — the metal ping when a shell bounces off armor.

     Fully procedural (same reasoning as flame(): a bounce sound that must
     exist on every deploy cannot depend on an asset that may 404). Three
     layers, because one layer is a beep:

       * three INHARMONIC sine partials (not 1x/2x/3x — that is a bell, a
         3x-linked set is a string; metal plates ring at 1 / ~2.7 / ~4.9),
         each decaying at its own rate — that is what makes it a clang and
         not a note;
       * a high-passed NOISE SLAP as the strike transient, so there is an
         "attack" before the ring;
       * the pitch is randomised per bounce, so ricochets never sound like a
         sample stuck on the same note twenty times in a match. */
  ricochet(vol){
    if(!this._ctx || this._muted) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const ctx = this._ctx;
    const t = ctx.currentTime + 0.005;
    const v = this._volume * (vol == null ? 1 : vol);
    const base = 620 + Math.random() * 480;
    const partials = [1, 2.71, 4.9];
    const gains = [1, 0.42, 0.22];
    const decays = [1, 0.8, 0.6];
    const dur = 0.20 + Math.random() * 0.16;
    for(let i = 0; i < partials.length; i++){
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * partials[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0002, v * gains[i]), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * decays[i]);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    if(!this._bounceNoise){
      const len = Math.floor(ctx.sampleRate * 0.25);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for(let i = 0; i < len; i++){
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
      this._bounceNoise = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._bounceNoise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1900;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(Math.max(0.0002, v * 0.55), t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    src.connect(hp).connect(g2).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.08);
  },

  /* -----------------------------------------------------------------------
     WALL IMPACT — the dull knock of a shell dying in a wall.

     The armor ping above is a RING; a shot into concrete is a THUD with a
     short bright tick. Low muffle, fast decay, no repetition: three low
     partials die before the eye finishes noticing. */
  wallClang(vol){
    if(!this._ctx || this._muted) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const ctx = this._ctx;
    const t = ctx.currentTime + 0.005;
    const v = this._volume * (vol == null ? 1 : vol) * 0.8;
    const partials = [162 + Math.random() * 60, 407, 753];
    for(let i = 0; i < partials.length; i++){
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.frequency.value = partials[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0002, v * [1, 0.5, 0.26][i]), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (0.11 + i * 0.03));
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.2);
    }
  },

  /* -----------------------------------------------------------------------
     ARMOR HIT — the sound of a tank TAKING damage (not a bounce: the shell
     goes in).

     Three layers again, tuned "heavy":

       * a sub THUD (150 -> 52 Hz sweep): chassis displacement, the part you
         hear in your chest;
       * a band-passed NOISE CRUNCH around 200-900 Hz: metal crushing, the
         "chunk" of the shell biting;
       * a short mid RING (~300 Hz, quiet): the after-cold of a struck plate.

     `heavy` (0..1) is the damage fraction, which pushes the thud louder and
     the sweep lower - big damage sounds BIGGER than chip damage. */
  armorHit(vol, heavy){
    if(!this._ctx || this._muted) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const ctx = this._ctx;
    const t = ctx.currentTime + 0.005;
    const hv = (heavy == null ? 0.5 : Math.max(0, Math.min(1, heavy)));
    const v = this._volume * (vol == null ? 1 : vol);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 150 - hv * 40;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f0 * 0.34), t + 0.17);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, v * (0.55 + hv * 0.45)), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.3);
    if(!this._crunchNoise){
      const len = Math.floor(ctx.sampleRate * 0.4);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._crunchNoise = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._crunchNoise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.6;
    bp.frequency.setValueAtTime(780 - hv * 260, t);
    bp.frequency.exponentialRampToValueAtTime(210, t + 0.16);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(Math.max(0.0002, v * (0.5 + hv * 0.4)), t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(bp).connect(g2).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.25);
    const o3 = ctx.createOscillator();
    o3.type = 'triangle';
    o3.frequency.value = 300 + Math.random() * 110;
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(Math.max(0.0002, v * 0.22), t);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o3.connect(g3).connect(ctx.destination);
    o3.start(t);
    o3.stop(t + 0.16);
  },

  /* -----------------------------------------------------------------------
     END OF BATTLE — the stinger under the closing cinematic.

     Fully procedural, on the same reasoning as `flame()` above: an end-of-match
     sting is one sound that must be correct on every match, and it cannot be
     made correct by shipping an asset that may 404 on a fresh deploy.

     Three layers, because one layer is a beep and two is a chord but neither is
     an ending:

       * a sub DROP (90Hz -> 38Hz over 0.9s) for the world losing momentum;
       * a filtered noise SWELL for air moving past the camera as it swings
         around the tank;
       * a three-note TONE, major on a win and minor falling on a loss.

     `kind` is 'win' | 'loss' | 'skip'. Skip is a bare fifth with no third,
     because "BATTLE ENDED" is nobody's victory and giving it one of the other
     two resolutions would say something untrue about the match. */
  endStinger(kind){
    if(!this._ctx || this._muted) return;
    if(this._ctx.state === 'suspended') this._ctx.resume();
    const ctx = this._ctx;
    const t = ctx.currentTime + 0.01;
    const vol = this._volume;
    const win  = (kind === 'win');

    /* --- sub drop --------------------------------------------------------- */
    const sub = ctx.createOscillator();
    const subG = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(90, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.9);
    subG.gain.setValueAtTime(0.0001, t);
    subG.gain.exponentialRampToValueAtTime(Math.max(0.001, vol * 0.9), t + 0.05);
    subG.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    sub.connect(subG).connect(ctx.destination);
    sub.start(t); sub.stop(t + 1.5);

    /* --- noise swell ------------------------------------------------------ */
    if(!this._stingerNoise){
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._stingerNoise = buf;
    }
    const nz = ctx.createBufferSource();
    nz.buffer = this._stingerNoise;
    nz.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + 0.75);
    bp.frequency.exponentialRampToValueAtTime(420, t + 1.5);
    const nzG = ctx.createGain();
    nzG.gain.setValueAtTime(0.0001, t);
    nzG.gain.exponentialRampToValueAtTime(Math.max(0.001, vol * 0.30), t + 0.30);
    nzG.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    nz.connect(bp).connect(nzG).connect(ctx.destination);
    nz.start(t); nz.stop(t + 1.55);

    /* --- the chord -------------------------------------------------------- */
    /* A5 minor for a loss (A, C, E), C major for a win (C, E, G). The third is
       what actually decides whether it reads as a triumph or a funeral; there is
       no neutral option, which is why 'skip' omits the note entirely and gets a
       root/fifth/octave. */
    const notes = (kind === 'skip') ? [196.00, 293.66, 392.00]
                : win          ? [261.63, 329.63, 392.00, 523.25]
                               : [220.00, 261.63, 329.63];
    notes.forEach((f, i) => {
      const at = t + i * 0.055;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = win || kind === 'skip' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f, at);
      /* The loss falls. A held minor chord reads as a menu; a falling one reads
         as the last note of something. */
      if(!win && kind !== 'skip'){
        o.frequency.setValueAtTime(f, at);
        o.frequency.exponentialRampToValueAtTime(f * 0.94, at + 2.2);
      }
      const peak = vol * 0.34 * (i === 0 ? 1 : 0.72);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), at + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, at + (win || kind === 'skip' ? 2.4 : 3.0));
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + (win || kind === 'skip' ? 2.5 : 3.1));
    });
  },

  /* -----------------------------------------------------------------------
     Fetch and decode an audio file, safely.

     Two real bugs used to live at every call site:

     1. A missing file returns the server's 404 page, and `r.arrayBuffer()`
        SUCCEEDS on that -- the HTML body comes back happily and the `.catch()`
        never fires. The HTML was then handed straight to decodeAudioData, which
        failed with "Unable to decode audio data".

     2. decodeAudioData both takes an error callback AND returns a promise. In
        every current browser the promise rejects regardless of the callback, and
        nothing was attached to it -- so every failure surfaced as an
        UNHANDLED REJECTION in the console, several times a minute, for the
        whole life of the page.

     Three music tracks referenced by menu.js do not exist on disk
     (assets/menu.mp3, assets/shop/shop.mp3, assets/1.mp3), so this fired every
     time the menu, the store or the shop was opened. A missing music track is
     not a reason to spam the console or to leave a rejected promise dangling,
     so it is now simply reported once and skipped.
     Returns null on any failure. */
  async _decode(ctx, url){
    let res;
    try {
      res = await fetch(url);
    } catch(e){
      return null;                      // offline / DNS / connection refused
    }
    const reportMissing = (why) => {
      if(this._missingReported[url]) return;
      this._missingReported[url] = true;
      console.warn('[audio] missing or unreadable:', url, why);
    };
    if(!res.ok){
      reportMissing('(HTTP ' + res.status + ')');
      return null;                      // 404 body is HTML, not audio
    }
    /* A 200 is NOT proof of an audio file. This server answers a missing path
       with the full HTML page and a 200, which used to waltz straight into
       decodeAudioData and fail with "unknown content type" — readable, but
       useless and repeated every time. The content type is authoritative about
       what arrived; audio served as octet-stream still passes, HTML does not. */
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if(ct.indexOf('text/html') === 0){
      reportMissing('(the server sent an HTML page — the file does not exist in this deployment)');
      return null;
    }
    let buf;
    try { buf = await res.arrayBuffer(); } catch(e){ return null; }
    try {
      return await ctx.decodeAudioData(buf);
    } catch(e){
      /* decodeAudioData in every current browser rejects cleanly; reporting it
         once per URL keeps a corrupt file from spamming the console. */
      reportMissing('(could not decode: ' + (e && e.message) + ')');
      return null;
    }
  },

  playMusic(src, loop=true){
    if(!this._ctx) return;
    if(this._currentSrc === src) return;
    if(this._currentMusic){
      try { this._currentMusic.stop(); } catch(e){}
      this._currentMusic = null;
      this._currentSrc = null;
    }
    if(this._muted) return;
    const self = this;
    Audio._decode(this._ctx, src).then(ab => {
      /* Re-checked: the player may have switched tracks, muted or left the menu
         while the fetch was in flight, and starting a stale track now would
         leave music playing over the battle. */
      if(!ab || self._muted || self._currentSrc === src) return;
      if(self._currentMusic){
        try { self._currentMusic.stop(); } catch(e){}
        self._currentMusic = null;
      }
      const srcNode = self._ctx.createBufferSource();
      srcNode.buffer = ab;
      srcNode.loop = loop;
      const g = self._ctx.createGain();
      g.gain.value = self._musicVolume;
      srcNode.connect(g).connect(self._ctx.destination);
      srcNode.start(0);
      self._currentMusic = srcNode;
      self._currentSrc = src;
    }).catch(()=>{});
  },

  stopMusic(){
    if(this._currentMusic){
      try { this._currentMusic.stop(); } catch(e){}
      this._currentMusic = null;
      this._currentSrc = null;
    }
  },

  setVolume(v){
    this._volume = Math.max(0, Math.min(1, v));
    localStorage.setItem('audio_volume', this._volume);
  },

  setMusicVolume(v){
    this._musicVolume = Math.max(0, Math.min(1, v));
    localStorage.setItem('audio_musicVolume', this._musicVolume);
  },

  setMuted(m){
    this._muted = m;
    localStorage.setItem('audio_muted', m ? '1' : '0');
    if(m) this.stopMusic();
  },

  toggleMute(){
    this.setMuted(!this._muted);
    return this._muted;
  },

  isMuted(){ return this._muted; },
  getVolume(){ return this._volume; },
  getMusicVolume(){ return this._musicVolume; },
};
