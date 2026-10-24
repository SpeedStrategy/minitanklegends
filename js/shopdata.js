const SHOP_DATA = {
  offers: [],
  sections: [],
  backdrop: null,
  _loaded: false,

  // 15 deals: reward:amount:price:currency:priority:stock
  ALL_DEALS: [
    { reward:'first_spray', amount:1, price:0, currency:'gold', priority:1, stock:1, free:true, name:'First Spray', desc:'A simple gray square spray. Free for all players!' },
    /* Tank styles: one paint texture over the whole tank. Always on the shelf
       (priority keeps them near the top) and not one-shot daily filler. */
    { reward:'style_woodland_camo', amount:1, price:1200, currency:'gold', priority:1, stock:99, name:'Woodland Camo', desc:'Olive-drab military woodland pattern for your tank.' },
    { reward:'style_desert_camo',   amount:1, price:1200, currency:'gold', priority:1, stock:99, name:'Desert Storm',  desc:'Sandy desert pattern with brown blotches.' },
    { reward:'style_tiger_stripes', amount:1, price:1800, currency:'gold', priority:1, stock:99, name:'Tiger Stripes',  desc:'Loud orange paint job with black stripes.' },
    { reward:'cash', amount:750,  price:10,  currency:'gold',  priority:1, stock:10 },
    { reward:'cash', amount:1000, price:12,  currency:'gold',  priority:1, stock:10 },
    { reward:'cash', amount:1250, price:15,  currency:'gold',  priority:2, stock:5  },
    { reward:'cash', amount:1500, price:17,  currency:'gold',  priority:2, stock:5  },
    { reward:'cash', amount:2500, price:22,  currency:'gold',  priority:3, stock:2  },
    { reward:'gold',  amount:3,    price:750,  currency:'cash',  priority:2, stock:5  },
    { reward:'gold',  amount:5,    price:1000, currency:'cash',  priority:2, stock:5  },
    { reward:'gold',  amount:7,    price:1200, currency:'cash',  priority:2, stock:2  },
    { reward:'gold',  amount:10,   price:1500, currency:'cash',  priority:3, stock:2  },
    { reward:'basic_crate', amount:1, price:3,  currency:'gold',  priority:1, stock:5  },
    { reward:'basic_crate', amount:2, price:5,  currency:'gold',  priority:2, stock:2  },
    { reward:'rare_crate',  amount:1, price:7,  currency:'gold',  priority:1, stock:5  },
    { reward:'rare_crate',  amount:2, price:12, currency:'gold',  priority:2, stock:2  },
    { reward:'basic_crate', amount:1, price:150, currency:'cash', priority:3, stock:1  },
    { reward:'rare_crate',  amount:1, price:500, currency:'cash', priority:3, stock:1  },
  ],

  // Free daily offer
  FREE_OFFER: { reward:'cash', amount:100, id:'daily_free' },

/* 'gems' WAS RENAMED TO 'gold' AND THE SHOP DATA NEVER CAME WITH IT.

     The settings save had a one-time migration (config.js) that moved a gold
     balance across from the old `gems` key. The SHOP did not: saves/shop.json
     and every copy already in a player's localStorage still say
     `"currency":"gems"` and `"reward":"gems"`.

     canAfford() switches on exactly three currency names and falls through to
     `false` for anything else, so every gold-priced offer has been permanently
     greyed out — "Not enough cash" on an offer the player has plenty for, with
     no way to tell why. And a `gems` reward pays out nothing at all.

     This normalises both fields on the way in, so the shop reads its own data
     correctly the first time after the update and writes it back corrected. */
  _migrateCurrencies(offers){
    let changed = false;
    const out = (offers || []).map(o => {
      const n = Object.assign({}, o);
      if(n.currency === 'gems'){ n.currency = 'gold'; changed = true; }
      if(n.reward === 'gems'){ n.reward = 'gold'; changed = true; }
      return n;
    });
    return { offers: out, changed };
  },

  init(){
    this._loadShopFile();
    if(!this._loaded || !this.offers.length){
      this._loadFromFile().catch(() => {}).then(loaded => {
        if(!loaded) this.refreshDaily();
      });
    }
    if(this.offers && this.offers.length){
      const m = this._migrateCurrencies(this.offers);
      if(m.changed){ this.offers = m.offers; this.saveShopFile(); }
    }
  },

  async _loadFromFile(){
    try {
      const resp = await fetch('saves/shop.json');
      if(!resp.ok) return false;
      const data = await resp.json();
      if(data && data.offers && data.offers.length){
        this.offers = this._migrateCurrencies(data.offers).offers;
        this.sections = data.sections || [];
        this.backdrop = data.backdrop || null;
        this._loaded = true;
        this.saveShopFile();
        return true;
      }
    } catch(e){}
    return false;
  },

  _loadShopFile(){
    try {
      const raw = localStorage.getItem('tankparty_shop');
      if(raw){
        const d = JSON.parse(raw);
        if(d && d.offers) { this.offers = this._migrateCurrencies(d.offers).offers; this.sections = d.sections || []; this.backdrop = d.backdrop || null; this._loaded = true; }
      }
    } catch(e){}
  },

  saveShopFile(){
    localStorage.setItem('tankparty_shop', JSON.stringify({
      offers: this.offers,
      sections: this.sections,
      backdrop: this.backdrop,
    }));
  },

  refreshDaily(){
    const now = Date.now();
    const dayKey = Math.floor(now / 86400000);
    const lastKey = parseInt(localStorage.getItem('shop_daykey') || '0');
    if(dayKey !== lastKey){
      localStorage.setItem('shop_daykey', dayKey);
      localStorage.setItem('shop_free_claimed', '0');
    }
    this.offers = this._pickWeighted(this.ALL_DEALS, 6);
  },

  _pickWeighted(arr, count){
    const weights = { 1:3, 2:2, 3:1 };
    const pool = arr.map(d => ({ ...d, _weight: weights[d.priority] || 1 }));
    const result = [];
    for(let i = 0; i < count && pool.length; i++){
      const totalW = pool.reduce((s, x) => s + x._weight, 0);
      let r = Math.random() * totalW;
      let idx = 0;
      for(let j = 0; j < pool.length; j++){
        r -= pool[j]._weight;
        if(r <= 0){ idx = j; break; }
      }
      result.push(pool.splice(idx, 1)[0]);
    }
    return result;
  },

  getOffers(){ return this.offers; },

  isFreeClaimed(){
    return localStorage.getItem('shop_free_claimed') === '1';
  },

  claimFree(){
    if(this.isFreeClaimed()) return false;
    localStorage.setItem('shop_free_claimed', '1');
    const s = Menu.settings;
    s.cash = (s.cash || 0) + this.FREE_OFFER.amount;
    saveSettings(s);
    return true;
  },

  canAfford(offer){
    const s = Menu.settings;
    if(offer.currency === 'cash') return (s.cash || 0) >= offer.price;
    if(offer.currency === 'coins') return (s.coins || 0) >= offer.price;
    if(offer.currency === 'gold') return (s.gold || 0) >= offer.price;
    return false;
  },

  purchase(offer){
    const s = Menu.settings;
    if(!this.canAfford(offer)) return false;
    if(offer.currency === 'cash') s.cash = (s.cash || 0) - offer.price;
    else if(offer.currency === 'coins') s.coins = (s.coins || 0) - offer.price;
    else if(offer.currency === 'gold') s.gold = (s.gold || 0) - offer.price;
    if(offer.stock > 0) offer.stock--;
    // Handle spray reward
    if(offer.reward === 'first_spray'){
      // Mutate the same object that gets saved below — calling addOwnedSpray()
      // first would be overwritten by saveSettings(s) with the stale list.
      if(!Array.isArray(s.ownedSprays)) s.ownedSprays = [];
      if(!s.ownedSprays.includes('first_spray')) s.ownedSprays.push('first_spray');
      if(!s.equippedSpray) s.equippedSpray = 'first_spray';
      // Also file the ownership under the sprays themselves. The settings slot
      // gets rewritten by a settings reset or by an older copy of the save;
      // the sprays file is the one that holds your paint, so your spray stays
      // yours either way.
      try{
        const d = JSON.parse(localStorage.getItem('tankparty_sprays')||'{}');
        if(!Array.isArray(d.owned)) d.owned = [];
        if(!d.owned.includes('first_spray')) d.owned.push('first_spray');
        localStorage.setItem('tankparty_sprays', JSON.stringify(d));
      }catch(e){}
    } else if(offer.reward && offer.reward.indexOf('style_') === 0){
      /* A style purchase files ownership through the same two-slot pattern the
         spray uses: the settings list (this object, saved below) and the
         styles' own keyed store, either of which counts as owned. */
      const styleId = offer.reward.slice('style_'.length);
      if(!Array.isArray(s.ownedStyles)) s.ownedStyles = [];
      if(!s.ownedStyles.includes(styleId)) s.ownedStyles.push(styleId);
      try{
        if(window.TankStyles) window.TankStyles.addOwnedStyle(styleId);
      }catch(e){}
    } else if(offer.reward === 'cash') s.cash = (s.cash || 0) + offer.amount;
    else if(offer.reward === 'coins') s.coins = (s.coins || 0) + offer.amount;
    else if(offer.reward === 'gold') s.gold = (s.gold || 0) + offer.amount;
    // crates: no-op for now
    saveSettings(s);
    this.saveShopFile();
    return true;
  },
};
