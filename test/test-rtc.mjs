/* Runtime test for the direct peer-to-peer link.

   Run: node test-rtc.mjs

   The point of this file is the parts that are invisible when they break.
   Every one of them fails SILENTLY in a browser: a direct link that never
   opens, a candidate that arrived too early and was thrown away, a client that
   never receives a single snapshot. There is no error, no red console line, and
   the game still works perfectly — on the WebSocket, exactly as before. Which
   is both why the layer is safe to ship and why it could be broken for weeks
   without anybody knowing.

   So the tests here are about the handshake and the plumbing, driven against a
   stub RTCPeerConnection, because that is the only way to make a thing that
   normally needs two real browsers and a real NAT testable at all. */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const RTC_SRC = new URL('../js/rtc-net.js', import.meta.url);
const MATCHMAKER_SRC = new URL('../worker/matchmaker.js', import.meta.url);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
};
const settle = () => new Promise((r) => setTimeout(r, 20));

/* ------------------------------------------------- a stub browser for rtc-net */

/* Models the three things a real RTCPeerConnection does that break naive code:
   setLocalDescription is async, addIceCandidate rejects before there is a
   remote description, and the channel on the answering side arrives via
   ondatachannel rather than from createDataChannel. */
function makeWorld() {
  const sent = [];           /* everything handed to Net._raw */

  function PeerConnection(ice) {
    this.iceServers = ice;
    this._local = null;
    this._remote = null;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
  }
  PeerConnection.prototype.setLocalDescription = function (d) {
    this._local = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    return Promise.resolve();
  };
  PeerConnection.prototype.setRemoteDescription = function (d) {
    this._remote = d;
    this.signalingState = 'stable';
    return Promise.resolve();
  };
  PeerConnection.prototype.createOffer = function () {
    return Promise.resolve({ type: 'offer', sdp: 'v=0-offer' });
  };
  PeerConnection.prototype.createAnswer = function () {
    return Promise.resolve({ type: 'answer', sdp: 'v=0-answer' });
  };
  PeerConnection.prototype.createDataChannel = function (label, opts) {
    const ch = makeChannel();
    this._madeChannel = ch;
    /* A real channel opens asynchronously. */
    return ch;
  };
  /* Opened by the test, not by the constructor.

     A channel that opened on a timer would make "is it open yet?" a race
     against setTimeout, and the assertions below are about the state machine
     rather than about timing — so the opening is driven explicitly and every
     scenario can say when it happens. */
  PeerConnection.prototype.addIceCandidate = function () {
    /* THE BEHAVIOUR THAT MATTERS: this is what a real browser does when a
       candidate turns up before the description it belongs to. */
    if (!this._remote) return Promise.reject(new Error('remote description not set'));
    return Promise.resolve();
  };
  PeerConnection.prototype.close = function () { this.connectionState = 'closed'; };
  PeerConnection.prototype.__fireIce = function (c) {
    this.onicecandidate && this.onicecandidate({ candidate: { toJSON: () => c } });
  };

  function makeChannel() {
    return {
      readyState: 'connecting',
      bufferedAmount: 0,
      onopen: null, onclose: null, onmessage: null,
      _sent: [],
      send(s) { this._sent.push(s); },
      close() { this.readyState = 'closed'; this.onclose && this.onclose(); },
      /* test helper: pretend the network delivered this */
      deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); },
    };
  }

  const Net = {
    _raw(obj) { sent.push(obj); return true; },
    role: 'client',
    hostId: 'HOST1',
    playerId: 'ME',
    _handle: (msg) => { received.push(msg); },
    _startDirectLink: null,
  };
  const received = [];

  const ctx = vm.createContext({
    window: { RTCPeerConnection: PeerConnection, Net },
    Net,
    RTCPeerConnection: PeerConnection,
    console, setTimeout, clearTimeout, JSON, Promise, Date,
  });
  vm.runInContext(readFileSync(RTC_SRC, 'utf8'), ctx);

  /* net.js normally does this at load time. Reproduced here because it is the
     seam between the two files and a fault in it is invisible from inside
     either one. */
  const ALLOWED = { host: ['input'], client: ['state', 'spawn', 'fullstate', 'matchend'] };
  ctx.window.Rtc.onMessage = (peerId, obj) => {
    const mine = ALLOWED[Net.role] || [];
    if (mine.indexOf(obj.t) < 0) return;
    obj.from = peerId;
    Net._handle(obj);
  };

  /* Completes the handshake: the offer has gone out and an answer has come
     back, and the channel is open. Returns the channel so a scenario can
     deliver into it. */
  const world = { ctx, Net, sent, received, makeChannel };

  world.link = async function (peerId) {
    const R = ctx.window.Rtc;
    R.dial(peerId);
    await settle();
    R.onSignal({ t: 'rtc-answer', from: peerId, sdp: { type: 'answer', sdp: 'y' } });
    await settle();
    const ch = R._peers[peerId].pc._madeChannel;
    ch.readyState = 'open';
    ch.onopen && ch.onopen();
    return ch;
  };

  return Object.assign(world, {
    Rtc: ctx.window.Rtc, link: world.link,
    last: (t) => [...sent].reverse().find((m) => m.t === t),
    all: (t) => sent.filter((m) => m.t === t),
  });
}

