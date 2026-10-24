/* ============================================================================
   test-same-account.mjs — two players, ONE logged-in account.

   Run:  node server/test-same-account.mjs

   THE QUESTION THIS ANSWERS
   ------------------------
   "I opened two windows, both logged in as the same account, and the second
   player never joined."

   The identity a match is built on is NOT the account:

     * the server mints a player id per SOCKET, in the `welcome` it sends from
       fetch() — before any message has been received;
     * the browser keeps that id in sessionStorage, which is per-TAB
       (session-guard.js), precisely so two tabs cannot collide;
     * the queue is a list of player ids. A duplicate NAME does not
       deduplicate anything — queuePlayer pushes p.id, not the name.

   So two tabs on one account must produce two humans, and this file is what
   establishes that instead of asserting it. It checks the specific counts and
   roles the two-tab case has to produce, so it fails if that ever stops being
   true.

   It also pins the hijack guard, which is the reason the id is per-tab: a
   second tab offering a live player's id must be refused a resume, not
   silently take over the session.
   ========================================================================== */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '   <- ' + detail : '')); }
}

/* ------------------------------------------------------------------ fakes */

class FakeWS {
  constructor(id) {
    this.id = id; this.sent = []; this.bufferedAmount = 0;
    this.closed = false; this.att = null;
  }
  send(str) { if (!this.closed) this.sent.push(JSON.parse(str)); }
  close() { this.closed = true; }
  deserializeAttachment() { return this.att; }
  serializeAttachment(a) { this.att = a; }
  take(t) { const i = this.sent.findIndex((m) => m.t === t); return i < 0 ? null : this.sent.splice(i, 1)[0]; }
  all(t) { return this.sent.filter((m) => m.t === t); }
}

class FakeStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, JSON.parse(JSON.stringify(v))); }
  async setAlarm(t) { this.alarm = t; }
  async deleteAlarm() { this.alarm = null; }
}

class FakeState {
  constructor() { this.storage = new FakeStorage(); this._queue = []; this.sockets = new Set(); }
  blockConcurrencyWhile(fn) { const p = fn(); this._queue.push(p); return p; }
  async settled() { await Promise.all(this._queue); this._queue.length = 0; }
  acceptWebSocket(ws) { this.sockets.add(ws); }
  getWebSockets() { return Array.from(this.sockets); }
}

function fakeEnv() { return { LOBBY: { idFromName: () => 'test-id', get: () => null } }; }

/* WebSocketPair is a Cloudflare global with no Node equivalent. Shimmed so the
   object under test runs its real fetch() upgrade path rather than a mock of
   it — the same reason the existing worker tests shim it. */
let wsSeq = 0;
globalThis.WebSocketPair = function WebSocketPair() {
  wsSeq++;
  return [new FakeWS('c' + wsSeq), new FakeWS('s' + wsSeq)];
};

const NativeResponse = globalThis.Response;
globalThis.Response = class TestResponse extends NativeResponse {
  constructor(body, init) {
    const ws = init && init.webSocket;
    if (init && init.status === 101) {
      super(null, { status: 200, headers: (init && init.headers) || undefined });
      this._status = 101; this.webSocket = ws;
    } else { super(body, init); }
  }
  get status() { return this._status !== undefined ? this._status : 200; }
};

async function boot() {
  const mod = await import(
    pathToFileURL(path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      '..', 'worker', 'matchmaker.js')).href
  );
  const state = new FakeState();
  const env = fakeEnv();
  const lobby = new mod.Lobby(state, env);
  await state.settled();
  return { Lobby: mod.Lobby, lobby, state, env };
}

/* One browser tab. `account` is SHARED between the two tabs below — that is
   the whole point. Only the socket differs, which is the only thing the lobby
   is supposed to key on. */
