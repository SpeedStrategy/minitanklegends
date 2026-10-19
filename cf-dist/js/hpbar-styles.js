/* ============================================================
   hpbar-styles.js — the cartoon health bar, in five levels of detail.

   WHY A SEPARATE FILE
   -------------------
   This is pure canvas2d drawing with no dependency on three.js, the Tank class
   or anything else in the game, for one reason: so the preview page that offers
   these five options can load this exact file and draw with the exact code the
   game runs. A preview that re-implements the styles is a preview of something
   that is not what ships, and it drifts the moment either side is edited.

   Tank._drawHp calls HPBarStyles.draw. Nothing else may.

   THE FIVE STYLES
   ---------------
   All five keep the same plate: same pill shape, same 4px sticker outline, same
   dark track, same lagging orange "health just lost" ghost, same white hit flash
   and same low-HP pulse. They differ only in how the filled portion is built --
   how many pieces, and how much shading each piece carries.

     1 SOLID        one continuous bar, two shading bands. Fewest pieces.
     2 CHUNKY       6 blocks, hard gaps, one highlight band each.
     3 FINE         12 blocks, hard gaps, two bands each. This is the bar the
                     game already had with the per-block specular streak
                     removed -- the streak was the detail that made it read as
                     photographed rather than drawn.
     4 GLOSS        one continuous pill with a rounded gloss cap on the
                     highlight, in the manner of a cartoon glass meter.
     5 BOLD         4 blocks, each with its own dark outline, no shading at
                     all. The most graphic and the least detailed.

   NOTHING SOFT ANYWHERE. No gradients, no blur, no glow, no soft shadows. Every
   edge is a hard boundary between two flat fills, which is what separates a
   drawn cartoon from a rendered photograph.
   ============================================================ */

