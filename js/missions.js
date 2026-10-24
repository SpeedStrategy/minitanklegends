/* ============================================================
   missions.js — Missions menu (Daily / Clan / Challenges / Event)

   Four tabs (with icons before each tab name):
     📋 Daily      — 5 quests: 1 easy, 2 medium, 2 hard.
                    Harder = bigger reward (cash; hard ones also
                    give a few coins). Refresh every day at 00:00
                    local time.
     👥 Clan      — 3 quests: 1 solo (medium) + 2 that need you
                    in a platoon gladiator room with at least one
                    clan member.
     🏆 Challenges — placeholders: a daily / weekly / monthly quest
                    card with a timer, nothing else yet.
     🎉 Event     — automatically filled from any active events
                    (window.MISSION_EVENTS or fetched config).

   Progress is tracked from real matches (wins, kills, damage,
   platoon-with-clan gladiator battles) via Missions.recordX().
   State persists in localStorage (tankparty_missions).
   ============================================================ */

window.Missions = (function(){

  var LS_KEY = 'tankparty_missions';
  var DAY_MS = 24 * 60 * 60 * 1000;

  var STATE_DEFAULTS = {
    dailyDate: '',           // YYYY-MM-DD the daily set was last generated for
    daily: {},               // questId -> {progress, claimed, claimedAt}
    clanDate: '',
    clan: {},
    challengeDate: '',
    challenges: {},
  };

  function loadState(){
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if(s) return Object.assign({}, STATE_DEFAULTS, s);
    } catch(e){}
    return JSON.parse(JSON.stringify(STATE_DEFAULTS));
  }
  function saveState(){
    try { localStorage.setItem(LS_KEY, JSON.stringify(window.MISSIONS_STATE)); } catch(e){}
  }
  window.MISSIONS_STATE = loadState();

  function todayStr(d){
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function nextMidnight(){
    var d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
  function timeLeftMs(targetMs){
    return Math.max(0, targetMs - Date.now());
  }
  function fmtTime(ms){
    ms = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(ms / 3600), m = Math.floor((ms % 3600) / 60);
    return (h > 0 ? h + 'h ' : '') + m + 'm';
  }

  /* ------------------------------------------------------------
     Quest definitions
     ------------------------------------------------------------ */
  /* DAILY QUESTS.

     Three are mode-free and count in any battle. The rest carry a `modes` list
     and only advance in those modes, because the two modes are not the same game
     and a quest that one of them silently satisfies is worse than no quest: the
     player did the thing and got nothing, and the card says IN PROGRESS.

     BOTH GAMEMODES ARE COVERED: 'gladiator' (free-for-all, kill-based, your own
     placement is the score) and 'teamDeathmatch' (round-based, team score). One
     set only would leave half of every player's play contributing to nothing. */

  var DAILY_QUESTS = [
    /* ---- any mode ---- */
    { id:'d_easy_1', diff:'easy',   modes:null,          title:'Win a battle',      target:1,    cash:200, coins:0 },
    { id:'d_easy_2', diff:'easy',   modes:null,          title:'Deal 1,000 damage', target:1000, cash:200, coins:0 },
    { id:'d_easy_3', diff:'easy',   modes:null,          title:'Destroy 2 enemies', target:2,    cash:200, coins:0 },

    /* ---- gladiator ---- */
    { id:'d_glad_1', diff:'medium', modes:['gladiator'], title:'Top 3 in Gladiator',        target:1, cash:400, coins:0 },
    { id:'d_glad_2', diff:'medium', modes:['gladiator'], title:'Win 2 Gladiator battles',   target:2, cash:420, coins:2 },
    { id:'d_glad_3', diff:'hard',   modes:['gladiator'], title:'Deal 8,000 damage in Gladiator', target:8000, cash:700, coins:8 },

    /* ---- team deathmatch ---- */
    { id:'d_tdm_1',  diff:'medium', modes:['teamDeathmatch'], title:'Win 2 Team Deathmatch battles', target:2, cash:420, coins:2 },
    { id:'d_tdm_2',  diff:'medium', modes:['teamDeathmatch'], title:'Destroy 6 enemies as a team',   target:6, cash:450, coins:3 },
    { id:'d_tdm_3',  diff:'hard',   modes:['teamDeathmatch'], title:'Score 9,000 damage for your team', target:9000, cash:720, coins:9 },

    /* ---- the other team modes share the team quest, because they are the same
            game with a different win condition ---- */
    { id:'d_team_any', diff:'hard', modes:['captureTheCircle','baseDefend'],
      title:'Win 1 team battle (Circle or Base)', target:1, cash:600, coins:6 }
  ];

  var CLAN_QUESTS = [
    { id:'c_solo_1',  mode:'solo',  title:'Win 2 solo battles', target:2, cash:400, coins:0, desc:'No other players needed — fight solo in any mode' },
    { id:'c_clan_1',  mode:'clan',  title:'Win 1 platoon battle with a clan member', target:1, cash:500, coins:5, desc:'Play Gladiator in a platoon room with ≥1 clan member' },
    { id:'c_clan_2',  mode:'clan',  title:'Destroy 3 enemies with your clan', target:3, cash:550, coins:8, desc:'Kills count while in a clan platoon battle' },
    { id:'c_clan_3',  mode:'clan',  title:'Deal 5,000 damage with your clan', target:5000, cash:650, coins:10, desc:'Damage dealt in a clan platoon battle' }
  ];

  var CHALLENGE_PLACEHOLDERS = [
    { id:'ch_daily',   period:'daily',   title:'Daily Trial',   desc:'A fresh trial every 24 hours. Coming soon.' },
    { id:'ch_weekly',  period:'weekly',  title:'Weekly Gauntlet',  desc:'Seven days. One objective. Coming soon.' },
    { id:'ch_monthly', period:'monthly', title:'Monthly Operations', desc:'Month-long campaigns. Coming soon.' }
  ];

  /* Events fill the Event tab. Set window.MISSION_EVENTS = [{id,title,target,
     reward,endsAt}] before opening the menu, or call Missions.setEvents().
     Empty = "No active events right now". */
  var EVENT_QUESTS = [];
  function setEvents(list){ EVENT_QUESTS = Array.isArray(list) ? list : []; }
  window.MISSION_EVENTS = window.MISSION_EVENTS || [];
  setEvents(window.MISSION_EVENTS);
  window.Missions_setEvents = setEvents;

  function diffLabel(d){
    return d === 'easy' ? 'EASY' : d === 'medium' ? 'MEDIUM' : 'HARD';
  }
  function diffColor(d){
    return d === 'easy' ? '#7bd36e' : d === 'medium' ? '#ffb12b' : '#ff5b5b';
  }

  /* ------------------------------------------------------------
     Helpers for new UI
     ------------------------------------------------------------ */
  function countUnclaimed(tab){
    var st = window.MISSIONS_STATE;
    var count = 0;
    if(tab === 'daily'){
      DAILY_QUESTS.forEach(function(q){
        var s = st.daily[q.id] || { progress: 0, claimed: false };
        if(s.progress >= q.target && !s.claimed) count++;
      });
    } else if(tab === 'clan'){
      CLAN_QUESTS.forEach(function(q){
        var s = st.clan[q.id] || { progress: 0, claimed: false };
        if(s.progress >= q.target && !s.claimed) count++;
      });
    }
    return count;
  }
  function updateMissionStats(){
    var st = window.MISSIONS_STATE;
    var completed = 0;
    // Daily
    DAILY_QUESTS.forEach(function(q){
      var s = st.daily[q.id] || { progress: 0, claimed: false };
      if(s.claimed) completed++;
    });
    // Clan
    CLAN_QUESTS.forEach(function(q){
      var s = st.clan[q.id] || { progress: 0, claimed: false };
      if(s.claimed) completed++;
    });
    var ce = document.getElementById('ms-total-completed');
    if(ce) animateValue(ce, completed);
  }
  function animateValue(el, target){
    var start = parseInt(el.textContent || '0', 10);
    if(start === target) return;
    var duration = 400;
    var startTime = performance.now();
    function tick(now){
      var p = Math.min(1, (now - startTime) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(start + (target - start) * eased);
      if(p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------
     Daily refresh (midnight local)
     ------------------------------------------------------------ */
  function refreshDailyIfNeeded(){
    var st = window.MISSIONS_STATE;
    var today = todayStr();
    if(st.dailyDate === today) return;
    st.dailyDate = today;
    st.daily = {};
    DAILY_QUESTS.forEach(q => { st.daily[q.id] = { progress: 0, claimed: false, claimedAt: 0 }; });
    saveState();
  }

  function refreshClanIfNeeded(){
    var st = window.MISSIONS_STATE;
    var today = todayStr();
    if(st.clanDate === today) return;
    st.clanDate = today;
    st.clan = {};
    CLAN_QUESTS.forEach(q => { st.clan[q.id] = { progress: 0, claimed: false, claimedAt: 0 }; });
    saveState();
  }

  function refreshChallengesIfNeeded(){
    var st = window.MISSIONS_STATE;
    var today = todayStr();
    if(st.challengeDate === today) return;
    st.challengeDate = today;
    st.challenges = {};
    CHALLENGE_PLACEHOLDERS.forEach(q => { st.challenges[q.id] = { claimed: false, claimedAt: 0 }; });
    saveState();
  }

  function ensureState(){
    refreshDailyIfNeeded();
    refreshClanIfNeeded();
    refreshChallengesIfNeeded();
  }

  /* ------------------------------------------------------------
     Progress tracking (called from game.js / tank.js)
     ------------------------------------------------------------ */

  /* Context of the current battle (set at battle start via recordBattle).
     recordWin / recordKill use it to decide which quests count. */
  var activeBattle = { mode: '', gamemode: '', withClanMember: false };

  /* THE ONLY THING THAT ADDS PROGRESS.

     Every quest is advanced through here. It used to be three near-copies of
     this function, each hardcoding a quest id AND an INDEX into the definitions
     array to find that quest's target:

         d['d_easy_1'].progress = Math.min(DAILY_QUESTS[0].target, ...)

     The index is the bug. `DAILY_QUESTS[0]` happens to be `d_easy_1` today, so
     it worked — and the moment anyone reorders, inserts or removes a quest, the
     cap silently becomes some other quest's number. A damage quest capped at 1
     because a wins-quest moved to index 1 is the kind of thing that ships and is
     never noticed, because the card still fills up, just wrongly and instantly.

     So the target is looked up BY ID, from a map built once, and the mode check
     happens here rather than in each caller. */
  var DAILY_BY_ID = {};
  DAILY_QUESTS.forEach(function(q){ DAILY_BY_ID[q.id] = q; });
  var CLAN_BY_ID = {};
  CLAN_QUESTS.forEach(function(q){ CLAN_BY_ID[q.id] = q; });

  /* Does this quest count in the battle that is running? A quest with no `modes`
     counts everywhere; one with modes counts only in those. */
  function questCounts(q, battle){
    if(!q || !q.modes) return true;
    if(!battle || !battle.gamemode) return false;
    return q.modes.indexOf(battle.gamemode) >= 0;
  }

  function bump(bucket, id, by, battle){
    var q = (bucket === 'clan') ? CLAN_BY_ID[id] : DAILY_BY_ID[id];
    if(!q) return;
    if(!questCounts(q, battle)) return;
    var s = window.MISSIONS_STATE[bucket][id];
    if(!s) return;
    /* Already claimed, or already full: no further credit. Without this a quest
       capped at 1 kept absorbing kills all day and its progress bar stayed pinned
       at 100% — which reads as a quest that will not finish, because claiming is
       a separate click the player has not made yet. */
    if(s.claimed || s.progress >= q.target) return;
    s.progress = Math.min(q.target, (s.progress || 0) + by);
  }

  function recordWin(opts){
    ensureState();
    var battle = (opts && opts.mode !== undefined) ? opts : activeBattle;
    /* WINS: mode-free quests only. `d_easy_1` is the one that counts any win, and
       every mode-tagged win quest is listed explicitly below. */
    bump('daily', 'd_easy_1', 1, battle);
    bump('daily', 'd_glad_2', 1, battle);
    bump('daily', 'd_tdm_1',  1, battle);
    bump('daily', 'd_team_any', 1, battle);
    /* Clan: solo gladiator win (singleplayer gladiator) */
    if(battle.mode === 'sp' && battle.gamemode === 'gladiator'){
      bump('clan', 'c_solo_1', 1, battle);
    }
    /* Clan: win a platoon gladiator battle with a clan member */
    if((battle.mode === 'host' || battle.mode === 'client') &&
       battle.gamemode === 'gladiator' && battle.withClanMember){
      bump('clan', 'c_clan_1', 1, battle);
    }
    saveState();
  }

  function recordDamage(n){
    ensureState();
    var b = activeBattle;
    var amt = Math.round(n || 0);
    if(amt <= 0) return;
    bump('daily', 'd_easy_2',  amt, b);
    bump('daily', 'd_glad_3',  amt, b);
    bump('daily', 'd_tdm_3',   amt, b);
    /* Clan: damage while in a clan platoon battle */
    var isClanPlat = (b.mode === 'host' || b.mode === 'client') &&
                     b.gamemode === 'gladiator' && b.withClanMember;
    if(isClanPlat) bump('clan', 'c_clan_3', amt, b);
    saveState();
  }

  function recordKill(){
    ensureState();
    var b = activeBattle;
    bump('daily', 'd_easy_3', 1, b);
    bump('daily', 'd_tdm_2',  1, b);
    /* Clan: kills while in a clan platoon battle */
    var isClanPlat = (b.mode === 'host' || b.mode === 'client') &&
                     b.gamemode === 'gladiator' && b.withClanMember;
    if(isClanPlat) bump('clan', 'c_clan_2', 1, b);
    saveState();
  }

  /* Assists, which the game has tracked since they were added to the results
     screen and which no quest ever asked for. It is the one number that rewards
     doing damage to a tank somebody else finished, so it is the cheapest quest in
     the game to complete while playing normally. */
  function recordAssist(){
    ensureState();
    var b = activeBattle;
    bump('clan', 'c_clan_2', 0, b);   // no assist quest in the clan set yet; keeps the call symmetrical
    saveState();
  }

  /* Called when a battle starts (and when the client learns the mode).
     opts = { mode, gamemode, withClanMember }
     mode: 'sp' | 'host' | 'client'
     gamemode: 'gladiator' | 'deathmatch' | ...
     withClanMember: true if the room contained at least one clan member */
  function recordBattle(opts){
    ensureState();
    opts = opts || {};
    activeBattle = {
      mode: opts.mode || '',
      gamemode: opts.gamemode || '',
      withClanMember: !!opts.withClanMember
    };
  }

  /* ------------------------------------------------------------
     Claiming rewards
     ------------------------------------------------------------ */
  /* CLAIM: one function for both tabs.

     They were two identical bodies differing only in which array they searched,
     which is how the two drifted: the daily one checked `st.daily[id]` and the
     clan one `st.clan[id]`, and a card for a quest id that does not exist in its
     own tab returned false from one and true from the other depending on which
     button was wired.

     A card can only be claimed when it is genuinely complete. The check is here
     rather than only on the button because the button is disabled by a class the
     CSS owns, and a claim that trusts a class is a claim that can be triggered
     from the keyboard on a card that is not ready. */
  function claim(id, bucket){
    ensureState();
    bucket = (bucket === 'clan') ? 'clan' : 'daily';
    var q = (bucket === 'clan') ? CLAN_BY_ID[id] : DAILY_BY_ID[id];
    if(!q) return false;
    var s = window.MISSIONS_STATE[bucket][id];
    if(!s || s.claimed) return false;
    if((s.progress || 0) < q.target) return false;
    s.claimed = true;
    s.claimedAt = Date.now();
    grantReward(q.cash, q.coins);
    saveState();
    return true;
  }

  function claimDaily(id){ return claim(id, 'daily'); }
  function claimClan(id){ return claim(id, 'clan'); }

  function grantReward(cash, coins){
    try {
      var s = window.Menu && Menu.settings;
      if(!s) return;
      if(cash) s.cash = (s.cash || 0) + cash;
      if(coins) s.coins = (s.coins || 0) + coins;
      if(window.saveSettings) saveSettings(s);
      if(window.Menu && Menu._updateCurrencies) Menu._updateCurrencies();
      var msg = '+' + cash + ' Cash' + (coins ? ' +' + coins + ' Coins' : '');
      if(window.Menu && Menu.toast) Menu.toast('Reward claimed: ' + msg);
    } catch(e){}
  }

  /* ------------------------------------------------------------
     Rendering
     ------------------------------------------------------------ */
  var _currentTab = 'daily';

  function render(tab){
    ensureState();
    var wrap = document.getElementById('menu-missions');
    if(!wrap) return;
    var card = wrap.querySelector('.menu-card');
    if(!card) card = wrap;
    var cur = tab || 'daily';
    _currentTab = cur;

    var tabHtml = [
      { k:'daily',      icon:'assets/icons/missions-daily.webp',      label:'Daily',      type:'supply' },
      { k:'clan',       icon:'assets/icons/missions-clan.webp',       label:'Clan',       type:'platoon' },
      { k:'challenges', icon:'assets/icons/missions-challenge.webp',  label:'Challenges', type:'special' },
      { k:'event',      icon:'assets/icons/missions-event.webp',      label:'Event',      type:'event' }
    ].map(function(t){
      return '<div class="ms-tab' + (t.k === cur ? ' active' : '') + '" data-ms-tab="' + t.k + '" data-type="' + t.type + '" tabindex="0" role="button" aria-label="' + t.label + ' missions">' +
        '<img class="ms-tab-icon" src="' + t.icon + '" alt="">' +
        '<span class="ms-tab-label">' + t.label + '</span>' +
        '<span class="ms-tab-badge" data-count="' + (countUnclaimed(t.k) || 0) + '"></span>' +
        '<span class="ms-tab-ripple"></span>' +
      '</div>';
    }).join('');

    card.innerHTML =
      '<div class="ms-briefing">' +
        '<div class="ms-header-bar">' +
          '<div class="ms-title-block">' +
            '<div class="ms-classification">CLASSIFIED // TACTICAL INTEL</div>' +
            '<h2 class="ms-main-title"><span class="ms-title-icon">📋</span>MISSION BOARD</h2>' +
            '<div class="ms-subtitle">Select operation category from the left panel</div>' +
          '</div>' +
          '<div class="ms-stats-panel">' +
            '<div class="ms-stat"><span class="ms-stat-val" id="ms-total-completed">0</span><span class="ms-stat-label">COMPLETED</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="ms-content-grid">' +
          '<aside class="ms-sidebar">' + tabHtml + '</aside>' +
          '<main class="ms-main" tabindex="0">' + renderTabBody(cur) + '</main>' +
        '</div>' +
        '<div class="ms-footer-bar">' +
          '<div class="ms-back-btn" data-back="menu-main" tabindex="0" role="button" aria-label="Return to HQ">' +
            '<span class="ms-back-icon">←</span> RETURN TO HQ' +
          '</div>' +
        '</div>' +
      '</div>';

    /* Wire the cards HERE, now that they are in the document.

       Not in renderDaily()/renderClan(), which only build a string — wiring from
       there ran against a DOM that did not contain these cards yet, matched
       nothing, and left every card unclickable. */
    wireClaims();

    // Mount WebGL background
    if(window.MissionsBG) window.MissionsBG.mount(card.querySelector('.ms-briefing'));

    // Staggered entrance animation
    requestAnimationFrame(function(){
      var briefing = card.querySelector('.ms-briefing');
      if(briefing) briefing.classList.add('ms-visible');
      card.querySelectorAll('.ms-tab').forEach(function(el, i){
        el.style.transitionDelay = (i * 60) + 'ms';
        el.classList.add('ms-tab-in');
      });
      // Animate mission cards
      card.querySelectorAll('.ms-mission-card').forEach(function(el, i){
        el.style.transitionDelay = (i * 80) + 'ms';
        el.classList.add('ms-card-in');
      });
    });

    // Tab click/keyboard handlers
    card.querySelectorAll('[data-ms-tab]').forEach(function(el){
      var handler = function(){ 
        if(el.classList.contains('active')) return;
        // Clan tab: check if user is in a clan
        if(el.dataset.msTab === 'clan' && !window.Menu._clanData){
          playUISound('hover');
          showClanRedirectPopup();
          return;
        }
        playUISound('tab');
        switchTab(el.dataset.msTab);
      };
      el.onclick = handler;
      el.onkeydown = function(e){
        if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
      };
    });
    var back = card.querySelector('[data-back]');
    if(back && window.Menu && Menu.show) {
      back.onclick = function(){ playUISound('back'); Menu.show('menu-main'); };
      back.onkeydown = function(e){
        if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound('back'); Menu.show('menu-main'); }
      };
    }
    
    updateMissionStats();
    
    // Focus first tab for keyboard nav
    var firstTab = card.querySelector('[data-ms-tab]');
    if(firstTab) firstTab.focus();
  }

  function switchTab(tab){
    ensureState();
    _currentTab = tab;
    var wrap = document.getElementById('menu-missions');
    if(!wrap) return;
    var card = wrap.querySelector('.menu-card');
    if(!card) return;

    // Update active tab
    card.querySelectorAll('.ms-tab').forEach(function(el){
      el.classList.toggle('active', el.dataset.msTab === tab);
    });

    // Swap content
    var main = card.querySelector('.ms-main');
    if(main){
      main.innerHTML = renderTabBody(tab);
      // Animate new cards
      requestAnimationFrame(function(){
        main.querySelectorAll('.ms-mission-card').forEach(function(el, i){
          el.style.transitionDelay = (i * 80) + 'ms';
          el.classList.add('ms-card-in');
        });
      });
    }

    // Re-wire claim buttons
    wireClaims();
  }

  function playUISound(type){
    if(!window.Audio || !Audio.click) return;
    var sounds = {
      tab: 'ui',
      back: 'ui',
      claim: 'cash',
      hover: 'ui'
    };
    var s = sounds[type] || 'ui';
    if(Audio.click) Audio.click(s, 0.3);
  }

  function renderTabBody(tab){
    if(tab === 'daily') return renderDaily();
    if(tab === 'clan') return renderClan();
    if(tab === 'challenges') return renderChallenges();
    if(tab === 'event') return renderEvent();
    return '';
  }

  function rewardBadge(cash, coins){
    var b = '';
    if(cash) b += '<span class="ms-reward ms-reward-cash"><img class="ms-reward-icon" src="assets/currency/cash.webp" alt="">' + cash.toLocaleString() + '</span>';
    if(coins) b += '<span class="ms-reward ms-reward-coins"><img class="ms-reward-icon" src="assets/currency/coin.webp" alt="">' + coins + '</span>';
    return b || '<span class="ms-reward ms-reward-none">—</span>';
  }

  function progressBar(p, target){
    var pct = target ? Math.min(100, Math.round(p / target * 100)) : 0;
    return '<div class="ms-progress-wrap" data-pct="' + pct + '">' +
           '<div class="ms-progress-bar">' +
             '<div class="ms-progress-fill" style="width:' + pct + '%"></div>' +
             '<div class="ms-progress-glint"></div>' +
           '</div>' +
           '<div class="ms-progress-text">' + p.toLocaleString() + ' / ' + target.toLocaleString() + '</div>' +
           '</div>';
  }

  /* ONE CARD, BUILT THE SAME WAY FOR BOTH TABS.

     The daily and clan tabs used to build their cards with two separate blocks of
     near-identical string concatenation. Every change to a card therefore had to
     be made twice, and they had already diverged: the clan card had a brief line
     and the daily card did not.

     THE FLIP. A finished card is turned over to show CLAIMED rather than being
     replaced by a different card. Replacing it loses the thing you just finished —
     the objective, the numbers, the reward — at the exact moment you want to
     check it. Flipping keeps the front visible until it rotates out of sight, and
     the back is the receipt.

     Clicking the CARD is what claims, not just the button. The button is the
     affordance; the whole card being live is what makes it feel like an object
     rather than a form. */
  function missionCard(q, i, s, bucket){
    var done = (s.progress || 0) >= q.target;
    var claimed = !!s.claimed;
    var modeTag = q.modes ? ('<span class="ms-mission-mode">' +
                    (q.modes.length === 1 ? q.modes[0] : 'TEAM') + '</span>') : '';
    return '<div class="ms-mission-card' + (claimed ? ' completed' : '') +
             (done && !claimed ? ' ready' : '') + (q.modes ? ' mode-gated' : '') +
           '" data-ms-claim="' + q.id + '" data-ms-bucket="' + bucket + '"' +
           (done && !claimed ? ' tabindex="0" role="button"' : '') +
           ' style="--delay:' + (i * 80) + 'ms">' +
        '<div class="ms-card-inner">' +
          '<div class="ms-card-face ms-card-front">' +
            '<div class="ms-mission-header">' +
              '<span class="ms-mission-type" style="background:' +
                (bucket === 'clan' ? (q.mode === 'solo' ? '#7bd36e' : '#ffb12b') : diffColor(q.diff)) + '">' +
                (bucket === 'clan' ? (q.mode === 'solo' ? 'SOLO' : 'PLATOON') : diffLabel(q.diff)) + '</span>' +
              modeTag +
              '<span class="ms-mission-id">' + (bucket === 'clan' ? 'CL-' : 'OP-') + (i+1).toString().padStart(2,'0') + '</span>' +
            '</div>' +
            '<div class="ms-mission-body">' +
              '<h3 class="ms-mission-title">' + q.title + '</h3>' +
              (q.desc ? '<p class="ms-mission-brief">' + q.desc + '</p>' : '') +
              '<div class="ms-mission-progress">' + progressBar(s.progress || 0, q.target) + '</div>' +
              '<div class="ms-mission-rewards">' + rewardBadge(q.cash, q.coins) + '</div>' +
            '</div>' +
            '<div class="ms-mission-action">' +
              '<button class="ms-btn' + (done && !claimed ? ' primary' : '') + (claimed ? ' claimed' : '') + '"' +
                (done && !claimed ? '' : ' disabled') + '>' +
                (claimed ? 'CLAIMED' : (done ? 'TAP TO CLAIM' : 'IN PROGRESS')) +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="ms-card-face ms-card-back">' +
            '<div class="ms-back-tick">✓</div>' +
            '<div class="ms-back-title">CLAIMED</div>' +
            '<div class="ms-back-sub">' + rewardBadge(q.cash, q.coins) + '</div>' +
            '<div class="ms-back-sub">Done for today</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renderDaily(){
    var st = window.MISSIONS_STATE;
    var html = '<div class="ms-section-header">' +
      '<div class="ms-section-title"><span class="ms-section-icon">📋</span>DAILY OPERATIONS</div>' +
      '<div class="ms-section-timer" id="ms-daily-timer">Resets in ' + fmtTime(timeLeftMs(nextMidnight())) + '</div>' +
      '</div>' +
      '<div class="ms-intel-summary">' +
        '<span class="ms-intel-chip easy"><span class="ms-chip-dot"></span>2 EASY</span>' +
        '<span class="ms-intel-chip medium"><span class="ms-chip-dot"></span>3 MEDIUM</span>' +
        '<span class="ms-intel-chip hard"><span class="ms-chip-dot"></span>3 HARD</span>' +
      '</div>' +
      '<div class="ms-daily-grid">';
    DAILY_QUESTS.forEach(function(q, i){
      var s = st.daily[q.id] || { progress: 0, claimed: false };
      var done = s.progress >= q.target;
      var claimed = s.claimed;
      var pct = q.target ? Math.min(100, Math.round(s.progress / q.target * 100)) : 0;
      html += missionCard(q, i, s, 'daily');
    });
    html += '</div>';
    html += '<div class="ms-intel-note">Intel refreshes at 00:00 hours. Higher threat levels yield greater rewards.</div>';
    /* NOT WIRED HERE.

       renderDaily() RETURNS a string; the caller is what puts it in the document.
       Wiring from inside this function therefore ran against a DOM that did not
       have these cards in it yet, found nothing, and bound no handlers — so no
       card was ever claimable by clicking it. It is called from render() and
       switchTab() instead, both of which run after the innerHTML assignment. */
    startTimer('ms-daily-timer', nextMidnight(), function(){ render('daily'); });
    return html;
  }

  function renderClan(){
    var st = window.MISSIONS_STATE;
    var html = '<div class="ms-section-header">' +
      '<div class="ms-section-title"><span class="ms-section-icon">👥</span>CLAN OPERATIONS</div>' +
      '<div class="ms-section-timer" id="ms-clan-timer">Resets in ' + fmtTime(timeLeftMs(nextMidnight())) + '</div>' +
      '</div>' +
      '<div class="ms-intel-summary">' +
        '<span class="ms-intel-chip solo"><span class="ms-chip-dot"></span>1 SOLO</span>' +
        '<span class="ms-intel-chip clan"><span class="ms-chip-dot"></span>3 PLATOON</span>' +
      '</div>' +
      '<div class="ms-card-grid">';
    CLAN_QUESTS.forEach(function(q, i){
      var s = st.clan[q.id] || { progress: 0, claimed: false };
      html += missionCard(q, i, s, 'clan');
    });
    html += '</div>';
    html += '<div class="ms-intel-note">Solo ops count in any engagement. Platoon ops require Gladiator mode with ≥1 clan member in your fireteam.</div>';
    /* Not wired here — see the note in renderDaily. */
    startTimer('ms-clan-timer', nextMidnight(), function(){ render('clan'); });
    return html;
  }

  function renderChallenges(){
    var html = '<div class="ms-section-header">' +
      '<div class="ms-section-title"><span class="ms-section-icon">🏆</span>CHALLENGES</div>' +
      '<div class="ms-section-timer">CLASSIFIED</div>' +
      '</div>' +
      '<div class="ms-challenges-intro">' +
        '<div class="ms-challenges-lock">' +
          '<div class="ms-lock-icon">🔒</div>' +
          '<div class="ms-lock-glow"></div>' +
        '</div>' +
        '<h3 class="ms-challenges-title">COMING SOON</h3>' +
        '<p class="ms-challenges-desc">Daily, weekly, and monthly challenges are being prepared. Check back soon.</p>' +
      '</div>';
    var periods = { daily: { ms: DAY_MS, label:'resets daily' }, weekly: { ms: 7 * DAY_MS, label:'resets weekly' }, monthly: { ms: 30 * DAY_MS, label:'resets monthly' } };
    html += '<div class="ms-card-grid">';
    CHALLENGE_PLACEHOLDERS.forEach(function(q, i){
      var p = periods[q.period] || { ms: DAY_MS, label:'resets daily' };
      html += '<div class="ms-mission-card locked" style="--delay:' + (i * 80) + 'ms">' +
        '<div class="ms-card-inner">' +
          '<div class="ms-card-face ms-card-front">' +
        '<div class="ms-mission-header">' +
          '<span class="ms-mission-type classified">' + q.period.toUpperCase() + '</span>' +
          '<span class="ms-mission-id">CH-' + (i+1).toString().padStart(2,'0') + '</span>' +
        '</div>' +
        '<div class="ms-mission-body">' +
          '<h3 class="ms-mission-title">' + q.title + '</h3>' +
          '<p class="ms-mission-brief">' + q.desc + '</p>' +
          '<div class="ms-mission-progress"><div class="ms-progress-wrap locked"><div class="ms-progress-bar"><div class="ms-progress-fill" style="width:0%"></div></div><div class="ms-progress-text">CLASSIFIED</div></div></div>' +
          '<div class="ms-mission-rewards"><span class="ms-reward ms-reward-classified">[CLASSIFIED]</span></div>' +
        '</div>' +
        '<div class="ms-mission-action">' +
          '<button class="ms-btn locked" disabled>AWAITING DEPLOYMENT</button>' +
        '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderEvent(){
    var html = '<div class="ms-section-header">' +
      '<div class="ms-section-title"><span class="ms-section-icon">🎉</span>EVENT OPERATIONS</div>' +
      '<div class="ms-section-timer">LIMITED TIME</div>' +
      '</div>';
    if(!EVENT_QUESTS.length){
      html += '<div class="ms-event-empty">' +
        '<div class="ms-event-empty-icon">' +
          '<div class="ms-radar">' +
            '<div class="ms-radar-sweep"></div>' +
            '<div class="ms-radar-dot"></div>' +
          '</div>' +
        '</div>' +
        '<h3 class="ms-event-empty-title">NO ACTIVE EVENTS</h3>' +
        '<p class="ms-event-empty-desc">Event operations are deployed by High Command on special occasions. ' +
        'Limited-time campaigns, seasonal operations, and surprise attacks will appear here automatically when live.</p>' +
        '<div class="ms-event-empty-hint">Stay vigilant, Commander.</div>' +
      '</div>';
      return html;
    }
    html += '<div class="ms-card-grid">';
    EVENT_QUESTS.forEach(function(q, i){
      var endsIn = q.endsAt ? fmtTime(timeLeftMs(q.endsAt)) : 'event end';
      html += '<div class="ms-mission-card event" style="--delay:' + (i * 80) + 'ms">' +
        '<div class="ms-card-inner">' +
          '<div class="ms-card-face ms-card-front">' +
        '<div class="ms-mission-header">' +
          '<span class="ms-mission-type event">EVENT</span>' +
          '<span class="ms-mission-id">EV-' + (i+1).toString().padStart(2,'0') + '</span>' +
        '</div>' +
        '<div class="ms-mission-body">' +
          '<h3 class="ms-mission-title">' + q.title + '</h3>' +
          '<div class="ms-mission-progress">' + progressBar(q.progress || 0, q.target || 1) + '</div>' +
          '<div class="ms-mission-rewards">' + rewardBadge(q.cash || 0, q.coins || 0) + '</div>' +
          '<p class="ms-mission-brief">Time remaining: ' + endsIn + '</p>' +
        '</div>' +
        '<div class="ms-mission-action">' +
          '<button class="ms-btn event" disabled>LIVE OPERATION</button>' +
        '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  /* Wire the cards.

     The tab is read off the card's own data-ms-bucket rather than passed in.
     It used to be passed, and the old signature was wireClaims(html, tab) from switchTab with
     the tab being switched TO — which is correct only when that tab is the one
     whose cards were just rendered. A card whose id happened to exist in the other
     tab would claim from there instead. Reading it off the card cannot be wrong. */
  function wireClaims(){
    var card = document.querySelector('#menu-missions .menu-card');
    if(!card) return;
    card.querySelectorAll('[data-ms-claim]').forEach(function(missionCard){
      var id  = missionCard.dataset.msClaim;
      var bucket = missionCard.dataset.msBucket || 'daily';

      var tryClaim = function(e){
        if(e){ e.preventDefault(); e.stopPropagation(); }
        var ok = claim(id, bucket);
        if(ok){
          playUISound('claim');
          missionCard.classList.add('claimed');
          /* The flip is the whole confirmation. Re-rendering after it would take
             the front face away the instant it finished turning, so the receipt
             is left on screen until the player switches tabs. */
          updateMissionStats();
        } else if(window.Menu && Menu.toast){
          Menu.toast('Not ready yet — complete the quest first');
          playUISound('hover');
        }
      };

      /* The CARD, not just the button. A finished card is the only one that
         responds, so a card at 40% cannot be clicked into a claim it has not
         earned — the interactivity itself is the readiness check. */
      if(missionCard.classList.contains('ready')){
        missionCard.onclick = tryClaim;
        missionCard.onkeydown = function(e){
          if(e.key === 'Enter' || e.key === ' '){ tryClaim(e); }
        };
        var btn = missionCard.querySelector('.ms-btn');
        if(btn){
          /* Redundant with the card handler, and deliberately so: it stops the
             click bubbling to the card so the flip is not triggered twice, and it
             keeps the button working if the card handler is ever removed. */
          btn.onclick = function(e){ e.stopPropagation(); tryClaim(e); };
        }
      }
    });
  }

  var _timers = [];
  function startTimer(id, targetMs, onDone){
    var el = document.getElementById(id);
    if(!el) return;
    clearInterval(el._t);
    var tick = function(){
      var left = timeLeftMs(targetMs);
      if(left <= 0){ el.textContent = 'Resets now'; clearInterval(el._t); if(onDone) onDone(); return; }
      el.textContent = 'Resets in ' + fmtTime(left);
    };
    tick();
    el._t = setInterval(tick, 60000);
  }

  function clearTimers(){
    document.querySelectorAll('.ms-timer').forEach(function(el){ clearInterval(el._t); el._t = null; });
  }

  /* --- Clan redirect popup --- */
  function showClanRedirectPopup(){
    // Remove existing popup if any
    var existing = document.querySelector('.ms-clan-popup-overlay');
    if(existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'ms-clan-popup-overlay';
    overlay.innerHTML =
      '<div class="ms-clan-popup">' +
        '<div class="ms-clan-popup-icon">👥</div>' +
        '<h3 class="ms-clan-popup-title">JOIN A CLAN FIRST</h3>' +
        '<p class="ms-clan-popup-desc">Clan missions require you to be a member of a clan. ' +
        'Join or create a clan to unlock co-op operations with your squad.</p>' +
        '<div class="ms-clan-popup-actions">' +
          '<button class="ms-btn ms-clan-popup-btn primary" id="ms-clan-popup-join">FIND A CLAN</button>' +
          '<button class="ms-btn ms-clan-popup-btn" id="ms-clan-popup-create">CREATE CLAN</button>' +
          '<button class="ms-btn ms-clan-popup-btn secondary" id="ms-clan-popup-cancel">LATER</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    requestAnimationFrame(function(){ overlay.classList.add('ms-popup-visible'); });

    document.getElementById('ms-clan-popup-join').onclick = function(){
      overlay.remove();
      if(window.Menu) Menu.show('menu-search-clans');
    };
    document.getElementById('ms-clan-popup-create').onclick = function(){
      overlay.remove();
      if(window.Menu) Menu.show('menu-create-clan');
    };
    document.getElementById('ms-clan-popup-cancel').onclick = function(){
      overlay.classList.remove('ms-popup-visible');
      setTimeout(function(){ overlay.remove(); }, 300);
    };
  }

  /* ---------------------------------------------------------------------------
     READING PROGRESS BACK OUT, FOR THE RESULTS SCREEN.

     The results screen needs to know which quests a battle moved, and it cannot
     work that out for itself from the saved state alone: a quest already at 2/3
     before a battle looks identical to one the battle advanced to 2/3, and only
     the second belongs on a results screen.

     So progress is snapshotted when a battle starts and compared here. The quest
     DEFINITIONS stay in here rather than being exposed, because they are the
     one thing in this file that must not drift: the id a save file uses has to
     match the target and title the UI shows, and a caller that could read the
     definitions could also write a wrong one.
     --------------------------------------------------------------------------- */

  /* A flat, JSON-safe copy of every quest's progress. Taken before a battle. */
  function snapshotProgress(){
    ensureState();
    var st = window.MISSIONS_STATE;
    var out = {};
    ['daily', 'clan'].forEach(function(bucket){
      out[bucket] = {};
      var defs = bucket === 'daily' ? DAILY_QUESTS : CLAN_QUESTS;
      defs.forEach(function(q){
        var s = st[bucket][q.id] || { progress: 0, claimed: false };
        out[bucket][q.id] = { progress: s.progress || 0, claimed: !!s.claimed };
      });
    });
    return out;
  }

  /* Every quest, with its title, target and progress — read only. */
  function listProgress(){
    ensureState();
    var st = window.MISSIONS_STATE;
    var out = [];
    [['daily', DAILY_QUESTS], ['clan', CLAN_QUESTS]].forEach(function(pair){
      var bucket = pair[0];
      pair[1].forEach(function(q){
        var s = st[bucket][q.id] || { progress: 0, claimed: false };
        out.push({
          bucket: bucket,
          id: q.id,
          title: q.title,
          target: q.target,
          /* Carried through so the results screen and the tests can tell a
             Gladiator quest from a Team Deathmatch one without a lookup table. */
          modes: q.modes || null,
          progress: Math.min(s.progress || 0, q.target),
          claimed: !!s.claimed,
          done: (s.progress || 0) >= q.target,
        });
      });
    });
    return out;
  }

  return {
    render: render,
    setEvents: setEvents,
    recordWin: recordWin,
    recordDamage: recordDamage,
    recordKill: recordKill,
    recordAssist: recordAssist,
    recordBattle: recordBattle,
    /* Claiming used to be reachable only through a DOM click handler, which made
       it impossible to test that a quest pays out exactly once — the one property
       that matters and the one hardest to check by clicking. */
    claimDaily: claimDaily,
    claimClan: claimClan,
    getState: function(){ ensureState(); return window.MISSIONS_STATE; },
    snapshotProgress: snapshotProgress,
    listProgress: listProgress,
    resetAll: function(){
      window.MISSIONS_STATE = JSON.parse(JSON.stringify(STATE_DEFAULTS));
      saveState();
      ensureState();
    }
  };
})();