/* heal.cjs — restores the full GM 2.0 card markup for the TWO live cards.
   Strategy: whole-block canonical replace, not piecemeal insertions —
   another agent merges buffers around here, and half-applied edits are what
   produced the messy in-between states. A canonical block is idempotent and
   converges: whatever the block currently looks like, after this script it is
   exactly this text. Run again any time the friend's save overwrote it. */
const fs = require('fs');
const f = 'index.html';
let s = fs.readFileSync(f, 'utf8');

function card(mode, kicker, iconSvg, name, desc) {
  return [
    '          <div class="gm-card" data-gamemode="' + mode + '">',
    '            <div class="gm-card-overlay"></div>',
    '            <div class="gm-card-sheen"></div>',
    '            <div class="gm-card-content">',
    '              <div class="gm-card-kicker">' + kicker + '</div>',
    '              <div class="gm-card-icon">' + iconSvg + '</div>',
    '              <div class="gm-card-name">' + name + '</div>',
    '              <div class="gm-card-desc">' + desc + '</div>',
    '            </div>',
    '            <div class="gm-card-cta">ENTER \u25B8</div>',
    '          </div>'
  ].join('\r\n');
}

const CC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
const BD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/><path d="M12 5V2"/><path d="M12 2.8c1.6.5 3 .4 4.4-.4-.2 1.6.2 3 1.6 4.2-1.6.2-2.8 1-3.6 2.4-.8-1.4-2-2.2-3.6-2.4 1.4-1.2 1.8-2.6 1.6-4.2 1.4.8 2.8.9 4.4.4"/></svg>';

const TARGETS = [
  { mode: 'captureTheCircle', block: card('captureTheCircle', 'ZONE CONTROL', CC_SVG,
      'CAPTURE THE CIRCLE', 'Stand in the circle to capture. Teams compete to claim the zone.') },
  { mode: 'baseDefend', block: card('baseDefend', 'ENDLESS SIEGE', BD_SVG,
      'BASE DEFEND', "Unlimited respawns. Destroy the enemy team's base before they destroy yours.") }
];

let changed = 0;
for(const t of TARGETS){
  const openTag = '<div class="gm-card" data-gamemode="' + t.mode + '">';
  const idx = s.indexOf(openTag);
  if(idx < 0){ console.error('missing card ' + t.mode); process.exit(1); }
  /* the card block ends at the next card open tag or at the panel close:
     the cards are real children of .gm-cards now (the stray `</div>` that
     used to close the panel right after LOCKED-MODE-END is gone), so a
     card-close line may be followed by a sibling card, not the closer. */
  /* the card block ends at the next sibling card open tag (any indent — a
     friend's save may reindent) or at the card's own close line. The close
     pattern tolerates 0..10 spaces only: content closes inside the card are
     12+ spaces and must never end the block early. */
  const scan = s.slice(idx + 20);
  const reA = /\r\n\s+<div class="gm-card" data-gamemode="/;
  const reB = /\r\n {0,10}<\/div>/;
  const mA = reA.exec(scan), mB = reB.exec(scan);
  const a = mA ? mA.index : Infinity;
  const b = mB ? mB.index : Infinity;
  const winner = a <= b ? mA : mB;
  if(!winner){ console.error('no end anchor ' + t.mode); process.exit(1); }
  const end = idx + 20 + winner.index + winner[0].length;
  if(s.slice(idx, end) !== t.block){ changed++; }
  s = s.slice(0, idx) + t.block + s.slice(end);
}

if(changed){
  fs.writeFileSync(f, s);
  console.log('healed blocks:', changed);
} else {
  console.log('already canonical');
}
const c = (t) => (s.match(new RegExp(t, 'g')) || []).length;
console.log('sheen=' + c('gm-card-sheen'), 'kicker=' + c('gm-card-kicker'), 'cta=' + c('gm-card-cta'));
