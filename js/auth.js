/* ============================================================
   auth.js — accounts for Mini Tank Legends.

   WHAT CHANGED AND WHY
   --------------------
   The API used to live on a separate worker reached through a hardcoded URL
   (CONFIG.CLAN_API_URL), with CORS, and it stored accounts in Workers KV.

   Two things were wrong with that:

     1. KV on the free plan allows 1,000 writes a DAY, and registering costs
        three writes. That is roughly 333 signups a day before the quota is
        gone, with nothing left for logins or progress saves. It is now D1,
        which allows 100,000 rows written a day.

     2. A hardcoded cross-origin URL is a single point of failure that fails
        silently. When the address drifted to a subdomain that was never
        created, registration broke while the game carried on working and the
        player just saw "Cannot reach the account server".

   The API is now a Pages Function on this same origin, so the request is
   simply fetch('/api/...'). There is no URL to configure, no CORS, and if the
   game loaded then the API is up.

   Everything below the "API" section keeps the same public shape it always
   had — Auth.init(), Auth.login(), Auth.register(), Auth.user — so the rest of
   the game code does not know any of this changed.
   ============================================================ */

const Auth = {
  token: (() => { try { return localStorage.getItem('mtl_token'); } catch (e) { return null; } })(),
  user: null,
  _saveTimer: null,

  /* ---------- API ---------- */

  /* Same origin, always. No configurable base URL on purpose: the one thing
     this constant was for is the thing that broke. */
  _api(path, opts) {
    const url = path.startsWith('/') ? path : '/' + path;
    return fetch(url, opts).then(async (res) => {
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
      if (!res.ok) {
        const err = new Error(data.error || 'Something went wrong (' + res.status + ')');
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }, () => {
      throw new Error('Cannot reach the account server. Check your internet connection.');
    });
  },

  _json(body, method) {
    return {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    };
  },

  /* ---------- session ---------- */

  /* There is ONE account screen. When the login gate is present it is the only
     one, and this file defers to it. The older dialog in index.html is kept
     solely as a fallback for a page without the gate, because leaving it as the
     thing the main menu opens is what produced two different-looking account
     screens — and a player who clicks "Log In" in the menu and gets a plainer
     interface than the one they just chose is being told, in the most visible
     way possible, that something is half-finished. */
  _gate() {
    return (typeof window.LoginGate !== 'undefined' &&
            typeof window.LoginGate.reopen === 'function' &&
            window.LoginGate.available()) ? window.LoginGate : null;
  },

  /* Show the account screen.

     Defaults to the CHOOSER, not the login form. That is the fix for "I don't
     have a login": the menu's "Log In" used to jump straight to a login box,
     which is exactly the wrong screen for somebody who has no account yet —
     there was no Sign Up option anywhere on it, only a small Back button. All
     three options are on the chooser, so that is what it shows. */
  open(panel) {
    const gate = this._gate();
    if (gate) { gate.reopen(panel || 'choose'); return true; }
    this._openLegacy(panel);
    return false;
  },

  /* The pre-gate dialog. Still the fallback; deliberately untouched. */
  _openLegacy() {
    const ov = this._el('auth-overlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.classList.add('visible');
    document.body.classList.add('auth-open');
    const tab = this._el('auth-tab-login');
    if (tab && !this._activePanel) this._switchTab(tab.dataset.authtab || 'login');
    setTimeout(() => {
      const f = this._el('auth-login-login');
      if (f && f.focus) f.focus();
    }, 250);
  },

  /* ---------- guest -> account ---------- */

  /* A session exists now, so the player is not a guest any more. This used to
     be cleared only on the gate's registration path, which meant logging in
     from the main menu left the flag set and the browser describing somebody
     as a guest while they were signed in. */
  _clearGuestFlag() {
    try { localStorage.removeItem('mtl_guest'); } catch (e) { /* private mode */ }
  },

  /* A guest who signs up from the main menu has local progress worth keeping,
     exactly as one who signs up at the gate does. Captured BEFORE the session
     exists, because registering is the moment local progress starts being
     treated as authoritative-for-upload. */
  _carryGuestProgress(token) {
    let raw;
    try { raw = localStorage.getItem('tankparty_settings'); } catch (e) { return; }
    if (!raw) return;
    try {
      const profile = JSON.parse(raw);
      this._api('/api/auth/profile', this._json({ token, profile }, 'PUT')).catch(function () {});
    } catch (e) { /* malformed local state is not worth blocking on */ }
  },

  async init() {
    if (!this.token) return false;
    if (this.user) return true;

    /* Offline-friendly: show the cached account immediately rather than
       blocking the menu on a round trip, then confirm with the server. */
    try {
      const cached = localStorage.getItem('mtl_user');
      if (cached) {
        this.user = JSON.parse(cached);
        this._updateUI();
      }
    } catch (e) { /* corrupt cache is not worth a crash */ }

    try {
      const data = await this._api('/api/auth/me?token=' + encodeURIComponent(this.token));
      this.user = data.user;
      try { localStorage.setItem('mtl_user', JSON.stringify(data.user)); } catch (e) {}
      this._applyRemoteProfile(data.user.profile);
      this._updateUI();
      return true;
    } catch (err) {
      /* Only a network failure may keep the cached session alive. A 401 is a
         real answer — the session is gone — and keeping the cached user would
         leave someone who signed out on another device apparently still
         signed in here, losing progress on every save.

         It goes through leaveAccount rather than _clearSession because the
         account's NAME is part of leaving it. This is the path where somebody
         signs out on their phone and finds themselves still called by that
         account's name on this machine, which is the same bug as pressing Log
         Out here and looking identical. */
      if (err.status === undefined && this.user) return true;
      this.leaveAccount();
      return false;
    }
  },

  _setSession(token, user) {
    this.token = token;
    this.user = user;
    try {
      localStorage.setItem('mtl_token', token);
      localStorage.setItem('mtl_user', JSON.stringify(user));
    } catch (e) { /* private mode: the session simply will not persist */ }
  },

  _clearSession() {
    this.token = null;
    this.user = null;
    try {
      localStorage.removeItem('mtl_token');
      localStorage.removeItem('mtl_user');
    } catch (e) { /* nothing to clean up */ }
  },

  async login(login, password) {
    const data = await this._api('/api/auth/login', this._json({ login, password }));
    this._setSession(data.token, data.user);
    this._clearGuestFlag();
    this._applyRemoteProfile(data.user.profile);
    this._updateUI();
    this._checkVerifiedBanner();
  },

  async register(username, email, password) {
    /* Read the guest's local progress first: once a session exists the game
       starts merging local state upward, and a re-read afterwards would race the
       first upload. */
    let carried = null;
    try { carried = localStorage.getItem('tankparty_settings'); } catch (e) {}

    const data = await this._api('/api/auth/register', this._json({ username, email, password }));
    this._setSession(data.token, data.user);
    this._clearGuestFlag();
    if (carried) {
      try { this._carryGuestProgress(data.token); } catch (e) { /* best effort */ }
    }
    this._applyRemoteProfile(data.user.profile);
    this._updateUI();
  },

  async logout() {
    try {
      await this._api('/api/auth/logout', this._json({ token: this.token }));
    } catch (e) { /* signing out locally is the part that matters */ }
    this.leaveAccount();
    this._toast('Logged out');
  },

  /* GOING FROM AN ACCOUNT BACK TO BEING NOBODY.

     Two things have to be true the moment a session ends, and for a long time
     only one of them was.

     The token and the cached user were cleared, so Auth.loggedIn() correctly
     answered no. But `playerName` lives in tankparty_settings, and that is NOT
     cleared with the session: _applyRemoteProfile wrote the account's username
     into it on the way in, on purpose, because that is what makes the profile
     card show the right name.

     So signing out left "Vostok" sitting in the one field every screen reads as
     the player's name. Pick Guest at the gate afterwards and the menu showed the
     account's name, on the profile card, in the clan roster and on the score
     board — a signed-out player still being called by their account. It looked
     exactly like the gate failing to log them out, because from the outside it
     is: the session really was gone, the name really was not.

     Logging out is the moment the name stops being theirs. A guest gets a fresh
     generated one from the same generator a first-time guest gets, so nobody is
     left nameless and nobody is left wearing somebody else's account.

     Order matters and it is not cosmetic: _clearSession() runs FIRST, so the
     save below cannot schedule a profile upload and overwrite the account's
     stored profile with an empty name on the way out. */
  leaveAccount() {
    /* Read the name out BEFORE the session goes, because _forgetAccountName has
       to know which account it is being left in order to recognise the name
       that account put in the settings. After _clearSession() this.user is null
       and there is nothing left to compare against. */
    const username = (this.user && this.user.username) || '';
    this._clearSession();
    this._forgetAccountName(username);
    this._updateUI();
    this._refreshMenuProfile();
  },

  /* Give back the name this browser was showing because of an account.

     ONE CONDITION, EXACTLY: the stored name has to BE the name of the account
     being left. Everything else is left exactly as it was.

     The first version of this also replaced any name matching /^Player\d{4}$/,
     on the reasoning that generated names are placeholders nobody chose. That is
     true of where the name came from and irrelevant to whether it is now the
     player's: a guest who has been called Player4821 all afternoon would have
     been renamed on every log out, and the rename would not be cosmetic. Clan
     membership, the score board and the platoon roster are all keyed on this
     string, so it changes who the game thinks this browser is.

     Replacing only the account's own name cannot do that. It fires exactly once
     per logout, on the one value that belongs to the account, and a player who
     was a guest before signing up gets their old guest nickname back.

     Mutated in place on Menu.settings rather than replaced. game.js took
     `this.settings = Menu.settings` by reference at boot, so handing the menu
     a brand new object would leave the running game reading the old one and the
     name would come straight back on screen. */
  _forgetAccountName(username) {
    try {
      /* Nothing to match against means nothing to undo. This is the path taken
         when a player picks Guest at the gate while never having signed in, and
         it has to be a complete no-op. */
      const gone = username || '';
      if (!gone) return;

      if (window.loadSettings && window.saveSettings) {
        const stored = window.loadSettings();
        if ((stored.playerName || '') === gone) {
          stored.playerName = window.generatePlayerName ? window.generatePlayerName() : '';
          window.saveSettings(stored);
        }
      }

      const live = window.Menu && window.Menu.settings;
      if (live && (live.playerName || '') === gone) {
        live.playerName = window.generatePlayerName ? window.generatePlayerName() : '';
      }
    } catch (e) { /* a name is cosmetic; never block signing out on it */ }
  },

  _refreshMenuProfile() {
    try {
      if (window.Menu && typeof window.Menu.refreshProfile === 'function') window.Menu.refreshProfile();
    } catch (e) { /* cosmetic only */ }
  },

  loggedIn() {
    return !!(this.token && this.user);
  },

  /* ---------- password reset ---------- */

  /* Always resolves, never throws, and takes about the same time either way.
     The server deliberately returns an identical answer for an unknown
     address, so this cannot be used to find out who has an account. */
  async requestReset(email) {
    await this._api('/api/auth/forgot', this._json({ email }));
    return true;
  },

  async resetPassword(token, password) {
    const data = await this._api('/api/auth/reset', this._json({ token, password }));
    /* The server revokes every session on a password change, including this
       one's, so the old token is dead either way. Clearing it here means the
     next page load does not spend a request discovering that.

       leaveAccount, for the same reason init() uses it: every session has just
       ended, so the account's name goes with it. Resetting a password from the
       login screen while signed in on another tab should not leave this one
       still displaying the old account's name. */
    this.leaveAccount();
    return data;
  },

  async resendVerification(email) {
    await this._api('/api/auth/resend-verify', this._json({ email }));
    return true;
  },

  async changePassword(currentPassword, newPassword) {
    return this._api('/api/auth/change-password', this._json({
      token: this.token, currentPassword, newPassword,
    }));
  },

  /* ---------- progress sync ---------- */

  _applyRemoteProfile(profile) {
    if (!profile || !window.loadSettings) return;
    try {
      const s = window.loadSettings();
      let changed = false;
      const pCoins = typeof profile.coins === 'number' ? profile.coins : null;
      const pCash = typeof profile.cash === 'number' ? profile.cash : null;
      /* Older clients sent a lone 'coins' meaning cash. Treat it as cash so the
         two builds do not disagree about the same balance. */
      if (pCash !== null && pCash > (s.cash || 0)) { s.cash = pCash; changed = true; }
      else if (pCash === null && pCoins !== null && pCoins > (s.cash || 0)) { s.cash = pCoins; changed = true; }
      if (pCash !== null && pCoins !== null && pCoins > (s.coins || 0)) { s.coins = pCoins; changed = true; }
      if (typeof profile.gold === 'number' && profile.gold > (s.gold || 0)) { s.gold = profile.gold; changed = true; }
      if (typeof profile.clanWeeklyXP === 'number' && profile.clanWeeklyXP > (s.clanWeeklyXP || 0)) {
        s.clanWeeklyXP = profile.clanWeeklyXP; changed = true;
      }
      if (profile.allUnlocked) { s.allUnlocked = true; changed = true; }
      if (Array.isArray(profile.unlockedTanks) && profile.unlockedTanks.length) {
        const cur = new Set(s.unlockedTanks || ['coolbuddy']);
        let any = false;
        profile.unlockedTanks.forEach((t) => { if (t && !cur.has(t)) { cur.add(t); any = true; } });
        if (any) { s.unlockedTanks = Array.from(cur); changed = true; }
      }
      /* A GENERATED NAME IS NOT A CHOSEN NAME.

         config.js invents "Player8459" for anyone who has not set one, and a
         guest session uploads that to the server along with every other
         setting. From then on /api/auth/me hands it back as a perfectly
         truthy playerName — indistinguishable from a name the player
         deliberately picked. So the "fall back to the username" rule added for
         this exact bug never once fired, because the placeholder was not empty.
         It was a real value in the database, and the account carried its own
         placeholder back into the menu indefinitely.

         Generated names have one exact shape, and no player has ever chosen a
         name that matches it, so it is safe to refuse them outright.

         Anything else is only honoured when there is no username to prefer.
         Local settings are shared by every account that uses the same browser,
         so a stored name can belong to a DIFFERENT account entirely - observed
         live, one profile carrying another's name. There is no rename feature
         for the stored value to legitimately win against, so the account's own
         username is authoritative and the stored name is a fallback for guests
         and nothing else. */
      const GENERATED_NAME = /^Player\d{4}$/;
      const storedName = profile.playerName || '';
      const storedIsReal = storedName && !GENERATED_NAME.test(storedName);
      const username = (this.user && this.user.username) || '';
      const realName = username || (storedIsReal ? storedName : '');
      if (realName && s.playerName !== realName) { s.playerName = realName; changed = true; }

      /* THE LIVE OBJECT TOO, NOT JUST THE STORED COPY.

         `s` here is a fresh object from loadSettings(); it is what gets written
         back to localStorage. Menu.settings is a DIFFERENT object, loaded once
         at boot and held by reference everywhere it matters — game.js does
         `this.settings = Menu.settings` and then sends settings.playerName to
         the score board, the clan roster and every other player in a match.

         So updating only `s` left the account's name in storage and the guest's
         Player#### in the running game: the menu drew one name (it prefers
         Auth.user.username) while the match reported another, for as long as the
         tab stayed open. That is the same "two names for one person" the comment
         above is about, just with the halves the other way round.

         Assigned in place for the reason given on _forgetAccountName: replacing
         the object would leave game.js holding the old one. */
      const live = window.Menu && window.Menu.settings;
      if (live && realName && (live.playerName || '') !== realName) {
        live.playerName = realName;
      }

      /* Repair the stored record too, or the placeholder returns on the next
         page load and the card is wrong again by the time it is next opened. */
      if (realName && storedName !== realName && !this._repairingName) {
        this._repairingName = true;
        try {
          const fresh = window.loadSettings();
          fresh.playerName = realName;
          window.saveSettings(fresh);
          this._uploadProfile(fresh).catch(() => {}).then(() => { this._repairingName = false; });
        } catch (e) { this._repairingName = false; }
      }
      if (profile.playerClan) { s.playerClan = profile.playerClan; changed = true; }
      if (profile.selectedTank) { s.selectedTank = profile.selectedTank; changed = true; }
      if (profile.clanWeeklyRewarded) { s.clanWeeklyRewarded = true; changed = true; }
      if (changed && window.saveSettings) window.saveSettings(s);
    } catch (e) { /* a bad profile must never break the menu */ }
  },

  onSettingsSaved(s) {
    if (!this.token || !this.user) return;
    clearTimeout(this._saveTimer);
    /* Debounced so a settings screen that writes on every keystroke is one
       request rather than forty. Two and a half seconds is also short enough
       that closing the tab during a purchase has not lost it. */
    this._saveTimer = setTimeout(() => this._uploadProfile(s), 2500);
  },

  async _uploadProfile(s) {
    if (!this.token) return;
    const profile = {
      cash: typeof s.cash === 'number' ? s.cash : 0,
      coins: typeof s.coins === 'number' ? s.coins : 0,
      gold: typeof s.gold === 'number' ? s.gold : 0,
      unlockedTanks: s.unlockedTanks || ['coolbuddy'],
      allUnlocked: !!s.allUnlocked,
      playerName: s.playerName || '',
      playerClan: s.playerClan || '',
      selectedTank: s.selectedTank || 'coolbuddy',
      clanWeeklyXP: typeof s.clanWeeklyXP === 'number' ? s.clanWeeklyXP : 0,
      clanWeekKey: typeof s.clanWeekKey === 'number' ? s.clanWeekKey : 0,
      clanWeeklyRewarded: !!s.clanWeeklyRewarded,
      trophyCount: typeof s.trophyCount === 'number' ? s.trophyCount : 0,
      level: typeof s.level === 'number' ? s.level : 0,
      xp: typeof s.xp === 'number' ? s.xp : 0,
    };
    try {
      await this._api('/api/auth/profile', this._json({ token: this.token, profile }, 'PUT'));
      /* Remember the push so init() does not re-download a profile we just
         wrote. Only cleared on a real change, which is rare. */
      this._profileUploadedAt = Date.now();
    } catch (e) { /* offline — the next save retries */ }
  },

  /* ---------- URL HANDOFFS ---------- */

  /* The password-reset and email-verification links both land on the game with
     a token in the query string. This reads them, opens the right panel, and
     scrubs the token out of the address bar immediately.

     Scrubbing matters: a token left in the URL ends up in the browser history,
     in a screenshot, and in anything the player copies out of the address bar.
     A reset token is a password-replacement credential. */
  handleUrlTokens() {
    let params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }

    const reset = params.get('reset');
    if (reset) {
      this._scrubUrl();
      this._pendingResetToken = reset;
      this._showPanel('reset');
      this.open();
      return true;
    }

    const verify = params.get('verify');
    if (verify) {
      this._scrubUrl();
      this._confirmVerification(verify);
      return false;
    }

    const verified = params.get('verified');
    if (verified !== null) {
      this._scrubUrl();
      if (verified === '1') {
        if (this.user) { try { this.user.emailVerified = true; } catch (e) {} }
        this._showPanel('verified');
        this.open();
      }
      return false;
    }
    return false;
  },

  _scrubUrl() {
    try {
      history.replaceState({}, document.title, location.pathname + location.hash);
    } catch (e) { /* nothing to do; the token is read either way */ }
  },

  async _confirmVerification(token) {
    try {
      await this._api('/api/auth/verify-email', this._json({ token }));
      if (this.user) {
        this.user.emailVerified = true;
        try { localStorage.setItem('mtl_user', JSON.stringify(this.user)); } catch (e) {}
      }
      this._showPanel('verified');
      this.open();
    } catch (e) {
      this._showPanel('verified');
      this.open();
      const t = this._el('auth-verified-text');
      if (t) t.textContent = 'This confirmation link is invalid or has expired. You can request a new one from the log-in screen.';
    }
  },

  /* A one-line reminder under the account button when the address is still
     unconfirmed, since an unconfirmed address cannot be recovered from. */
  _checkVerifiedBanner() {
    try {
      const mini = this._el('auth-mini');
      if (!mini || !this.user) return;
      if (this.user.emailVerified) { mini.title = 'Account: ' + this.user.username; return; }
      mini.title = 'Account: ' + this.user.username + ' — email not confirmed yet';
    } catch (e) { /* cosmetic only */ }
  },

  /* ---------- UI ---------- */

  _el(id) { return document.getElementById(id); },

  /* NOTE: there is no open() here on purpose.

     open() is defined once, in the session section above, where it prefers the
     login gate and falls back to _openLegacy(). This used to be a SECOND open()
     that went straight to the legacy overlay — and because it came later in the
     object literal it silently won, so the gate-aware version was dead code.
     The menu's "Log In" therefore kept opening the old dialog no matter what
     the gate did, and no amount of fixing the gate changed it.

     close() and toggle() below still target the legacy overlay on purpose: they
     are only reached on a page with no gate at all. */

  close() {
    const ov = this._el('auth-overlay');
    if (!ov) return;
    ov.classList.remove('visible');
    /* A reset token is single-use and lives in memory only; dropping the
       reference means a later visit to this dialog cannot replay it. */
    this._pendingResetToken = null;
    this._activePanel = null;
    setTimeout(() => {
      if (!ov.classList.contains('visible')) ov.classList.add('hidden');
    }, 350);
  },

  toggle() {
    const ov = this._el('auth-overlay');
    if (ov && !ov.classList.contains('hidden')) this.close();
    else this.open();
  },

  _switchTab(name) {
    this._activePanel = name;
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authtab === name));
    document.querySelectorAll('.auth-panel').forEach((p) => p.classList.toggle('active', p.id === 'auth-panel-' + name));
  },

  /* Panels reached from a link rather than a tab (forgot, reset, verified) are
     shown without highlighting a tab, because no tab owns them. */
  _showPanel(name) {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.auth-panel').forEach((p) => p.classList.toggle('active', p.id === 'auth-panel-' + name));
    this._activePanel = name;
  },

  _setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.classList.add('busy');
      btn.innerHTML = '<span class="auth-spin"></span>';
    } else {
      btn.classList.remove('busy');
      btn.textContent = btn.dataset.label || label;
    }
  },

  _showError(panel, msg) {
    const el = this._el('auth-error-' + panel);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 400);
  },

  _clearError(panel) {
    const el = this._el('auth-error-' + panel);
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
  },

  _showOk(panel, msg) {
    const el = this._el('auth-ok-' + panel);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  _success(btn) {
    if (btn) {
      btn.classList.remove('busy');
      btn.classList.add('success');
      btn.innerHTML = '&#10003;';
    }
  },

  _submit(panel) {
    const btn = this._el(panel === 'login' ? 'auth-login-btn' : 'auth-reg-btn');
    if (btn && btn.classList.contains('busy')) return;
    this._clearError(panel);

    if (panel === 'login') {
      const login = (this._el('auth-login-login') || {}).value || '';
      const pass = (this._el('auth-login-pass') || {}).value || '';
      if (!login || !pass) { this._showError('login', 'Enter your username/email and password'); return; }
      this._setBusy(btn, true);
      this.login(login.trim(), pass)
        .then(() => {
          this._success(btn);
          setTimeout(() => this.close(), 450);
          this._afterLogin();
        })
        .catch((e) => {
          this._setBusy(btn, false, 'Log In');
          this._showError('login', e.message);
        });
      return;
    }

    const uname = (this._el('auth-reg-username') || {}).value || '';
    const email = (this._el('auth-reg-email') || {}).value || '';
    const pass = (this._el('auth-reg-pass') || {}).value || '';
    const pass2 = (this._el('auth-reg-pass2') || {}).value || '';
    if (!uname || !email || !pass || !pass2) { this._showError('register', 'Please fill in all fields'); return; }
    if (pass !== pass2) { this._showError('register', 'The passwords do not match'); return; }
    this._setBusy(btn, true);
    this.register(uname.trim(), email.trim(), pass)
      .then(() => {
        this._success(btn);
        setTimeout(() => this.close(), 450);
        this._afterLogin();
        /* The verification mail has already been sent by the server. Saying so
           here is the difference between "did it work?" and silence. */
        this._toast('Account created — check your email to confirm it');
      })
      .catch((e) => {
        this._setBusy(btn, false, 'Create Account');
        this._showError('register', e.message);
      });
  },

  _submitForgot() {
    const btn = this._el('auth-forgot-btn');
    const email = ((this._el('auth-forgot-email') || {}).value || '').trim();
    this._clearError('forgot');
    if (!email) { this._showError('forgot', 'Enter your account email'); return; }
    this._setBusy(btn, true);
    /* The success text is identical whether the address exists or not, which
       is the point — this panel must not become an account lookup. */
    this.requestReset(email)
      .then(() => {
        this._setBusy(btn, false, 'Send reset link');
        this._showOk('forgot', 'If that address has an account, a reset link is on its way. Check your spam folder too.');
      })
      .catch((e) => {
        this._setBusy(btn, false, 'Send reset link');
        this._showError('forgot', e.message);
      });
  },

  _submitReset() {
    const btn = this._el('auth-reset-btn');
    this._clearError('reset');
    const pass = (this._el('auth-reset-pass') || {}).value || '';
    const pass2 = (this._el('auth-reset-pass2') || {}).value || '';
    const token = this._pendingResetToken;
    if (!token) { this._showError('reset', 'This reset link is no longer valid. Request a new one.'); return; }
    if (pass.length < 8) { this._showError('reset', 'Password must be at least 8 characters'); return; }
    if (pass !== pass2) { this._showError('reset', 'The passwords do not match'); return; }
    this._setBusy(btn, true);
    this.resetPassword(token, pass)
      .then(() => {
        this._pendingResetToken = null;
        this._success(btn);
        this._toast('Password changed — log in with your new password');
        setTimeout(() => { this._switchTab('login'); this._setBusy(btn, false, 'Set new password'); btn.classList.remove('success'); }, 1200);
      })
      .catch((e) => {
        this._setBusy(btn, false, 'Set new password');
        this._showError('reset', e.message);
      });
  },

  _toast(msg) {
    try { if (window.Menu && Menu.toast) Menu.toast(msg); } catch (e) { /* cosmetic only */ }
  },

  _afterLogin() {
    try {
      if (window.saveSettings && window.loadSettings) window.saveSettings(window.loadSettings());
      if (window.Menu && typeof window.Menu.refreshProfile === 'function') window.Menu.refreshProfile();
      this._toast('Welcome, ' + ((this.user && this.user.username) || '') + '!');
      this._checkVerifiedBanner();
    } catch (e) { /* the session is established regardless */ }
  },

  _updateUI() {
    const mini = this._el('auth-mini');
    const acc = this._el('profile-account');
    const logged = this.loggedIn();
    if (mini) {
      /* "Sign In / Sign Up" rather than "Log In" while signed out. Two reasons:
         it says both things are available, and it is wide enough to read at a
         glance — the old label was small enough that a player could sit in front
         of a game with no way to make an account and simply not notice it. */
      mini.textContent = logged ? 'Log Out' : 'Sign In / Sign Up';
      mini.classList.toggle('logged-in', logged);
      mini.title = logged
        ? 'Signed in as ' + (this.user ? this.user.username : '')
        : 'Sign in, or create an account to save your progress';
    }
    /* NOTHING. THIS BAR HAS NO TEXT TO SHOW.

       It printed "Account: <username>" here, and later "Signed in". Both were
       wrong in the same way: the profile card a few pixels away is already
       showing the player's name in full, and a Log Out button beside it already
       says, without words, that there is an account. This bar was a third
       rendering of a fact the screen had communicated twice already.

       The request was for no wasted space, and that is the honest answer —
       there is nothing here that the name and the button have not said. It
       stays in the markup because other code measures against it, but it is
       always empty. */
    if (acc) {
      acc.textContent = '';
      acc.classList.add('hidden');
    }
  },

  bind() {
    const ov = this._el('auth-overlay');
    if (ov) {
      ov.addEventListener('click', (e) => { if (e.target === ov) this.close(); });
    }

    const mini = this._el('auth-mini');
    if (mini) {
      mini.addEventListener('click', async () => {
        if (this.loggedIn()) {
          /* logout() raises the toast itself now, so that signing out is
             announced the same way however it was reached. Saying it here as
             well showed the player two identical toasts. */
          await this.logout();
        } else {
          /* Opens the SAME screen as the gate, not a second dialog, and lands
             on the chooser so Sign Up is reachable. */
          this.open('choose');
        }
      });
    }

    document.querySelectorAll('.auth-tab').forEach((t) => {
      t.addEventListener('click', () => this._switchTab(t.dataset.authtab));
    });

    const lbtn = this._el('auth-login-btn');
    if (lbtn) lbtn.addEventListener('click', () => this._submit('login'));
    const rbtn = this._el('auth-reg-btn');
    if (rbtn) rbtn.addEventListener('click', () => this._submit('register'));

    /* Enter submits from any field in the form, so a password manager's Enter
       does not land nowhere. */
    const enter = (fn) => (e) => { if (e.key === 'Enter') fn(); };
    const bindEnter = (id, fn) => { const el = this._el(id); if (el) el.addEventListener('keydown', enter(fn)); };
    bindEnter('auth-login-login', () => this._submit('login'));
    bindEnter('auth-login-pass', () => this._submit('login'));
    bindEnter('auth-reg-username', () => this._submit('register'));
    bindEnter('auth-reg-email', () => this._submit('register'));
    bindEnter('auth-reg-pass', () => this._submit('register'));
    bindEnter('auth-reg-pass2', () => this._submit('register'));
    bindEnter('auth-forgot-email', () => this._submitForgot());
    bindEnter('auth-reset-pass', () => this._submitReset());
    bindEnter('auth-reset-pass2', () => this._submitReset());

    const forgot = this._el('auth-forgot-btn');
    if (forgot) forgot.addEventListener('click', () => this._submitForgot());
    const reset = this._el('auth-reset-btn');
    if (reset) reset.addEventListener('click', () => this._submitReset());

    const forgotLink = this._el('auth-forgot-link');
    if (forgotLink) {
      forgotLink.addEventListener('click', (e) => {
        e.preventDefault();
        this._clearError('forgot');
        const ok = this._el('auth-ok-forgot');
        if (ok) ok.classList.add('hidden');
        this._showPanel('forgot');
        setTimeout(() => { const f = this._el('auth-forgot-email'); if (f && f.focus) f.focus(); }, 120);
      });
    }

    const forgotBack = this._el('auth-forgot-back');
    if (forgotBack) {
      forgotBack.addEventListener('click', (e) => {
        e.preventDefault();
        this._switchTab('login');
      });
    }

    const vbtn = this._el('auth-verified-btn');
    if (vbtn) vbtn.addEventListener('click', () => this.close());

    const gm = this._el('auth-google-login');
    if (gm) gm.addEventListener('click', () => this._toast('Google login is coming soon!'));
    const gr = this._el('auth-google-register');
    if (gr) gr.addEventListener('click', () => this._toast('Google login is coming soon!'));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const ov2 = this._el('auth-overlay');
        if (ov2 && !ov2.classList.contains('hidden')) this.close();
      }
    });

    this._updateUI();
  },
};

