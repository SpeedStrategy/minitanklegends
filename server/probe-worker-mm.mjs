/* probe-worker-mm.mjs — two raw sockets into the DEPLOYED matchmaker worker.
   Run: node server/probe-worker-mm.mjs
   Purpose: answer, without any game code in the loop, whether the deployed
   Lobby pairs two humans who queue within the same window into ONE match
   (A host, B client), or hands each player a private room as host.
   Logs every message with a wall-clock stamp. Exits after 75 s. */

const URL = 'wss://tanklg.nojus-t.workers.dev/mp';
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);

function sock(label) {
  const ws = new WebSocket(URL);
  const log = (...a) => console.log(`[${stamp()}] ${label}`, ...a);
  ws.onopen = () => log('open');
  ws.onclose = (e) => { log('close code=' + e && e.code); process.exitCode = 0; };
  ws.onerror = (e) => log('error');
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
    catch { return log('non-json frame'); }
    if (m.t === 'state') return log('state snapshot (bytes ' + (ev.data.length || 0) + ')');
    if (m.players && m.players.length) {
      log(m.t, 'code=' + m.code, 'role=' + m.role, 'hostId=' + m.hostId,
          'humans=' + (m.humanCount != null ? m.humanCount : (m.players ? m.players.length : '?')),
          'bots=' + m.botCount, 'seed=' + m.seed);
    } else {
      log(m.t, JSON.stringify(m).slice(0, 220));
    }
    /* as soon as welcome arrives, hello; right after hello, queue */
    if (m.t === 'welcome' && !ws._ok) {
      ws._ok = true;
      ws.send(JSON.stringify({ t: 'hello', name: label, tank: 'coolbuddy', color: 0x33aa77 }));
      log('hello sent');
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'queue', mode: 'team-deathmatch' }));
        log('queue sent');
      }, 250);
    }
  };
  return ws;
}

console.log('probing', URL, '— two sockets, immediate double queue…');
sock('P1');
setTimeout(() => sock('P2'), 400);
setTimeout(() => { console.log('[done]'); process.exit(0); }, 75000);