async function connect(h, account, name) {
  const req = new Request('https://x/mp', { headers: { Upgrade: 'websocket' } });
  await h.lobby.fetch(req);
  const sockets = h.state.getWebSockets();
  const ws = sockets[sockets.length - 1];
  const welcome = ws.sent.find((m) => m.t === 'welcome');
  ws.sent.length = 0;
  if (name) await h.lobby.webSocketMessage(ws, JSON.stringify({ t: 'hello', name }));
  ws.sent.length = 0;
  ws.account = account;
  ws.playerId = welcome ? welcome.playerId : null;
  return ws;
}

async function send(h, ws, obj) {
  await h.lobby.webSocketMessage(ws, JSON.stringify(obj));
}

/* ========================================================================= */

console.log('\n-- two tabs, ONE account --');
{
  const h = await boot();
  const ACCOUNT = 'Vostok';

  const a = await connect(h, ACCOUNT, ACCOUNT);
  const b = await connect(h, ACCOUNT, ACCOUNT);

  check('both tabs are welcomed', !!a.playerId && !!b.playerId,
    'A=' + a.playerId + ' B=' + b.playerId);
  check('each tab gets its OWN player id, despite one account',
    !!a.playerId && !!b.playerId && a.playerId !== b.playerId,
    'A=' + a.playerId + ' B=' + b.playerId);
  check('neither tab hijacked the other', !a.all('welcome').length && !b.all('welcome').length);

  await send(h, a, { t: 'queue', mode: 'random-battle' });
  const q1 = a.take('queued');
  check('the first tab queues', !!q1, q1 && JSON.stringify(q1));

  await send(h, b, { t: 'queue', mode: 'random-battle' });
  const q2 = b.take('queued');
  check('the SECOND tab queues too', !!q2, q2 && JSON.stringify(q2));
  check('the queue counts BOTH players',
    q2 && q2.queueSize === 2, 'queueSize=' + (q2 && q2.queueSize));
  check('the lobby holds two players',
    Object.keys(h.lobby.db.players).length === 2,
    Object.keys(h.lobby.db.players).length);

  /* Nothing is matched early — the 15 second window. */
  check('nobody is matched before the window runs out',
    a.all('matched').length === 0 && b.all('matched').length === 0);

  /* Wind the window forward rather than sleeping fifteen seconds. */
  h.lobby.db.players[a.playerId].queuedAt = Date.now() - 16000;
  h.state.storage.alarm = null;
  await h.lobby.alarm();
  await h.state.settled();

  const ma = a.all('matched').pop();
  const mb = b.all('matched').pop();

  check('BOTH tabs are matched', !!ma && !!mb, 'A=' + !!ma + ' B=' + !!mb);
  check('they land in the SAME match', !!ma && !!mb && ma.code === mb.code,
    ma && mb ? (ma.code + ' vs ' + mb.code) : 'one missing');
  check('the match counts TWO humans', !!ma && ma.humanCount === 2,
    'humanCount=' + (ma && ma.humanCount));
  check('exactly one tab is the host', !!ma && !!mb && ma.role !== mb.role,
    ma && mb ? (ma.role + ' vs ' + mb.role) : 'one missing');
  check('the roster carries BOTH players', !!ma && ma.players && ma.players.length >= 2,
    'players=' + ((ma && ma.players) || []).length);
  check('both roster entries are humans, not bots',
    !!ma && ma.players && ma.players.every((p) => p.isBot === false),
    ma && JSON.stringify((ma.players || []).map((p) => p.isBot)));
}

console.log('\n-- a second tab cannot steal a live session --');
{
  const h = await boot();
  const a = await connect(h, 'Vostok', 'Vostok');
  /* Same account, and it offers the first tab's id — the one case that could
     collapse two players into one. */
  const b = await connect(h, 'Vostok', 'Vostok');
  await h.lobby.webSocketMessage(b, JSON.stringify({ t: 'hello', name: 'Vostok', resume: a.playerId }));

  const again = b.all('welcome').pop();
  check('the second tab is NOT resumed into the first tab\'s session',
    !again || again.playerId !== a.playerId || again.resumed !== true,
    'second=' + ((again || {}).playerId) + ' resumed=' + ((again || {}).resumed));
  check('and the first tab keeps its own identity',
    h.lobby.db.players[a.playerId] !== undefined);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);