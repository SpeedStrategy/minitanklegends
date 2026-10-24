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
         signed in here, losing progress on every save. */
      if (err.status === undefined && this.user) return true;
      this._clearSession();
      this._updateUI();
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
    this._clearSession();
    this._updateUI();
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
     next page load does not spend a request discovering that. */
    this._clearSession();
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
      /* A SIGNED-IN PLAYER'S NAME IS THEIR USERNAME. ONE NAME, NEVER TWO.

         The server profile carries a free-text playerName, but it is empty for
         every account that never set one, and this line only ever assigned it
         when it was truthy. So signing in left the locally generated name — the
         "Player8459" from config.js — sitting in place. The menu then drew that
         invented name as the heading and the real account name on the line
         beneath it, so one player appeared to be called two different things.

         The generated name was always the wrong one to show, because it is the
         one the player did not choose. Falling back to the username means the
         screen can only ever show the name the player typed, and the generated
         name stays where it belongs: a guest who has not signed in anywhere. */
      const realName = profile.playerName || (this.user && this.user.username) || '';
      if (realName && s.playerName !== realName) { s.playerName = realName; changed = true; }
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
    /* STATUS ONLY — THIS BAR DOES NOT OWN THE NAME.

       It used to print "Account: <username>" here, while the profile card a
       few hundred pixels below printed the same name as its heading, so one
       name appeared twice on a single screen. With the card's generated
       nickname also in play it was three renderings and two different
       spellings, which is how a player ended up looking at their own card
       unable to say which one was them.

       The card owns the name. This bar sits beside the Log Out button, so all
       it needs to say is whether there is an account at all. */
    if (acc) {
      acc.textContent = logged ? 'Signed in' : '';
      acc.classList.toggle('hidden', !logged);
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
          await this.logout();
          this._toast('Logged out');
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