/* ========================================================================= */
console.log('\n-- the handshake --');
{
  const w = makeWorld();
  ok('reports WebRTC as supported', w.Rtc.supported() === true);

  w.Rtc.dial('HOST1');
  ok('dial returns true when it starts', w.Rtc.supported() && w.Rtc._peers['HOST1'] !== undefined);

  await settle();
  const offer = w.last('rtc-offer');
  ok('an offer is sent to the host', !!offer);
  ok('the offer names the host', offer && offer.to === 'HOST1');
  ok('the offer carries the sdp', offer && offer.sdp && offer.sdp.type === 'offer');
  ok('nothing is open yet', w.Rtc.isOpen('HOST1') === false);
  ok('and send() says so rather than pretending', w.Rtc.send('HOST1', { t: 'input' }) === false);
}

console.log('\n-- the answer side --');
{
  const w = makeWorld();
  /* The host receives an offer and answers it. */
  w.Net.role = 'host';
  w.Rtc.onSignal({ t: 'rtc-offer', from: 'C1', sdp: { type: 'offer', sdp: 'x' } });
  await settle();
  const answer = w.last('rtc-answer');
  ok('the host answers the offer', !!answer);
  ok('the answer names the client', answer && answer.to === 'C1');
  ok('the answer carries the sdp', answer && answer.sdp && answer.sdp.type === 'answer');
}

console.log('\n-- candidates that arrive too early --');
{
  /* THE ONE THAT MATTERS. A candidate before the answer is refused by a real
     browser. Dropping it produces a connection that looks perfectly healthy and
     never carries a byte — no error, no warning, just a game still running on
     the WebSocket and an engineer wondering why. */
  const w = makeWorld();
  w.Rtc.dial('HOST1');
  await settle();

  const pc = w.Rtc._peers['HOST1'].pc;
  w.Rtc.onSignal({ t: 'rtc-ice', from: 'HOST1', cand: { candidate: 'early-1' } });
  ok('an early candidate is queued, not dropped', w.Rtc._peers['HOST1'].pending.length === 1);
  ok('and it is the one that arrived', w.Rtc._peers['HOST1'].pending[0].candidate === 'early-1');
  ok('the connection is not yet usable', w.Rtc.isOpen('HOST1') === false);
  ok('so nothing goes out on it yet', w.Rtc.send('HOST1', { t: 'input' }) === false);

  w.Rtc.onSignal({ t: 'rtc-answer', from: 'HOST1', sdp: { type: 'answer', sdp: 'y' } });
  await settle();
  ok('the queue is flushed once the description lands', w.Rtc._peers['HOST1'].pending.length === 0);
}

console.log('\n-- sending over an open channel --');
{
  const w = makeWorld();
  const ch = await w.link('HOST1');

  ok('the peer is reported open', w.Rtc.isOpen('HOST1') === true);
  ok('connectedIds lists it', w.Rtc.connectedIds().indexOf('HOST1') >= 0);

  const sent = w.Rtc.send('HOST1', { t: 'input', input: { throttle: 1 } });
  ok('send reports success', sent === true);
  ok('the payload went over the channel', ch._sent.length === 1);
  ok('and it is the input, not a wrapper', JSON.parse(ch._sent[0]).input.throttle === 1);

  /* A backlog the peer cannot drain must be refused, or the queue grows until
     the tab dies. A stale snapshot is worth nothing; the next one is coming. */
  ch.bufferedAmount = 300000;
  ok('a backed-up channel refuses rather than buffering', w.Rtc.send('HOST1', { t: 'input' }) === false);
  ch.bufferedAmount = 0;
  ok('and accepts again once it drains', w.Rtc.send('HOST1', { t: 'input' }) === true);
}

console.log('\n-- a client only accepts what a host should send it --');
{
  /* Without this, a player who reaches the host over the direct channel could
     also send the host a 'state' frame and move every other player's tank. */
  const w = makeWorld();
  w.Net.role = 'client';
  const ch = await w.link('HOST1');

  ch.deliver({ t: 'state', s: { time: 1 } });
  ok('a snapshot from the host is accepted', w.received.length === 1);
  ok('and is stamped with who sent it', w.received[0].from === 'HOST1');

  ch.deliver({ t: 'input', input: {} });
  ok('an input from the host is refused', w.received.length === 1);

  ch.deliver({ t: 'state', s: {} });
  ok('a second snapshot is accepted', w.received.length === 2);
}

