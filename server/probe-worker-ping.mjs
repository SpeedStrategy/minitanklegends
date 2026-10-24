/* probe-worker-ping.mjs — measure the DEPLOYED relay round-trip.
   Run: node server/probe-worker-ping.mjs
   hello → queue → wait for 'matched' → send 20 pings → report RTTs. */

const URL = 'wss://tanklg.nojus-t.workers.dev/mp';
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const rtts = [];
let pongs = 0;

const ws = new WebSocket(URL);
ws.onopen = () => console.log(`[${stamp()}] open`);
ws.onerror = (e) => { console.log(`[${stamp()}] ws error`); };
ws.onclose = (e) => console.log(`[${stamp()}] close ${e && e.code}`);

ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
  catch { return; }
  if (m.t === 'pong') {
    pongs++;
    rtts.push(performance.now() - m.ts);
    return;
  }
  if (m.players) {
    console.log(`[${stamp()}]`, m.t, 'code=' + m.code, 'role=' + m.role, 'humans=' + (m.humanCount != null ? m.humanCount : m.players.length));
  } else {
    console.log(`[${stamp()}]`, m.t, JSON.stringify(m).slice(0, 150));
  }
  if (m.t === 'welcome' && !ws._helloDone) {
    ws._helloDone = true;
    ws.send(JSON.stringify({ t: 'hello', name: 'PINGTEST', tank: 'coolbuddy', color: 0x999999 }));
    setTimeout(() => ws.send(JSON.stringify({ t: 'queue', mode: 'team-deathmatch' })), 200);
    setTimeout(() => console.log(`[${stamp()}] waiting for match…`), 600);
  }
  if (m.t === 'matched') {
    console.log(`[${stamp()}] matched — firing 20 pings`);
    let n = 0;
    const iv = setInterval(() => {
      ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
      if (++n >= 20) { clearInterval(iv); setTimeout(report, 800); }
    }, 100);
  }
};

function report() {
  rtts.sort((a, b) => a - b);
  console.log('\n== Relay ping results ==');
  console.log('pongs:', pongs, 'of 20');
  if (rtts.length) {
    console.log('min ' + rtts[0].toFixed(1) + ' ms  median ' + rtts[Math.floor(rtts.length / 2)].toFixed(1) + ' ms  max ' + rtts[rtts.length - 1].toFixed(1) + ' ms');
    console.log('samples: ' + rtts.map(x => x.toFixed(0)).join(','));
  }
  process.exit(0);
}
