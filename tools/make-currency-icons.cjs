/* makes the two currency icons from the progression spec:
     assets/rewards/upgradepoints.png      (teal roundel, dark "+")
     assets/rewards/goldupgradepoints.png  (golden coin, star + shine)
   16x16 logical pixels scaled 4x = 64x64 output. Pure node (zlib + crc32).
   Usage: node tools/make-currency-icons.cjs  (rerun to tweak the art) */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 16, SCALE = 4, W = S * SCALE;
const canvas = new Uint8Array(W * W * 4);

function px(x, y, r, g, b, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  for (let sy = 0; sy < SCALE; sy++)
    for (let sx = 0; sx < SCALE; sx++) {
      const i = ((y * SCALE + sy) * W + x * SCALE + sx) * 4;
      canvas[i] = r; canvas[i + 1] = g; canvas[i + 2] = b; canvas[i + 3] = a;
    }
}

function disc(cx, cy, rad, r, g, b, a) {
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + .5 - cx, y + .5 - cy);
      if (d <= rad) px(x, y, r, g, b, a);
    }
}

function rect(x0, y0, w, h, r, g, b, a) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) px(x, y, r, g, b, a);
}

function star(cx, cy, R, r0, r, g, b, a) {
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const ang = Math.atan2(y + .5 - cy, x + .5 - cx);
      const d = Math.hypot(x + .5 - cx, y + .5 - cy);
      const spoke = Math.abs(Math.cos(4 * ang)) * (R - r0) * 0.9;
      if (d <= r0 + spoke) px(x, y, r, g, b, a);
    }
}

/* ---- upgradepoints.png: teal circuit coin with a plus ---- */
function drawUpgradePoints() {
  disc(8, 8, 7.2, 16, 96, 82, 255);        // dark rim
  disc(8, 8, 6.2, 26, 188, 158, 255);      // face
  disc(8, 6.6, 4.7, 242, 255, 250, 255);   // top shine
  disc(8, 9, 4.9, 26, 178, 148, 255);      // lower face
  rect(7, 4, 2, 8, 12, 60, 52, 255);       // plus vertical
  rect(4, 7, 8, 2, 12, 60, 52, 255);       // plus horizontal
  px(13, 3, 225, 255, 246, 230);           // sparkle
  px(2, 12, 200, 255, 240, 200);
}

/* ---- goldupgradepoints.png: golden star coin ---- */
function drawGold() {
  disc(8, 8, 7.2, 130, 88, 10, 255);       // rim deep gold
  disc(8, 8, 6.3, 250, 196, 26, 255);      // face
  disc(8, 6.6, 4.9, 255, 230, 110, 255);   // shine
  disc(8, 9.4, 5.1, 244, 178, 40, 255);    // lower face
  star(8, 8, 5.2, 1.6, 186, 116, 10, 255); // star, dark
  star(8, 8, 4.0, 0.9, 255, 243, 160, 255); // star core bright
  px(14, 3, 255, 252, 214, 230);           // glints
  px(13, 5, 255, 252, 214, 200);
  px(2, 13, 240, 196, 60, 210);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < body.length; i++) {
    crc ^= body[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  const cb = Buffer.alloc(4);
  cb.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0);
  return Buffer.concat([len, t, data, cb]);
}

function writePng(name) {
  const stride = W * 4 + 1;
  const raw = Buffer.alloc(stride * W);
  for (let y = 0; y < W; y++) {
    raw[y * stride] = 0; // filter none
    for (let x = 0; x < W * 4; x++)
      raw[y * stride + 1 + x] = canvas[y * W * 4 + x];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
  const out = path.join('assets', 'rewards', name);
  fs.writeFileSync(out, png);
  console.log('wrote', out, png.length, 'bytes');
}

canvas.fill(0); drawUpgradePoints(); writePng('upgradepoints.png');
canvas.fill(0); drawGold();          writePng('goldupgradepoints.png');