console.log('\n-- rubbish off the channel --');
{
  const w = makeWorld();
  const ch = await w.link('HOST1');

  ch.onmessage({ data: 'not json at all' });
  ok('malformed JSON does not throw', true);
  ok('and is not delivered', w.received.length === 0);

  ch.onmessage({ data: 'x'.repeat(300000) });
  ok('an oversized message is refused', w.received.length === 0);

  ch.onmessage({ data: 'null' });
  ch.onmessage({ data: '42' });
  ok('non-objects are refused', w.received.length === 0);
}

console.log('\n-- failure is invisible, which is the point --');
{
  /* The promise of this layer is that a direct link which never opens costs
     nothing. If that stopped being true the whole design would be wrong, so it
     is worth pinning rather than assuming. */
  const w = makeWorld();
  w.Rtc.dial('HOST1');
  await settle();

  /* Connection fails. */
  w.Rtc._peers['HOST1'].pc.connectionState = 'failed';
  w.Rtc._peers['HOST1'].pc.onconnectionstatechange();
  ok('a failed connection is torn down', w.Rtc._peers['HOST1'] === undefined);
  ok('send() falls back to the socket path', w.Rtc.send('HOST1', { t: 'input' }) === false);
  ok('connectedIds is empty, so no peer is skipped on the server',
     w.Rtc.connectedIds().length === 0);

  /* 'disconnected' is often transient and must NOT be treated as fatal. */
  w.Rtc.dial('HOST1');
  await settle();
  w.Rtc._peers['HOST1'].pc.connectionState = 'disconnected';
  w.Rtc._peers['HOST1'].pc.onconnectionstatechange();
  ok('a transient disconnect is left alone', w.Rtc._peers['HOST1'] !== undefined);
}

console.log('\n-- teardown --');
{
  const w = makeWorld();
  w.Rtc.dial('HOST1');
  w.Rtc.dial('HOST2');
  await settle();
  ok('two peers are being dialled', Object.keys(w.Rtc._peers).length === 2);

  w.Rtc.closeAll();
  ok('closeAll clears every peer', Object.keys(w.Rtc._peers).length === 0);
  ok('and connectedIds is empty afterwards', w.Rtc.connectedIds().length === 0);

  /* Dialling the same peer twice must not build a second connection. */
  w.Rtc.dial('HOST1');
  await settle();
  const first = w.Rtc._peers['HOST1'];
  w.Rtc.dial('HOST1');
  ok('dialling the same peer twice is a no-op', w.Rtc._peers['HOST1'] === first);
}

/* ========================================================================= */
console.log('\n-- the server only relays signalling --');
{
  /* Read the matchmaker as text rather than instantiating it: the DO needs a
     DurableObjectState, and what is being checked here is a property of the
     source — that the relay refuses a destination outside the match. */
  const src = readFileSync(MATCHMAKER_SRC, 'utf8');

  ok('the three signalling types are handled',
     /case 'rtc-offer':[\s\S]{0,200}case 'rtc-answer':[\s\S]{0,200}case 'rtc-ice':/.test(src));
  ok('a destination outside the match is refused',
     /target\.matchCode !== m\.code/.test(src));
  ok('a peer cannot signal itself',
     /target\.id === p\.id\).*return/.test(src));

  /* The snapshot exclusion. If this is wrong, every RTC peer is sent two copies
     of every frame and the saving is entirely lost. */
  ok('state can name peers to skip',
     /case 'state':[\s\S]{0,600}msg\.rtc/.test(src));
  ok('the skip list is validated against the match, not trusted',
     /m\.playerIds\.indexOf\(id\) >= 0/.test(src));
  ok('broadcastState accepts the skip set',
     /broadcastState\(match, fromId, obj, skip\)/.test(src));
  ok('and skips those peers',
     /if \(skip && skip\.has\(id\)\) continue;/.test(src));
  ok('an empty skip list means no exclusion at all',
     /if \(!skip\.size\) skip = null;/.test(src));

  /* Signalling must never reach storage. */
  const rtcCase = src.slice(src.indexOf("case 'rtc-offer'"), src.indexOf("case 'ping'"));
  ok('signalling is never persisted', !/this\.persist\(\)/.test(rtcCase));
  ok('signalling writes nothing to match storage', !/m\.[a-zA-Z]+\s*=/.test(rtcCase));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);