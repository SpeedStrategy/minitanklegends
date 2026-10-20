/* ============================================================
   nakama-net.js — Nakama game backend integration.
   Handles auth, real-time multiplayer, cloud storage.
   ============================================================ */

const NakamaNet = {
  client: null,
  session: null,
  socket: null,
  _socketConnected: false,
  /* Match messages travel by OPCODE. nakama-js dropped the "send any object"
      shape years ago: sendMatchState() is (matchId, opCode, Uint8Array). Every
      kind of message we send gets a number, and the receiving side decodes the
      bytes back to the same object it always was. The numbers are ours to
      choose — anything but 0 (reserved by the server for internal use). */
  OP: { join: 1, input: 2, state: 3, spawn: 4, new_host: 5 },

  onPlayerJoin: null,
  onPlayerLeave: null,
  onInput: null,
  onState: null,
  onWelcome: null,
  onHostChange: null,
  worldMatchId: 'fr-' + CONFIG.NAKAMA.SERVER_KEY, // persistent world match name

  /* ---------- Init ---------- */
  /* True when the SDK is actually on the page.

     The bundle is loaded from a CDN and that URL currently returns 404, so
     `nakamajs` genuinely does not exist at runtime. Calling `new` on an
     undefined global throws a ReferenceError naming a variable the player has
     never heard of, which is a terrible thing to show somebody who clicked a
     button. game.js checks before it gets here; this is the backstop for a
     caller that forgets. */
  available(){
    return typeof nakamajs !== 'undefined';
  },
  init(){
    if(!this.available()) return false;
    const cfg = CONFIG.NAKAMA;
    /* useSSL goes in the CONSTRUCTOR now, not as a follow-on property: the
       Client builds its baseURL from useSSL when it is constructed, so a later
       assignment would leave it talking plain http to an SSL endpoint. */
    this.client = new nakamajs.Client(cfg.SERVER_KEY, cfg.HOST, cfg.PORT, cfg.USE_SSL);
    return true;
  },

  /* ---------- Auth ---------- */
  async authenticateEmail(email, password){
    if(!this.client) this.init();
    this.session = await this.client.authenticateEmail({ email, password });
    return this.session;
  },

  async registerEmail(email, password){
    if(!this.client) this.init();
    this.session = await this.client.authenticateEmail({ email, password, create: true });
    return this.session;
  },

  async authenticateDevice(deviceId){
    if(!this.client) this.init();
    this.session = await this.client.authenticateDevice({ id: deviceId });
    return this.session;
  },

  get userId(){ return this.session ? this.session.user_id : null; },
  get username(){ return this.session ? this.session.username : null; },
  get isAuthenticated(){ return !!this.session; },

  /* ---------- Socket ---------- */
  async connectSocket(){
    if(!this.session) throw new Error('Not authenticated');
    const cfg = CONFIG.NAKAMA;
    this.socket = this.client.createSocket(cfg.USE_SSL, false);
    /* nakama-js no longer exposes an isConnected flag, so keep our own;
       ondisconnect is the one official signal of a broken socket. */
    this.socket.ondisconnect = () => { this._socketConnected = false; };
    await this.socket.connect(this.session);
    this._socketConnected = true;
  },

  disconnectSocket(){
    if(this.socket){
      try{ this.socket.disconnect(); }catch(e){}
      this.socket = null;
      this._socketConnected = false;
    }
  },

  /* ---------- Multiplayer (client-relayed) ---------- */
  get isConnected(){ return !!this.socket && this._socketConnected; },

  async createMatch(name){
    if(!this.socket) await this.connectSocket();
    const match = await this.socket.createMatch(name);
    this.currentMatch = match;
    this.matchId = match.id;
    this.isHost = true;
    this._wireMatch();
    return match;
  },

  async joinMatch(matchId){
    if(!this.socket) await this.connectSocket();
    const match = await this.socket.joinMatch(matchId);
    this.currentMatch = match;
    this.matchId = matchId;
    this.isHost = false;
    this._wireMatch();
    return match;
  },

  async joinOrCreateWorld(){
    if(!this.socket) await this.connectSocket();
    // Try to join existing persistent world match via cloud storage
    const worldId = await this.storageRead('world', 'match_id');
    if(worldId){
      try {
        const match = await this.socket.joinMatch(worldId);
        this.currentMatch = match;
        this.matchId = match.id;
        this.isHost = false;
        this._wireMatch();
        return match;
      } catch(e) {
        // Match stale or gone — will create new one below
      }
    }
    // Create new match as world host
    const match = await this.socket.createMatch();
    this.currentMatch = match;
    this.matchId = match.id;
    this.isHost = true;
    await this.storageWrite('world', 'match_id', match.id);
    this._wireMatch();
    return match;
  },

  async leaveMatch(){
    if(this.currentMatch && this.socket){
      try{ this.socket.leaveMatch(this.currentMatch.id); }catch(e){}
    }
    this.currentMatch = null;
    this.matchId = null;
    this.isHost = false;
  },

  _wireMatch(){
    if(!this.currentMatch) return;
    /* Match data arrives as { opCode, data: Uint8Array, ... }. The op code
       names the kind of message and the bytes are the old payload back again. */
    this.currentMatch.onmatchdata = (result) => {
      if(result instanceof Array || !('op_code' in result)) return;
      const payload = this._decodeMatchData(result);
      if(!payload) return;
      const sender = result.user_id || (result.presence && (result.presence.user_id || result.presence.userId)) || null;
      if(payload.t === 'join' && this.onPlayerJoin){
        this.onPlayerJoin({ peerId: sender, name: payload.name, tank: payload.tank, color: payload.color });
      }
      if(payload.t === 'input' && this.onInput){
        this.onInput(sender, payload.input);
      }
      if(payload.t === 'state' && this.onState){
        this.onState(payload.s);
      }
      if(payload.t === 'spawn' && this.onWelcome){
        this.onWelcome(payload);
      }
      if(payload.t === 'new_host' && this.onHostChange){
        this.onHostChange(payload.hostId);
      }
    };
    this.currentMatch.onmatchpresence = (result) => {
      (result.leaves || []).forEach(p => {
        if(this.onPlayerLeave) this.onPlayerLeave(p.user_id || p.userId);
      });
    };
  },

  /* Bytes in -> the object that went out. TextEncoder/TextDecoder are provided
     by every browser that has WebRTC, so no polyfill is needed here. */
  _encodeMatchData(payload){
    try { return new TextEncoder().encode(JSON.stringify(payload)); }
    catch(e){ return null; }
  },
  _decodeMatchData(result){
    try {
      const bytes = result.data instanceof Uint8Array ? result.data : null;
      if(bytes && bytes.length) return JSON.parse(new TextDecoder().decode(bytes));
    } catch(e){}
    return null;
  },

  sendMatchData(data){
    if(!this.currentMatch || !this.socket || !this.isConnected) return;
    /* opCode selects the message kind; the payload is the bytes carrying it.
       (nakama-js 2.x: sendMatchState(matchId, opCode, Uint8Array) — the old
       two-argument sendMatchData() call never existed on this version and was
       failing groundlessly.) */
    try{
      const code = (typeof data.t === 'string' && this.OP[data.t]) || 219;
      const bytes = this._encodeMatchData(data);
      if(bytes) this.socket.sendMatchState(this.currentMatch.id, code, bytes);
    }catch(e){}
  },

  /* ---------- Cloud storage ---------- */
  async storageWrite(collection, key, value){
    if(!this.session) throw new Error('Not authenticated');
    const objects = [{ collection, key, value }];
    await this.client.writeStorageObjects(this.session, objects);
  },

  async storageRead(collection, key){
    if(!this.session) return null;
    try {
      const objects = await this.client.readStorageObjects(this.session, { collection, key });
      return objects.length ? objects[0].value : null;
    } catch(e) { return null; }
  },

  /* ---------- Disconnect ---------- */
  async disconnect(){
    await this.leaveMatch();
    this.disconnectSocket();
    this.session = null;
  },
};