(function(){
  'use strict';

  const HPBarStyles = {};

  /* f > 1 lightens, f < 1 darkens. Kept here so every style shades the same way. */
  function shade(hex, f){
    const n = parseInt(String(hex).slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    const g = Math.min(255, Math.round(((n >> 8)  & 255) * f));
    const b = Math.min(255, Math.round((n & 255) * f));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* The dark track every style starts from. Two flat bands, so even the empty
     bar reads as drawn rather than as a hole. */
  const TRACK_HI = '#2b3040';
  const TRACK_LO = '#1e2230';
  /* The lost-health ghost: flat comic orange, deliberately the one warm colour
     on the plate so it never gets confused with live health. */
  const GHOST_HI = '#ffc861';
  const GHOST_LO = '#e07f10';

  function rr(g, x, y, w, h, r){
    if(g.roundRect) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  }

  /* How much of block i is covered by a normalised 0..1 value, given that the
     gaps are part of the total width. Shared by every block-based style so a
     full bar always ends flush with the right edge of the track. */
  function cover(f, i, kW, tileW, step){
    const d = f * kW - i * step;
    if(d <= 0) return 0;
    return d >= tileW ? 1 : d / tileW;
  }

  /* ---- the per-style filled portions -------------------------------------
     Each returns after clipping to its own pieces. Flat fills only. */
  const painters = {

    /* 1 -- SOLID. One bar, a light band across the top 38% and a dark band
       across the bottom 14%. This is the least busy of the five. */
    1: function(g, o, kX, kY, kW, kH, kR){
      if(o.ghost > 0.004){
        const w = o.ghost * kW;
        g.fillStyle = GHOST_LO; g.fillRect(kX, kY, w, kH);
        g.fillStyle = GHOST_HI; g.fillRect(kX, kY, w, kH * 0.38);
      }
      if(o.fill > 0.004){
        const w = o.fill * kW;
        g.fillStyle = o.hpCol;              g.fillRect(kX, kY, w, kH);
        g.fillStyle = shade(o.hpCol, 1.5);  g.fillRect(kX, kY, w, kH * 0.38);
        g.fillStyle = shade(o.hpCol, 0.7);  g.fillRect(kX, kY + kH * 0.86, w, kH * 0.14);
      }
    },

    /* 2 -- CHUNKY. Six blocks with hard gaps, one highlight band each. Wide
       enough that the bar still reads as health at a glance from across the
       map, which twelve blocks do not. */
    2: function(g, o, kX, kY, kW, kH){
      const n = 6, gap = 5;
      const tileW = (kW - gap * (n - 1)) / n, step = tileW + gap;
      for(let i = 0; i < n; i++){
        const x = kX + i * step;
        const wG = tileW * cover(o.ghost, i, kW, tileW, step);
        const wF = tileW * cover(o.fill, i, kW, tileW, step);
        g.save();
        g.beginPath(); rr(g, x, kY, tileW, kH, 3); g.clip();
        g.fillStyle = TRACK_HI; g.fillRect(x, kY, tileW, kH);
        g.fillStyle = TRACK_LO; g.fillRect(x, kY + kH * 0.62, tileW, kH * 0.38);
        if(wG > 0.5){
          g.fillStyle = GHOST_LO; g.fillRect(x, kY, wG, kH);
          g.fillStyle = GHOST_HI; g.fillRect(x, kY, wG, kH * 0.38);
        }
        if(wF > 0.5){
          g.fillStyle = o.hpCol;             g.fillRect(x, kY, wF, kH);
          g.fillStyle = shade(o.hpCol, 1.45); g.fillRect(x, kY, wF, kH * 0.38);
        }
        g.restore();
      }
    },

    /* 3 -- FINE. Twelve blocks like the bar that shipped, minus the per-block
       white specular streak. That streak was the single detail that made the
       bar look photographed; nothing else about it needed to change. */
    3: function(g, o, kX, kY, kW, kH){
      const n = 12, gap = 4;
      const tileW = (kW - gap * (n - 1)) / n, step = tileW + gap;
      for(let i = 0; i < n; i++){
        const x = kX + i * step;
        const wG = tileW * cover(o.ghost, i, kW, tileW, step);
        const wF = tileW * cover(o.fill, i, kW, tileW, step);
        g.save();
        g.beginPath(); rr(g, x, kY, tileW, kH, 4); g.clip();
        g.fillStyle = TRACK_HI; g.fillRect(x, kY, tileW, kH);
        g.fillStyle = TRACK_LO; g.fillRect(x, kY + kH * 0.62, tileW, kH * 0.38);
        if(wG > 0.5){
          g.fillStyle = GHOST_LO; g.fillRect(x, kY, wG, kH);
          g.fillStyle = GHOST_HI; g.fillRect(x, kY, wG, kH * 0.40);
          g.fillStyle = GHOST_LO; g.fillRect(x, kY + kH * 0.84, wG, kH * 0.16);
        }
        if(wF > 0.5){
          g.fillStyle = o.hpCol;             g.fillRect(x, kY, wF, kH);
          g.fillStyle = shade(o.hpCol, 1.5); g.fillRect(x, kY, wF, kH * 0.40);
          g.fillStyle = shade(o.hpCol, 0.7); g.fillRect(x, kY + kH * 0.84, wF, kH * 0.16);
        }
        g.restore();
      }
    },

    /* 4 -- GLOSS. One continuous pill with a rounded cap of highlight across the
       top-left, the way a cartoon draws a glass meter. The cap is a flat lighter
       shape with a hard edge, not a gradient. */
    4: function(g, o, kX, kY, kW, kH, kR){
      if(o.ghost > 0.004){
        const w = o.ghost * kW;
        g.save();
        g.beginPath(); rr(g, kX, kY, w, kH, kR); g.clip();
        g.fillStyle = GHOST_LO; g.fillRect(kX, kY, w, kH);
        g.restore();
      }
      if(o.fill > 0.004){
        const w = o.fill * kW;
        g.save();
        g.beginPath(); rr(g, kX, kY, w, kH, kR); g.clip();
        g.fillStyle = o.hpCol;             g.fillRect(kX, kY, w, kH);
        g.fillStyle = shade(o.hpCol, 0.72); g.fillRect(kX, kY + kH * 0.80, w, kH * 0.20);
        /* the gloss cap: a rounded lozenge sitting in the upper band */
        const capW = Math.min(w * 0.55, kW * 0.34);
        g.fillStyle = shade(o.hpCol, 1.55);
        g.beginPath();
        rr(g, kX + 3, kY + kH * 0.14, capW, kH * 0.34, kH * 0.17);
        g.fill();
        g.restore();
      }
    },

    /* 5 -- BOLD. Four blocks, each carrying its own dark outline, and no
       shading whatsoever -- one flat colour per block. The most graphic of the
       five and the cheapest to read at any distance. */
    5: function(g, o, kX, kY, kW, kH){
      const n = 4, gap = 7, ow = 2.5;
      const tileW = (kW - gap * (n - 1)) / n, step = tileW + gap;
      for(let i = 0; i < n; i++){
        const x = kX + i * step;
        const wG = tileW * cover(o.ghost, i, kW, tileW, step);
        const wF = tileW * cover(o.fill, i, kW, tileW, step);
        /* empty block */
        g.fillStyle = TRACK_LO;
        g.beginPath(); rr(g, x, kY, tileW, kH, 5); g.fill();
        g.strokeStyle = TRACK_HI; g.lineWidth = ow;
        g.beginPath(); rr(g, x + ow/2, kY + ow/2, tileW - ow, kH - ow, 4); g.stroke();
        if(wG > 0.5){
          g.fillStyle = GHOST_LO;
          g.beginPath(); rr(g, x, kY, wG, kH, 5); g.fill();
        }
        if(wF > 0.5){
          g.fillStyle = o.hpCol;
          g.beginPath(); rr(g, x, kY, wF, kH, 5); g.fill();
          g.strokeStyle = o.outline; g.lineWidth = ow;
          g.beginPath(); rr(g, x + ow/2, kY + ow/2, wF - ow, kH - ow, 4); g.stroke();
        }
      }
    },
  };

  /* ------------------------------------------------------------------ draw */
  HPBarStyles.draw = function(g, o){
    const style = painters[o.style] ? o.style : 3;
    const painter = painters[style];

    const pX = o.x, pY = o.y, pW = o.w, pH = o.h;
    const pR = pH / 2;                       /* the plate is a full pill */
    const kX = pX + 4, kY = pY + 4, kW = pW - 8, kH = pH - 8;
    const kR = kH / 2;

    g.save();
    g.beginPath(); rr(g, kX, kY, kW, kH, kR); g.clip();

    /* Dark track first, so the gaps between blocks read as hard separators. */
    g.fillStyle = TRACK_LO;
    g.fillRect(kX, kY, kW, kH);

    painter(g, o, kX, kY, kW, kH, kR);

    /* ---- overlays that apply to every style ---- */

    /* White hit flash. */
    if(o.flash > 0.004){
      g.fillStyle = 'rgba(255,255,255,' + (o.flash * 0.75).toFixed(3) + ')';
      const w = Math.max(o.fill, o.ghost) * kW;
      g.fillRect(kX, kY, w, kH);
    }
    /* Low-HP pulse, so a nearly-dead tank is impossible to miss. */
    if(o.fill > 0.004 && o.fill <= 0.25){
      const p = (Math.sin(o.pulse || 0) + 1) * 0.5;
      g.fillStyle = 'rgba(255,50,50,' + (0.12 + 0.32 * p).toFixed(3) + ')';
      const w = o.fill * kW;
      g.fillRect(kX, kY, w, kH);
    }

    g.restore();

    /* Sticker outline, stroked INSET so nothing grows past the plate edge. */
    g.strokeStyle = o.outline;
    g.lineWidth = 4;
    g.beginPath();
    rr(g, pX + 2, pY + 2, pW - 4, pH - 4, Math.max(0, pR - 2));
    g.stroke();

    return style;
  };

  /* Metadata for the preview page, so it cannot describe a style that does not
     exist or describe one of them wrongly. */
  HPBarStyles.LIST = [
    { id: 1, name: 'SOLID',        note: 'one continuous bar, two shading bands' },
    { id: 2, name: 'CHUNKY',       note: '6 blocks, hard gaps, one highlight each' },
    { id: 3, name: 'FINE',         note: '12 blocks, no specular streak (the current bar, minus the detail)' },
    { id: 4, name: 'GLOSS',        note: 'one pill with a rounded cartoon gloss cap' },
    { id: 5, name: 'BOLD',         note: '4 blocks, own outlines, no shading at all' },
  ];
  HPBarStyles.shade = shade;
  HPBarStyles.COLOURS = { TRACK_HI:TRACK_HI, TRACK_LO:TRACK_LO, GHOST_HI:GHOST_HI, GHOST_LO:GHOST_LO };

  if(typeof window !== 'undefined') window.HPBarStyles = HPBarStyles;
  if(typeof globalThis !== 'undefined') globalThis.HPBarStyles = HPBarStyles;
})();