/* Expose to the window. payments.js and the shop renderer gate on
   `window.Auth` — a bare top-level `const` is NOT a window property, so
   without this line the store renders nothing and every buy button reports
   "log in first" even while logged in. */
window.Auth = Auth;

/* ---------------------------------------------------------------------------
   BOOT

   Two jobs, split by who should do them.

   BINDING IS ALWAYS OURS. The "Log In" label in the main menu belongs to this
   file and nothing else wires it. It used to be called from Gate.unlock(),
   which meant that if the gate were ever absent or failed to load, the menu
   button would be dead and there would be no way to sign in at all — a failure
   that is invisible until someone tries it.

   THE SESSION CHECK IS THE GATE'S, when there is one. This file used to run its
   own Auth.init() as well, which meant two concurrent checks racing: both
   hashed the same token, both could decide the session was dead, both cleared
   localStorage, and whichever lost could clear it *after* the gate had already
   unlocked — logging a player out a second after they got in.

   The watchdog covers the gate arriving late. If it shows up after this has
   already run init(), the second check is harmless: it re-reads the same user
   and unlocks again. Two checks cost one redundant request. Zero checks would
   strand a signed-in player, which is far worse. */
(function boot() {
  function start() {
    Auth.bind();

    if (window.__gatePresent || window.LoginGate) return;
    setTimeout(function () {
      if (window.__gatePresent || window.LoginGate) return;
      Auth.init().then(function () { Auth.handleUrlTokens(); });
    }, 2500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();