/* PAYMENTS — the client's half of the Stripe store.

   Everything of value lives on the server (clan-api-worker/payments.js). This
   file never knows a price in a way it could be trusted with: it asks the
   worker what the storefront table is, and posts a product ID. There is no
   Stripe key here and there must never be one — anything in this file is
   readable by every player.

   The flow is:
     buy()          -> POST /pay/checkout -> Stripe's hosted page (full page
                       redirect; the game is frozen behind it, so a card
                       number never touches this code)
     handleReturn() -> the player comes back to ?purchase=success, we re-read
                       the account and pull the new balances down.
 */

const PAYMENTS = {
  /* Reads the same single source auth.js reads (CONFIG.CLAN_API_URL), with
     AUTH_API as the second choice for the same reason. There is no reason for
     this file to name the registry host itself -- three copies of one address
     is three things that can disagree, and they did: all three were pointed at
     an account subdomain that had never been set, which would have failed
     every purchase and every login while the game itself played fine. */
  API: (typeof AUTH_API !== 'undefined') ? AUTH_API
     : ((typeof CONFIG !== 'undefined' && CONFIG.CLAN_API_URL) ? CONFIG.CLAN_API_URL
        : 'https://clan-registry-api.nojus-t.workers.dev'),

  _products: null,

  async _api(path, opts) {
    let res;
    try {
      res = await fetch(this.API + path, opts);
    } catch (e) {
      throw new Error('Cannot reach the store. Check your connection.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || ('Store error ' + res.status));
    return data;
  },

  /* The storefront table, fetched once and cached for the session. */
  async products() {
    if (this._products) return this._products;
    const d = await this._api('/pay/products');
    this._products = d.products || [];
    return this._products;
  },

  /* Start a purchase. Throws with a readable message if it cannot be started;
     the caller shows it. Returns nothing on success — the browser is on its
     way to Stripe. */
  async buy(productId) {
    if (!window.Auth || !Auth.loggedIn()) {
      throw new Error('Log in before buying — a purchase needs an account to go to.');
    }
    const d = await this._api('/pay/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: Auth.token, productId }),
    });
    if (!d.url) throw new Error('The store did not return a checkout link.');
    window.location.href = d.url;
  },

  /* THE RETURN TRIP.

     Stripe redirects back to `?purchase=success&session_id=..`. The goods are
     granted by the webhook, not by this page — so all this can do is pull the
     new balances down, which may be a moment after the redirect lands. It is
     called once at boot, retries briefly so a webhook that is still landing is
     not missed, and then removes the query string so a refresh cannot re-run it
     or leave a success URL sitting in the address bar. */
  async handleReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('purchase');
    if (!result) return;

    /* Clean the URL first: if anything below throws, the player is not left on a
       page that re-triggers the whole flow on the next refresh. */
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);

    if (result !== 'success') {
      if (window.Menu && Menu.toast) Menu.toast('Purchase cancelled');
      return;
    }
    if (!window.Auth || !Auth.loggedIn()) {
      if (window.Menu && Menu.toast) Menu.toast('Payment received — log in to see it');
      return;
    }

    /* The webhook is what grants. Poll a few times, because the redirect can
       arrive before Stripe has finished calling us. */
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const d = await Auth._api('/auth/me?token=' + encodeURIComponent(Auth.token));
        if (d.user) {
          Auth.user = d.user;
          try { localStorage.setItem('mtl_user', JSON.stringify(d.user)); } catch (e) {}
          const before = window.loadSettings ? window.loadSettings() : null;
          Auth._applyRemoteProfile(d.user.profile);
          const after = window.loadSettings ? window.loadSettings() : null;
          const gained = before && after &&
            ((after.cash || 0) - (before.cash || 0) + (after.gold || 0) - (before.gold || 0));
          if (window.Menu) {
            if (gained > 0) {
              Menu.toast('Purchase complete — ' + gained + ' added!');
              if (Menu._updateCurrencies) Menu._updateCurrencies();
            } else {
              Menu.toast('Payment received — your items are on the way');
            }
          }
          return;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1200));
    }
    if (window.Menu && Menu.toast) Menu.toast('Payment received — balance will update shortly');
  },
};

if (typeof window !== 'undefined') window.PAYMENTS = PAYMENTS;

/* If this page load is the return trip from Stripe, finish it. Guarded so it
   costs nothing on an ordinary load — no `?purchase=` means no work.

   It waits on Auth.init() rather than running alongside it, because the whole
   job is pulling the new balances down and that needs a session token. Calling
   init again is harmless: it returns immediately if the account is already
   loaded, and otherwise re-confirms it with the server. */
(function bootPayments(){
  const start = () => {
    if (window.PAYMENTS) PAYMENTS.handleReturn();
  };
  const afterAuth = () => {
    try {
      if (window.Auth && typeof Auth.init === 'function') return Auth.init();
    } catch (e) {}
    return null;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      Promise.resolve(afterAuth()).then(start, start);
    });
  } else {
    Promise.resolve(afterAuth()).then(start, start);
  }
})();
