/* gen-battle-sfx.mjs — synthesise the battle SFX samples into assets/sounds/.
 *
 * Runtime audio.js keeps procedural fallbacks for everything here, but a
 * sampled, pre-composed sound is better in two ways that matter in a match:
 * the modal decay is longer and inharmonic the way struck steel actually
 * rings, and each call can pick one of several variants so a firefight does
 * not play the same transient fifteen times.
 *
 * Generates (mono 16-bit 44.1 kHz WAV):
 *   assets/sounds/bounce_ping_1.wav .. 3   — ricochet off armor (struck steel)
 *   assets/sounds/wall_knock_1.wav  .. 2   — shell dying in concrete (dead thud)
 *   assets/sounds/armor_light_1.wav .. 2   — chip damage into a tank
 *   assets/sounds/armor_heavy_1.wav .. 2   — that hurt: sub thud + metal crunch
 *
 * Run with the bundled node:  node tools/gen-battle-sfx.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'sounds');
mkdirSync(OUT, { recursive: true });

const rnd = (a, b) => a + Math.random() * (b - a);

/* ── DSP helpers ─────────────────────────────────────────────────────── */
function buf(sec){ return new Float32Array(Math.ceil(sec * SR)); }

/* one-pole low / high pass, applied in place */
function onepole(x, fc, type){
  const dt = 1 / SR;
  const a = Math.exp(-2 * Math.PI * fc * dt);
  let y = 0;
  for(let i = 0; i < x.length; i++){
    y = x[i] * (1 - a) + y * a;
    if(type === 'high') x[i] = x[i] - y;
    else x[i] = y;
  }
  return x;
}

/* a decaying sine partial, with optional freq slide (mult: f * slide(t)) */
function partial(dur, f0, amp, tau, slideTo, slideT){
  const x = buf(dur);
  let phase = 0;
  let f = f0;
  const target = slideTo || f0, tS = slideT || 0.15;
  for(let i = 0; i < x.length; i++){
    const t = i / SR;
    if(slideTo) f = f0 + (target - f0) * Math.min(1, t / tS);
    phase += 2 * Math.PI * f / SR;
    x[i] = amp * Math.exp(-t / tau) * Math.sin(phase);
  }
  return x;
}

/* exponentially-decaying noise burst */
function noiseBurst(dur, amp, tau, fc, type){
  const x = buf(dur);
  for(let i = 0; i < x.length; i++)
    x[i] = (Math.random() * 2 - 1) * amp * Math.exp(-i / SR / tau);
  return fc ? onepole(x, fc, type) : x;
}

/* swept resonant noise: band "crunch" that falls in pitch (metal tearing) */
function crunch(dur, amp, fStart, fEnd){
  const x = buf(dur);
  /* simulate a lowpass whose cutoff sweeps down, fed with noise */
  let y = 0, z = 0;
  for(let i = 0; i < x.length; i++){
    const t = i / SR;
    const k = Math.min(1, t / (dur * 0.6));
    const fc = fStart * Math.pow(fEnd / fStart, k);
    const a = Math.exp(-2 * Math.PI * fc / SR);
    const n = Math.random() * 2 - 1;
    const env = Math.exp(-t / (dur * 0.35)) * (1 - Math.exp(-t / 0.004));
    y = n * (1 - a) + y * a;
    z = y * (1 - a) + z * a;
    x[i] = (y - z) * amp * env;
  }
  return x;
}

function softClip(x, drive = 1.5){
  for(let i = 0; i < x.length; i++)
    x[i] = Math.tanh(x[i] * drive);
  return x;
}

function addMix(dst, src, gain = 1, atSec = 0){
  const at = Math.round(atSec * SR);
  for(let i = 0; i < src.length && at + i < dst.length; i++)
    dst[at + i] += src[i] * gain;
  return dst;
}

function fadeInOut(x, inMs = 2, outMs = 8){
  const nIn = Math.min(x.length, Math.round(inMs * SR / 1000));
  for(let i = 0; i < nIn; i++) x[i] *= i / nIn;
  const start = x.length - Math.round(outMs * SR / 1000);
  if(start > 0) for(let i = start; i < x.length; i++) x[i] *= (x.length - i) / (x.length - start);
  return x;
}

/* ── WAV writer: mono 16-bit PCM ─────────────────────────────────────── */
function writeWav(name, x){
  let peak = 0;
  for(let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const norm = peak > 1e-6 ? 0.94 / peak : 1;   /* -0.5 dBFS, leaves clip headroom */
  const data = Buffer.alloc(x.length * 2);
  for(let i = 0; i < x.length; i++)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i] * norm)) * 32767), i * 2);
  const header = Buffer.alloc(44);
  const len = data.length;
  header.write('RIFF', 0); header.writeUInt32LE(36 + len, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(len, 40);
  const file = join(OUT, name);
  writeFileSync(file, Buffer.concat([header, data]));
  console.log(' wrote', name, ((44 + len) / 1024).toFixed(0) + 'KB', (x.length / SR).toFixed(2) + 's');
}

/* ── the sounds ──────────────────────────────────────────────────────── */

