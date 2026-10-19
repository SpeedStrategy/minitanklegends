const MENU_COMMANDS = [
  { value: 'none', label: 'None' },
  { value: 'singleplayer', label: 'Singleplayer' },
  { value: 'multiplayer', label: 'Multiplayer' },
  { value: 'collections', label: 'Collections' },
  { value: 'settings', label: 'Settings' },
  { value: 'codes', label: 'Codes' },
  { value: 'preview', label: 'Preview Tank' },
  { value: 'back', label: '← Back' },
];

const MenuEditor = {
  _isOpen: false,
  elements: [],
  selected: null,
  _dragMode: null,
  _dragStart: null,
  _dragElm: null,
  _imageCounter: 0,

  open(){
    if(this._isOpen) return;
    this._isOpen = true;
    document.getElementById('me-overlay').classList.remove('hidden');
    document.querySelectorAll('.menu').forEach(m=>m.classList.add('hidden'));
    document.getElementById('hud').classList.add('hidden');
    if(!this._inited) this._init();
    this._render();
  },

  close(){
    document.getElementById('me-overlay').classList.add('hidden');
    this._isOpen = false;
    Menu.show('menu-main');
  },

  _init(){
    this._canvas = document.createElement('canvas');
    this._canvas.width = 800;
    this._canvas.height = 600;
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._ctx = this._canvas.getContext('2d');
    document.getElementById('me-canvas-host').appendChild(this._canvas);
    this._load();
    this._wire();
    this._inited = true;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  },

  _loop(){
    if(!this._isOpen) return;
    this._render();
    requestAnimationFrame(this._loop);
  },

  _render(){
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(32, 36, 42, 0.8)';
    ctx.fillRect(0, 0, w, h);
    const grid = 30;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for(let x=0;x<=w;x+=grid){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
    for(let y=0;y<=h;y+=grid){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
    this.elements.forEach(el=> this._drawElement(el));
  },

  _drawElement(el){
    const ctx = this._ctx;
    ctx.save();
    if(el.type === 'image' && el.image){
      ctx.drawImage(el.image, el.x, el.y, el.w, el.h);
    } else if(el.type === 'button' || el.type === 'chat-input' || el.type === 'chat-send'){
      // Transparent UI - no background fill, only border
      ctx.strokeStyle = el.placeholderColor || 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const r = 12;
      ctx.moveTo(el.x + r, el.y);
      ctx.lineTo(el.x + el.w - r, el.y);
      ctx.quadraticCurveTo(el.x + el.w, el.y, el.x + el.w, el.y + r);
      ctx.lineTo(el.x + el.w, el.y + el.h - r);
      ctx.quadraticCurveTo(el.x + el.w, el.y + el.h, el.x + el.w - r, el.y + el.h);
      ctx.lineTo(el.x + r, el.y + el.h);
      ctx.quadraticCurveTo(el.x, el.y + el.h, el.x, el.y + el.h - r);
      ctx.lineTo(el.x, el.y + r);
      ctx.quadraticCurveTo(el.x, el.y, el.x + r, el.y);
      ctx.closePath();
      ctx.stroke();
      
      // Semi-transparent fill for visibility
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fill();
      
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 15px Segoe UI';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = el.type === 'chat-input' ? 'Chat Input' : el.type === 'chat-send' ? 'Send' : (el.label || 'Button');
      ctx.fillText(label, el.x + el.w/2, el.y + el.h/2);
      if(el.command && el.command !== 'none' && el.type === 'button'){
        ctx.fillStyle = '#ffb12b';
        ctx.font = '10px Segoe UI';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('➤ ' + el.command, el.x + el.w - 4, el.y + el.h - 4);
      }
    }
    if(el === this.selected){
      ctx.strokeStyle = '#ffb12b';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4);
      ctx.setLineDash([]);
      const hs = 8;
      ctx.fillStyle = '#ffb12b';
      [[el.x, el.y],[el.x+el.w, el.y],[el.x, el.y+el.h],[el.x+el.w, el.y+el.h],
       [el.x+el.w/2, el.y],[el.x+el.w/2, el.y+el.h],[el.x, el.y+el.h/2],[el.x+el.w, el.y+el.h/2]].forEach(([hx,hy])=>{
        ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
      });
    }
    ctx.restore();
  },

  _wire(){
    const canvas = this._canvas;
    const getPos = (e)=> {
      const r = canvas.getBoundingClientRect();
      const scaleX = canvas.width / r.width;
      const scaleY = canvas.height / r.height;
      return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
    };

    canvas.addEventListener('mousedown', (e)=>{
      if(e.button !== 0) return;
      const pos = getPos(e);
      const hit = this._hitTest(pos.x, pos.y);
      if(hit){
        this.selected = hit;
        this._refreshInspector();
        this._dragMode = 'move';
        this._dragStart = { x: pos.x - hit.x, y: pos.y - hit.y };
        this._dragElm = hit;
        const handle = this._hitHandle(pos.x, pos.y);
        if(handle) this._dragMode = 'resize';
      } else {
        this.selected = null;
        this._refreshInspector();
        this._dragMode = null;
      }
    });

    canvas.addEventListener('mousemove', (e)=>{
      if(!this._dragMode || !this._dragElm) return;
      const pos = getPos(e);
      if(this._dragMode === 'move'){
        this._dragElm.x = Math.max(0, pos.x - this._dragStart.x);
        this._dragElm.y = Math.max(0, pos.y - this._dragStart.y);
      } else if(this._dragMode === 'resize'){
        const nw = Math.max(20, pos.x - this._dragElm.x);
        const nh = Math.max(20, pos.y - this._dragElm.y);
        this._dragElm.w = nw;
        this._dragElm.h = nh;
      }
    });

    window.addEventListener('mouseup', ()=>{
      this._dragMode = null;
      this._dragElm = null;
    });

    document.getElementById('me-upload-png').onclick = ()=>{
      document.getElementById('me-file-input').click();
    };
    document.getElementById('me-file-input').onchange = (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      const img = new Image();
      img.onload = ()=>{
        this._imageCounter++;
this.elements.push({
    type: 'image',
    image: img,
    x: 50, y: 50,
    w: Math.min(img.width, 400),
    h: Math.min(img.height, 400),
    name: 'Image ' + this._imageCounter,
    opacity: 0.8
  });
        this._save();
        this.toast('Image added');
      };
      img.src = URL.createObjectURL(file);
      e.target.value = '';
    };

    document.getElementById('me-add-btn').onclick = ()=>{
this.elements.push({
    type: 'button',
    x: 100, y: 103,
    w: 160, h: 50,
    label: 'New Button',
    command: 'none',
    hitbox: { x: 0, y: 0, w: 160, h: 50 },
    placeholderColor: 'rgba(255, 255, 255, 0.3)'
  });
      this._save();
      this.toast('Button added');
    };

    document.getElementById('me-add-chat-input').onclick = ()=>{
this.elements.push({
    type: 'chat-input',
    x: 100, y: 200,
    w: 300, h: 40,
    placeholderColor: 'rgba(255, 255, 255, 0.3)'
  });
      this._save();
      this.toast('Chat Input added');
    };

    document.getElementById('me-add-chat-send').onclick = ()=>{
this.elements.push({
    type: 'chat-send',
    x: 420, y: 200,
    w: 80, h: 40,
    placeholderColor: 'rgba(255, 255, 255, 0.3)'
  });
      this._save();
      this.toast('Send Button added');
    };

    document.getElementById('me-delete-selected').onclick = ()=>{
      if(!this.selected) return;
      this.elements = this.elements.filter(e=> e !== this.selected);
      this.selected = null;
      this._refreshInspector();
      this._save();
    };

    document.getElementById('me-back').onclick = ()=> this.close();

    document.getElementById('me-save').onclick = ()=>{
      this._save();
      this.toast('Menu layout saved!');
    };

    document.getElementById('me-apply').onclick = ()=>{
      this._save();
      this._applyToMainMenu();
    };

    window.addEventListener('keydown', (e)=>{
      if(!this._isOpen) return;
      if(e.code==='Delete' || e.code==='Backspace'){
        if(this.selected){
          this.elements = this.elements.filter(el=> el !== this.selected);
          this.selected = null;
          this._refreshInspector();
          this._save();
        }
      }
      if(e.code==='Escape'){ this.selected = null; this._refreshInspector(); }
    });
  },

  _hitTest(x, y){
    for(let i=this.elements.length-1;i>=0;i--){
      const el = this.elements[i];
      if(x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h) return el;
    }
    return null;
  },

  _hitHandle(x, y){
    if(!this.selected) return false;
    const el = this.selected;
    const hs = 10;
    const bx = el.x + el.w, by = el.y + el.h;
    return (x >= bx - hs && x <= bx + hs && y >= by - hs && y <= by + hs);
  },

  _refreshInspector(){
    const ins = document.getElementById('me-inspector');
    if(!this.selected){
      ins.innerHTML = '<div class="me-title">Inspector</div><div class="me-muted">Click an element to select it<br>Drag to move<br>Bottom-right handle to resize</div>';
      return;
    }
    const el = this.selected;
    let html = `<div class="me-title">Inspector</div>`;
    html += `<div class="me-row"><span>Type</span> ${el.type}</div>`;
    html += `<div class="me-row"><span>X</span> <input type="number" class="me-num" value="${Math.round(el.x)}" data-prop="x"></div>`;
    html += `<div class="me-row"><span>Y</span> <input type="number" class="me-num" value="${Math.round(el.y)}" data-prop="y"></div>`;
    html += `<div class="me-row"><span>W</span> <input type="number" class="me-num" value="${Math.round(el.w)}" data-prop="w"></div>`;
    html += `<div class="me-row"><span>H</span> <input type="number" class="me-num" value="${Math.round(el.h)}" data-prop="h"></div>`;
    if(el.type === 'button'){
      html += `<div class="me-row"><span>Label</span> <input type="text" class="me-text" value="${el.label||''}" data-prop="label"></div>`;
      html += `<div class="me-row"><span>Command</span> <select class="me-select" data-prop="command">`;
      MENU_COMMANDS.forEach(c=>{
        html += `<option value="${c.value}"${(el.command||'none')===c.value?' selected':''}>${c.label}</option>`;
      });
      html += `</select></div>`;
      html += `<div class="me-row"><span>Placeholder Color</span> <input type="color" class="me-color" value="${this._rgbaToHex(el.placeholderColor||'rgba(255,255,255,0.3)')}" data-prop="placeholderColor"></div>`;
      html += `<div class="me-title" style="margin-top:12px">Hitbox</div>`;
      html += `<div class="me-hint">Relative to element position</div>`;
      html += `<div class="me-row"><span>HX</span> <input type="number" class="me-num" value="${el.hitbox?.x||0}" data-prop="hitbox.x"></div>`;
      html += `<div class="me-row"><span>HY</span> <input type="number" class="me-num" value="${el.hitbox?.y||0}" data-prop="hitbox.y"></div>`;
      html += `<div class="me-row"><span>HW</span> <input type="number" class="me-num" value="${el.hitbox?.w||el.w}" data-prop="hitbox.w"></div>`;
      html += `<div class="me-row"><span>HH</span> <input type="number" class="me-num" value="${el.hitbox?.h||el.h}" data-prop="hitbox.h"></div>`;
    }
    if(el.type === 'image'){
      html += `<div class="me-row"><span>Name</span> ${el.name||'Image'}</div>`;
    }
    if(el.type === 'chat-input' || el.type === 'chat-send'){
      html += `<div class="me-row"><span>Placeholder Color</span> <input type="color" class="me-color" value="${this._rgbaToHex(el.placeholderColor||'rgba(255,255,255,0.3)')}" data-prop="placeholderColor"></div>`;
    }
    ins.innerHTML = html;
    ins.querySelectorAll('.me-num, .me-text, .me-select, .me-color').forEach(inp=>{
      inp.onchange = ()=>{
        const path = inp.dataset.prop.split('.');
        let target = el;
        for(let i=0;i<path.length-1;i++) target = target[path[i]] = target[path[i]] || {};
        if(inp.type === 'color'){
          target[path[path.length-1]] = this._hexToRgba(inp.value);
        } else {
          target[path[path.length-1]] = inp.type==='number' ? +inp.value : inp.value;
        }
        this._save();
      };
    });
  },

  _save(){
    const data = this.elements.map(el=>({
      type: el.type,
      x: el.x, y: el.y, w: el.w, h: el.h,
      label: el.label,
      bgColor: el.bgColor,
      command: el.command,
      hitbox: el.hitbox,
      name: el.name,
      imageData: el.image ? this._canvasToData(el.image, Math.round(el.w), Math.round(el.h)) : null,
    }));
    localStorage.setItem('tankparty_menueditor', JSON.stringify(data));
  },

  _load(){
    try{
      const data = JSON.parse(localStorage.getItem('tankparty_menueditor'));
      if(!data) return;
      this.elements = [];
      data.forEach(d=>{
        const el = { ...d };
        if(el.type === 'image' && el.imageData){
          const img = new Image();
          img.onload = ()=>{ el.image = img; };
          img.src = el.imageData;
        }
        this.elements.push(el);
      });
    }catch(e){}
  },

  _canvasToData(img, w, h){
    const c = document.createElement('canvas');
    c.width = w || img.width;
    c.height = h || img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL();
  },

  _rgbaToHex(rgba){
    if(rgba.startsWith('#')) return rgba;
    const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if(!match) return '#ffffff';
    const r = parseInt(match[1]).toString(16).padStart(2, '0');
    const g = parseInt(match[2]).toString(16).padStart(2, '0');
    const b = parseInt(match[3]).toString(16).padStart(2, '0');
    return '#' + r + g + b;
  },

  _hexToRgba(hex){
    if(hex.startsWith('rgba')) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.3)`;
  },

  _applyToMainMenu(){
    localStorage.setItem('tankparty_custommainmenu', '1');
    this.toast('Custom menu set as main!');
    this.close();
  },

  toast(msg){
    if(Menu && Menu.toast) Menu.toast(msg);
  },
};