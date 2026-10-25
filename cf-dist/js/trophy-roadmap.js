/* trophy-roadmap.js — the Trophy Roadmap overlay and the dynamic progress
   button that lives at the bottom of the player profile menu.

   The button shows the NEXT trophy the player is working toward: its icon,
   its name, and a "current / threshold" count, with an orange fill that
   grows left-to-right as wins accumulate. Clicking it opens a full-screen
   roadmap: a single horizontal track with ten milestone dots, odd ones
   above the line and even ones below, each carrying its trophy icon and
   threshold number. Owned trophies glow; locked ones stay dim. */
(function () {
  'use strict';

  function catalog() {
    try { return (typeof getTrophyCatalog === 'function') ? getTrophyCatalog() : []; }
    catch (e) { return []; }
  }

  /* Trophies sorted by their win threshold (Rookie first, Legend last). */
  function sortedTrophies() {
    return catalog().slice().sort(function (a, b) {
      return (a.threshold || 0) - (b.threshold || 0);
    });
  }

  function ownedSet() {
    try {
      const ids = (typeof ownedTrophyIds === 'function') ? ownedTrophyIds()
                : ((window.Menu && Menu.settings && Array.isArray(Menu.settings.trophyOwnedIds)) ? Menu.settings.trophyOwnedIds : []);
      return new Set(ids);
    } catch (e) { return new Set(); }
  }

  function winCount() {
    try {
      const s = (typeof loadSettings === 'function') ? loadSettings() : ((window.Menu && Menu.settings) || null);
      return (s && typeof s.trophyCount === 'number') ? s.trophyCount : 0;
    } catch (e) { return 0; }
  }

  /* Find the next trophy the player has not yet earned. Only WIN-BASED
     trophies count here - the no-threshold ones (Beta Tester) are not part
     of the roadmap and never come from wins. */
  function nextTrophy() {
    const owned = ownedSet();
    const list = sortedTrophies().filter(t => typeof t.threshold === 'number');
    for (let i = 0; i < list.length; i++) {
      if (!owned.has(list[i].id)) return list[i];
    }
    return list.length ? list[list.length - 1] : null;
  }

  function updateProgressButton() {
    const btn = document.getElementById('trophy-progress-btn');
    if (!btn) return;
    const fill = document.getElementById('trophy-progress-fill');
    const icon = document.getElementById('trophy-progress-icon');
    const label = document.getElementById('trophy-progress-label');
    const count = document.getElementById('trophy-progress-count');
    const t = nextTrophy();
    const wc = winCount();
    if (t) {
      if (icon) icon.src = t.icon;
      if (label) label.textContent = t.name;
      const thr = (typeof t.threshold === 'number') ? t.threshold : 0;
      if (count) count.textContent = wc + ' / ' + thr;
      const pct = thr > 0 ? Math.min(100, (wc / thr) * 100) : 100;
      if (fill) fill.style.width = pct + '%';
      btn.title = 'Trophy Roadmap - next: ' + t.name + ' (' + wc + ' / ' + thr + ' wins)';
    } else {
      if (label) label.textContent = 'All earned!';
      if (count) count.textContent = wc + ' wins';
      if (fill) fill.style.width = '100%';
      btn.title = 'Trophy Roadmap - all ' + sortedTrophies().length + ' trophies earned!';
    }
  }

  /* Make sure every trophy whose threshold the player has already crossed is
     actually owned. Rookie sits at 0 wins, so a brand-new player already
     owns it even without a single win - we cannot wait for a win event that
     may never come. Runs at boot and whenever the menus open. */
  function ensureEarnedTrophies() {
    try {
      const cat = (typeof getTrophyCatalog === 'function') ? getTrophyCatalog() : [];
      const s = (typeof loadSettings === 'function') ? loadSettings() : null;
      if (!s) return;
      if (!Array.isArray(s.trophyOwnedIds)) s.trophyOwnedIds = [];
      const owned = new Set(s.trophyOwnedIds);
      const wc = (typeof s.trophyCount === 'number') ? s.trophyCount : 0;
      let changed = false;
      for (const t of cat) {
        if (typeof t.threshold !== 'number') continue;
        if (wc >= t.threshold && !owned.has(t.id)) {
          s.trophyOwnedIds.push(t.id);
          owned.add(t.id);
          changed = true;
          if (typeof awardTrophy === 'function') awardTrophy(t.id);
        }
      }
      if (changed) {
        if (typeof saveSettings === 'function') saveSettings(s);
        if (typeof Menu !== 'undefined' && Menu.refreshProfile) Menu.refreshProfile();
      }
    } catch (e) {}
  }

  function buildRoadmap() {
    const dots = document.getElementById('trophy-roadmap-dots');
    if (!dots) return;
    /* The ten win milestones only. Beta Tester is a separate trophy and
       deliberately not part of this ladder. */
    const list = sortedTrophies().filter(t => typeof t.threshold === 'number');
    const owned = ownedSet();
    const wc = winCount();
    dots.innerHTML = '';
    list.forEach(function (t, i) {
      const thr = t.threshold;
      const isOwned = owned.has(t.id);
      const isNext = !isOwned && (i === 0 || owned.has(list[i - 1].id));
      const side = (i % 2 === 0) ? 'top' : 'bottom';
      const div = document.createElement('div');
      div.className = 'trophy-roadmap-dot ' + side + (isOwned ? ' owned' : '') + (isNext ? ' next' : '');
      div.innerHTML =
        '<div class="trophy-roadmap-icon-wrap">' +
          '<div class="trophy-roadmap-tile"><img class="trophy-roadmap-icon" src="' + t.icon + '" alt="" draggable="false"></div>' +
          '<div class="trophy-roadmap-chip">' + thr.toLocaleString('en-US') + '</div>' +
          '<div class="trophy-roadmap-name">' + t.name + '</div>' +
        '</div>';
      div.title = isOwned
        ? t.name + ' - earned'
        : t.name + ' - ' + thr.toLocaleString('en-US') + ' wins';
      dots.appendChild(div);
    });
    const fill = document.getElementById('trophy-roadmap-fill');
    if (fill) fill.style.width = roadFillPct(list, owned, wc).toFixed(2) + '%';
    const countEl = document.getElementById('trophy-roadmap-count');
    if (countEl) {
      countEl.className = 'trophy-roadmap-count';
      countEl.textContent = wc.toLocaleString('en-US') + ' win' + (wc === 1 ? '' : 's');
    }
    /* "Where you are now" banner: floats above the last earned milestone. */
    positionHereBanner(list, owned, wc);
  }

  /* Evenly spread row of n groups: group i occupies 1/n of the row, so its
     centre sits at (i + 0.5) / n of the row width. */
  function roadFillPct(list, owned, wc) {
    const n = list.length;
    if (!n) return 0;
    const center = i => ((i + 0.5) * 100) / n;
    const firstUnowned = list.findIndex(t => !owned.has(t.id));
    if (firstUnowned < 0) return 100;
    if (firstUnowned === 0) return 0;
    const prev = list[firstUnowned - 1];
    const cur = list[firstUnowned];
    const start = center(firstUnowned - 1);
    const end = center(firstUnowned);
    if (typeof prev.threshold !== 'number' || typeof cur.threshold !== 'number' || cur.threshold <= prev.threshold) {
      return start;
    }
    const f = Math.max(0, Math.min(1, (wc - prev.threshold) / (cur.threshold - prev.threshold)));
    return start + (end - start) * f;
  }

  /* A white ribbon pinned above the milestone the player has most recently
     earned (Rookie for a fresh account), with a tail pointing down at it. */
  function positionHereBanner(list, owned, wc) {
    const track = document.getElementById('trophy-roadmap-track');
    const fill = document.getElementById('trophy-roadmap-fill');
    if (!track || !fill) return;
    let banner = document.getElementById('trophy-roadmap-here');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'trophy-roadmap-here';
      banner.className = 'trophy-roadmap-here';
      track.appendChild(banner);
    }
    /* tip = last earned milestone index; banner sits at the tip of the road */
    let curIdx = -1;
    for (let i = 0; i < list.length; i++) {
      if (owned.has(list[i].id)) curIdx = i;
    }
    if (curIdx < 0) curIdx = 0;
    const pct = roadFillPct(list, owned, wc);
    /* The fill's left edge is inset 30px and its width is pct% of the
       (track - 60px) region, so the tip sits at 30 + pct%*(W-60). Position
       the banner there in pixels so it lines up exactly with the road end. */
    const tipPx = 30 + (pct / 100) * (track.clientWidth - 60);
    banner.style.left = tipPx + 'px';
    /* opposite side from the milestone at the tip, so it never covers a tile */
    const tipOnTop = (curIdx % 2 === 0);
    banner.classList.toggle('above', !tipOnTop);
    banner.classList.toggle('below', tipOnTop);
    const cur = list[curIdx];
    /* Compact marker: trophy count on top, an arrow below it pointing at
       the road tip. Down arrow (\/) when above the road, up arrow (/\)
       when below - the arrow always points toward the road. */
    banner.className = 'trophy-roadmap-here ' + (tipOnTop ? 'below' : 'above');
    banner.innerHTML =
      '<span class="here-num">' + wc.toLocaleString('en-US') + '</span>' +
      '<span class="here-arrow"></span>';
  }

  function openRoadmap() {
    ensureEarnedTrophies();
    const el = document.getElementById('trophy-roadmap');
    if (el) el.classList.remove('hidden');
    /* Build AFTER revealing so the track has real layout (clientWidth is 0
       while display:none, which used to pin the banner at 27px). */
    buildRoadmap();
  }

  function closeRoadmap() {
    const el = document.getElementById('trophy-roadmap');
    if (el) el.classList.add('hidden');
  }

  /* Wire up. */
  function wire() {
    ensureEarnedTrophies();
    const btn = document.getElementById('trophy-progress-btn');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof Audio !== 'undefined' && Audio.click) Audio.click();
        openRoadmap();
      });
    }
    const closeBtn = document.getElementById('trophy-roadmap-close');
    if (closeBtn && !closeBtn._wired) {
      closeBtn._wired = true;
      closeBtn.addEventListener('click', closeRoadmap);
    }
    const backdrop = document.getElementById('trophy-roadmap-backdrop');
    if (backdrop && !backdrop._wired) {
      backdrop._wired = true;
      backdrop.addEventListener('click', closeRoadmap);
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeRoadmap();
    });
    updateProgressButton();
  }

  /* Re-render whenever the profile menu OR the main menu becomes visible -
     the button itself now sits in the main menu top bar, next to the gear. */
  function hookMenus() {
    for (const id of ['menu-main', 'menu-profile']) {
      const el = document.getElementById(id);
      if (!el || el._trophyObserved) continue;
      el._trophyObserved = true;
      const obs = new MutationObserver(function () {
        if (!el.classList.contains('hidden')) {
          ensureEarnedTrophies();
          updateProgressButton();
        }
      });
      obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wire(); hookMenus(); });
  } else {
    setTimeout(function () { wire(); hookMenus(); }, 0);
  }

  window.updateTrophyProgressButton = updateProgressButton;
  window.openTrophyRoadmap = openRoadmap;
  window.closeTrophyRoadmap = closeRoadmap;
})();