/* BOUNCE — shell riccochets off armor.
   Struck spring steel: a fast strike slap, then a stack of INHARMONIC partials
   (not 1x/2x/3x — real plate modes are spaced ~1 / 2.32 / 3.01 / 4.1 / 5.4)
   that fall in pitch slightly at first and ring out. */
function bouncePing(base){
  const dur = rnd(0.55, 0.75);
  const o = buf(dur);
  /* strike transient: bright slap */
  addMix(o, noiseBurst(0.05, 1.0, 0.004, 3200, 'high'), 0.5);
  /* modal ladder */
  const modes = [1, 2.32, 3.01, 4.10, 5.42], amps = [1, 0.55, 0.34, 0.18, 0.10], taus = [0.55, 0.42, 0.32, 0.24, 0.16];
  for(let i = 0; i < modes.length; i++){
    const f = base * modes[i] * rnd(0.98, 1.02);
    addMix(o, partial(dur, f, amps[i], taus[i] * rnd(0.85, 1.15), f * 0.94, 0.06),
           0.34);
  }
  /* low "body" of the clang so it reads physical, not like a doorbell */
  addMix(o, partial(dur, base * 0.38, 0.9, 0.18), 0.22);
  addMix(o, partial(dur, base * 0.55, 0.7, 0.12), 0.15);
  /* micro-beating: two detuned copies of the loudest partial */
  addMix(o, partial(dur, base * rnd(0.992, 1.008), 0.5, 0.3), 0.20);
  softClip(o, 1.35);
  fadeInOut(o, 1, 20);
  return o;
}

/* WALL — the dead knock of a shell dying in concrete: two low partials die
   almost immediately, dust of debris, no ring. */
function wallKnock(){
  const dur = rnd(0.22, 0.3);
  const o = buf(dur);
  const f = rnd(150, 210);
  addMix(o, partial(dur, f, 1.0, 0.07), 0.9);
  addMix(o, partial(dur, f * 2.4 * rnd(0.97, 1.03), 0.5, 0.045), 0.5);
  addMix(o, partial(dur, f * 3.7, 0.3, 0.03), 0.35);
  addMix(o, noiseBurst(0.06, 1.0, 0.006, 900, 'high'), 0.35);
  addMix(o, noiseBurst(dur, 0.7, 0.09, 500), 0.5, 0.005);   /* the "wall shakes" */
  softClip(o, 1.2);
  fadeInOut(o, 1, 40);
  return o;
}

/* ARMOR (light) — chip: bright bite, short, plate still rings a little. */
function armorLight(){
  const dur = rnd(0.4, 0.5);
  const o = buf(dur);
  const f = rnd(190, 250);
  addMix(o, partial(dur, f, 1.0, 0.11, f * 0.72, 0.09), 0.85);        /* thud */
  addMix(o, crunch(0.16, 0.85, 1100, 320), 0.55);                    /* bite */
  addMix(o, partial(dur, f * 4.3 * rnd(0.99, 1.01), 0.4, 0.13), 0.25);
  addMix(o, partial(dur, f * 6.1, 0.25, 0.09), 0.18);
  addMix(o, noiseBurst(0.03, 1.0, 0.003, 2500, 'high'), 0.4);
  softClip(o, 1.3);
  fadeInOut(o, 1, 30);
  return o;
}

/* ARMOR (heavy) — the shell went in: deep chassis displacement, low crunch,
   a wounded-after ring underneath. */
function armorHeavy(){
  const dur = rnd(0.65, 0.8);
  const o = buf(dur);
  const f = rnd(120, 160);
  addMix(o, partial(dur, f, 1.0, 0.22, f * 0.38, 0.16), 0.95);       /* sub thud */
  addMix(o, partial(dur, 52, 0.9, 0.3), 0.6);                        /* chest */
  addMix(o, crunch(0.28, 0.9, 760, 190), 0.6);                       /* crushing */
  addMix(o, partial(0.5, f * 3.2 * rnd(0.98, 1.02), 0.4, 0.35), 0.22, 0.04); /* wounded ring */
  addMix(o, partial(0.4, f * 1.72, 0.3, 0.28), 0.18, 0.02);
  addMix(o, noiseBurst(0.04, 1.0, 0.005, 1200, 'high'), 0.45);
  softClip(o, 1.25);
  fadeInOut(o, 1, 50);
  return o;
}

const jobs = [
  ['bounce_ping_1.wav', () => bouncePing(rnd(1350, 1500))],
  ['bounce_ping_2.wav', () => bouncePing(rnd(1600, 1850))],
  ['bounce_ping_3.wav', () => bouncePing(rnd(2000, 2400))],
  ['wall_knock_1.wav', wallKnock],
  ['wall_knock_2.wav', wallKnock],
  ['armor_light_1.wav', armorLight],
  ['armor_light_2.wav', armorLight],
  ['armor_heavy_1.wav', armorHeavy],
  ['armor_heavy_2.wav', armorHeavy],
];
for(const [name, gen] of jobs) writeWav(name, gen());
console.log('done');
