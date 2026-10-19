var Editor123 = {

    _open: false,

    _mode: 'launcher',

    _menuId: null,

    _canvas: null,

    _ctx: null,

    _elements: {},

    _selected: null,

    _dragMode: null,

    _dragStart: null,

    _dragElm: null,

    _imgCounter: 0,



    // 3D map state

    _mapScene: null, _mapRenderer: null, _mapCamera: null, _mapControls: null,

    _mapGround: null, _mapModels: [], _mapObjs: [], _mapSelObj: null, _mapSelObjs: [],

    _mapClipboard: [], _mapPlacing: false, _mapPlacingMulti: [],

    _mapLib: [], _mapAnimId: null,

    _gltfLoader: null, _fbxLoader: null,

    _physics: null, _physBodies: [], _physSimulating: false, _physLock: false,

    _mapOutlines: [], _mapMouseDown: null,



    // Editor tools state

    _snapEnabled: false, _snapSize: 1,

    _sceneBgColor: 0x14181e, _sceneFogDensity: 0.008, _sceneAmbient: 0x404060,

    _paintMode: false, _paintColor: 0x4a7a4a, _paintBrushSize: 2,

    _currentTool: 'select', _grassMode: false, _grassEraseMode: false, _grassTexUrl: null, _grassBrushSize: 3, _grassDensity: 20, _grassScale: 0.5, _grassColor: 0x6aaa4a,

    _grass3dWidth: 0.08, _grass3dHeight: 0.3, _grass3dColorBottom: '#4f7c13', _grass3dColorTop: '#79a01c',

    _grassWindSpeed: 1.2, _grassWindStrength: 0.3,

    _grassMesh: null, _grassCount: 0, _grassMaxBlades: 50000, _grassBladeData: [],

    _grassBrushCircle: null, _mapMouseNDC: null,



    MENU_NAMES: {

        'menu-main': 'Main Menu', 'menu-play-select': 'Play Select',

        'menu-multiplayer': 'Multiplayer', 'menu-host': 'Host Room',

        'menu-join': 'Join Room', 'menu-join-hidden': 'Hidden Join',

        'menu-collections': 'Collections', 'menu-store': 'Store',

        'menu-storage': 'Storage', 'menu-settings': 'Settings',

        'menu-preview': 'Preview Tank', 'menu-codes': 'Codes',

    },

    ALL_MENUS: ['menu-main', 'menu-play-select', 'menu-multiplayer', 'menu-host',

        'menu-join', 'menu-join-hidden', 'menu-collections', 'menu-store',

        'menu-storage', 'menu-settings', 'menu-preview', 'menu-codes'],



    COMMANDS: [

        { value: 'none', label: 'None' }, { value: 'singleplayer', label: 'Singleplayer' },

        { value: 'multiplayer', label: 'Multiplayer' }, { value: 'collections', label: 'Collections' },

        { value: 'settings', label: 'Settings' }, { value: 'codes', label: 'Codes' },

        { value: 'preview', label: 'Preview Tank' }, { value: 'back', label: '← Back' },

    ],



    /* ────── LIFECYCLE ────── */

    open: function () {

        if (this._open) return;

        this._open = true;

        document.querySelectorAll('.menu').forEach(function (m) { m.classList.add('hidden'); });

        document.getElementById('hud').classList.add('hidden');

        this._loadElem();

        this._buildOverlay();

        this._renderLauncher();

    },

    close: function () {

        this._stopMapEditor();

        var ov = document.getElementById('editor123-overlay');

        if (ov) ov.remove();

        this._open = false;

        this._menuId = null; this._canvas = null;

        Menu.show('menu-main');

    },

    toast: function (m) { if (Menu && Menu.toast) Menu.toast(m); },



    _buildOverlay: function () {

        var ex = document.getElementById('editor123-overlay');

        if (ex) ex.remove();

        var d = document.createElement('div');

        d.id = 'editor123-overlay';

        d.style.cssText = 'position:fixed;inset:0;z-index:200;background:#181c22;display:flex;flex-direction:column;color:#eee;font:14px Segoe UI,sans-serif';

        d.innerHTML = '<div id="editor123-content" style="flex:1;display:flex;overflow:hidden"></div>';

        document.body.appendChild(d);

    },



    /* ────── LAUNCHER ────── */

    _renderLauncher: function () {

        this._mode = 'launcher';

        var c = document.getElementById('editor123-content');

        c.innerHTML =

            '<div style="margin:auto;text-align:center;max-width:600px">' +

            '<h1 style="font-size:32px;color:#ffb12b;margin-bottom:8px;letter-spacing:1px">EDITOR SUITE</h1>' +

            '<p style="color:#777;margin-bottom:32px;font-size:13px">Design menus &amp; build worlds visually</p>' +

            '<div style="display:flex;gap:24px;justify-content:center;flex-wrap:wrap">' +

            '<div class="e123-launcher-btn" data-mode="menus" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">🎨</div>' +

            '<div style="font-size:17px;font-weight:700">Edit Menus</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">Customize any menu screen<br>with images &amp; buttons</div></div>' +

            '<div class="e123-launcher-btn" data-mode="map" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">\u{1F5FA}</div>' +

            '<div style="font-size:17px;font-weight:700">World Editor</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">3D scene with physics,<br>hierarchy &amp; GLB/FBX import</div></div>' +

            '<div class="e123-launcher-btn" data-mode="shop" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">\u{1F6D2}</div>' +

            '<div style="font-size:17px;font-weight:700">Shop Editor</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">Edit shop offers,<br>sections &amp; layout</div></div>' +

            '<div class="e123-launcher-btn" data-mode="clan" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">\u{1F465}</div>' +

            '<div style="font-size:17px;font-weight:700">Clan Editor</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">Design clan UI,<br>chat &amp; badges</div></div>' +

            '<div class="e123-launcher-btn" data-mode="tank" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">\u{1F6E1}</div>' +

            '<div style="font-size:17px;font-weight:700">Tank Editor</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">Set hitbox, turret<br>pivot &amp; shell spawn</div></div>' +

            '<div class="e123-launcher-btn" data-mode="collections" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">\u{1F3AF}</div>' +

            '<div style="font-size:17px;font-weight:700">Collections</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">Assign tanks to<br>collection slots</div></div>' +

            '<div class="e123-launcher-btn" data-mode="mapimporter" style="width:210px;padding:44px 20px;background:linear-gradient(145deg,#252a32,#1e232a);border-radius:18px;cursor:pointer;border:2px solid #2a2f36;transition:.2s">' +

            '<div style="font-size:44px;margin-bottom:10px">\u{1F5FA}</div>' +

            '<div style="font-size:17px;font-weight:700">Map Importer</div>' +

            '<div style="color:#888;font-size:12px;margin-top:6px">Import GLB maps,<br>detect spawns &amp; publish</div></div>' +

            '</div>' +

            '<div id="e123-l-back" style="margin-top:36px;padding:10px 36px;background:#2a2f36;border-radius:10px;cursor:pointer;display:inline-block;color:#888;font-size:13px;transition:.15s">← Back to Menu</div></div>';

        c.querySelectorAll('.e123-launcher-btn').forEach(function (b) {

            b.onmouseover = function () { this.style.borderColor = '#ffb12b'; this.style.background = 'linear-gradient(145deg,#2a303a,#222830)'; };

            b.onmouseout = function () { this.style.borderColor = '#2a2f36'; this.style.background = 'linear-gradient(145deg,#252a32,#1e232a)'; };

            b.onclick = function () {

                try {

                    if (this.dataset.mode === 'menus') Editor123._renderMenuList();

                    else if (this.dataset.mode === 'shop') Editor123._renderShopEditor();

                    else if (this.dataset.mode === 'clan') Editor123._renderClanEditor();

                    else if (this.dataset.mode === 'tank'){ if(window.TankEditor) Editor123._renderTankEditor = window.TankEditor.render; if(Editor123._renderTankEditor) Editor123._renderTankEditor(); else Editor123.toast('Tank Editor not loaded'); }

                    else if (this.dataset.mode === 'collections') Editor123._renderCollectionEditor();

                    else if (this.dataset.mode === 'mapimporter'){ if(window.MapImporter) window.MapImporter.render(); else Editor123.toast('Map Importer not loaded'); }

                    else Editor123._render3DEditor();

                } catch(e){ console.error(e); Editor123.toast('Error: '+e.message); }

            };

        });

        document.getElementById('e123-l-back').onclick = function () { Editor123.close(); };

    },



    /* ═══════════════════════════

       MENU EDITOR

       ═══════════════════════════ */

    _renderMenuList: function () {

        this._mode = 'menus';

        var c = document.getElementById('editor123-content');

        var h = '<div style="width:220px;min-width:220px;background:#1a1e24;padding:14px;overflow-y:auto;border-right:1px solid #252a32">' +

            '<h3 style="margin:0 0 10px;color:#ffb12b;font-size:14px;letter-spacing:.5px">MENUS</h3>';

        this.ALL_MENUS.forEach(function (id) {

            var els = Editor123._elements[id] || [];

            h += '<div class="e123-menu-card" data-id="' + id + '" style="padding:9px 12px;background:#22272e;border-radius:8px;margin-bottom:6px;cursor:pointer;border:2px solid transparent">' +

                '<div style="font-weight:600;font-size:12px;color:#ddd">' + (Editor123.MENU_NAMES[id] || id) + '</div>' +

                '<div style="font-size:10px;color:#666;margin-top:3px">' + els.length + ' overlay' + (els.length !== 1 ? 's' : '') + '</div></div>';

        });

        h += '<div id="e123-m-back" style="margin-top:12px;padding:9px;background:#2a2f36;border-radius:8px;cursor:pointer;text-align:center;color:#888;font-size:12px">← Back</div></div>' +

            '<div style="flex:1;display:flex;flex-direction:column;overflow:hidden">' +

            '<div id="e123-m-toolbar" style="padding:8px 14px;background:#1a1e24;display:flex;gap:6px;align-items:center;border-bottom:1px solid #252a32;flex-shrink:0">' +

            '<span style="color:#777;font-size:12px;margin-right:8px">Select a menu to edit</span></div>' +

            '<div id="e123-m-area" style="flex:1;position:relative;overflow:auto;background:#181c22"></div></div>';

        c.innerHTML = h;

        c.querySelectorAll('.e123-menu-card').forEach(function (card) {

            card.onclick = function () {

                c.querySelectorAll('.e123-menu-card').forEach(function (x) { x.style.borderColor = 'transparent'; });

                this.style.borderColor = '#ffb12b';

                Editor123._openMenuEditor(this.dataset.id);

            };

        });

        document.getElementById('e123-m-back').onclick = function () { Editor123._renderLauncher(); };

    },



    _openMenuEditor: function (menuId) {

        this._menuId = menuId;

        this._selected = null;

        if (!this._elements[menuId]) this._elements[menuId] = [];



        var name = this.MENU_NAMES[menuId] || menuId;

        var tb = document.getElementById('e123-m-toolbar');

        tb.innerHTML =

            '<span style="color:#ffb12b;font-weight:600;font-size:13px">🎨 ' + name + '</span>' +

            '<span style="color:#555;font-size:10px;margin:0 8px">|</span>' +

            '<span class="e123-tbtn" id="e-img">🖼️ Image</span>' +

            '<span class="e123-tbtn" id="e-btn">➕ Button</span>' +

            '<span class="e123-tbtn" id="e-cmt">💬 Note</span>' +

            '<span class="e123-tbtn" id="e-del" style="color:#c66">🗑️ Delete</span>' +

            '<div style="flex:1"></div>' +

            '<span class="e123-tbtn" id="e-save">💾 Save</span>';



        var area = document.getElementById('e123-m-area');

        area.innerHTML = '';



        // Clone menu as background reference (scaled to fit)

        var src = document.getElementById(menuId);

        if (src) {

            var cl = src.cloneNode(true);

            cl.id = 'e123-menu-clone';

            cl.className = cl.className.replace(/hidden/g, '');

            cl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:transparent;pointer-events:none;z-index:1';

            cl.style.removeProperty('background-color');

            cl.style.removeProperty('background-image');

            area.appendChild(cl);

        }



        // Canvas overlay

        var cv = document.createElement('canvas');

        cv.id = 'e123-canvas';

        cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:auto;cursor:crosshair';

        cv.width = 900; cv.height = 650;

        area.appendChild(cv);

        this._canvas = cv;

        this._ctx = cv.getContext('2d');

        this._wireCanvas();

        this._wireMenuTools();

        this._renderCanvas();

    },



    _wireCanvas: function () {

        var self = this;

        var cv = this._canvas;

        var gp = function (e) {

            var r = cv.getBoundingClientRect();

            return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };

        };

        cv.onmousedown = function (e) {

            if (e.button !== 0) return;

            var pos = gp(e);

            var els = self._elements[self._menuId] || [];

            var hit = null;

            for (var i = els.length - 1; i >= 0; i--) {

                var el = els[i];

                if (pos.x >= el.x && pos.x <= el.x + el.w && pos.y >= el.y && pos.y <= el.y + el.h) { hit = el; break; }

            }

            if (hit) {

                self._selected = hit;

                self._dragMode = 'move';

                self._dragStart = { x: pos.x - hit.x, y: pos.y - hit.y };

                self._dragElm = hit;

                var hs = 10, bx = hit.x + hit.w, by = hit.y + hit.h;

                if (pos.x >= bx - hs && pos.x <= bx + hs && pos.y >= by - hs && pos.y <= by + hs) self._dragMode = 'resize';

            } else {

                self._selected = null; self._dragMode = null; self._dragElm = null;

            }

            self._renderCanvas();

        };

        cv.ondblclick = function () {

            if (!self._selected) return;

            var el = self._selected;

            if (el.type === 'comment') { var t = prompt('Edit note:', el.text || ''); if (t !== null) { el.text = t; self._renderCanvas(); } }

            else if (el.type === 'button') { var l = prompt('Button label:', el.label || ''); if (l !== null) { el.label = l; self._renderCanvas(); } }

        };

        cv.onmousemove = function (e) {

            if (!self._dragMode || !self._dragElm) return;

            var pos = gp(e);

            if (self._dragMode === 'move') { self._dragElm.x = Math.max(0, pos.x - self._dragStart.x); self._dragElm.y = Math.max(0, pos.y - self._dragStart.y); }

            else if (self._dragMode === 'resize') { self._dragElm.w = Math.max(20, pos.x - self._dragElm.x); self._dragElm.h = Math.max(20, pos.y - self._dragElm.y); }

            self._renderCanvas();

        };

        window.addEventListener('mouseup', function () { self._dragMode = null; self._dragElm = null; });

        var kh = function (e) {

            if ((e.code === 'Delete' || e.code === 'Backspace') && self._selected && self._menuId) {

                self._elements[self._menuId] = self._elements[self._menuId].filter(function (x) { return x !== self._selected; });

                self._selected = null; self._renderCanvas();

            }

            if (e.code === 'Escape') { self._selected = null; self._renderCanvas(); }

        };

        window.addEventListener('keydown', kh);

    },



    _wireMenuTools: function () {

        var self = this;

        var $ = function (id, fn) { var el = document.getElementById(id); if (el) el.onclick = fn; };

        $('e-img', function () {

            var inp = document.createElement('input');

            inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp';

            inp.onchange = function (e) {

                var f = e.target.files[0]; if (!f) return;

                var img = new Image();

                img.onload = function () {

                    self._imgCounter++;

                    self._elements[self._menuId].push({ type: 'image', image: img, x: 40, y: 40, w: Math.min(img.width, 400), h: Math.min(img.height, 400), name: 'Image ' + self._imgCounter });

                    self._renderCanvas(); self.toast('Image added');

                };

                img.src = URL.createObjectURL(f); inp.value = '';

            };

            inp.click();

        });

        $('e-btn', function () {

            self._elements[self._menuId].push({ type: 'button', x: 150, y: 200, w: 160, h: 50, label: 'New Button', bgColor: '#383838', command: 'none', hitbox: { x: 0, y: 0, w: 160, h: 50 } });

            self._renderCanvas();

        });

        $('e-cmt', function () {

            var t = prompt('Note text:', 'Design note...');

            if (t === null) return;

            self._elements[self._menuId].push({ type: 'comment', x: 150, y: 150, w: 260, h: 80, text: t });

            self._renderCanvas();

        });

        $('e-del', function () {

            if (!self._selected) return;

            self._elements[self._menuId] = self._elements[self._menuId].filter(function (x) { return x !== self._selected; });

            self._selected = null; self._renderCanvas();

        });

        $('e-save', function () { self._saveElem(); self.toast('Saved'); });

    },



    _renderCanvas: function () {

        var ctx = this._ctx; if (!ctx) return;

        var w = this._canvas.width, h = this._canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Grid

        ctx.strokeStyle = 'rgba(255,255,255,0.04)';

        ctx.lineWidth = 1;

        for (var x = 0; x <= w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }

        for (var y = 0; y <= h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

        // Overlay elements

        var self = this;

        (this._elements[this._menuId] || []).forEach(function (el) { self._drawEl(el); });

        // Selection handles + inspector

        if (this._selected) {

            var el = this._selected;

            ctx.save();

            ctx.strokeStyle = '#ffb12b'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);

            ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4); ctx.setLineDash([]);

            ctx.fillStyle = '#ffb12b';

            var hs = 8;

            [[el.x, el.y], [el.x + el.w, el.y], [el.x, el.y + el.h], [el.x + el.w, el.y + el.h],

            [el.x + el.w / 2, el.y], [el.x + el.w / 2, el.y + el.h],

            [el.x, el.y + el.h / 2], [el.x + el.w, el.y + el.h / 2]].forEach(function (p) { ctx.fillRect(p[0] - hs / 2, p[1] - hs / 2, hs, hs); });

            ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(w - 230, 0, 230, 120);

            ctx.fillStyle = '#ffb12b'; ctx.font = 'bold 13px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';

            ctx.fillText('Inspector', w - 214, 8);

            ctx.fillStyle = '#aaa'; ctx.font = '11px Segoe UI';

            ctx.fillText('Type: ' + el.type + '  X:' + Math.round(el.x) + ' Y:' + Math.round(el.y) + ' W:' + Math.round(el.w) + ' H:' + Math.round(el.h), w - 214, 28);

            if (el.type === 'button') ctx.fillText('Label: "' + (el.label || '') + '"', w - 214, 44);

            if (el.type === 'comment') ctx.fillText('"' + (el.text || '') + '"', w - 214, 44);

            ctx.fillStyle = '#666'; ctx.font = '10px Segoe UI';

            ctx.fillText('Drag · Dbl-click edit · Delete remove', w - 214, 66);

            ctx.fillText('(Background shows the actual menu)', w - 214, 82);

            ctx.restore();

        }

    },



    _drawEl: function (el) {

        var ctx = this._ctx; ctx.save();

        var drawRR = function (x, y, w, h, r) {

            ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);

            ctx.quadraticCurveTo(x + w, y, x + w, y + r);

            ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);

            ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);

            ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();

        };

        if (el.type === 'image' && el.image) {

            ctx.drawImage(el.image, el.x, el.y, el.w, el.h);

        } else if (el.type === 'button') {

            ctx.fillStyle = el.bgColor || '#383838';

            drawRR(el.x, el.y, el.w, el.h, 12); ctx.fill();

            ctx.fillStyle = '#fff';

            ctx.font = 'bold 14px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

            ctx.fillText(el.label || 'Button', el.x + el.w / 2, el.y + el.h / 2);

            if (el.command && el.command !== 'none') {

                ctx.fillStyle = '#ffb12b'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';

                ctx.fillText('➤ ' + el.command, el.x + el.w - 4, el.y + el.h - 4);

            }

        } else if (el.type === 'comment') {

            ctx.fillStyle = 'rgba(40,60,40,0.88)';

            drawRR(el.x, el.y, el.w, el.h, 8); ctx.fill();

            ctx.strokeStyle = '#4a8'; ctx.lineWidth = 1.5; ctx.stroke();

            ctx.fillStyle = '#8f8'; ctx.font = 'bold 11px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';

            ctx.fillText('💬 ' + (el.text || 'note'), el.x + 10, el.y + 8);

            ctx.fillStyle = '#888'; ctx.font = 'italic 10px Segoe UI';

            ctx.fillText('(editor only)', el.x + 10, el.y + el.h - 20);

        }

        ctx.restore();

    },



    /* ═══════════════════════════

       3D WORLD EDITOR (physics + hierarchy + realistic lighting)

       ═══════════════════════════ */

    _render3DEditor: function () {

        this._mode = 'map';

        this._mapLib = this._loadLib();

        // Global asset register shared with _mapLib for batch import + click-to-spawn

        window.editorAssets = window.editorAssets || {};

        window.editorAssets.models = this._mapLib;

        this._mapObjs = this._loadMap();

        // Extract grass blade data from saved map into global single-mesh buffer

        this._grassBladeData = [];

        this._grassCount = 0;

        for (var oi = 0; oi < this._mapObjs.length; oi++) {

            var go = this._mapObjs[oi];

            if (go && go.kind === 'grass3d' && go.bladeData && go.bladeData.length > 0) {

                Array.prototype.push.apply(this._grassBladeData, go.bladeData);

            }

        }

        this._grassCount = this._grassBladeData.length;

        // Keep only ONE grass3d entry and point it at the live array

        var keptGrass = false;

        for (var oi2 = this._mapObjs.length - 1; oi2 >= 0; oi2--) {

            if (this._mapObjs[oi2] && this._mapObjs[oi2].kind === 'grass3d') {

                if (!keptGrass) {

                    this._mapObjs[oi2].bladeData = this._grassBladeData;

                    keptGrass = true;

                } else {

                    this._mapObjs.splice(oi2, 1);

                }

            }

        }

        this._mapSelObj = null; this._mapSelObjs = [];

        this._mapPlacing = false; this._mapPlacingMulti = [];

        this._physSimulating = false;



        var c = document.getElementById('editor123-content');



        // Layout: Library (left) | 3D Viewport (center) | Hierarchy (right)

        c.innerHTML =

            '<div style="width:240px;min-width:240px;background:#1a1e24;display:flex;flex-direction:column;border-right:1px solid #252a32">' +

            '<div style="padding:10px 12px;border-bottom:1px solid #252a32">' +

            '<h3 style="margin:0;color:#ffb12b;font-size:13px;letter-spacing:.3px">📦 LIBRARY</h3>' +

            '<div style="font-size:10px;color:#666;margin-top:2px"><span id="e-lib-count">' + this._mapLib.length + '</span> models <span id="e-lib-sel-count" style="color:#ffb12b;display:none"></span></div></div>' +

            '<div id="e-lib-list" data-lib-container style="flex:1;overflow-y:auto;padding:6px">' +

            (this._mapLib.length === 0 ? '<div style="color:#555;font-size:11px;text-align:center;padding:20px 6px">No models.<br>Click Import below.</div>' : '') + '</div>' +

            '<div style="padding:6px;border-top:1px solid #252a32">' +

            '<span class="e123-tbtn e-pri" id="e-imp" style="display:block;text-align:center;font-size:11px;padding:5px">📥 Import GLB / FBX</span>' +

            '<span class="e123-tbtn" id="e-imp-server" style="display:block;text-align:center;font-size:11px;padding:5px;margin-top:3px">🌐 From Server</span>' +

            '<span class="e123-tbtn" id="e-del-lib" style="display:block;text-align:center;font-size:11px;padding:5px;margin-top:3px;color:#c66">🗑️ Remove</span></div>' +

            '<div id="e123-map-back" style="padding:8px;background:#2a2f36;text-align:center;cursor:pointer;color:#888;font-size:11px">← Back</div></div>' +



            // Center: 3D viewport

            '<div style="flex:1;display:flex;flex-direction:column">' +

            '<div style="padding:4px 10px;background:#1a1e24;border-bottom:1px solid #252a32;display:flex;align-items:center;gap:6px;flex-shrink:0;font-size:11px">' +

            '<span style="color:#ffb12b;font-weight:600;font-size:12px">🌍 Viewport</span>' +

            '<span class="e123-tbtn e-pri" id="e-add-btn" style="font-size:11px;font-weight:700">+ Add</span>' +

            '<span style="color:#666"><span id="e-obj-cnt">' + this._mapObjs.length + '</span> objs</span>' +

            '<span id="e-placing-indicator" style="color:#8f8;display:none">🔵 Placing...</span>' +

            '<span style="color:#444">|</span>' +

            '<span class="e123-tbtn e123-gizmo-btn" data-gizmo="translate" style="font-size:10px;font-weight:600">⟷ Move</span>' +

            '<span class="e123-tbtn e123-gizmo-btn" data-gizmo="rotate" style="font-size:10px">↻ Rot</span>' +

            '<span class="e123-tbtn e123-gizmo-btn" data-gizmo="scale" style="font-size:10px">⇔ Scale</span>' +

            '<span style="color:#444">|</span>' +

            '<span class="e123-tbtn" id="e-snap-btn" style="font-size:10px">🧲 Snap</span>' +

            '<span class="e123-tbtn" id="e-scatter-btn" style="font-size:10px">🌱 Scatter</span>' +

            '<span class="e123-tbtn" id="e-rand-btn" style="font-size:10px">🎲 Rand</span>' +

            '<span class="e123-tbtn" id="e-scene-settings-btn" style="font-size:10px">⚙️ Scene</span>' +

            '<div style="flex:1"></div>' +

            '<span class="e123-tbtn" id="e-simulate" style="font-size:10px">▶ Sim</span>' +

            '<span class="e123-tbtn" id="e-clear-3d" style="color:#c66;font-size:10px">🗑️ Clear</span>' +

            '<span class="e123-tbtn e-pri" id="e-save-3d" style="font-size:10px">💾 Save</span>' +

            '<span class="e123-tbtn" id="e-gamemodes-btn" style="font-size:10px;color:#ff9a2a">🎮 GAMEMODES</span>' +

            '<span class="e123-tbtn" id="e-deselect-btn" style="font-size:10px;color:#ffb12b">✕ Deselect</span>' +

            '<span class="e123-tbtn e-pri" id="e-save-game" style="font-size:10px">🎮 Save to Game</span>' +

            '<span class="e123-tbtn" id="e-export-map" style="font-size:10px">📋 Export Map Code</span>' +

            '<span id="e-shortcuts-toggle" style="font-size:10px;color:#666;cursor:pointer;padding:0 4px" title="Keyboard shortcuts">⌨️</span></div>' +

            '<div id="e-shortcuts-panel" style="display:none;position:absolute;top:32px;right:8px;background:#1a1e24;border:1px solid #2a2f36;border-radius:6px;padding:8px 12px;font-size:10px;color:#aaa;z-index:50;line-height:1.6;white-space:nowrap">' +

            '<b style="color:#ffb12b">Scene Shortcuts</b><br>' +

            'Ctrl+Click — Toggle multi-select<br>' +

            'Ctrl+A — Select all objects<br>' +

            'Ctrl+C — Copy selected<br>' +

            'Ctrl+V — Paste<br>' +

            'Ctrl+D — Duplicate<br>' +

            'Delete — Delete selected<br>' +

            'ESC — Deselect<br>' +

            'G — Toggle snap-to-grid<br>' +

            'R — Randomize rotation<br>' +

            'F — Focus on selected<br>' +

            '<b style="color:#ffb12b;margin-top:4px;display:inline-block">Library Shortcuts</b><br>' +

            'Ctrl+Click — Toggle multi-select<br>' +

            'Ctrl+A — Select all models<br>' +

            'Delete — Remove selected</div>' +

            '<div id="e-view-3d" style="flex:1;position:relative;overflow:hidden;background:#111;min-height:300px"></div></div>' +



            // Right: Hierarchy + Inspector

            '<div style="width:240px;min-width:240px;background:#1a1e24;display:flex;flex-direction:column;border-left:1px solid #252a32">' +

            '<div style="padding:10px 12px;border-bottom:1px solid #252a32">' +

            '<h3 style="margin:0;color:#ffb12b;font-size:13px;letter-spacing:.3px">📋 HIERARCHY</h3>' +

            '<div style="font-size:10px;color:#666;margin-top:2px">Scene objects</div></div>' +

            '<div id="e-hierarchy" style="flex:1;overflow-y:auto;padding:6px">' +

            '<div style="padding:5px 8px;color:#555;font-size:11px;border-left:2px solid #3a4;margin-bottom:2px">🌍 Ground</div>' +

            '</div>' +

            '<div style="border-top:1px solid #252a32;padding:10px 12px">' +

            '<h3 style="margin:0;color:#ffb12b;font-size:13px;letter-spacing:.3px">🔍 INSPECTOR</h3></div>' +

            '<div id="e-inspector" style="flex:0 0 auto;max-height:260px;overflow-y:auto;padding:6px 12px 12px;font-size:12px">' +

            '<div style="color:#555">Select an object to edit</div></div></div>';



        // Populate library list + hierarchy

        this._renderLibList();

        this._renderHierarchy();

        this._wire3DTools();

        this._init3DScene();

        this._wireKeys();

        // Ensure at least one ground exists

        var hasGround = false;

        this._mapObjs.forEach(function (o) { if ((o.kind || '') === 'ground') hasGround = true; });

        if (!hasGround) {

            this._mapObjs.push({ kind: 'ground', subType: 'ground', name: 'Ground', x: 0, z: 0, y: 0, rot: 0, scale: 1, color: 0x5a7a5a, planeW: 80, planeH: 80, type: 'wall' });

        }

        // Build 3D scene from loaded objects (safe wrap)

        try { this._rebuildScene(); } catch (e) { console.error('Editor startup rebuild failed', e); }

    },



    /* ---------- Add menu (primitives, 2D, image, light, sound, water) ---------- */

    _showAddMenu: function () {

        var self = this;

        var existing = document.getElementById('e-add-dropdown');

        if (existing) { existing.remove(); return; }

        var div = document.createElement('div');

        div.id = 'e-add-dropdown';

        div.style.cssText = 'position:absolute;top:28px;left:50px;z-index:300;background:#1a1e24;border:1px solid #2a2f36;border-radius:8px;padding:6px;font-size:11px;box-shadow:0 4px 20px rgba(0,0,0,0.5);min-width:200px';

        var items = [];

        function addItem(cat, icon, onClick) {

            items.push({ cat: cat, icon: icon, onClick: onClick });

        }

        addItem('Primitives', 'Cube', function () { self._spawnBuiltin('primitive', 'cube', 'Cube'); });

        addItem('Primitives', 'Sphere', function () { self._spawnBuiltin('primitive', 'sphere', 'Sphere'); });

        addItem('Primitives', 'Cylinder', function () { self._spawnBuiltin('primitive', 'cylinder', 'Cylinder'); });

        addItem('Primitives', 'Plane', function () { self._spawnBuiltin('primitive', 'plane', 'Plane'); });

        addItem('Primitives', 'Cone', function () { self._spawnBuiltin('primitive', 'cone', 'Cone'); });

        addItem('Primitives', 'Torus', function () { self._spawnBuiltin('primitive', 'torus', 'Torus'); });

        addItem('2D Shapes', 'Square', function () { self._spawnBuiltin('shape2d', 'square', 'Square'); });

        addItem('2D Shapes', 'Circle', function () { self._spawnBuiltin('shape2d', 'circle', 'Circle'); });

        addItem('2D Shapes', 'Triangle', function () { self._spawnBuiltin('shape2d', 'triangle', 'Triangle'); });

        addItem('2D Shapes', 'Hexagon', function () { self._spawnBuiltin('shape2d', 'hexagon', 'Hexagon'); });

        addItem('Image', 'Import Image...', function () { self._importImage(); div.remove(); });

        addItem('Light', 'Directional', function () { self._spawnBuiltin('light', 'directional', 'Directional Light'); });

        addItem('Light', 'Point', function () { self._spawnBuiltin('light', 'point', 'Point Light'); });

        addItem('Light', 'Spot', function () { self._spawnBuiltin('light', 'spot', 'Spot Light'); });

        addItem('Light', 'Ambient', function () { self._spawnBuiltin('light', 'ambient', 'Ambient Light'); });

        addItem('Sound', 'Sound Source', function () { self._spawnBuiltin('sound', 'sound', 'Sound'); });

        addItem('Water', 'Water Body', function () { self._spawnBuiltin('water', 'water', 'Water Body'); });

        addItem('Ground', 'Ground Plane', function () { self._spawnBuiltin('ground', 'ground', 'Ground Plane'); });

        addItem('Spawn Points', 'Player Spawn', function () { self._spawnSpawnPoint('player', 'Player Spawn'); });

        addItem('Spawn Points', 'Gladiator Spawn', function () { self._spawnSpawnPoint('gladiator', 'Gladiator Spawn'); });

        addItem('Spawn Points', 'Blue Box (Gladiator)', function () { self._spawnSpawnPoint('gladiatorbox', 'Blue Box'); });

        addItem('Spawn Points', 'Platform King Spawn', function () { self._spawnSpawnPoint('platform-king', 'Platform King Spawn'); });

        addItem('Spawn Points', 'AFK Dummy Spawn', function () { self._spawnSpawnPoint('afk-dummy', 'AFK Dummy Spawn'); });

        addItem('Spawn Points', 'Attack Dummy Spawn', function () { self._spawnSpawnPoint('attack-dummy', 'Attack Dummy Spawn'); });

        addItem('Tools', '🌿 Grass Painter', function () { self._showGrassPainter(); });

        addItem('Tools', '🎨 Paint Terrain', function () { self._showPaintTool(); });

        var cats = {};

        items.forEach(function (it) { if (!cats[it.cat]) cats[it.cat] = []; cats[it.cat].push(it); });

        var html = '';

        var catIcons = { Primitives: '✨', '2D Shapes': '📐', Image: '🖼️', Light: '💡', Sound: '🔊', Water: '🌊', Ground: '🏔️', 'Spawn Points': '📍', Tools: '🔧' };

        Object.keys(cats).forEach(function (cat) {

            html += '<div style="color:#ffb12b;font-size:10px;font-weight:600;padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.5px">' + (catIcons[cat] || '') + ' ' + cat + '</div>';

            cats[cat].forEach(function (it) {

                html += '<div class="e123-add-item" style="padding:5px 8px;cursor:pointer;border-radius:4px;color:#ccc;display:flex;align-items:center;gap:6px">' +

                    '<span>' + it.icon + '</span></div>';

            });

        });

        div.innerHTML = html;

        var btn = document.getElementById('e-add-btn');

        if (btn) btn.parentNode.appendChild(div);

        var idx = 0;

        div.querySelectorAll('.e123-add-item').forEach(function (el) {

            var handler = items[idx].onClick;

            el.onclick = function (e) { e.stopPropagation(); handler(); div.remove(); };

            el.onmouseover = function () { this.style.background = '#2a2f36'; };

            el.onmouseout = function () { this.style.background = 'transparent'; };

            idx++;

        });

        setTimeout(function () {

            document.addEventListener('click', function _close(e) {

                if (!div.contains(e.target) && e.target.id !== 'e-add-btn') { div.remove(); document.removeEventListener('click', _close); }

            }, { once: false });

        }, 10);

    },



    _spawnBuiltin: function (kind, subType, name) {

        var obj = {

            kind: kind, subType: subType, name: name,

            x: 0, z: 0, y: 0.5, rot: 0, scale: 1,

            color: kind === 'light' ? 0xffffff : 0x5a7acc,

            type: kind === 'water' ? 'water' : 'wall',

        };

        if (kind === 'light') {

            obj.y = 5; obj.intensity = 1; obj.range = 20; obj.angle = Math.PI / 4;

        }

        if (kind === 'sound') {

            obj.y = 1; obj.volume = 1; obj.range = 15; obj.soundShape = 'sphere';

        }

        if (kind === 'water') {

            obj.y = 0.05; obj.planeW = 20; obj.planeH = 20; obj.type = 'water';

        }

        if (kind === 'image') {

            obj.y = 1; obj.planeW = 2; obj.planeH = 2; obj.imgData = null;

        }

        if (kind === 'ground') {

            obj.y = 0; obj.planeW = 40; obj.planeH = 40; obj.color = 0x4a6a4a; obj.type = 'wall';

        }

        this._mapObjs.push(obj);

        var idx = this._mapObjs.length - 1;

        this._selectObject(idx, false);

        this._updCnt();

        this._rebuildScene();

        this._renderHierarchy();

        this.toast('Added: ' + name);

    },



    _spawnSpawnPoint: function (spawnType, name) {
        var obj = {
            kind: 'spawnpoint',
            subType: spawnType,
            name: name,
            x: 0, z: 0, y: 0.5, rot: 0, scale: 1,
            color: this._getSpawnPointColor(spawnType),
            type: 'spawnpoint'
        };
        this._mapObjs.push(obj);
        var idx = this._mapObjs.length - 1;
        this._selectObject(idx, false);
        this._updCnt();
        this._rebuildScene();
        this._renderHierarchy();
        this.toast('Added: ' + name);
    },

    _getSpawnPointColor: function (spawnType) {
        switch (spawnType) {
            case 'player': return 0x00ff00;
            case 'gladiator': return 0xff0000;
            case 'gladiatorbox': return 0x2299ff;
            case 'platform-king': return 0xffa500;
            case 'afk-dummy': return 0x808080;
            case 'attack-dummy': return 0xff00ff;
            default: return 0xffffff;
        }
    },



    _showPaintTool: function () {

        var self = this;

        this._paintMode = !this._paintMode;

        if (!this._paintMode) { this.toast('Paint mode OFF'); return; }

        // Create a simple color picker overlay

        var existing = document.getElementById('e-paint-panel');

        if (existing) existing.remove();

        var div = document.createElement('div');

        div.id = 'e-paint-panel';

        div.style.cssText = 'position:absolute;top:28px;left:230px;z-index:300;background:#1a1e24;border:1px solid #2a2f36;border-radius:8px;padding:10px;font-size:11px;box-shadow:0 4px 20px rgba(0,0,0,0.5);min-width:180px';

        div.innerHTML =

            '<div style="color:#ffb12b;font-weight:600;margin-bottom:6px">🎨 Paint Terrain</div>' +

            '<label style="color:#aaa;display:block;margin:4px 0">Color:</label>' +

            '<input type="color" id="e-paint-color" value="#4a7a4a" style="width:100%;height:30px;border:none;background:transparent;cursor:pointer">' +

            '<label style="color:#aaa;display:block;margin:4px 0">Brush size:</label>' +

            '<input type="range" id="e-paint-size" min="1" max="10" step="0.5" value="2" style="width:100%">' +

            '<div style="margin-top:8px;display:flex;gap:4px">' +

            '<span class="e123-tbtn e-pri" id="e-paint-apply" style="flex:1;text-align:center">Paint</span>' +

            '<span class="e123-tbtn" id="e-paint-close" style="flex:1;text-align:center">Close</span></div>' +

            '<div style="color:#666;font-size:10px;margin-top:6px">Click on ground or objects to paint</div>';

        var btn = document.getElementById('e-add-btn');

        if (btn) btn.parentNode.appendChild(div);

        document.getElementById('e-paint-color').oninput = function () {

            self._paintColor = parseInt(this.value.substring(1), 16);

        };

        document.getElementById('e-paint-size').oninput = function () {

            self._paintBrushSize = parseFloat(this.value);

        };

        document.getElementById('e-paint-apply').onclick = function () {

            self._paintMode = true;

            self.toast('Paint mode active — click objects to color them');

        };

        document.getElementById('e-paint-close').onclick = function () {

            self._paintMode = false;

            div.remove();

            self.toast('Paint mode OFF');

        };

        self._paintMode = true;

        self.toast('Paint mode active — click objects to color them');

    },



    _showGrassPainter: function () {

        var self = this;

        var existing = document.getElementById('e-grass-panel');

        if (existing) { existing.remove(); self._currentTool = 'select'; self._grassMode = false; if (self._grassBrushCircle) self._grassBrushCircle.visible = false; self.toast('Grass painter closed'); return; }

        var div = document.createElement('div');

        div.id = 'e-grass-panel';

        div.style.cssText = 'position:absolute;top:28px;left:230px;z-index:300;background:#1a1e24;border:1px solid #2a2f36;border-radius:8px;padding:10px;font-size:11px;box-shadow:0 4px 20px rgba(0,0,0,0.5);min-width:200px';

        div.innerHTML =

            '<div style="color:#ffb12b;font-weight:600;margin-bottom:6px">🌿 3D Grass Painter</div>' +

            '<div style="color:#888;font-size:10px;margin-bottom:8px">Instanced 3D blades with wind sway &amp; gradient</div>' +

            '<label style="color:#aaa;display:block;margin:4px 0">Brush radius:</label>' +

            '<input type="range" id="e-grass-radius" min="0.3" max="15" step="0.1" value="3" style="width:100%">' +

            '<label style="color:#aaa;display:block;margin:4px 0">Blades per click:</label>' +

            '<input type="range" id="e-grass-density" min="1" max="300" step="1" value="20" style="width:100%">' +

            '<label style="color:#aaa;display:block;margin:4px 0">Blade width:</label>' +

            '<input type="range" id="e-grass-w" min="0.02" max="0.2" step="0.01" value="0.08" style="width:100%">' +

            '<label style="color:#aaa;display:block;margin:4px 0">Blade height:</label>' +

            '<input type="range" id="e-grass-h" min="0.05" max="0.5" step="0.01" value="0.3" style="width:100%">' +

            '<label style="color:#aaa;display:block;margin:4px 0">Color base:</label>' +

            '<input type="color" id="e-grass-color-bottom" value="#4f7c13" style="width:100%;height:24px;border:none;background:transparent;cursor:pointer">' +

            '<label style="color:#aaa;display:block;margin:4px 0">Color tip:</label>' +

            '<input type="color" id="e-grass-color-top" value="#79a01c" style="width:100%;height:24px;border:none;background:transparent;cursor:pointer">' +

            '<details style="margin-top:8px;background:#1e232a;border-radius:6px;padding:4px">' +

            '<summary style="cursor:pointer;color:#ffb12b;font-weight:600;font-size:11px;padding:4px">🌬️ Wind &amp; Shader</summary>' +

            '<div style="padding:6px 4px">' +

            '<label style="color:#aaa;display:block;margin:2px 0;font-size:10px">Wind Speed (' + this._grassWindSpeed.toFixed(1) + ')</label>' +

            '<input type="range" id="e-grass-wind-speed" min="0.1" max="5.0" step="0.1" value="' + this._grassWindSpeed + '" style="width:100%">' +

            '<label style="color:#aaa;display:block;margin:2px 0;font-size:10px">Wind Strength (' + this._grassWindStrength.toFixed(1) + ')</label>' +

            '<input type="range" id="e-grass-wind-strength" min="0.0" max="2.0" step="0.05" value="' + this._grassWindStrength + '" style="width:100%">' +

            '</div></details>' +

            '<div style="margin-top:6px;display:flex;gap:4px">' +

            '<span class="e123-tbtn e-pri" id="e-grass-paint" style="flex:1;text-align:center">🌱 Paint</span>' +

            '<span class="e123-tbtn" id="e-grass-erase" style="flex:1;text-align:center;color:#f88">🧹 Erase</span>' +

            '<span class="e123-tbtn" id="e-grass-close" style="flex:1;text-align:center">Close</span></div>' +

            '<div style="color:#666;font-size:10px;margin-top:6px">Click/hold to paint or erase 3D grass</div>';

        var btn = document.getElementById('e-add-btn');

        if (btn) btn.parentNode.appendChild(div);



        document.getElementById('e-grass-radius').oninput = function () { self._grassBrushSize = parseFloat(this.value); if (self._grassBrushCircle) { self._grassBrushCircle.scale.setScalar(self._grassBrushSize); } };

        document.getElementById('e-grass-density').oninput = function () { self._grassDensity = parseInt(this.value); };

        document.getElementById('e-grass-w').oninput = function () { self._grass3dWidth = parseFloat(this.value); };

        document.getElementById('e-grass-h').oninput = function () { self._grass3dHeight = parseFloat(this.value); };

        document.getElementById('e-grass-color-bottom').oninput = function () {

            self._grass3dColorBottom = this.value;

        };

        document.getElementById('e-grass-color-top').oninput = function () {

            self._grass3dColorTop = this.value;

        };



        document.getElementById('e-grass-wind-speed').oninput = function () {

            self._grassWindSpeed = parseFloat(this.value);

            var lbl = this.previousElementSibling;

            if (lbl) lbl.textContent = 'Wind Speed (' + self._grassWindSpeed.toFixed(1) + ')';

            if (self._grassMesh && self._grassMesh.material && self._grassMesh.material.uniforms) {

                self._grassMesh.material.uniforms.uWindSpeed.value = self._grassWindSpeed;

            }

        };

        document.getElementById('e-grass-wind-strength').oninput = function () {

            self._grassWindStrength = parseFloat(this.value);

            var lbl = this.previousElementSibling;

            if (lbl) lbl.textContent = 'Wind Strength (' + self._grassWindStrength.toFixed(1) + ')';

            if (self._grassMesh && self._grassMesh.material && self._grassMesh.material.uniforms) {

                self._grassMesh.material.uniforms.uWindStrength.value = self._grassWindStrength;

            }

        };



        document.getElementById('e-grass-paint').onclick = function () {

            self._currentTool = 'grass_painter';

            self._grassMode = true;

            self._grassEraseMode = false;

            self.toast('3D grass paint active — click ground to stamp blades');

        };

        document.getElementById('e-grass-erase').onclick = function () {

            self._currentTool = 'grass_painter';

            self._grassMode = true;

            self._grassEraseMode = true;

            if (self._grassBrushCircle) self._grassBrushCircle.scale.setScalar(self._grassBrushSize);

            self.toast('Grass erase active — click/hold to remove blades');

        };

        document.getElementById('e-grass-close').onclick = function () {

            self._currentTool = 'select';

            self._grassMode = false;

            self._grassEraseMode = false;

            if (self._grassBrushCircle) self._grassBrushCircle.visible = false;

            div.remove();

            self.toast('Grass painter closed');

        };

        // NOTE: _currentTool stays 'select' until user clicks Paint or Erase

        self.toast('Grass painter panel open — configure settings, then click 🌱 Paint');

    },



    _spawnGrass: function (pos) {

        var count = this._grassDensity || 20;

        var radius = this._grassBrushSize || 3;

        var newBlades = [];

        for (var gi = 0; gi < count; gi++) {

            var angle = Math.random() * Math.PI * 2;

            var dist = Math.sqrt(Math.random()) * radius;

            var rotY = Math.random() * Math.PI * 2;

            var sx = this._grass3dWidth || 0.08;

            var sy = this._grass3dHeight || 0.3;

            sx *= 0.7 + Math.random() * 0.6;

            sy *= 0.7 + Math.random() * 0.6;

            newBlades.push({

                x: pos.x + Math.cos(angle) * dist,

                z: pos.z + Math.sin(angle) * dist,

                y: 0, rotY: rotY, sx: sx, sy: sy,

            });

        }



        // Persist blade data

        Array.prototype.push.apply(this._grassBladeData, newBlades);



        // Ensure ONE map entry for the whole grass layer

        var grassEntry = null;

        for (var oi = 0; oi < this._mapObjs.length; oi++) {

            if (this._mapObjs[oi] && this._mapObjs[oi].kind === 'grass3d') {

                grassEntry = this._mapObjs[oi];

                break;

            }

        }

        if (!grassEntry) {

            grassEntry = {

                kind: 'grass3d', subType: 'painter', name: 'Grass Instanced',

                x: 0, z: 0, y: 0,

                bladeData: this._grassBladeData,

                width: this._grass3dWidth || 0.08,

                height: this._grass3dHeight || 0.3,

                colorBottom: this._grass3dColorBottom || '#4f7c13',

                colorTop: this._grass3dColorTop || '#79a01c',

            };

            this._mapObjs.push(grassEntry);

            this._updCnt();

            this._renderHierarchy();

        } else {

            grassEntry.bladeData = this._grassBladeData;

        }



        // Update or create the single InstancedMesh

        var startIdx = this._grassCount;

        this._grassCount += newBlades.length;

        this._ensureGrassMesh();

        if (!this._grassMesh) return;  // shaders not available



        var dummy = new THREE.Object3D();

        for (var vi = 0; vi < newBlades.length; vi++) {

            var bd = newBlades[vi];

            var idx = startIdx + vi;

            var sw = bd.sx || 0.08;

            var sh = bd.sy || 0.3;

            dummy.position.set(bd.x, bd.y, bd.z);

            dummy.rotation.set(0, bd.rotY || 0, 0);

            dummy.scale.set(sw, sh, sw);

            dummy.updateMatrix();

            this._grassMesh.setMatrixAt(idx, dummy.matrix);

        }

        this._grassMesh.instanceMatrix.needsUpdate = true;

        this._grassMesh.count = this._grassCount;

        this._grassMesh.computeBoundingSphere();

        this._grassMesh.computeBoundingBox();

        this._grassMesh.frustumCulled = false;



        this.toast('Placed ' + count + ' 3D grass blades (total ' + this._grassCount + ')');

    },



    _eraseGrass: function (pos) {

        if (!this._grassMesh) return;

        var radius = this._grassBrushSize || 3;

        var radiusSq = radius * radius;

        var keep = [];

        for (var ei = 0; ei < this._grassBladeData.length; ei++) {

            var bd = this._grassBladeData[ei];

            var dx = bd.x - pos.x;

            var dz = bd.z - pos.z;

            if (dx * dx + dz * dz > radiusSq) {

                keep.push(bd);

            }

        }

        var removed = this._grassBladeData.length - keep.length;

        if (removed === 0) return;



        this._grassBladeData = keep;

        this._grassCount = keep.length;



        // Rebuild instance matrix from kept blades

        var dummy = new THREE.Object3D();

        for (var ei = 0; ei < this._grassCount; ei++) {

            var bd = this._grassBladeData[ei];

            var sw = bd.sx || 0.08;

            var sh = bd.sy || 0.3;

            dummy.position.set(bd.x, bd.y, bd.z);

            dummy.rotation.set(0, bd.rotY || 0, 0);

            dummy.scale.set(sw, sh, sw);

            dummy.updateMatrix();

            this._grassMesh.setMatrixAt(ei, dummy.matrix);

        }

        this._grassMesh.instanceMatrix.needsUpdate = true;

        this._grassMesh.count = this._grassCount;



        // Sync to the map entry so JSON save reflects it

        for (var oi = 0; oi < this._mapObjs.length; oi++) {

            if (this._mapObjs[oi] && this._mapObjs[oi].kind === 'grass3d') {

                this._mapObjs[oi].bladeData = this._grassBladeData;

                break;

            }

        }



        this.toast('Erased ' + removed + ' blade(s) — ' + this._grassCount + ' remaining');

    },



    /** Create or recreate the single global grass InstancedMesh for all blades */

    _ensureGrassMesh: function () {

        var g3dDef = (typeof SHADERS !== 'undefined' && SHADERS.grass3d) ? SHADERS.grass3d : null;

        if (!g3dDef) return;



        // If mesh exists and params match, reuse it

        if (this._grassMesh && this._grassMesh.geometry && this._grassMesh.material) {

            // Sync all live uniforms to the material

            var mu = this._grassMesh.material.uniforms;

            mu.uColorBottom.value.set(this._grass3dColorBottom);

            mu.uColorTop.value.set(this._grass3dColorTop);

            mu.uWindSpeed.value = this._grassWindSpeed;

            mu.uWindStrength.value = this._grassWindStrength;

            return;

        }



        // Dispose old mesh

        if (this._grassMesh) {

            this._mapScene.remove(this._grassMesh);

            this._grassMesh.geometry.dispose();

            this._grassMesh.material.dispose();

        }



        var g3dMat = new THREE.ShaderMaterial({

            uniforms: THREE.UniformsUtils.clone(g3dDef.uniforms),

            vertexShader: g3dDef.vertexShader,

            fragmentShader: g3dDef.fragmentShader,

            side: THREE.DoubleSide,

        });

        g3dMat.uniforms.uColorBottom.value.set(this._grass3dColorBottom);

        g3dMat.uniforms.uColorTop.value.set(this._grass3dColorTop);

        g3dMat.uniforms.uWindSpeed.value = this._grassWindSpeed;

        g3dMat.uniforms.uWindStrength.value = this._grassWindStrength;

        g3dMat.uniforms.uTime.value = performance.now() / 1000;



        var bladeGeo = this._makeBladeGeometry(3);

        var im = new THREE.InstancedMesh(bladeGeo, g3dMat, this._grassMaxBlades);

        im.castShadow = false;

        im.receiveShadow = true;

        im.frustumCulled = false;

        bladeGeo.computeBoundingBox();

        bladeGeo.computeBoundingSphere();

        im.count = this._grassCount;



        // Write all existing blades

        if (this._grassCount > 0) {

            var dummy2 = new THREE.Object3D();

            for (var bi = 0; bi < this._grassCount; bi++) {

                var bd2 = this._grassBladeData[bi];

                var sw2 = bd2.sx || 0.08;

                var sh2 = bd2.sy || 0.3;

                dummy2.position.set(bd2.x, bd2.y, bd2.z);

                dummy2.rotation.set(0, bd2.rotY || 0, 0);

                dummy2.scale.set(sw2, sh2, sw2);

                dummy2.updateMatrix();

                im.setMatrixAt(bi, dummy2.matrix);

            }

            im.instanceMatrix.needsUpdate = true;

        }



        this._mapScene.add(im);

        this._grassMesh = im;

    },



    _importImage: function (replaceIdx) {

        var self = this;

        var inp = document.createElement('input');

        inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';

        inp.onchange = function (e) {

            var f = e.target.files[0]; if (!f) return;

            var img = new Image();

            img.onload = function () {

                if (replaceIdx != null && self._mapObjs[replaceIdx]) {

                    // Replace image in existing object

                    var obj = self._mapObjs[replaceIdx];

                    if (obj.imgUrl) URL.revokeObjectURL(obj.imgUrl);

                    obj.imgUrl = URL.createObjectURL(f);

                    obj.imgWidth = img.width;

                    obj.imgHeight = img.height;

                    obj.planeW = Math.min(img.width / 256, 4);

                    obj.planeH = Math.min(img.height / 256, 4);

                    self._rebuildScene();

                    self._renderInspector();

                    self.toast('Image replaced: ' + f.name);

                } else {

                    // Create new image object

                    var obj = {

                        kind: 'image', subType: 'image', name: f.name.replace(/\.[^.]+$/, ''),

                        x: 0, z: 0, y: 1, rot: 0, scale: 1,

                        color: 0xffffff, type: 'wall',

                        imgData: null, imgBase64: null,

                        planeW: Math.min(img.width / 256, 4), planeH: Math.min(img.height / 256, 4),

                        imgWidth: img.width, imgHeight: img.height,

                    };

                    obj.imgUrl = URL.createObjectURL(f);

                    self._mapObjs.push(obj);

                    var idx = self._mapObjs.length - 1;

                    self._selectObject(idx, false);

                    self._updCnt(); self._rebuildScene(); self._renderHierarchy();

                    self.toast('Image added: ' + f.name);

                }

                inp.value = '';

            };

            img.src = URL.createObjectURL(f);

        };

        inp.click();

    },



    _makeBladeGeometry: function (segments) {

        segments = Math.max(1, Math.round(segments || 3));

        var positions = new Float32Array((segments * 2 + 1) * 3);

        for (var i = 0; i < segments; i++) {

            var t = i / segments;

            var w = 0.5 * Math.pow(1 - t, 1.2);

            positions[i * 6 + 0] = -w;

            positions[i * 6 + 1] = t;

            positions[i * 6 + 3] = w;

            positions[i * 6 + 4] = t;

        }

        positions[segments * 6 + 1] = 1;

        var indices = [];

        for (var i = 0; i < segments - 1; i++) {

            var l = i * 2, r = l + 1, nl = l + 2, nr = l + 3;

            indices.push(l, nl, r, r, nl, nr);

        }

        var lastL = (segments - 1) * 2;

        indices.push(lastL, segments * 2, lastL + 1);

        var geo = new THREE.BufferGeometry();

        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        geo.setIndex(indices);

        geo.computeVertexNormals();

        geo.computeBoundingBox();

        geo.computeBoundingSphere();

        return geo;

    },



    _renderLibList: function () {

        var list = document.getElementById('e-lib-list') || document.getElementById('library-container') || document.querySelector('[data-lib-container]');

        if (!list) return;

        list.innerHTML = '';

        var cnt = document.getElementById('e-lib-count');

        if (cnt) cnt.textContent = this._mapLib.length;

        var selCnt = document.getElementById('e-lib-sel-count');

        if (selCnt) { selCnt.style.display = this._mapPlacingMulti.length > 0 ? '' : 'none'; selCnt.textContent = '(' + this._mapPlacingMulti.length + ' sel)'; }

        if (this._mapLib.length === 0) {

            list.innerHTML = '<div data-placeholder style="color:#555;font-size:11px;text-align:center;padding:20px 6px">No models.<br>Click Import below.</div>';

            return;

        }

        var self = this;

        var selSet = {};

        this._mapPlacingMulti.forEach(function (i) { selSet[i] = true; });

        this._mapLib.forEach(function (m, i) {

            var selected = !!selSet[i];

            var item = document.createElement('div');

            item.className = 'e123-lib-item';

            item.dataset.idx = i;

            item.style.cssText = 'padding:6px 8px;background:' + (selected ? 'rgba(255,177,43,0.12)' : '#22272e') + ';border-radius:5px;margin-bottom:3px;cursor:pointer;border:1.5px solid ' + (selected ? '#ffb12b' : 'transparent') + ';display:flex;align-items:center;gap:6px';

            item.innerHTML = '<div style="width:28px;height:28px;background:#181c22;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">📦</div>' +

                '<div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:600;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (m.name || 'Model') + '</div>' +

                '<div style="font-size:9px;color:#666">' + (m.type || 'glb') + '</div></div>';

            item.onclick = function (ev) {

                if (ev.ctrlKey || ev.metaKey) {

                    // Toggle multi-select

                    var idx = parseInt(this.dataset.idx);

                    var pos = self._mapPlacingMulti.indexOf(idx);

                    if (pos >= 0) {

                        self._mapPlacingMulti.splice(pos, 1);

                    } else {

                        self._mapPlacingMulti.push(idx);

                    }

                } else {

                    self._mapPlacingMulti = [parseInt(this.dataset.idx)];

                }

                self._mapPlacing = self._mapPlacingMulti.length > 0 ? self._mapPlacingMulti[self._mapPlacingMulti.length - 1] : false;

                var ind = document.getElementById('e-placing-indicator');

                if (ind) {

                    if (self._mapPlacing !== false && self._mapLib[self._mapPlacing]) {

                        ind.style.display = ''; ind.textContent = '🔵 Placing: ' + self._mapLib[self._mapPlacing].name + (self._mapPlacingMulti.length > 1 ? ' (+' + (self._mapPlacingMulti.length - 1) + ')' : '');

                    } else {

                        ind.style.display = 'none';

                    }

                }

                self._renderLibList();

            };

            list.appendChild(item);

        });

    },



    _renderHierarchy: function () {

        var h = document.getElementById('e-hierarchy');

        if (!h) return;

        var html = '';

        var self = this;

        // Build parent-child tree

        var children = {};

        this._mapObjs.forEach(function (o, i) {

            var p = o.parentIdx != null ? o.parentIdx : -1;

            if (!children[p]) children[p] = [];

            children[p].push(i);

        });

        var selSet = {};

        this._mapSelObjs.forEach(function (i) { selSet[i] = true; });

        function renderTree(parentIdx, depth) {

            var list = children[parentIdx] || [];

            list.forEach(function (i) {

                var o = self._mapObjs[i];

                if (!o) return;

                var sel = !!selSet[i];

                var indent = depth * 16;

                var isParent = children[i] && children[i].length > 0;

                var icon = (o.kind === 'ground') ? '🏔️' : (o.kind === 'light') ? '💡' : (o.kind === 'sound') ? '🔊' : (o.kind === 'water') ? '🌊' : (isParent ? '📁' : '📦');

                html += '<div class="e123-h-item" data-idx="' + i + '" style="padding:4px 8px 4px ' + (8 + indent) + 'px;font-size:11px;cursor:pointer;border-left:2px solid ' + (sel ? '#ffb12b' : '#444') + ';background:' + (sel ? 'rgba(255,177,43,0.1)' : 'transparent') + ';margin-bottom:1px;border-radius:0 4px 4px 0;display:flex;align-items:center;gap:4px">' +

                    icon + ' ' + (o.name || 'Object ' + (i + 1)) +

                    (o.parentIdx != null && o.parentIdx >= 0 ? '<span style="color:#555;font-size:9px;margin-left:auto">child</span>' : '') +

                    '</div>';

                renderTree(i, depth + 1);

            });

        }

        renderTree(-1, 0);

        h.innerHTML = html;

        h.querySelectorAll('.e123-h-item').forEach(function (item) {

            item.onclick = function (ev) {

                self._selectObject(parseInt(this.dataset.idx), ev.ctrlKey || ev.metaKey);

            };

            item.oncontextmenu = function (e) {

                e.preventDefault();

                var idx = parseInt(this.dataset.idx);

                var count = self._mapSelObjs.length > 0 ? self._mapSelObjs.length : 1;

                var menu = document.createElement('div');

                menu.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;background:#22272e;border:1px solid #2a2f36;border-radius:6px;padding:4px 0;z-index:300;font-size:11px;min-width:120px';

                menu.innerHTML =

                    '<div class="e123-ctx-item" style="padding:6px 14px;cursor:pointer;color:#ddd">🗑️ Delete (' + count + ')</div>' +

                    '<div class="e123-ctx-item" style="padding:6px 14px;cursor:pointer;color:#ddd">⬆️ Parent to selected</div>' +

                    '<div class="e123-ctx-item" style="padding:6px 14px;cursor:pointer;color:#ddd">⬇️ Unparent</div>' +

                    '<div class="e123-ctx-item" style="padding:6px 14px;cursor:pointer;color:#ddd">✏️ Rename</div>';

                document.body.appendChild(menu);

                var close = function () { if (menu.parentNode) menu.parentNode.removeChild(menu); };

                menu.querySelectorAll('.e123-ctx-item').forEach(function (item2, ci) {

                    item2.onclick = function () {

                        close();

                        if (ci === 0) {

                            // Delete all selected (or this one if nothing selected)

                            var toDelete = self._mapSelObjs.length > 0 ? self._mapSelObjs.slice() : [idx];

                            if (confirm('Delete ' + toDelete.length + ' object(s)?')) {

                                self._recursiveDelete(toDelete);

                                self._mapSelObj = null; self._mapSelObjs = [];

                                self._rebuildScene(); self._updCnt(); self._renderHierarchy(); self._renderInspector();

                            }

                        } else if (ci === 1) {

                            if (self._mapSelObj != null && self._mapSelObj !== idx) {

                                self._mapObjs[idx].parentIdx = self._mapSelObj;

                                self._renderHierarchy();

                                self.toast('Parented to ' + (self._mapObjs[self._mapSelObj] ? self._mapObjs[self._mapSelObj].name : 'selected'));

                            } else { self.toast('Select a different object as parent first'); }

                        } else if (ci === 2) {

                            self._mapObjs[idx].parentIdx = -1;

                            self._renderHierarchy();

                            self.toast('Unparented');

                        } else if (ci === 3) {

                            var newName = prompt('New name:', self._mapObjs[idx].name || '');

                            if (newName !== null) { self._mapObjs[idx].name = newName || 'Object'; self._renderHierarchy(); self._renderInspector(); }

                        }

                    };

                });

                document.addEventListener('click', close, { once: true });

            };

        });

    },



    _recursiveDelete: function (indices) {

        var self = this;

        if (!Array.isArray(indices)) indices = [indices];

        var toRemove = indices.slice();

        // Find all children of all selected indices

        this._mapObjs.forEach(function (o, i) {

            function isDescendant(pidx) {

                if (o.parentIdx === pidx) return true;

                if (o.parentIdx != null && o.parentIdx >= 0) return isDescendant(o.parentIdx);

                return false;

            }

            indices.forEach(function (idx) {

                if (isDescendant(idx) && toRemove.indexOf(i) < 0) toRemove.push(i);

            });

        });

        toRemove.sort(function (a, b) { return b - a; });

        toRemove.forEach(function (i) {

            if (self._mapObjs[i]) {

                if (self._mapObjs[i].imgUrl) URL.revokeObjectURL(self._mapObjs[i].imgUrl);

                if (self._mapObjs[i].audioUrl) URL.revokeObjectURL(self._mapObjs[i].audioUrl);

            }

            self._mapObjs.splice(i, 1);

        });

    },



    _selectObject: function (idx, ctrl) {

        if (ctrl) {

            // Toggle multi-select

            var pos = this._mapSelObjs.indexOf(idx);

            if (pos >= 0) {

                this._mapSelObjs.splice(pos, 1);

                if (this._mapSelObj === idx) this._mapSelObj = this._mapSelObjs.length > 0 ? this._mapSelObjs[this._mapSelObjs.length - 1] : null;

            } else {

                this._mapSelObjs.push(idx);

                this._mapSelObj = idx;

            }

        } else {

            this._mapSelObjs = [idx];

            this._mapSelObj = idx;

        }

        this._renderHierarchy();

        this._highlightSelected();

        this._renderInspector();

        // Attach transform controls to primary selected mesh

        if (this._transformControls) {

            if (this._mapSelObj != null && this._mapModels[this._mapSelObj]) {

                this._transformControls.attach(this._mapModels[this._mapSelObj]);

                this._transformControls.setSpace('world');

            } else {

                this._transformControls.detach();

            }

        }

        if (!ctrl) this.toast('Selected: ' + (this._mapObjs[idx] ? this._mapObjs[idx].name : ''));

    },



    _renderInspector: function () {

        var panel = document.getElementById('e-inspector');

        if (!panel) return;

        var obj = this._mapObjs[this._mapSelObj];

        if (!obj) {

            panel.innerHTML = this._mapSelObjs.length > 1

                ? '<div style="color:#ffb12b;font-size:11px">' + this._mapSelObjs.length + ' objects selected</div>'

                : '<div style="color:#555">Select an object to edit</div>';

            return;

        }

        var self = this;

        var kind = obj.kind || 'model';

        var libItem = this._mapLib[obj.libIdx];

        var colorHex = obj.color != null ? '#' + obj.color.toString(16).padStart(6, '0') : '#5a7acc';

        // Build common fields

        var html =

            '<div style="margin-bottom:6px"><label style="color:#888;display:block;font-size:10px;margin-bottom:2px">Name</label>' +

            '<input id="e-insp-name" value="' + (obj.name || 'Object') + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:3px 6px;font-size:11px"></div>' +

            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:6px">' +

            '<label style="color:#888;font-size:10px;grid-column:1">X <input id="e-insp-x" type="number" step="0.1" value="' + obj.x.toFixed(1) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

            '<label style="color:#888;font-size:10px;grid-column:2">Y <input id="e-insp-y" type="number" step="0.1" value="' + (obj.y != null ? obj.y : 0.5).toFixed(1) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

            '<label style="color:#888;font-size:10px;grid-column:3">Z <input id="e-insp-z" type="number" step="0.1" value="' + obj.z.toFixed(1) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label></div>' +

            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">' +

            '<label style="color:#888;font-size:10px">Rot Y <input id="e-insp-rot" type="number" step="0.1" value="' + ((obj.rot || 0) * 180 / Math.PI).toFixed(1) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

            '<label style="color:#888;font-size:10px">Scale <input id="e-insp-scale" type="number" step="0.01" min="0.0001" value="' + (obj.scale || 1).toFixed(4) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label></div>';

        // Kind-specific fields

        if (kind === 'image') {

            html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">' +

                '<label style="color:#888;font-size:10px">Width <input id="e-insp-iw" type="number" step="0.1" min="0.1" value="' + ((obj.planeW || 2).toFixed(1)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

                '<label style="color:#888;font-size:10px">Height <input id="e-insp-ih" type="number" step="0.1" min="0.1" value="' + ((obj.planeH || 2).toFixed(1)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label></div>' +

                '<span class="e123-tbtn" id="e-insp-reimg" style="display:block;text-align:center;font-size:10px;padding:4px;margin-top:4px">🖼️ Import New Image</span>';

            if (obj.imgWidth) html += '<div style="color:#666;font-size:9px;margin-top:2px">Original: ' + obj.imgWidth + '×' + obj.imgHeight + 'px</div>';

        } else if (kind === 'light') {

            html += '<div style="display:grid;grid-template-columns:1fr;gap:4px;margin-bottom:4px">' +

                '<label style="color:#888;font-size:10px">Intensity <input id="e-insp-li" type="number" step="0.1" min="0" value="' + ((obj.intensity != null ? obj.intensity : 1).toFixed(1)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

                '<label style="color:#888;font-size:10px">Range <input id="e-insp-lr" type="number" step="1" min="0" value="' + ((obj.range || 20).toFixed(0)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

                '</div><div style="margin-top:4px"><label style="color:#888;font-size:10px">Type <select id="e-insp-lt" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px">' +

                '<option value="directional"' + ((obj.subType||'') === 'directional' ? ' selected' : '') + '>Directional</option>' +

                '<option value="point"' + ((obj.subType||'') === 'point' ? ' selected' : '') + '>Point</option>' +

                '<option value="spot"' + ((obj.subType||'') === 'spot' ? ' selected' : '') + '>Spot</option>' +

                '<option value="ambient"' + ((obj.subType||'') === 'ambient' ? ' selected' : '') + '>Ambient</option></select></label></div>';

        } else if (kind === 'sound') {

            html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">' +

                '<label style="color:#888;font-size:10px">Volume <input id="e-insp-sv" type="number" step="0.1" min="0" max="1" value="' + ((obj.volume != null ? obj.volume : 1).toFixed(1)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

                '<label style="color:#888;font-size:10px">Range <input id="e-insp-sr" type="number" step="1" min="0" value="' + ((obj.range || 15).toFixed(0)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label></div>' +

                '<span class="e123-tbtn" id="e-insp-snd" style="display:block;text-align:center;font-size:10px;padding:4px;margin-top:4px">🔊 Import Audio File</span>';

        } else if (kind === 'water') {

            html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">' +

                '<label style="color:#888;font-size:10px">Width <input id="e-insp-ww" type="number" step="1" min="1" value="' + ((obj.planeW || 20).toFixed(0)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

                '<label style="color:#888;font-size:10px">Height <input id="e-insp-wh" type="number" step="1" min="1" value="' + ((obj.planeH || 20).toFixed(0)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label></div>' +

                '<div style="color:#3af;font-size:10px">🌊 Uses stylized water shader</div>';

        } else if (kind === 'ground') {

            html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">' +

                '<label style="color:#888;font-size:10px">Width <input id="e-insp-gw" type="number" step="1" min="1" value="' + ((obj.planeW || 40).toFixed(0)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label>' +

                '<label style="color:#888;font-size:10px">Height <input id="e-insp-gh" type="number" step="1" min="1" value="' + ((obj.planeH || 40).toFixed(0)) + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px"></label></div>' +

                '<div style="color:#888;font-size:9px">🏔️ Ground plane — use +Add to create more</div>' +

                '<span class="e123-tbtn" id="e-insp-copy-grass-color" style="display:block;text-align:center;font-size:10px;padding:4px;margin-top:4px">🌿 Copy grass color to ground</span>';

        } else if (kind === 'primitive' || kind === 'shape2d') {

            html += '<div style="color:#666;font-size:10px;margin-bottom:4px">' + (kind === 'primitive' ? '3D ' : '2D ') + (obj.subType || '').charAt(0).toUpperCase() + (obj.subType || '').slice(1) + '</div>';

        }

        // Color picker (not for water)

        if (kind !== 'water') {

            html += '<div style="margin-top:4px"><label style="color:#888;font-size:10px">Color <input id="e-insp-color" type="color" value="' + colorHex + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;padding:1px 4px;height:24px"></label></div>';

        }

        // Ambient color picker (model kind only)

        if (kind === 'model') {

            var ambientHex = obj.ambient != null ? '#' + obj.ambient.toString(16).padStart(6, '0') : '#ffffff';

            html += '<div style="margin-top:4px"><label style="color:#888;font-size:10px">Ambient <input id="e-insp-ambient" type="color" value="' + ambientHex + '" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;padding:1px 4px;height:24px"></label></div>';

        }

        // Type selector (not for lights, water)

        if (kind !== 'light' && kind !== 'water') {

            html += '<div style="margin-top:4px"><label style="color:#888;font-size:10px">Type <select id="e-insp-type" style="width:100%;background:#181c22;border:1px solid #2a2f36;border-radius:4px;color:#eee;padding:2px 4px;font-size:11px">' +

                '<option value="wall" ' + ((obj.type||'wall') === 'wall' ? 'selected' : '') + '>Wall / obstacle</option>' +

                '<option value="water" ' + ((obj.type||'') === 'water' ? 'selected' : '') + '>Water (shader)</option>' +

                '<option value="bush" ' + ((obj.type||'') === 'bush' ? 'selected' : '') + '>Bush / cover</option>' +

                '</select></label></div>';

        }

        if (libItem) html += '<div style="color:#666;font-size:10px;margin-top:2px">Model: ' + libItem.name + '</div>';

        panel.innerHTML = html;

        // Wire inspector inputs

        var _wireInsp = function () {

            var nameEl = document.getElementById('e-insp-name');

            if (nameEl) nameEl.onchange = function () { obj.name = this.value || 'Object'; self._renderHierarchy(); };

            var xEl = document.getElementById('e-insp-x');

            if (xEl) xEl.onchange = function () { obj.x = parseFloat(this.value) || 0; self._rebuildScene(); };

            var yEl = document.getElementById('e-insp-y');

            if (yEl) yEl.onchange = function () { obj.y = parseFloat(this.value) || 0.5; self._rebuildScene(); };

            var zEl = document.getElementById('e-insp-z');

            if (zEl) zEl.onchange = function () { obj.z = parseFloat(this.value) || 0; self._rebuildScene(); };

            var rotEl = document.getElementById('e-insp-rot');

            if (rotEl) rotEl.onchange = function () { obj.rot = (parseFloat(this.value) || 0) * Math.PI / 180; self._rebuildScene(); };

            var scaleEl = document.getElementById('e-insp-scale');

            if (scaleEl) scaleEl.onchange = function () { obj.scale = parseFloat(this.value) || 1; self._rebuildScene(); };

            // Image-specific

            var iwEl = document.getElementById('e-insp-iw');

            if (iwEl) iwEl.onchange = function () { obj.planeW = parseFloat(this.value) || 2; self._rebuildScene(); };

            var ihEl = document.getElementById('e-insp-ih');

            if (ihEl) ihEl.onchange = function () { obj.planeH = parseFloat(this.value) || 2; self._rebuildScene(); };

            var reimgEl = document.getElementById('e-insp-reimg');

            if (reimgEl) reimgEl.onclick = function () { self._importImage(self._mapSelObj); };

            // Light-specific

            var liEl = document.getElementById('e-insp-li');

            if (liEl) liEl.onchange = function () { obj.intensity = parseFloat(this.value) || 1; self._rebuildScene(); };

            var lrEl = document.getElementById('e-insp-lr');

            if (lrEl) lrEl.onchange = function () { obj.range = parseFloat(this.value) || 20; self._rebuildScene(); };

            var ltEl = document.getElementById('e-insp-lt');

            if (ltEl) ltEl.onchange = function () { obj.subType = this.value; self._rebuildScene(); };

            // Sound-specific

            var svEl = document.getElementById('e-insp-sv');

            if (svEl) svEl.onchange = function () { obj.volume = parseFloat(this.value) || 1; };

            var srEl = document.getElementById('e-insp-sr');

            if (srEl) srEl.onchange = function () { obj.range = parseFloat(this.value) || 15; self._rebuildScene(); };

            var sndEl = document.getElementById('e-insp-snd');

            if (sndEl) sndEl.onclick = function () {

                var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'audio/mpeg,audio/wav,audio/ogg,audio/mp3';

                inp.onchange = function (e) { var f = e.target.files[0]; if (!f) return; obj.audioUrl = URL.createObjectURL(f); self.toast('Audio: ' + f.name); };

                inp.click();

            };

            // Water-specific

            var wwEl = document.getElementById('e-insp-ww');

            if (wwEl) wwEl.onchange = function () { obj.planeW = parseFloat(this.value) || 20; self._rebuildScene(); };

            var whEl = document.getElementById('e-insp-wh');

            if (whEl) whEl.onchange = function () { obj.planeH = parseFloat(this.value) || 20; self._rebuildScene(); };

            // Ground-specific

            var gwEl = document.getElementById('e-insp-gw');

            if (gwEl) gwEl.onchange = function () { obj.planeW = parseFloat(this.value) || 40; self._rebuildScene(); };

            var ghEl = document.getElementById('e-insp-gh');

            if (ghEl) ghEl.onchange = function () { obj.planeH = parseFloat(this.value) || 40; self._rebuildScene(); };

            var copyGrassColorEl = document.getElementById('e-insp-copy-grass-color');

            if (copyGrassColorEl) copyGrassColorEl.addEventListener('click', function () {

                var c = self._grass3dColorBottom || '#4f7c13';

                // 1. Persist color in data model

                obj.color = parseInt(c.slice(1), 16);

                // 2. Update UI color swatch

                var colorEl = document.getElementById('e-insp-color');

                if (colorEl) colorEl.value = c;

                // 3. Directly update the live 3D mesh material in the scene

                var linearColor = new THREE.Color(c);

                linearColor.convertSRGBToLinear();

                for (var mi = 0; mi < self._mapModels.length; mi++) {

                    var mo = self._mapObjs[mi];

                    if (mo && mo === obj && self._mapModels[mi]) {

                        var groundMesh = self._mapModels[mi];

                        if (groundMesh.material) {

                            if (groundMesh.material.isShaderMaterial && groundMesh.material.uniforms && groundMesh.material.uniforms.uColor) {

                                groundMesh.material.uniforms.uColor.value.copy(linearColor);

                            } else if (groundMesh.material.color) {

                                groundMesh.material.color.copy(linearColor);

                                groundMesh.material.needsUpdate = true;

                            }

                        }

                        break;

                    }

                }

                self.toast('Ground color set to grass base ' + c);

            });

            // Common

            var colorEl = document.getElementById('e-insp-color');

            if (colorEl) colorEl.onchange = function () {

                obj.color = parseInt(this.value.slice(1), 16);

                // Update material color directly — do NOT rebuild scene (preserves position/rot/scale)

                var cm = self._mapModels[self._mapSelObj];

                if (cm) {

                    var hex = new THREE.Color(obj.color);

                    cm.traverse(function (c) {

                        if (c.isMesh && c.material) {

                            var mats = Array.isArray(c.material) ? c.material : [c.material];

                            mats.forEach(function (mat) {

                                // Custom shader material with uColor uniform

                                if (mat.uniforms && mat.uniforms.uColor) {

                                    mat.uniforms.uColor.value.copy(hex);

                                // NodeMaterial / TSL — colorNode or standard color.set

                                } else if (mat.colorNode && typeof mat.colorNode.assign === 'function') {

                                    mat.colorNode.assign(new THREE.Color(obj.color));

                                } else if (mat.color && typeof mat.color.set === 'function') {

                                    mat.color.set(hex);

                                }

                                mat.transparent = false;

                                mat.opacity = 1.0;

                                mat.depthWrite = true;

                                mat.depthTest = true;

                                mat.side = THREE.FrontSide;

                                mat.needsUpdate = true;

                            });

                        }

                    });

                }

            };

            var ambientEl = document.getElementById('e-insp-ambient');

            if (ambientEl) ambientEl.onchange = function () {

                obj.ambient = parseInt(this.value.slice(1), 16);

                var modelMesh = self._mapModels[self._mapSelObj];

                if (modelMesh) {

                    var ambientCol = new THREE.Color(obj.ambient);

                    modelMesh.traverse(function (c) { if (c.isMesh) { c.visible = true; if (c.material) {

                        var mats = Array.isArray(c.material) ? c.material : [c.material];

                        mats.forEach(function (mat) {

                            if (mat.isMeshPhongMaterial && mat.ambient) mat.ambient.copy(ambientCol);

                            if (mat.isMeshStandardMaterial) {

                                var intensity = obj.ambient === 0xffffff ? 0.12 : 0;

                                mat.emissive.copy(ambientCol).multiplyScalar(intensity > 0 ? 1 : 0);

                                mat.emissiveIntensity = intensity;

                                mat.userData._ambientHex = obj.ambient;

                                mat.userData._ambientIntensity = intensity;

                            } else if (mat.isMeshPhongMaterial) {

                                var intensity = obj.ambient === 0xffffff ? 0.12 : 0;

                                mat.emissive.copy(ambientCol).multiplyScalar(intensity > 0 ? 1 : 0);

                                mat.emissiveIntensity = intensity;

                                mat.userData._ambientHex = obj.ambient;

                                mat.userData._ambientIntensity = intensity;

                            }

                        });

                    } }});

                }

            };

            var typeEl = document.getElementById('e-insp-type');

            if (typeEl) typeEl.onchange = function () { obj.type = this.value; self.toast('Type: ' + this.value); };

        }; _wireInsp();

    },



    _saveToGame: function () {

        var self = this;

        var gameObjects = [];

        this._mapObjs.forEach(function (o) {

            var kind = o.kind || 'model';

            // Skip editor-only types that can't render in the game

            if (kind === 'light' || kind === 'sound' || kind === 'image' || kind === 'shape2d' ||

                kind === 'grass3d' || kind === 'grass' || kind === 'ground') return;

            // Spawn points & blue boxes export as game entities (type + subType),
            // so world.loadCustomMapData can collect them for each gamemode.

            if (kind === 'spawnpoint') {

                gameObjects.push({

                    x: o.x, z: o.z, y: 0.5, ry: o.rot || 0,

                    type: (o.subType === 'gladiatorbox' ? 'gladiatorbox' : 'spawnpoint'),

                    subType: o.subType || 'player',

                });

                return;

            }

            // Map editor primitive sub-types to game kinds

            var gKind = 'cube';

            if (kind === 'primitive') {

                switch (o.subType) {

                    case 'cylinder': gKind = 'cylinder'; break;

                    case 'cone':     gKind = 'cone';     break;

                    case 'torus':    gKind = 'torus';    break;

                    case 'plane':    gKind = 'cube';     break;

                    default:         gKind = 'cube';     break;

                }

            } else if (kind === 'water') {

                gKind = 'cube';

            } else if (kind === 'model') {

                gKind = 'cube';

            }

            var obj = {

                x: o.x, y: o.y || 0.5, z: o.z,

                sx: o.scale || 1, sy: o.scale || 1, sz: o.scale || 1,

                ry: o.rot || 0,

                kind: gKind,

                color: o.color != null ? o.color : 0x5a7acc,

                type: o.type || (kind === 'water' ? 'water' : 'wall'),

            };

            // Flatten planes

            if (kind === 'primitive' && o.subType === 'plane') {

                obj.sy = 0.15;

            }

            // Model library reference (imported GLB/OBJ)

            var libItem = self._mapLib[o.libIdx];

            if (libItem && (libItem.data || libItem.base64)) {

                obj.isModel = true;

                obj.modelName = libItem.name;

                obj.modelFormat = libItem.type || 'glb';

                if (libItem.base64) obj.modelData = libItem.base64;

            }

            gameObjects.push(obj);

        });

        var mapData = { objects: gameObjects };

        try {

            saveMainMap(mapData);

            self.toast('Saved ' + gameObjects.length + ' objects as your main map!');

        } catch (e) {

            self.toast('Error saving: ' + e.message);

        }

    },



    _wire3DTools: function () {

        var self = this;

        document.getElementById('e-imp').onclick = function () { self._importModel(); };

        document.getElementById('e-imp-server').onclick = function () { self._importFromServer(); };

        document.getElementById('e-del-lib').onclick = function () {

            var toDel = self._mapPlacingMulti.length > 0 ? self._mapPlacingMulti.slice().sort(function (a, b) { return b - a; }) : [];

            if (toDel.length === 0) { self.toast('Select model(s) in Library first (Ctrl+Click for multi)'); return; }

            if (!confirm('Delete ' + toDel.length + ' model(s) from library? Objects in scene will be removed too.')) return;

            // Delete from server and remove placed objects

            toDel.forEach(function (idx) {

                var libEntry = self._mapLib[idx];

                if (libEntry && libEntry.serverUrl) {

                    var parts = libEntry.serverUrl.split('/');

                    var fname = parts[parts.length - 1];

                    var host = libEntry.serverUrl.split('/').slice(0, 3).join('/');

                    fetch(host + '/api/models/' + encodeURIComponent(fname), { method: 'DELETE' }).catch(function () {});

                }

            });

            // Remove placed objects referencing deleted lib indices and adjust remaining

            self._mapObjs = self._mapObjs.filter(function (o) { return toDel.indexOf(o.libIdx) < 0; });

            self._mapObjs.forEach(function (o) {

                var shift = 0;

                toDel.forEach(function (di) { if (o.libIdx > di) shift++; });

                o.libIdx -= shift;

            });

            // Remove library entries (highest first to preserve indices)

            toDel.forEach(function (idx) { self._mapLib.splice(idx, 1); });

            self._saveLib(self._mapLib);

            self._mapPlacing = false; self._mapPlacingMulti = [];

            self._renderLibList();

            self._rebuildScene(); self._updCnt(); self._renderHierarchy(); self._renderInspector();

            var ind = document.getElementById('e-placing-indicator'); if (ind) ind.style.display = 'none';

            self.toast('Deleted ' + toDel.length + ' model(s) from library');

        };

        document.getElementById('e123-map-back').onclick = function () { self._stopMapEditor(); self._renderLauncher(); };

        document.getElementById('e-clear-3d').onclick = function () {

            if (!confirm('Remove all placed objects?')) return;

            self._mapObjs = []; self._mapSelObj = null; self._mapSelObjs = []; self._rebuildScene(); self._updCnt(); self._renderHierarchy(); self._renderInspector();

        };

        document.getElementById('e-save-3d').onclick = function () { self._saveMapWithGamemode(); };

        document.getElementById('e-simulate').onclick = function () {

            self._physSimulating = !self._physSimulating;

            this.textContent = self._physSimulating ? '⏸ Pause' : '▶ Sim';

            self._rebuildScene();

        };

        // Gizmo mode buttons

        document.querySelectorAll('.e123-gizmo-btn').forEach(function (btn) {

            btn.onclick = function () {

                document.querySelectorAll('.e123-gizmo-btn').forEach(function (b) { b.style.borderColor = 'transparent'; });

                this.style.borderColor = '#ffb12b';

                if (self._transformControls) self._transformControls.setMode(this.dataset.gizmo);

            };

        });

        // Save to Game

        document.getElementById('e-save-game').onclick = function () { self._saveToGame(); };

        // GAMEMODES button: assign which gamemode this map is for (with spawn validation)

        document.getElementById('e-gamemodes-btn').onclick = function () { self._saveMapWithGamemode(); };

        // Export Map Code

        document.getElementById('e-export-map').onclick = function () {

            var gameObjects = [];

            self._mapObjs.forEach(function (o) {

                var kind = o.kind || 'model';

                if (kind === 'light' || kind === 'sound' || kind === 'image' || kind === 'shape2d' ||

                    kind === 'grass3d' || kind === 'grass' || kind === 'ground' || kind === 'spawnpoint') return;

                var gKind = 'cube';

                if (kind === 'primitive') {

                    switch (o.subType) {

                        case 'cylinder': gKind = 'cylinder'; break;

                        case 'cone':     gKind = 'cone';     break;

                        case 'torus':    gKind = 'torus';    break;

                        default:         gKind = 'cube';     break;

                    }

                }

                var obj = {

                    x: o.x, y: o.y || 0.5, z: o.z,

                    sx: o.scale || 1, sy: o.scale || 1, sz: o.scale || 1,

                    ry: o.rot || 0, kind: gKind,

                    color: o.color != null ? o.color : 0x5a7acc,

                    type: o.type || (kind === 'water' ? 'water' : 'wall'),

                };

                if (kind === 'primitive' && o.subType === 'plane') obj.sy = 0.15;

                var libItem = self._mapLib[o.libIdx];

                if (libItem && (libItem.data || libItem.base64)) {

                    obj.isModel = true; obj.modelName = libItem.name;

                    obj.modelFormat = libItem.type || 'glb';

                    if (libItem.base64) obj.modelData = libItem.base64;

                }

                gameObjects.push(obj);

            });

            var exportData = { objects: gameObjects };

            try {

                var json = JSON.stringify(exportData);

                navigator.clipboard.writeText(json).then(function () {

                    self.toast('Copied ' + gameObjects.length + ' objects! Send this code to the dev.');

                }).catch(function () {

                    // Fallback: show in prompt

                    prompt('Copy this code manually:', json);

                });

            } catch (e) {

                self.toast('Export failed: ' + e.message);

            }

        };

        // Deselect button

        document.getElementById('e-deselect-btn').onclick = function () {

            if (self._transformControls) self._transformControls.detach();

            self._mapSelObj = null; self._mapSelObjs = [];

            self._highlightSelected(); self._renderHierarchy(); self._renderInspector();

            self._mapPlacing = false; self._mapPlacingMulti = [];

            var ind = document.getElementById('e-placing-indicator'); if (ind) ind.style.display = 'none';

            self._renderLibList();

            self.toast('Deselected');

        };

        // + Add button

        var addBtn = document.getElementById('e-add-btn');

        if (addBtn) addBtn.onclick = function () { self._showAddMenu(); };

        // Shortcuts toggle

        var st = document.getElementById('e-shortcuts-toggle');

        var sp = document.getElementById('e-shortcuts-panel');

        if (st && sp) { st.onclick = function () { sp.style.display = sp.style.display === 'none' ? 'block' : 'none'; }; }



        // ---- NEW TOOLS ----

        // Snap toggle

        var snapBtn = document.getElementById('e-snap-btn');

        if (snapBtn) {

            snapBtn.onclick = function () {

                self._snapEnabled = !self._snapEnabled;

                var on = self._snapEnabled;

                this.style.borderColor = on ? '#ffb12b' : 'transparent';

                this.style.fontWeight = on ? '600' : 'normal';

                self.toast('Snap ' + (on ? 'ON (' + self._snapSize + 'm)' : 'OFF'));

                if (self._transformControls) self._transformControls.setTranslationSnap(on ? self._snapSize : null);

            };

        }

        // Scatter tool

        var scatterBtn = document.getElementById('e-scatter-btn');

        if (scatterBtn) {

            scatterBtn.onclick = function () {

                var sel = self._mapSelObjs;

                if (sel.length === 0) { self.toast('Select object(s) to scatter'); return; }

                var count = parseInt(prompt('Number of copies to scatter:', '10'));

                if (!count || count < 1) return;

                var radius = parseFloat(prompt('Scatter radius:', '8'));

                if (!radius || radius < 0.5) radius = 8;

                var newIndices = [];

                for (var si = 0; si < count; si++) {

                    sel.forEach(function (origIdx) {

                        var orig = self._mapObjs[origIdx];

                        if (!orig) return;

                        var copy = JSON.parse(JSON.stringify(orig));

                        delete copy.imgUrl; delete copy.audioUrl; delete copy.imgBase64;

                        copy.x = (Math.random() - 0.5) * radius * 2;

                        copy.z = (Math.random() - 0.5) * radius * 2;

                        copy.rot = Math.random() * Math.PI * 2;

                        copy.scale = orig.scale * (0.5 + Math.random());

                        self._mapObjs.push(copy);

                        newIndices.push(self._mapObjs.length - 1);

                    });

                }

                self._mapSelObjs = newIndices;

                self._mapSelObj = newIndices.length > 0 ? newIndices[0] : null;

                self._rebuildScene(); self._updCnt(); self._renderHierarchy(); self._renderInspector();

                self.toast('Scattered ' + newIndices.length + ' objects');

            };

        }

        // Randomize transform

        var randBtn = document.getElementById('e-rand-btn');

        if (randBtn) {

            randBtn.onclick = function () {

                var sel = self._mapSelObjs;

                if (sel.length === 0) { self.toast('Select object(s) to randomize'); return; }

                sel.forEach(function (idx) {

                    var o = self._mapObjs[idx];

                    if (!o) return;

                    o.rot = Math.random() * Math.PI * 2;

                    o.scale = 0.3 + Math.random() * 1.7;

                });

                self._rebuildScene(); self._renderInspector();

                self.toast('Randomized ' + sel.length + ' objects');

            };

        }

        // Scene settings

        var sceneBtn = document.getElementById('e-scene-settings-btn');

        if (sceneBtn) {

            sceneBtn.onclick = function () {

                var bg = parseInt(prompt('Sky color (hex 0xRRGGBB):', '0x' + self._sceneBgColor.toString(16).padStart(6, '0')));

                if (bg && !isNaN(bg)) self._sceneBgColor = bg;

                var fog = parseFloat(prompt('Fog density (0=none, 0.01=light, 0.05=thick):', self._sceneFogDensity.toString()));

                if (fog >= 0) self._sceneFogDensity = fog;

                var amb = parseInt(prompt('Ambient light color (hex 0xRRGGBB):', '0x' + self._sceneAmbient.toString(16).padStart(6, '0')));

                if (amb && !isNaN(amb)) self._sceneAmbient = amb;

                if (self._mapScene) {

                    self._mapScene.background = new THREE.Color(self._sceneBgColor);

                    if (self._sceneFogDensity > 0) {

                        self._mapScene.fog = new THREE.FogExp2(self._sceneBgColor, self._sceneFogDensity);

                    } else {

                        self._mapScene.fog = null;

                    }

                    // Update ambient light in scene

                    self._mapScene.children.forEach(function (child) {

                        if (child.isAmbientLight) child.color.setHex(self._sceneAmbient);

                    });

                }

                self.toast('Scene settings updated');

            };

        }

    },



    _init3DScene: function () {

        var host = document.getElementById('e-view-3d');

        if (!host) { return; }

        var self = this;

        var W = 800, H = 500;

        try { W = host.clientWidth || 800; H = host.clientHeight || 500; } catch(e){}

        if (W < 100) W = 800; if (H < 100) H = 500;



        var scene = new THREE.Scene();

        scene.background = new THREE.Color(0x7ab8e0);

        this._mapScene = scene;



        var cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 250);

        cam.position.set(25, 20, 25);

        this._mapCamera = cam;



        var renderer;

        try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch(e){ host.innerHTML = 'WebGL unavailable'; return; }

        renderer.setSize(W, H);

        renderer.shadowMap.enabled = true;

        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        renderer.outputColorSpace = THREE.SRGBColorSpace;

        host.appendChild(renderer.domElement);

        this._mapRenderer = renderer;



        var controls = new THREE.OrbitControls(cam, renderer.domElement);

        controls.enableDamping = true;

        controls.dampingFactor = 0.12;

        controls.maxPolarAngle = Math.PI / 2.1;

        controls.minDistance = 3;

        controls.maxDistance = 150;

        controls.target.set(0, 0, 0);

        controls.update();

        this._mapControls = controls;



        // WASD + Ctrl keyboard state (defined before gizmo so handlers can use it)

        var keys = {};

        document.addEventListener('keydown', function (e) { keys[e.key.toLowerCase()] = true; });

        document.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });



        // Rotation angle badge (hidden until gizmo drag)

        var rotBadge = document.createElement('div');

        rotBadge.id = 'e-rot-badge';

        rotBadge.style.cssText = 'position:fixed;pointer-events:none;z-index:999;background:rgba(0,0,0,0.75);color:#ffb12b;font:bold 13px monospace;padding:4px 10px;border-radius:6px;border:1px solid #ffb12b44;display:none;transform:translate(-50%,-100%);white-space:nowrap';

        document.body.appendChild(rotBadge);



        // Transform gizmo

        var gizmo = new THREE.TransformControls(cam, renderer.domElement);

        gizmo.setSize(0.8);

        gizmo.space = 'world';

        scene.add(gizmo);

        this._transformControls = gizmo;



        gizmo.addEventListener('dragging-changed', function (ev) {

            controls.enabled = !ev.value;

            if (ev.value) {

                // Drag started — show badge near gizmo screen position

                rotBadge.style.display = 'block';

            } else {

                // Drag ended — hide badge

                rotBadge.style.display = 'none';

                // Persist snapped rotation back to data model

                if (self._mapSelObj != null && self._mapObjs[self._mapSelObj]) {

                    var attached = gizmo.object;

                    if (attached) {

                        self._mapObjs[self._mapSelObj].rot = attached.rotation.y;

                    }

                }

            }

        });



        gizmo.addEventListener('objectChange', function () {

            var attached = gizmo.object;

            if (!attached) return;



            // Ctrl-held: snap rotation.y to 5-degree increments

            if (keys['control']) {

                var deg = THREE.MathUtils.radToDeg(attached.rotation.y);

                var snapped = Math.round(deg / 5) * 5;

                attached.rotation.y = THREE.MathUtils.degToRad(snapped);

            }



            // Update rotation badge position

            if (rotBadge.style.display !== 'none') {

                var pos = new THREE.Vector3();

                attached.getWorldPosition(pos);

                pos.y += 2;

                pos.project(cam);

                var w2 = renderer.domElement.clientWidth / 2;

                var h2 = renderer.domElement.clientHeight / 2;

                var sx = pos.x * w2 + w2;

                var sy = -(pos.y * h2) + h2;

                var deg2 = THREE.MathUtils.radToDeg(attached.rotation.y);

                rotBadge.textContent = 'Y: ' + Math.round(deg2) + '\u00B0';

                rotBadge.style.left = sx + 'px';

                rotBadge.style.top = (sy - 16) + 'px';

            }

        });



        // Loaders for model parsing

        this._gltfLoader = new THREE.GLTFLoader();

        if (typeof THREE.FBXLoader !== 'undefined') {

            this._fbxLoader = new THREE.FBXLoader();

        }



        // Lights

        scene.add(new THREE.HemisphereLight(0x87ceeb, 0x5a3a2a, 0.9));

        var sun = new THREE.DirectionalLight(0xffdd99, 1.4);

        sun.position.set(25, 35, 20);

        sun.castShadow = true;

        scene.add(sun);

        var fillLight = new THREE.DirectionalLight(0x8899ff, 0.3); fillLight.position.set(-20, 10, -20); scene.add(fillLight);

        scene.add(new THREE.AmbientLight(0x666688, 0.35));



        // Grid

        var grid = new THREE.GridHelper(80, 40, 0x88bb88, 0x558855);

        grid.position.y = 0.01;

        scene.add(grid);



        // Grass brush circle overlay

        var circlePts = [];

        for (var ci = 0; ci <= 64; ci++) { var th2 = (ci / 64) * Math.PI * 2; circlePts.push(Math.cos(th2) * 1, 0, Math.sin(th2) * 1); }

        var circleGeo = new THREE.BufferGeometry();

        circleGeo.setAttribute('position', new THREE.Float32BufferAttribute(circlePts, 3));

        var circleMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });

        var brushCircle = new THREE.Line(new THREE.LineLoop(circleGeo, circleMat));

        brushCircle.position.y = 0.015;

        brushCircle.visible = false;

        brushCircle.scale.setScalar(self._grassBrushSize || 3);

        scene.add(brushCircle);

        self._grassBrushCircle = brushCircle;

        brushCircle.raycast = function () {};



        // Resize handler

        var ro = function () {

            var w2 = host.clientWidth || W, h2 = host.clientHeight || H;

            if (w2 < 10) w2 = W; if (h2 < 10) h2 = H;

            cam.aspect = w2 / h2; cam.updateProjectionMatrix();

            renderer.setSize(w2, h2);

        };

        window.addEventListener('resize', ro);

        this._mapResizeHandler = ro;



        // Input router — tool state is managed by _currentTool ('select' | 'grass_painter')

        var raycaster = new THREE.Raycaster();

        var mouse = new THREE.Vector2();

        renderer.domElement.addEventListener('pointermove', function (ev) {

            var rect2 = renderer.domElement.getBoundingClientRect();

            self._mapMouseNDC = {

                x: ((ev.clientX - rect2.left) / rect2.width) * 2 - 1,

                y: -((ev.clientY - rect2.top) / rect2.height) * 2 + 1,

            };

        });

        renderer.domElement.addEventListener('pointerleave', function () {

            if (self._grassBrushCircle) self._grassBrushCircle.visible = false;

        });

        renderer.domElement.addEventListener('click', function (ev) {

            if (gizmo.dragging) return;

            if (self._mapMouseDown && (Math.abs(ev.clientX - self._mapMouseDown.x) > 4 || Math.abs(ev.clientY - self._mapMouseDown.y) > 4)) return;

            var rect = renderer.domElement.getBoundingClientRect();

            mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;

            mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, cam);



            // Place mode: click on ground to place a model from library

            if (self._mapPlacing !== false && self._mapLib[self._mapPlacing]) {

                var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

                var pt = new THREE.Vector3();

                raycaster.ray.intersectPlane(groundPlane, pt);

                if (pt) {

                    var libEntry = self._mapLib[self._mapPlacing];

                    var obj = {

                        kind: 'model', subType: 'model',

                        name: libEntry.name || 'Model',

                        x: pt.x, z: pt.z, y: 0,

                        rot: 0, scale: 1,

                        libIdx: self._mapPlacing,

                        type: 'wall', color: 0xffffff, ambient: 0xffffff,

                    };

                    self._mapObjs.push(obj);

                    var idx = self._mapObjs.length - 1;

                    self._selectObject(idx, false);

                    self._updCnt();

                    self._rebuildScene();

                    self._renderHierarchy();

                    self.toast('Placed: ' + obj.name);

                }

                return;

            }



            // Grass paint / erase mode (single-click stamp)

            if (self._currentTool === 'grass_painter') {

                var grassPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

                var grassPt = new THREE.Vector3();

                if (raycaster.ray.intersectPlane(grassPlane, grassPt)) {

                    if (self._grassEraseMode) {

                        self._eraseGrass(grassPt);

                    } else {

                        self._spawnGrass(grassPt);

                    }

                }

                return;

            }



            // Paint terrain mode

            if (self._paintMode) {

                var paintPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

                var paintPt = new THREE.Vector3();

                if (raycaster.ray.intersectPlane(paintPlane, paintPt)) {

                    self._mapObjs.push({

                        kind: 'ground', subType: 'painted', name: 'Painted terrain',

                        x: paintPt.x, z: paintPt.z, y: 0, rot: 0, scale: 1,

                        color: self._paintColor, planeW: self._paintBrushSize, planeH: self._paintBrushSize,

                    });

                    self._updCnt();

                    self._rebuildScene();

                    self._renderHierarchy();

                    self.toast('Painted terrain at ' + paintPt.x.toFixed(1) + ', ' + paintPt.z.toFixed(1));

                }

                return;

            }



            // Select / transform mode

            var meshes = [];

            self._mapModels.forEach(function (m) {

                if (!m) return;

                m.traverse(function (c) { if (c.isMesh) meshes.push(c); });

                if (m.isMesh) meshes.push(m);

            });

            var hits = raycaster.intersectObjects(meshes, false);

            if (hits.length > 0) {

                var hitObj = hits[0].object;

                while (hitObj && hitObj.userData.editorObjIdx == null) hitObj = hitObj.parent;

                if (hitObj && hitObj.userData.editorObjIdx != null) {

                    var hitIdx = hitObj.userData.editorObjIdx;

                    if (self._mapSelObj === hitIdx && !ev.ctrlKey && !ev.metaKey && self._mapSelObjs.length <= 1) {

                        if (self._transformControls) self._transformControls.detach();

                        self._mapSelObj = null; self._mapSelObjs = [];

                        self._highlightSelected(); self._renderHierarchy(); self._renderInspector();

                    } else {

                        self._selectObject(hitIdx, ev.ctrlKey || ev.metaKey);

                    }

                }

            } else if (!ev.ctrlKey && !ev.metaKey) {

                if (self._transformControls) self._transformControls.detach();

                self._mapSelObj = null; self._mapSelObjs = [];

                self._highlightSelected(); self._renderHierarchy(); self._renderInspector();

            }

        });



        // Animation loop

        var time = 0;

        var anim = function () {

            self._mapAnimId = requestAnimationFrame(anim);

            try {

                time += 0.016;

                var ms = 12 * 0.016;

                if (keys['w']) controls.target.y += ms;

                if (keys['s']) controls.target.y -= ms;

                if (keys['a']) { var va = new THREE.Vector3(-1, 0, 0).applyQuaternion(cam.quaternion); va.y = 0; va.normalize(); controls.target.add(va.multiplyScalar(ms)); }

                if (keys['d']) { var vd = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion); vd.y = 0; vd.normalize(); controls.target.add(vd.multiplyScalar(ms)); }

                if (keys['q']) controls.target.y -= ms;

                if (keys['e']) controls.target.y += ms;



                // Water shader uniforms

                var pc = 0, pa = null;

                self._mapModels.forEach(function (m) {

                    if (!m || !m.material || !m.material.uniforms || !m.material.uniforms.uTime) return;

                    m.material.uniforms.uTime.value = time;

                    if (!m.material.uniforms.uProxPositions) return;

                    if (!pa) {

                        var wy = m.position.y, ar = m.material.uniforms.uProxPositions.value; pc = 0;

                        for (var oi = 0; oi < self._mapObjs.length && pc < 48; oi++) {

                            var o = self._mapObjs[oi]; if (!o || o.kind === 'water' || o.kind === 'light' || o.kind === 'ground') continue;

                            var ox = o.x || 0, oz = o.z || 0, oy = o.y != null ? o.y : 0.5;

                            if (o.parentIdx != null && o.parentIdx >= 0 && self._mapObjs[o.parentIdx]) { var po = self._mapObjs[o.parentIdx]; ox += (po.x || 0); oz += (po.z || 0); oy += (po.y != null ? po.y : 0.5); }

                            if (Math.abs(oy - wy) < 2.0) { if (!ar[pc]) ar[pc] = new THREE.Vector3(); ar[pc].set(ox, oy, oz); pc++; }

                        }

                        pa = ar;

                    }

                    m.material.uniforms.uProxCount.value = pc;

                    if (pa && m.material.uniforms.uProxPositions.value !== pa) { var dst = m.material.uniforms.uProxPositions.value; for (var pi = 0; pi < 48; pi++) dst[pi].copy(pa[pi]); }

                });



                // Grass shader uTime (global InstancedMesh — not in _mapModels)

                if (self._grassMesh && self._grassMesh.material && self._grassMesh.material.uniforms && self._grassMesh.material.uniforms.uTime) {

                    self._grassMesh.material.uniforms.uTime.value = time;

                }



                // Physics step

                if (self._physics && !self._physLock) {

                    self._physics.step(0.016);

                    if (self._physSimulating) {

                        for (var bi = 1; bi < self._physBodies.length; bi++) {

                            try { var pos = self._physBodies[bi].translation(); var rot = self._physBodies[bi].rotation(); if (self._mapModels[bi - 1]) { self._mapModels[bi - 1].position.set(pos.x, pos.y, pos.z); self._mapModels[bi - 1].quaternion.set(rot.x, rot.y, rot.z, rot.w); } } catch(e){}

                        }

                    }

                }



                // Brush circle visual (no painting — painting is handled by click handler)

                if (self._grassBrushCircle) {

                    if (self._currentTool === 'grass_painter' && self._mapMouseNDC) {

                        var bcRay = new THREE.Raycaster();

                        bcRay.setFromCamera(new THREE.Vector2(self._mapMouseNDC.x, self._mapMouseNDC.y), cam);

                        var bcPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

                        var bcPt = new THREE.Vector3();

                        if (bcRay.ray.intersectPlane(bcPlane, bcPt)) {

                            self._grassBrushCircle.position.x = bcPt.x;

                            self._grassBrushCircle.position.z = bcPt.z;

                            self._grassBrushCircle.visible = true;

                        } else {

                            self._grassBrushCircle.visible = false;

                        }

                    } else {

                        self._grassBrushCircle.visible = false;

                    }

                }



                controls.update();

                renderer.render(scene, cam);

            } catch(e){}

        };

        anim();

    },



    _rebuildScene: function () {

        this._physLock = true;

        var self = this;

        this._mapOutlines.forEach(function (o) { if (o.parent) o.parent.remove(o); });

        this._mapOutlines = [];

        this._mapModels.forEach(function (m) { self._mapScene.remove(m); });

        this._mapModels = [];

        if (this._physics) {

            for (var bi = this._physBodies.length - 1; bi >= 0; bi--) {

                var pb = this._physBodies[bi];

                if (pb && pb !== this._physGround) this._physics.removeRigidBody(pb);

            }

        }

        this._physBodies = [this._physGround];

        this._mapGround = null;



        var rebuildSelSet = {};

        this._mapSelObjs.forEach(function (i) { rebuildSelSet[i] = true; });



        // Water shader reference

        var waterShaderDef = (typeof SHADERS !== 'undefined' && SHADERS.water) ? SHADERS.water : null;



        this._mapObjs.forEach(function (o, idx) {

            var libItem = self._mapLib[o.libIdx];

            var kind = o.kind || 'model';

            var size = 1.5;

            var isSelected = !!rebuildSelSet[idx];

            var baseColor = o.color != null ? o.color : 0x5a7acc;



            // Compute geometry and material based on kind

            var mesh = null;

            var isImage = false, isLight = false, isSound = false, isWater = false;



            if (kind === 'primitive') {

                var geo;

                switch (o.subType) {

                    case 'sphere': geo = new THREE.SphereGeometry(size / 2, 32, 32); break;

                    case 'cylinder': geo = new THREE.CylinderGeometry(size / 2, size / 2, size, 32); break;

                    case 'plane': geo = new THREE.PlaneGeometry(size, size); break;

                    case 'cone': geo = new THREE.ConeGeometry(size / 2, size, 32); break;

                    case 'torus': geo = new THREE.TorusGeometry(size / 2, size / 4, 16, 32); break;

                    default: geo = new THREE.BoxGeometry(size, size, size);

                }

                var mat = Toon.mat({ color: baseColor });

                mesh = new THREE.Mesh(geo, mat);

            } else if (kind === 'shape2d') {

                var shape;

                switch (o.subType) {

                    case 'circle':

                        shape = new THREE.Shape(); shape.absarc(0, 0, size / 2, 0, Math.PI * 2); break;

                    case 'triangle':

                        shape = new THREE.Shape(); var r = size / 2;

                        for (var ti = 0; ti < 3; ti++) { var a = (ti / 3) * Math.PI * 2 - Math.PI / 2; if (ti === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r); } shape.closePath(); break;

                    case 'hexagon':

                        shape = new THREE.Shape(); var r2 = size / 2;

                        for (var hi = 0; hi < 6; hi++) { var a2 = (hi / 6) * Math.PI * 2 - Math.PI / 2; if (hi === 0) shape.moveTo(Math.cos(a2) * r2, Math.sin(a2) * r2); else shape.lineTo(Math.cos(a2) * r2, Math.sin(a2) * r2); } shape.closePath(); break;

                    default: // square

                        shape = new THREE.Shape([new THREE.Vector2(-size / 2, -size / 2), new THREE.Vector2(size / 2, -size / 2), new THREE.Vector2(size / 2, size / 2), new THREE.Vector2(-size / 2, size / 2)]);

                }

                var sGeo = new THREE.ShapeGeometry(shape);

                var sMat = Toon.mat({ color: baseColor, side: THREE.DoubleSide });

                mesh = new THREE.Mesh(sGeo, sMat);

            } else if (kind === 'image') {

                isImage = true;

                var pw = o.planeW || 2, ph = o.planeH || 2;

                var imgMat = Toon.mat({ color: baseColor, side: THREE.DoubleSide });

                if (o.imgUrl) {

                    var tex = new THREE.TextureLoader().load(o.imgUrl);

                    imgMat.map = tex; imgMat.needsUpdate = true;

                }

                mesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), imgMat);

            } else if (kind === 'light') {

                isLight = true;

                // Render a small glowing sphere indicator

                var lMat = new THREE.MeshBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.5 });

                mesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 16), lMat);

                // Also add the actual light

                var light;

                if (o.subType === 'directional') {

                    light = new THREE.DirectionalLight(baseColor, o.intensity != null ? o.intensity : 1);

                    light.target.position.set(0, 0, 1);

                } else if (o.subType === 'spot') {

                    light = new THREE.SpotLight(baseColor, o.intensity != null ? o.intensity : 1, o.range || 20, o.angle || Math.PI / 4);

                } else if (o.subType === 'ambient') {

                    light = new THREE.AmbientLight(baseColor, o.intensity != null ? o.intensity : 0.4);

                } else {

                    light = new THREE.PointLight(baseColor, o.intensity != null ? o.intensity : 1, o.range || 20);

                }

                if (light && light.isLight) {

                    light.userData.editorObjIdx = idx;

                    self._mapScene.add(light);

                }

            } else if (kind === 'sound') {

                isSound = true;

                var sndMat = Toon.mat({ color: baseColor, transparent: true, opacity: 0.5 });

                mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), sndMat);

                // Add a wireframe range indicator

                var rangeGeo = new THREE.SphereGeometry(o.range || 15, 24, 24);

                var wireMat = new THREE.MeshBasicMaterial({ color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.15 });

                var wireSphere = new THREE.Mesh(rangeGeo, wireMat);

                wireSphere.userData.editorObjIdx = idx;

                wireSphere.userData._isRangeIndicator = true;

            } else if (kind === 'water') {

                isWater = true;

                var ww = o.planeW || 20, wh = o.planeH || 20;

                if (waterShaderDef) {

                    var wMat = new THREE.ShaderMaterial({

                        uniforms: THREE.UniformsUtils.clone(waterShaderDef.uniforms),

                        vertexShader: waterShaderDef.vertexShader,

                        fragmentShader: waterShaderDef.fragmentShader,

                        side: THREE.DoubleSide,

                        transparent: true,

                    });

                    // Setup noise texture (data texture, LinearEncoding to avoid gamma double-correction)

                    if (!self._noiseTex) self._noiseTex = (typeof generateNoiseTexture !== 'undefined') ? generateNoiseTexture(256) : null;

                    if (self._noiseTex) {

                        self._noiseTex.colorSpace = THREE.NoColorSpace;

                        wMat.uniforms.uNoiseTex.value = self._noiseTex;

                    }

                    var waterGeo = new THREE.PlaneGeometry(ww, wh, 64, 64);

                    waterGeo.rotateX(-Math.PI / 2);

                    mesh = new THREE.Mesh(waterGeo, wMat);

                    mesh.frustumCulled = false;

                    mesh.renderOrder = 1;

                } else {

                    var waterGeo2 = new THREE.PlaneGeometry(ww, wh);

                    waterGeo2.rotateX(-Math.PI / 2);

                    mesh = new THREE.Mesh(waterGeo2, Toon.mat({ color: 0x3a8ec8, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));

                    mesh.frustumCulled = false;

                    mesh.renderOrder = 1;

                }

            } else if (kind === 'ground') {

                var groundLinear = new THREE.Color(baseColor);

                groundLinear.convertSRGBToLinear();

                if (o.subType === 'painted') {

                    var pMat = Toon.mat({ color: groundLinear, transparent: true, opacity: 0.6 });

                    var pGeo = new THREE.CircleGeometry((o.planeW || 2) / 2, 16);

                    pGeo.rotateX(-Math.PI / 2);

                    mesh = new THREE.Mesh(pGeo, pMat);

                } else {

                    var gw = o.planeW || 40, gh = o.planeH || 40;

                    var gMat = Toon.mat({ color: groundLinear });

                    var groundGeo = new THREE.PlaneGeometry(gw, gh);

                    groundGeo.rotateX(-Math.PI / 2);

                    mesh = new THREE.Mesh(groundGeo, gMat);

                    this._mapGround = mesh;

                }

            } else if (kind === 'spawnpoint') {

                // Render spawn point as a colored cylinder with indicator
                var spawnMat = Toon.mat({ 
                    color: baseColor, 
                    transparent: true,
                    opacity: 0.7
                });

                var spawnGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.2, 16);
                spawnGeo.translate(0, 0.6, 0);
                mesh = new THREE.Mesh(spawnGeo, spawnMat);

                // Add a ring indicator at the base
                var ringGeo = new THREE.RingGeometry(0.4, 0.5, 32);
                ringGeo.rotateX(-Math.PI / 2);
                var ringMat = new THREE.MeshBasicMaterial({ 
                    color: baseColor, 
                    transparent: true, 
                    opacity: 0.5,
                    side: THREE.DoubleSide
                });
                var ringMesh = new THREE.Mesh(ringGeo, ringMat);
                ringMesh.position.y = 0.05;
                ringMesh.userData.editorObjIdx = idx;
                ringMesh.userData._isSpawnIndicator = true;
                self._mapScene.add(ringMesh);
                self._mapModels.push(ringMesh);

            } else if (kind === 'grass3d') {

                // Single global InstancedMesh — managed by _ensureGrassMesh / _spawnGrass.

                // Push null placeholder to keep _mapModels & _physBodies parallel to _mapObjs.

                self._mapModels.push(null);

                self._physBodies.push(null);

                return;

            } else if (kind === 'grass') {

                // Legacy 2D grass (Points-based) — kept for old saves

                var grassTex = null;

                if (o.textureUrl) {

                    var texLoader = new THREE.TextureLoader();

                    grassTex = texLoader.load(o.textureUrl);

                }

                var gMat = new THREE.PointsMaterial({

                    map: grassTex || null,

                    color: baseColor,

                    size: o.bladeScale || 0.5,

                    sizeAttenuation: true,

                    transparent: true,

                    alphaTest: 0.01,

                    depthWrite: true,

                    blending: THREE.NormalBlending,

                });

                var positions = o.positions || [];

                var geo = new THREE.BufferGeometry();

                var posArr = new Float32Array(positions.length * 3);

                for (var pi = 0; pi < positions.length; pi++) {

                    posArr[pi * 3] = positions[pi].x;

                    posArr[pi * 3 + 1] = (positions[pi].y != null ? positions[pi].y : 0);

                    posArr[pi * 3 + 2] = positions[pi].z;

                }

                geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));

                mesh = new THREE.Points(geo, gMat);

                mesh.frustumCulled = false;

            } else {

                // Existing model kind: need libItem

                if (!libItem) return;

                var mat = Toon.mat({ color: baseColor });

                mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);

            }



            // Compute world position and add mesh

            var parentObj = (o.parentIdx != null && o.parentIdx >= 0) ? self._mapObjs[o.parentIdx] : null;

            var px = o.x, py = o.y != null ? o.y : 0.5, pz = o.z;

            if (parentObj) {

                px += parentObj.x; py += (parentObj.y != null ? parentObj.y : 0.5); pz += parentObj.z;

            }

            if (mesh) {

                mesh.position.set(px, py, pz);

                mesh.rotation.y = o.rot || 0;

                mesh.scale.setScalar(o.scale || 1);

                if (!isImage && !isWater) {

                    if (mesh.isGroup) {

                        mesh.traverse(function (c) { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });

                    } else { mesh.castShadow = true; mesh.receiveShadow = true; }

                }

                mesh.userData.editorObjIdx = idx;

                self._mapScene.add(mesh);

                self._mapModels.push(mesh);



                // Physics (skip lights, water, grass, spawnpoints)

                if (self._physics && !isLight && !isWater && kind !== 'grass' && kind !== 'grass3d' && kind !== 'spawnpoint') {

                    var desc = self._physSimulating

                        ? RAPIER.RigidBodyDesc.dynamic().setTranslation(px, py, pz)

                        : RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(px, py, pz);

                    var body = self._physics.createRigidBody(desc);

                    var hw = (size / 2) * (o.scale || 1);

                    var col = RAPIER.ColliderDesc.cuboid(hw, hw, hw);

                    var collider = self._physics.createCollider(col, body);

                    body.userData = body.userData || {};

                    body.userData._collider = collider;

                    if (mesh) {

                        mesh.userData._physBody = body;

                        mesh.userData._collider = collider;

                    }

                    self._physBodies.push(body);

                }



                // For existing models, try to load actual 3D model

                if (kind === 'model' && libItem) {

                    (function (boxIdx) {

                        self._loadModelData(libItem, function (srcGroup) {

                            if (!srcGroup) return;

                            // Clone group structure (geometries shared, materials replaced below)

                            var group = srcGroup.clone();

                            var currentBox = null;

                            var replaceIdx = -1;

                            for (var mi = 0; mi < self._mapModels.length; mi++) {

                                if (self._mapModels[mi].userData && self._mapModels[mi].userData.editorObjIdx === boxIdx) {

                                    currentBox = self._mapModels[mi];

                                    replaceIdx = mi;

                                    break;

                                }

                            }

                            if (!currentBox || replaceIdx < 0) return;

                            self._mapScene.remove(currentBox);

                            self._mapModels[replaceIdx] = group;

                            group.userData.editorObjIdx = boxIdx;

                            group.position.copy(currentBox.position);

                            group.rotation.y = currentBox.rotation.y;

                            group.scale.copy(currentBox.scale);

                            var objData = self._mapObjs[boxIdx];

                            var rockColor = objData && objData.color != null ? objData.color : 0x7a7f95;

                            var ambientVal = objData && objData.ambient != null ? objData.ambient : 0xffffff;

                            var ambientCol = new THREE.Color(ambientVal);

                            var ambientIntensity = ambientVal === 0xffffff ? 0.12 : 0;

                            group.traverse(function (c) {

                                if (c.isMesh) {

                                    c.visible = true;

                                    c.castShadow = true;

                                    c.receiveShadow = true;

                                    if (!c.geometry.attributes.normal) {

                                        c.geometry.computeVertexNormals();

                                    }

                                    c.material = Toon.mat({

                                        color: rockColor,

                                        flatShading: true,

                                    });

                                    c.material.transparent = false;

                                    c.material.opacity = 1.0;

                                    c.material.depthWrite = true;

                                    c.material.depthTest = true;

                                    c.material.side = THREE.FrontSide;

                                    c.material.emissive.copy(ambientCol).multiplyScalar(ambientIntensity > 0 ? 1 : 0);

                                    c.material.emissiveIntensity = ambientIntensity;

                                    c.material.userData._ambientHex = ambientVal;

                                    c.material.userData._ambientIntensity = ambientIntensity;

                                    c.material.userData._origEmissive = new THREE.Color(0);

                                    c.material.userData._origEmissiveIntensity = 0;

                                    c.material.needsUpdate = true;

                                }

                            });

                            self._mapScene.add(group);

                            var box3 = new THREE.Box3().setFromObject(group);

                            var sz = box3.max.clone().sub(box3.min);

                            if (objData && !objData._autoScaled && Math.max(sz.x, sz.y, sz.z) > 5) {

                                var maxDim = Math.max(sz.x, sz.y, sz.z);

                                var fitScale = 3 / maxDim;

                                group.scale.setScalar(fitScale);

                                objData.scale = fitScale;

                                objData._autoScaled = true;

                                box3.setFromObject(group);

                                sz = box3.max.clone().sub(box3.min);

                            }

                            self._highlightSelected();

                        });

                    })(idx);

                }

            }



            // Attach child mesh for sound range indicator

            if (isSound && mesh) {

                var rangeGeo = new THREE.SphereGeometry(o.range || 15, 24, 24);

                var wireMat = new THREE.MeshBasicMaterial({ color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.15 });

                var wireSphere = new THREE.Mesh(rangeGeo, wireMat);

                wireSphere.userData.editorObjIdx = idx;

                wireSphere.userData._isRangeIndicator = true;

                wireSphere.position.copy(mesh.position);

                self._mapScene.add(wireSphere);

            }

        });



        // Rebuild global grass mesh from stored blade data

        if (this._grassMesh) {

            this._mapScene.remove(this._grassMesh);

            if (this._grassMesh.geometry) this._grassMesh.geometry.dispose();

            if (this._grassMesh.material) this._grassMesh.material.dispose();

            this._grassMesh = null;

        }

        this._grassCount = this._grassBladeData.length;

        this._ensureGrassMesh();



        this._highlightSelected();

        this._updCnt();

        // Re-attach gizmo since all meshes were recreated

        if (this._transformControls && this._mapSelObj != null && this._mapModels[this._mapSelObj]) {

            this._transformControls.attach(this._mapModels[this._mapSelObj]);

            this._transformControls.setSpace('world');

        }

        // Ground sanity check — force visible, correct position, valid material

        for (var gi = 0; gi < this._mapObjs.length; gi++) {

            if (this._mapObjs[gi] && this._mapObjs[gi].kind === 'ground') {

                var gm = null;

                for (var gmi = 0; gmi < this._mapModels.length; gmi++) {

                    if (this._mapModels[gmi] && this._mapModels[gmi].userData && this._mapModels[gmi].userData.editorObjIdx === gi) {

                        gm = this._mapModels[gmi];

                        break;

                    }

                }

                if (gm) {

                    gm.visible = true;

                    var gob = this._mapObjs[gi];

                    gm.position.set(gob.x || 0, (gob.y != null ? gob.y : 0), gob.z || 0);

                    if (gm.material) {

                        gm.material.opacity = (gm.material.opacity != null && gm.material.opacity < 0.01) ? 1.0 : gm.material.opacity;

                        gm.material.transparent = gm.material.opacity < 1;

                        gm.material.needsUpdate = true;

                    }

                }

            }

        }



        this._physLock = false;

    },



    _highlightSelected: function () {

        var self = this;

        // Remove old outlines

        this._mapOutlines.forEach(function (o) { if (o.parent) o.parent.remove(o); });

        this._mapOutlines = [];



        var selSet = {};

        this._mapSelObjs.forEach(function (i) { selSet[i] = true; });



        this._mapModels.forEach(function (m, idx) {

            if (!m) return;

            var selected = !!selSet[idx];

            if (selected) {

                // Use BoxHelper on the top-level group to avoid per-mesh edge lines that clutter or interfere

                var bh = new THREE.BoxHelper(m, 0x000000);

                self._mapScene.add(bh);

                self._mapOutlines.push(bh);

            }

        });

    },



    _updCnt: function () {

        var el = document.getElementById('e-obj-cnt');

        if (el) el.textContent = this._mapObjs.length + (this._mapSelObjs.length > 0 ? ' (' + this._mapSelObjs.length + ' sel)' : '');

    },



    _importFromServer: function () {

        var self = this;

        var host = prompt('Server URL (default: http://localhost:3120):', 'http://localhost:3120') || 'http://localhost:3120';

        fetch(host + '/api/models')

            .then(function (r) { return r.json(); })

            .then(function (models) {

                if (!models || models.length === 0) { self.toast('No models on server'); return; }

                var html = models.map(function (m, i) {

                    return '<div class="e123-srv-item" data-idx="' + i + '" style="padding:8px 12px;background:#22272e;border-radius:6px;margin-bottom:4px;cursor:pointer">📦 ' + m.name + '</div>';

                }).join('');

                var div = document.createElement('div');

                div.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center';

                div.innerHTML = '<div style="background:#1a1e24;border-radius:12px;padding:20px;max-width:400px;width:90%;max-height:80vh;overflow-y:auto">' +

                    '<h3 style="margin:0 0 12px;color:#ffb12b;font-size:15px">Models on Server</h3>' + html +

                    '<div style="margin-top:12px;text-align:center"><span class="e123-tbtn" id="e-srv-close" style="padding:6px 24px">Close</span></div></div>';

                document.body.appendChild(div);

                div.querySelectorAll('.e123-srv-item').forEach(function (el) {

                    el.onclick = function () {

                        var model = models[parseInt(this.dataset.idx)];

                        var fullUrl = host + '/api/models/' + encodeURIComponent(model.name);

                        // Fetch the model binary from server and store as ArrayBuffer

                        fetch(host + model.url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {

                            var isGLB = /\.glb/i.test(model.name);

                            var bytes = new Uint8Array(buf); var bin = ''; for (var bi = 0; bi < bytes.length; bi++) bin += String.fromCharCode(bytes[bi]); var base64 = btoa(bin);

                            var libEntry = {

                                name: model.name.replace(/\.(glb|gltf|fbx)$/i, ''),

                                data: buf,

                                base64: base64,

                                type: isGLB ? 'glb' : 'fbx',

                            };

                            self._mapLib.push(libEntry);

                            self._addAssetToLibraryUI(libEntry.name, libEntry);

                            self._parseModelData(libEntry, function (group) {

                                libEntry._cachedGroup = group;

                            });

                            self._saveLib(self._mapLib);

                            self.toast('Imported: ' + model.name);

                        }).catch(function (e) {

                            // Fallback: store as URL

                            var fbEntry = { name: model.name.replace(/\.(glb|gltf|fbx)$/i, ''), data: host + model.url, type: /\.glb/i.test(model.name) ? 'glb' : 'fbx' };

                            self._mapLib.push(fbEntry);

                            self._addAssetToLibraryUI(fbEntry.name, fbEntry);

                            self._saveLib(self._mapLib);

                            self.toast('Imported (URL fallback): ' + model.name);

                        });

                        document.body.removeChild(div);

                    };

                });

                document.getElementById('e-srv-close').onclick = function () { document.body.removeChild(div); };

            })

            .catch(function (e) { self.toast('Server error: ' + e.message); });

    },



    _importModel: function () {

        var self = this;

        var inp = document.getElementById('e123-file-input');

        if (!inp) {

            inp = document.createElement('input');

            inp.id = 'e123-file-input';

            inp.type = 'file';

            inp.multiple = true;

            inp.accept = '.fbx,.glb,.gltf';

            inp.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:-1';

            document.body.appendChild(inp);

            inp.onchange = function (e) {

                var files = Array.from(e.target.files || []);

                inp.value = '';

                if (files.length === 0) return;

                // Filter supported formats (clean for loop)

                var modelFiles = [];

                for (var fi = 0; fi < files.length; fi++) {

                    var f = files[fi];

                    var ext = f.name.split('.').pop().toLowerCase();

                    if (ext === 'fbx' || ext === 'glb' || ext === 'gltf') modelFiles.push(f);

                }

                if (modelFiles.length === 0) { self.toast('No model files (FBX/GLB) selected'); return; }

                self.toast('Processing ' + modelFiles.length + ' file(s)...');

                // Sequential processing — one file at a time with setTimeout yield

                // to keep the UI responsive during a batch of 150+ files.

                var loadedCnt = 0;

                var failCnt = 0;

                var fileIdx = 0;

                function processNext() {

                    if (fileIdx >= modelFiles.length) {

                        try { self._saveLib(self._mapLib); } catch (e) {

                            console.warn('localStorage quota exceeded — models kept in memory only');

                        }

                        self._renderLibList();

                        self.toast('Loaded ' + loadedCnt + ' model(s)' + (failCnt ? ', ' + failCnt + ' failed' : ''));

                        // Ensure global register stays in sync

                        window.editorAssets.models = self._mapLib;

                        return;

                    }

                    var mf = modelFiles[fileIdx++];

                    var reader = new FileReader();

                    reader.onload = function (ev) {

                        try {

                            var arrayBuf = ev.target.result;

                            // Single-pass base64 conversion (correct byte grouping)

                            var bytes = new Uint8Array(arrayBuf);

                            var bin = '';

                            for (var bi = 0; bi < bytes.length; bi++) bin += String.fromCharCode(bytes[bi]);

                            var base64 = btoa(bin);

                            var ext = mf.name.split('.').pop().toLowerCase();

                            var assetName = mf.name.replace(/\.(glb|gltf|fbx)$/i, '');

                            var entry = {

                                name: assetName,

                                type: (ext === 'glb' || ext === 'gltf') ? 'glb' : 'fbx',

                                data: arrayBuf,

                                base64: base64,

                            };

                            self._mapLib.push(entry);

                            loadedCnt++;

                            // Real-time UI: immediately add a library slot for this file

                            self._addAssetToLibraryUI(assetName, entry);

                            // Kick off async parse (result cached for later scene building)

                            self._loadModelData(entry, function (group) {

                                entry._cachedGroup = group;

                            });

                        } catch (err) {

                            console.error('Import error for', mf.name, err);

                            failCnt++;

                        }

                        // Yield to browser before handling the next file

                        setTimeout(processNext, 0);

                    };

                    reader.onerror = function () {

                        console.error('FileReader error for', mf.name);

                        failCnt++;

                        setTimeout(processNext, 0);

                    };

                    reader.readAsArrayBuffer(mf);

                }

                processNext();

            };

        }

        inp.click();

    },



    /** Dynamically create a library UI slot for one asset and append it to the library

     *  container (findable as #e-lib-list, #library-container, or [data-lib-container]).

     *  Clicking the slot sets window.currentSelectedSpawnObject and activates the

     *  3D placement raycaster. */

    _addAssetToLibraryUI: function (assetName, entry) {

        var list = document.getElementById('e-lib-list') || document.getElementById('library-container') || document.querySelector('[data-lib-container]');

        if (!list) return;

        // Remove the "no models" placeholder if this is the first real entry

        var placeholder = list.querySelector('[data-placeholder]');

        if (placeholder) placeholder.remove();

        var idx = this._mapLib.length - 1;

        var self = this;

        var item = document.createElement('div');

        item.className = 'e123-lib-item';

        item.dataset.idx = idx;

        item.style.cssText = 'padding:6px 8px;background:#22272e;border-radius:5px;margin-bottom:3px;cursor:pointer;border:1.5px solid transparent;display:flex;align-items:center;gap:6px';

        item.innerHTML =

            '<div style="width:28px;height:28px;background:#181c22;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">📦</div>' +

            '<div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:600;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +

            (assetName || 'Model') + '</div>' +

            '<div style="font-size:9px;color:#666">' + (entry.type || 'glb') + '</div></div>';

        item.onclick = function () {

            var clickIdx = parseInt(this.dataset.idx);

            // Expose the asset name globally for the spawn placement raycaster

            if (typeof window.currentSelectedSpawnObject !== 'undefined') {

                window.currentSelectedSpawnObject = assetName;

            }

            // Activate the existing editor placement system

            self._mapPlacing = clickIdx;

            self._mapPlacingMulti = [clickIdx];

            var ind = document.getElementById('e-placing-indicator');

            if (ind) {

                ind.style.display = '';

                ind.textContent = '🔵 Placing: ' + assetName;

            }

            self._renderLibList();

            self.toast('Selected: ' + assetName + ' — click ground to place');

        };

        list.appendChild(item);

        // Keep the model count badge up to date

        var cnt = document.getElementById('e-lib-count');

        if (cnt) cnt.textContent = this._mapLib.length;

    },



    _parseModelData: function (libEntry, cb) {

        if (libEntry._cachedGroup) { cb(libEntry._cachedGroup); return; }

        try {

            var loader = this._gltfLoader;

            if (libEntry.type === 'glb') {

                loader = this._gltfLoader;

            } else {

                loader = this._fbxLoader;

                if (!loader) { console.warn('FBXLoader not available (fflate missing?)'); cb(null); return; }

            }

            if (!loader || !libEntry.data) { cb(null); return; }

            var buf = libEntry.data instanceof ArrayBuffer ? libEntry.data : this._base64ToArrayBuf(libEntry.base64);

            if (!buf) { cb(null); return; }

            if (libEntry.type === 'glb') {

                loader.parse(buf, '', function (result) {

                    var group = result && result.scene ? result.scene : result;

                    if (!group) { console.warn('GLTF parse produced no scene'); cb(null); return; }

                    libEntry._cachedGroup = group;

                    cb(group);

                }, function (err) {

                    console.warn('GLTF parse error:', err);

                    cb(null);

                });

            } else {

                // FBXLoader.parse returns the Group synchronously (no callbacks!)

                try {

                    var result = loader.parse(buf, '');

                    libEntry._cachedGroup = result;

                    cb(result);

                } catch (e2) {

                    console.warn('FBX parse error:', e2);

                    cb(null);

                }

            }

        } catch (e) { console.warn('Parse error:', e); cb(null); }

    },



    _parseModelData: function (libEntry, cb) {

        if (libEntry._cachedGroup) { cb(libEntry._cachedGroup); return; }

        try {

            var loader = this._gltfLoader;

            if (libEntry.type === 'glb') {

                loader = this._gltfLoader;

            } else {

                loader = this._fbxLoader;

                if (!loader) { console.warn('FBXLoader not available (fflate missing?)'); cb(null); return; }

            }

            if (!loader || !libEntry.data) { cb(null); return; }

            var buf = libEntry.data instanceof ArrayBuffer ? libEntry.data : this._base64ToArrayBuf(libEntry.base64);

            if (!buf) { cb(null); return; }

            if (libEntry.type === 'glb') {

                loader.parse(buf, '', function (result) {

                    var group = result && result.scene ? result.scene : result;

                    libEntry._cachedGroup = group;

                    cb(group);

                }, function () { cb(null); });

            } else {

                // FBXLoader.parse returns the Group synchronously (no callbacks!)

                try {

                    var result = loader.parse(buf, '');

                    libEntry._cachedGroup = result;

                    cb(result);

                } catch (e2) {

                    console.warn('FBX parse error:', e2);

                    cb(null);

                }

            }

        } catch (e) { console.warn('Parse error:', e); cb(null); }

    },



    _base64ToArrayBuf: function (base64) {

        try {

            var bin = atob(base64);

            var buf = new ArrayBuffer(bin.length);

            var view = new Uint8Array(buf);

            for (var i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);

            return buf;

        } catch (e) { return null; }

    },



    _loadModelData: function (libEntry, cb) {

        if (!libEntry) { cb(null); return; }

        if (libEntry._cachedGroup) { cb(libEntry._cachedGroup); return; }

        // If we have ArrayBuffer data, parse it

        if (libEntry.data instanceof ArrayBuffer || libEntry.base64) {

            this._parseModelData(libEntry, cb);

            return;

        }

        // Fallback: data might be a URL (server import)

        if (typeof libEntry.data === 'string') {

            try {

                var loader = libEntry.type === 'glb' ? this._gltfLoader : (this._fbxLoader || this._gltfLoader);

                if (!loader) { cb(null); return; }

                var self = this;

                loader.load(libEntry.data, function (result) {

                    var group = result && result.scene ? result.scene : result;

                    libEntry._cachedGroup = group;

                    cb(group);

                }, undefined, function () { cb(null); });

            } catch (e) { cb(null); }

            return;

        }

        cb(null);

    },



    /* ---------- keyboard shortcuts ---------- */

    _wireKeys: function () {

        var self = this;

        this._mapKeyHandler = function (e) {

            if (self._mode !== 'map') return;

            var ctrl = e.ctrlKey || e.metaKey;

            var key = e.code;

            // Library panel shortcuts (when focus is in lib or no scene selection)

            var libPanel = document.getElementById('e-lib-list');

            var inLib = libPanel && libPanel.contains(document.activeElement);

            if (inLib || self._mapPlacingMulti.length > 0) {

                if (ctrl && key === 'KeyA') {

                    e.preventDefault();

                    self._mapPlacingMulti = [];

                    self._mapLib.forEach(function (_, i) { self._mapPlacingMulti.push(i); });

                    self._mapPlacing = self._mapPlacingMulti.length > 0 ? self._mapPlacingMulti[self._mapPlacingMulti.length - 1] : false;

                    self._renderLibList();

                    self.toast('Selected all ' + self._mapPlacingMulti.length + ' model(s) in library');

                    return;

                }

                if (key === 'Delete' || key === 'Backspace') {

                    var delBtn = document.getElementById('e-del-lib');

                    if (delBtn) { delBtn.click(); }

                    return;

                }

            }

            if (key === 'Escape') {

                if (self._mapSelObj != null || self._mapSelObjs.length > 0) {

                    if (self._transformControls) self._transformControls.detach();

                    self._mapSelObj = null; self._mapSelObjs = [];

                    self._highlightSelected(); self._renderHierarchy(); self._renderInspector();

                }

                return;

            }

            if (key === 'Delete' || key === 'Backspace') {

                if (self._mapSelObjs.length > 0) {

                    var delCount = self._mapSelObjs.length;

                    self._recursiveDelete(self._mapSelObjs.slice());

                    self._mapSelObj = null; self._mapSelObjs = [];

                    self._rebuildScene(); self._updCnt(); self._renderHierarchy(); self._renderInspector();

                    self.toast('Deleted ' + delCount + ' object(s)');

                }

                return;

            }

            if (ctrl && key === 'KeyA') {

                // Select All

                e.preventDefault();

                self._mapSelObjs = [];

                self._mapObjs.forEach(function (o, i) { self._mapSelObjs.push(i); });

                self._mapSelObj = self._mapSelObjs.length > 0 ? self._mapSelObjs[self._mapSelObjs.length - 1] : null;

                self._highlightSelected(); self._renderHierarchy(); self._renderInspector();

                if (self._mapSelObj != null && self._mapModels[self._mapSelObj]) {

                    if (self._transformControls) self._transformControls.attach(self._mapModels[self._mapSelObj]);

                }

                self.toast('Selected ' + self._mapSelObjs.length + ' object(s)');

                return;

            }

            if (ctrl && key === 'KeyC') {

                // Copy

                e.preventDefault();

                self._mapClipboard = [];

                self._mapSelObjs.forEach(function (i) {

                    var o = self._mapObjs[i];

                    if (o) self._mapClipboard.push(JSON.parse(JSON.stringify(o)));

                });

                self.toast('Copied ' + self._mapClipboard.length + ' object(s)');

                return;

            }

            if (ctrl && key === 'KeyV') {

                // Paste

                e.preventDefault();

                if (self._mapClipboard.length === 0) { self.toast('Nothing to paste'); return; }

                self._mapClipboard.forEach(function (o) {

                    var copy = JSON.parse(JSON.stringify(o));

                    copy.x = (copy.x || 0) + 1.5;

                    copy.z = (copy.z || 0) + 1.5;

                    delete copy._autoScaled;

                    self._mapObjs.push(copy);

                });

                self._rebuildScene(); self._updCnt(); self._renderHierarchy();

                self.toast('Pasted ' + self._mapClipboard.length + ' object(s)');

                return;

            }

            if (ctrl && key === 'KeyD') {

                // Duplicate

                e.preventDefault();

                var copies = [];

                self._mapSelObjs.forEach(function (i) {

                    var o = self._mapObjs[i];

                    if (o) {

                        var copy = JSON.parse(JSON.stringify(o));

                        copy.x = (copy.x || 0) + 1.5;

                        copy.z = (copy.z || 0) + 1.5;

                        delete copy._autoScaled;

                        copies.push(copy);

                    }

                });

                copies.forEach(function (c) { self._mapObjs.push(c); });

                self._rebuildScene(); self._updCnt(); self._renderHierarchy();

                self.toast('Duplicated ' + copies.length + ' object(s)');

                return;

            }

            // G — Toggle snap

            if (key === 'KeyG' && !ctrl) {

                var snapBtn2 = document.getElementById('e-snap-btn');

                if (snapBtn2) snapBtn2.click();

                return;

            }

            // R — Randomize rotation/scale

            if (key === 'KeyR' && !ctrl) {

                var randBtn2 = document.getElementById('e-rand-btn');

                if (randBtn2) randBtn2.click();

                return;

            }

            // F — Focus on selected

            if (key === 'KeyF' && !ctrl && self._mapSelObj != null && self._mapModels[self._mapSelObj]) {

                var targetObj = self._mapModels[self._mapSelObj];

                if (targetObj && self._mapControls) {

                    var box = new THREE.Box3().setFromObject(targetObj);

                    var center = box.getCenter(new THREE.Vector3());

                    self._mapControls.target.copy(center);

                    var size = box.getSize(new THREE.Vector3());

                    var dist = Math.max(size.length(), 5) * 1.5;

                    var camDir = new THREE.Vector3(1, 0.7, 1).normalize();

                    self._mapCamera.position.copy(center).add(camDir.multiplyScalar(dist));

                    self._mapControls.update();

                }

                return;

            }

        };

        window.addEventListener('keydown', this._mapKeyHandler);

    },



    _stopMapEditor: function () {

        if (this._mapAnimId) { cancelAnimationFrame(this._mapAnimId); this._mapAnimId = null; }

        if (this._mapKeyHandler) { window.removeEventListener('keydown', this._mapKeyHandler); this._mapKeyHandler = null; }

        if (this._mapRenderer) { this._mapRenderer.dispose(); var el = this._mapRenderer.domElement; if (el && el.parentNode) el.parentNode.removeChild(el); this._mapRenderer = null; }

        if (this._mapResizeHandler) { window.removeEventListener('resize', this._mapResizeHandler); this._mapResizeHandler = null; }

        if (this._transformControls) { this._transformControls.dispose(); this._transformControls = null; }

        if (this._grassBrushCircle) { if (this._mapScene) this._mapScene.remove(this._grassBrushCircle); this._grassBrushCircle = null; }

        if (this._grassMesh) { if (this._mapScene) this._mapScene.remove(this._grassMesh); if (this._grassMesh.geometry) this._grassMesh.geometry.dispose(); if (this._grassMesh.material) this._grassMesh.material.dispose(); this._grassMesh = null; }

        this._grassCount = 0; this._grassBladeData = [];

        this._grassWindSpeed = 1.2; this._grassWindStrength = 0.3;

        this._mapScene = null; this._mapCamera = null; this._mapControls = null; this._mapModels = []; this._mapGround = null; this._physics = null; this._physBodies = [];

        this._currentTool = 'select';

        this._paintMode = false;

        this._grassMode = false;

        this._grassEraseMode = false;

        if (this._grassBrushCircle) this._grassBrushCircle.visible = false;

        var pp = document.getElementById('e-paint-panel');

        if (pp) pp.remove();

        var gp = document.getElementById('e-grass-panel');

        if (gp) gp.remove();

        if (this._grassTexUrl) { URL.revokeObjectURL(this._grassTexUrl); this._grassTexUrl = null; }

        this._mapOutlines.forEach(function (o) { if (o.parent) o.parent.remove(o); });

        this._mapOutlines = [];

        var rb = document.getElementById('e-rot-badge');

        if (rb) rb.remove();

    },



    /* ═══════════════════════════

       PERSISTENCE

       ═══════════════════════════ */

    _saveElem: function () {

        var self = this;

        var d = {};

        Object.keys(this._elements).forEach(function (k) { d[k] = self._elements[k].map(function (el) {

                var o = { type: el.type, x: el.x, y: el.y, w: el.w, h: el.h };

                if (el.type === 'image') { o.name = el.name; o.imageData = el.image ? self._imgData(el.image) : null; }

                else if (el.type === 'button') { o.label = el.label; o.bgColor = el.bgColor; o.command = el.command; o.hitbox = el.hitbox; }

                else if (el.type === 'comment') { o.text = el.text; }

                return o;

            }); });

        localStorage.setItem('tankparty_editor123_menus', JSON.stringify(d));

    },



    _loadElem: function () {

        var self = this;

        this._elements = {}; this._imgCounter = 0;

        try {

            var d = JSON.parse(localStorage.getItem('tankparty_editor123_menus'));

            if (!d) return;

            Object.keys(d).forEach(function (k) {

                self._elements[k] = [];

                d[k].forEach(function (el) {

                    var e = { type: el.type, x: el.x, y: el.y, w: el.w, h: el.h };

                    if (el.type === 'image') { e.name = el.name || 'Image'; if (el.imageData) { var img = new Image(); img.onload = function () { if (self._renderCanvas) self._renderCanvas(); }; img.src = el.imageData; e.image = img; } }

                    else if (el.type === 'button') { e.label = el.label || 'Button'; e.bgColor = el.bgColor || '#383838'; e.command = el.command || 'none'; e.hitbox = el.hitbox || { x: 0, y: 0, w: 0, h: 0 }; }

                    else if (el.type === 'comment') { e.text = el.text || 'comment'; }

                    self._elements[k].push(e);

                });

            });

        } catch (e) { }

    },



    _loadLib: function () {

        try {

            var raw = localStorage.getItem('tankparty_editor123_library');

            if (!raw || raw === '[]') return [];

            var arr = JSON.parse(raw);

            if (!Array.isArray(arr)) return [];

            // Reconstruct ArrayBuffer from base64 (chunked-aware join)

            arr.forEach(function (entry) {

                if (entry.base64) {

                    try {

                        var bin = atob(entry.base64);

                        var buf = new ArrayBuffer(bin.length);

                        var view = new Uint8Array(buf);

                        for (var i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);

                        entry.data = buf;

                    } catch (e) { entry.data = null; console.warn('Failed to decode base64 for', entry.name); }

                }

            });

            return arr;

        } catch (e) { console.warn('Library load error (corrupt localStorage?):', e); return []; }

    },

    _saveLib: function (l) {

        // Strip non-serializable fields before saving

        var clean = l.map(function (entry) {

            var e = { name: entry.name, type: entry.type };

            if (entry.base64) e.base64 = entry.base64;

            else if (typeof entry.data === 'string') e.data = entry.data;

            else e.data = null;

            return e;

        });

        var json = JSON.stringify(clean);

        var sizeBytes = new Blob([json]).size;

        if (sizeBytes > 4 * 1024 * 1024) {

            console.warn('Library data ~' + (sizeBytes / 1024 / 1024).toFixed(1) + 'MB — may exceed localStorage quota');

        }

        try {

            localStorage.setItem('tankparty_editor123_library', json);

        } catch (e) {

            console.error('Failed to save library (quota exceeded?):', e);

            throw e;

        }

    },

    _loadMap: function () {
        try {
            var raw = JSON.parse(localStorage.getItem('tankparty_editor123_map') || '[]');
            // Maps saved via the GAMEMODES flow are wrapped as {objects, gamemode}
            if (raw && !Array.isArray(raw) && Array.isArray(raw.objects)) {
                this._editorGamemode = raw.gamemode || 'sandbox';
                return raw.objects;
            }
            return raw;
        } catch (e) { return []; }
    },

    _saveMap: function () { try { localStorage.setItem('tankparty_editor123_map', JSON.stringify(this._mapObjs)); } catch (e) { console.error('Save map failed:', e); this.toast('Error saving map: ' + e.message); } },

    _saveMapWithGamemode: function () {
        var self = this;
        this._showGamemodeSelector(function (gamemode) {
            if (!gamemode) return;
            
            // Validate spawn points for selected gamemode
            var validation = self._validateSpawnPoints(gamemode);
            if (!validation.valid) {
                alert(validation.message);
                return;
            }
            
            // Save map with gamemode
            var mapData = {
                objects: self._mapObjs,
                gamemode: gamemode
            };
            try {
                localStorage.setItem('tankparty_editor123_map', JSON.stringify(mapData));
                self.toast('Saved ' + self._mapObjs.length + ' objects for ' + gamemode);
            } catch (e) {
                console.error('Save map failed:', e);
                self.toast('Error saving map: ' + e.message);
            }
        });
    },

    _showGamemodeSelector: function (callback) {
        var self = this;
        var existing = document.getElementById('e-gamemode-selector');
        if (existing) existing.remove();

        var div = document.createElement('div');
        div.id = 'e-gamemode-selector';
        div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:400;background:#1a1e24;border:2px solid #3a3f46;border-radius:12px;padding:20px;font-size:14px;box-shadow:0 8px 32px rgba(0,0,0,0.6);min-width:300px';
        
        div.innerHTML = 
            '<div style="color:#ffb12b;font-weight:700;font-size:16px;margin-bottom:15px;text-align:center">Select Gamemode</div>' +
            '<div style="display:flex;flex-direction:column;gap:8px">' +
            '<div class="e123-tbtn" data-gamemode="gladiator" style="padding:10px;text-align:center;background:#e74c3c;color:#fff">⚔️ Gladiator (10 spawns)</div>' +
            '<div class="e123-tbtn" data-gamemode="platform-king" style="padding:10px;text-align:center;background:#f39c12;color:#fff">👑 Platform King (8 spawns)</div>' +
            '<div class="e123-tbtn" data-gamemode="sandbox" style="padding:10px;text-align:center;background:#3498db;color:#fff">🏗️ Sandbox (1 player + 6 AFK + 1 attack)</div>' +
            '<div class="e123-tbtn" data-gamemode="multiplayer" style="padding:10px;text-align:center;background:#27ae60;color:#fff">👥 Multiplayer</div>' +
            '</div>' +
            '<div class="e123-tbtn" style="margin-top:15px;text-align:center;background:#3a3f46">Cancel</div>';
        
        document.body.appendChild(div);
        
        div.querySelectorAll('[data-gamemode]').forEach(function (btn) {
            btn.onclick = function () {
                div.remove();
                callback(btn.dataset.gamemode);
            };
            btn.onmouseover = function () { this.style.opacity = '0.8'; };
            btn.onmouseout = function () { this.style.opacity = '1'; };
        });
        
        div.querySelector('.e123-tbtn:not([data-gamemode])').onclick = function () {
            div.remove();
            callback(null);
        };
    },

    _validateSpawnPoints: function (gamemode) {
        var spawnPoints = this._mapObjs.filter(function (o) { return o.kind === 'spawnpoint'; });
        
        switch (gamemode) {
            case 'gladiator':
                var gladiatorSpawns = spawnPoints.filter(function (o) { return o.subType === 'gladiator'; });
                if (gladiatorSpawns.length !== 10) {
                    return {
                        valid: false,
                        message: 'Gladiator mode requires exactly 10 Gladiator Spawn points. Currently have: ' + gladiatorSpawns.length
                    };
                }
                break;
                
            case 'platform-king':
                var platformSpawns = spawnPoints.filter(function (o) { return o.subType === 'platform-king'; });
                if (platformSpawns.length !== 8) {
                    return {
                        valid: false,
                        message: 'Platform King mode requires exactly 8 Platform King Spawn points. Currently have: ' + platformSpawns.length
                    };
                }
                break;
                
            case 'sandbox':
                var playerSpawns = spawnPoints.filter(function (o) { return o.subType === 'player'; });
                var afkSpawns = spawnPoints.filter(function (o) { return o.subType === 'afk-dummy'; });
                var attackSpawns = spawnPoints.filter(function (o) { return o.subType === 'attack-dummy'; });
                
                if (playerSpawns.length !== 1) {
                    return {
                        valid: false,
                        message: 'Sandbox mode requires exactly 1 Player Spawn point. Currently have: ' + playerSpawns.length
                    };
                }
                if (afkSpawns.length !== 6) {
                    return {
                        valid: false,
                        message: 'Sandbox mode requires exactly 6 AFK Dummy Spawn points. Currently have: ' + afkSpawns.length
                    };
                }
                if (attackSpawns.length !== 1) {
                    return {
                        valid: false,
                        message: 'Sandbox mode requires exactly 1 Attack Dummy Spawn point. Currently have: ' + attackSpawns.length
                    };
                }
                break;
                
            case 'multiplayer':
                // Multiplayer doesn't have specific spawn point requirements
                break;
                
            default:
                return {
                    valid: false,
                    message: 'Unknown gamemode: ' + gamemode
                };
        }
        
        return { valid: true };
    },



    _imgData: function (img) {

        var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;

        c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL();

    },



    /* ──── SHOP EDITOR ──── */

    _renderShopEditor: function () {

        this._mode = 'shop';

        var self = this;

        var c = document.getElementById('editor123-content');

        var html =

            '<div style="display:flex;height:100%;width:100%">' +

            '<div style="width:240px;min-width:240px;background:#1a1e24;padding:14px;overflow-y:auto;border-right:1px solid #252a32">' +

            '<h3 style="margin:0 0 12px;color:#ffb12b;font-size:14px;letter-spacing:.5px">SHOP EDITOR</h3>' +

            '<div style="margin-bottom:10px"><label style="color:#888;font-size:11px">Page to edit</label>' +

            '<div style="display:flex;gap:4px;margin-bottom:12px">' +

            '<div class="se-page-btn active" data-page="shop" style="flex:1;padding:6px;border-radius:6px;background:#2a5a2a;text-align:center;cursor:pointer;font-size:11px;color:#fff">Shop</div>' +

            '<div class="se-page-btn" data-page="buy" style="flex:1;padding:6px;border-radius:6px;background:#333;text-align:center;cursor:pointer;font-size:11px;color:#888">Buy</div>' +

            '<div class="se-page-btn" data-page="receive" style="flex:1;padding:6px;border-radius:6px;background:#333;text-align:center;cursor:pointer;font-size:11px;color:#888">Receive</div></div>' +

            '<div id="se-page-content">' +

            '<div style="margin-bottom:10px"><label style="color:#888;font-size:11px">Sections (comma-sep)</label>' +

            '<input id="se-sections" type="text" value="' + (SHOP_DATA.sections.join(',') || 'main,offers,bank,bundles,keys,tlplus') + '" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px"></div>' +

            '<div style="margin-bottom:10px"><label style="color:#888;font-size:11px">Backdrop image URL</label>' +

            '<input id="se-backdrop" type="text" value="' + (SHOP_DATA.backdrop || '') + '" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px" placeholder="assets/shop/background.png"></div>' +

            '<div class="btn" id="se-add-offer" style="font-size:12px;padding:8px">+ Add Deal</div>' +

            '<div class="btn" id="se-save" style="font-size:12px;padding:8px;margin-top:6px;background:#2a5a2a;border-color:#3a7a3a">Save Shop</div>' +

            '<div class="btn" id="se-export" style="font-size:12px;padding:8px;margin-top:6px;background:#2a2a5a;border-color:#3a3a7a">Export Rotation</div>' +

            '<div class="btn" id="se-download" style="font-size:12px;padding:8px;margin-top:6px;background:#2a2a2a;border-color:#555">Download shop.json</div>' +

            '<div class="btn" id="se-reset" style="font-size:12px;padding:8px;margin-top:6px;background:#5a2a2a;border-color:#7a3a3a">Reset to Default</div></div>' +

            '<div id="e123-m-back" style="margin-top:16px;padding:9px;background:#2a2f36;border-radius:8px;cursor:pointer;text-align:center;color:#888;font-size:12px">&lt;- Back to Launcher</div></div>' +

            '<div style="flex:1;display:flex;flex-direction:column;overflow:hidden">' +

            '<div style="padding:8px 14px;background:#1a1e24;display:flex;gap:6px;align-items:center;border-bottom:1px solid #252a32;flex-shrink:0">' +

            '<span style="color:#ffb12b;font-weight:600;font-size:13px">\u{1F6D2} ' + (SHOP_DATA.offers.length || 0) + ' deals loaded</span></div>' +

            '<div id="se-list" style="flex:1;overflow-y:auto;padding:12px"></div>' +

            '</div></div>';

        c.innerHTML = html;

        self._renderShopOfferList();

        self._updateShopEditorHeader();

        document.getElementById('e123-m-back').onclick = function () { self._renderLauncher(); };

        document.getElementById('se-add-offer').onclick = function () { self._shopAddOffer(); };

        document.getElementById('se-save').onclick = function () { self._shopSave(); };

        document.getElementById('se-export').onclick = function () { self._shopExportRotation(); };

        document.getElementById('se-download').onclick = function () { self._shopDownloadJson(); };

        document.getElementById('se-reset').onclick = function () { self._shopReset(); };

        // Page selection tabs

        document.querySelectorAll('.se-page-btn').forEach(function (b) {

            b.onclick = function () {

                document.querySelectorAll('.se-page-btn').forEach(function (x) { x.style.background = '#333'; x.style.color = '#888'; });

                this.style.background = '#2a5a2a'; this.style.color = '#fff';

                var pg = document.getElementById('se-page-content');

                if (this.dataset.page === 'shop') pg.style.display = '';

                else pg.innerHTML = '<div style="color:#666;font-size:12px;text-align:center;padding:40px 0">' + this.dataset.page.charAt(0).toUpperCase() + this.dataset.page.slice(1) + ' page editor - coming soon<br><small>Drag elements will be here</small></div>';

            };

        });

    },



    _renderShopOfferList: function () {

        var list = document.getElementById('se-list');

        if (!list) return;

        if (!SHOP_DATA.offers.length) { SHOP_DATA.offers = SHOP_DATA.ALL_DEALS.map(function(d) { return Object.assign({}, d); }); }

        var offers = SHOP_DATA.offers;

        var html = '';

        offers.forEach(function (o, i) {

            var priceStr = o.price + ' ' + (o.currency === 'gold' ? '\u25C6' : (o.currency === 'coins' ? '\u25CF' : '$'));

            html += '<div class="se-offer-card" data-idx="' + i + '" style="background:#22272e;border:1px solid #333;border-radius:10px;padding:10px 14px;margin-bottom:8px;cursor:pointer;transition:.1s">' +

                '<div style="display:flex;justify-content:space-between;align-items:center">' +

                '<div><strong>' + o.reward + '</strong> <span style="color:#888;font-size:11px">x' + o.amount + '</span></div>' +

                '<div style="text-align:right;font-size:11px;color:#8af">' + priceStr + '</div></div>' +

                '<div style="display:flex;gap:10px;margin-top:6px;font-size:10px;color:#666">' +

                '<span>Priority: ' + o.priority + '</span><span>Stock: ' + (o.stock < 0 ? '\u221E' : o.stock) + '</span></div></div>';

        });

        list.innerHTML = html;

        this._updateShopEditorHeader();

        list.querySelectorAll('.se-offer-card').forEach(function (card) {

            card.onclick = function () {

                Editor123._shopEditOffer(parseInt(this.dataset.idx));

            };

        });

    },



    _updateShopEditorHeader: function () {

        var h = document.querySelector('#editor123-content > div > div:nth-child(2) > div:first-child span');

        if (h) h.textContent = '\u{1F6D2} ' + (SHOP_DATA.offers.length || 0) + ' offers loaded';

    },



    _shopAddOffer: function () {

        var newOffer = { reward:'cash', amount:100, price:10, currency:'gold', priority:1, stock:10 };

        SHOP_DATA.offers.push(newOffer);

        this._renderShopOfferList();

        this._shopEditOffer(SHOP_DATA.offers.length - 1);

    },



    _shopEditOffer: function (idx) {

        var self = this;

        var offer = SHOP_DATA.offers[idx];

        if (!offer) return;

        var c = document.getElementById('editor123-content');

        var existing = document.getElementById('se-edit-panel');

        if (existing) existing.remove();

        var panel = document.createElement('div');

        panel.id = 'se-edit-panel';

        panel.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:320px;background:#1a1e24;border-left:1px solid #333;z-index:10;padding:16px;overflow-y:auto';

        panel.innerHTML =

            '<h4 style="color:#ffb12b;margin:0 0 12px;font-size:13px">Edit Offer</h4>' +

            '<label style="color:#888;font-size:11px">Reward (cash/coins/gold/basic_crate/rare_crate)</label><input id="se-e-reward" value="' + offer.reward + '" style="width:100%;padding:6px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px;margin-bottom:8px">' +

            '<label style="color:#888;font-size:11px">Amount</label><input id="se-e-amount" type="number" value="' + offer.amount + '" style="width:100%;padding:6px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px;margin-bottom:8px">' +

            '<label style="color:#888;font-size:11px">Price</label><input id="se-e-price" type="number" value="' + offer.price + '" style="width:100%;padding:6px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px;margin-bottom:8px">' +

            '<label style="color:#888;font-size:11px">Currency (cash/coins/gold)</label><input id="se-e-currency" value="' + offer.currency + '" style="width:100%;padding:6px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px;margin-bottom:8px">' +

            '<label style="color:#888;font-size:11px">Priority (1-3, higher=more likely)</label><input id="se-e-priority" type="number" value="' + offer.priority + '" style="width:100%;padding:6px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px;margin-bottom:8px">' +

            '<label style="color:#888;font-size:11px">Stock (0 = sold out)</label><input id="se-e-stock" type="number" value="' + offer.stock + '" style="width:100%;padding:6px;border-radius:6px;border:1px solid #333;background:#222;color:#fff;font-size:12px;margin-bottom:8px">' +

            '<div style="display:flex;gap:8px">' +

            '<div class="btn" id="se-e-save" style="font-size:12px;padding:8px;flex:1;background:#2a5a2a">Update</div>' +

            '<div class="btn" id="se-e-delete" style="font-size:12px;padding:8px;flex:1;background:#5a2a2a">Delete</div></div>';

        c.style.position = 'relative';

        c.appendChild(panel);

        document.getElementById('se-e-save').onclick = function () {

            offer.reward = document.getElementById('se-e-reward').value;

            offer.amount = parseInt(document.getElementById('se-e-amount').value) || 0;

            offer.price = parseInt(document.getElementById('se-e-price').value) || 0;

            offer.currency = document.getElementById('se-e-currency').value;

            offer.priority = parseInt(document.getElementById('se-e-priority').value) || 1;

            offer.stock = parseInt(document.getElementById('se-e-stock').value) || 0;

            self._renderShopOfferList();

            panel.remove();

            Editor123.toast('Offer updated');

        };

        document.getElementById('se-e-delete').onclick = function () {

            SHOP_DATA.offers.splice(idx, 1);

            self._renderShopOfferList();

            panel.remove();

            Editor123.toast('Offer deleted');

        };

    },



    _shopExportRotation: function () {

        var data = { generatedAt: new Date().toISOString(), dayKey: Math.floor(Date.now() / 86400000), offers: SHOP_DATA.getOffers() };

        var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});

        var url = URL.createObjectURL(blob);

        var a = document.createElement('a');

        a.href = url; a.download = 'rotatingshop.json'; a.click();

        URL.revokeObjectURL(url);

        this.toast('Rotation exported');

    },



    _shopSave: function () {

        var sectionsStr = document.getElementById('se-sections');

        if (sectionsStr) SHOP_DATA.sections = sectionsStr.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

        var backdropEl = document.getElementById('se-backdrop');

        if (backdropEl) SHOP_DATA.backdrop = backdropEl.value || null;

        SHOP_DATA.saveShopFile();

        this.toast('Shop saved to saves/shop.json');

    },



    _shopDownloadJson: function () {

        var data = { offers: SHOP_DATA.offers, sections: SHOP_DATA.sections, backdrop: SHOP_DATA.backdrop };

        var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});

        var url = URL.createObjectURL(blob);

        var a = document.createElement('a');

        a.href = url; a.download = 'shop.json'; a.click();

        URL.revokeObjectURL(url);

        Editor123.toast('shop.json downloaded');

    },



    _shopReset: function () {

        if (!confirm('Reset shop to default offers?')) return;

        SHOP_DATA.offers = [];

        localStorage.removeItem('tankparty_shop');

        localStorage.removeItem('shop_daykey');

        localStorage.removeItem('shop_free_claimed');

        SHOP_DATA.refreshDaily();

        this._renderShopOfferList();

        this.toast('Shop reset to defaults');

    },



    /* ==================== CLAN EDITOR (v2 - full) ==================== */

    _renderClanEditor: function () {
        this._mode = 'clan';
        var c = document.getElementById('editor123-content');
        var html =
            '<div style="width:260px;min-width:260px;background:#1a1e24;padding:16px;overflow-y:auto;border-right:1px solid #252a32;display:flex;flex-direction:column;gap:6px">' +
            '<div style="font-size:18px;font-weight:700;color:#ffb12b;margin-bottom:2px">\u{1F465} Clan Editor</div>' +
            '<div style="font-size:11px;color:#888;margin-bottom:10px">Drag to move \u2022 8-handle resize \u2022 Del</div>' +
            '<div style="font-size:11px;color:#666;margin-bottom:2px;margin-top:2px">Elements</div>' +
            '<button class="e123-tbtn e-pri" id="ce-add-badge" style="font-size:12px;padding:7px 10px">\u{1F451} Badge</button>' +
            '<button class="e123-tbtn" id="ce-add-chat-body" style="font-size:12px;padding:7px 10px">\u{1F4AC} Chat Body</button>' +
            '<button class="e123-tbtn" id="ce-add-chat-input" style="font-size:12px;padding:7px 10px">\u{2328} Chat Input</button>' +
            '<button class="e123-tbtn" id="ce-add-chat-send" style="font-size:12px;padding:7px 10px">\u{1F4E8} Send Button</button>' +
            '<button class="e123-tbtn" id="ce-add-member" style="font-size:12px;padding:7px 10px">\u{1F465} Member List</button>' +
            '<button class="e123-tbtn" id="ce-add-progress" style="font-size:12px;padding:7px 10px">\u{1F4CA} XP Bar</button>' +
            '<button class="e123-tbtn" id="ce-add-xpcounter" style="font-size:12px;padding:7px 10px">\u{1F3AF} XP Counter</button>' +
            '<button class="e123-tbtn" id="ce-add-clancount" style="font-size:12px;padding:7px 10px">\u{1F465}\uFE0F Clan Count</button>' +
            '<button class="e123-tbtn" id="ce-add-sortbuttons" style="font-size:12px;padding:7px 10px">\u{2195}\uFE0F Sort Buttons</button>' +
            '<button class="e123-tbtn" id="ce-add-clan-name" style="font-size:12px;padding:7px 10px">\u{1F3DB}\uFE0F Clan Name</button>' +
            '<button class="e123-tbtn" id="ce-add-time-left" style="font-size:12px;padding:7px 10px">\u{23F3} Time Left</button>' +
            '<button class="e123-tbtn" id="ce-add-text" style="font-size:12px;padding:7px 10px">\u{1F4DD} Text</button>' +
            '<button class="e123-tbtn" id="ce-add-image" style="font-size:12px;padding:7px 10px">\u{1F5BC} Import PNG</button>' +
            '<input type="file" accept="image/png,image/jpeg" id="ce-file-input" style="display:none">' +
            '<div id="ce-props" style="display:none;margin-top:8px;padding-top:10px;border-top:1px solid #252a32">' +
            '<div style="font-size:12px;color:#aaa;margin-bottom:6px">Element Properties</div>' +
            '<label style="font-size:11px;color:#888">Text color</label>' +
            '<input type="color" id="ce-color-picker" style="width:100%;height:30px;background:transparent;border:1px solid #333;border-radius:4px;padding:2px;margin-bottom:6px;cursor:pointer">' +
            '<label style="font-size:11px;color:#888">Border color</label>' +
            '<input type="color" id="ce-border-picker" style="width:100%;height:30px;background:transparent;border:1px solid #333;border-radius:4px;padding:2px;margin-bottom:6px;cursor:pointer">' +
            '<label style="font-size:11px;color:#888">Border opacity (%)</label>' +
            '<input type="range" id="ce-border-opacity" min="10" max="100" value="50" style="width:100%;margin-bottom:6px">' +
            '<label style="font-size:11px;color:#888">Font size</label>' +
            '<input type="range" id="ce-font-size" min="8" max="72" value="16" style="width:100%;margin-bottom:6px">' +
            '<label style="font-size:11px;color:#888;display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
            '<input type="checkbox" id="ce-show-frame" checked style="accent-color:#ffb12b;width:14px;height:14px"> Show frame' +
            '</label>' +
            '<label style="font-size:11px;color:#888">Placeholder text</label>' +
            '<input type="text" id="ce-label-input" style="width:100%;background:#14181e;border:1px solid #333;border-radius:4px;padding:6px 8px;color:#fff;font-size:12px;margin-bottom:4px">' +
            '<div id="ce-member-extra" style="display:none;margin-top:6px;font-size:11px;color:#666">' +
            'Sort: <span id="ce-sort-display" style="color:#aaa">Name</span>' +
            '</div>' +
            '<div id="ce-text-extra" style="display:none;margin-top:6px">' +
            '<label style="font-size:11px;color:#888;margin-bottom:4px;display:block">Style</label>' +
            '<div style="display:flex;gap:6px;margin-bottom:4px">' +
            '<button class="e123-tbtn" id="ce-text-bold" style="font-size:11px;padding:5px 10px;flex:1;border:2px solid #252a32;font-weight:700">B</button>' +
            '<button class="e123-tbtn" id="ce-text-italic" style="font-size:11px;padding:5px 10px;flex:1;border:2px solid #252a32;font-style:italic">I</button>' +
            '</div>' +
            '</div>' +
            '<div id="ce-sortbuttons-extra" style="display:none;margin-top:6px">' +
            '<label style="font-size:11px;color:#888;margin-bottom:4px;display:block">Sort by</label>' +
            '<div style="display:flex;gap:6px;margin-bottom:4px">' +
            '<button class="e123-tbtn" id="ce-sb-name" style="font-size:11px;padding:5px 12px;flex:1;border:2px solid #252a32">Name</button>' +
            '<button class="e123-tbtn" id="ce-sb-xp" style="font-size:11px;padding:5px 12px;flex:1;border:2px solid #252a32">XP</button>' +
            '</div>' +
            '</div>' +
            '<div id="ce-progress-extra" style="display:none;margin-top:6px">' +
            '<label style="font-size:11px;color:#888">Fill %</label>' +
            '<input type="range" id="ce-progress-fill" min="0" max="100" value="65" style="width:100%;margin-bottom:6px">' +
            '<label style="font-size:11px;color:#888">Fill color</label>' +
            '<input type="color" id="ce-fill-picker" style="width:100%;height:30px;background:transparent;border:1px solid #333;border-radius:4px;padding:2px;margin-bottom:4px;cursor:pointer">' +
            '</div>' +
            '</div>' +
            '<div id="ce-delete-hint" style="margin-top:6px;display:none">' +
            '<div style="font-size:11px;color:#555">Press <b>Del</b> to remove selected</div>' +
            '</div>' +
            '</div>' +
            '<div style="flex:1;display:flex;flex-direction:column;overflow:hidden">' +
            '<div style="padding:10px 14px;background:#1e232a;border-bottom:1px solid #252a32;display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-size:13px;font-weight:600;color:#ddd">Clan UI Preview</span>' +
            '<div style="display:flex;gap:6px">' +
            '<button class="e123-tbtn" id="ce-export" style="font-size:11px;padding:6px 10px">\u{1F4E4} Export</button>' +
            '<button class="e123-tbtn" id="ce-save" style="font-size:11px;padding:6px 10px">Save</button>' +
            '<button class="e123-tbtn" id="ce-back" style="font-size:11px;padding:6px 10px">\u2190 Back</button>' +
            '</div></div>' +
            '<div id="ce-canvas-host" style="flex:1;background:#14181e;position:relative;overflow:hidden"></div>' +
            '</div>';
        c.innerHTML = html;

        var host = document.getElementById('ce-canvas-host');
        this._clanHostW = host.clientWidth || 800;
        this._clanHostH = host.clientHeight || 600;
        this._clanDpr = window.devicePixelRatio || 1;
        this._clanCanvas = document.createElement('canvas');
        this._clanCanvas.width = this._clanHostW * this._clanDpr;
        this._clanCanvas.height = this._clanHostH * this._clanDpr;
        this._clanCanvas.style.width = this._clanHostW + 'px';
        this._clanCanvas.style.height = this._clanHostH + 'px';
        this._clanCtx = this._clanCanvas.getContext('2d');
        host.appendChild(this._clanCanvas);

        this._clanElements = this._loadClanLayout();
        this._clanSortBy = 'name';
        this._clanSelected = null;
        this._clanDragMode = null;
        this._clanDragStart = null;
        this._clanDragElm = null;
        this._clanDragHandleType = null;
        this._clanImages = {};
        var self = this;
        this._clanElements.forEach(function (el) {
            if (el.type === 'image' && el.imageData) {
                var img = new Image();
                img.onload = function () { self._clanImages[el.imageData] = img; };
                img.src = el.imageData;
            }
        });

        this._wireClanEditor();
        this._clanLoop = this._clanLoop.bind(this);
        requestAnimationFrame(this._clanLoop);
    },

    _clanLoop: function () {
        if (this._mode !== 'clan') return;
        var ctx = this._clanCtx;
        var dpr = this._clanDpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var w = this._clanHostW;
        var h = this._clanHostH;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#14181e';
        ctx.fillRect(0, 0, w, h);
        var grid = 30;
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (var x = 0; x <= w; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
        for (var y = 0; y <= h; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        var self = this;
        this._clanElements.forEach(function (el) { if (el.type === 'image') self._drawClanElement(el); });
        this._clanElements.forEach(function (el) { if (el.type !== 'image') self._drawClanElement(el); });
        requestAnimationFrame(this._clanLoop);
    },

    _drawClanElement: function (el) {
        var ctx = this._clanCtx;
        ctx.save();
        var dpr = this._clanDpr;
        var hcol = el.borderColor || 'rgba(255,200,50,0.5)';
        var col = el.color || '#ffffff';
        var txtCol = el.placeholderColor || col;
        var bw = 2;
        var fs = (el.fontSize || 14) * dpr;
        var baseFont = fs + 'px Segoe UI';
        var boldFont = 'bold ' + fs + 'px Segoe UI';
        var sf = el.showFrame !== false;

        var drawFrame = function () {
            if (!sf) return;
            ctx.setLineDash([6 * dpr, 4 * dpr]);
            ctx.strokeStyle = hcol;
            ctx.lineWidth = bw * dpr;
            ctx.strokeRect(el.x, el.y, el.w, el.h);
            ctx.setLineDash([]);
        };

        if (el.type === 'badge') {
            var r = Math.min(el.w, el.h) / 2;
            var cx = el.x + el.w / 2, cy = el.y + el.h / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = hcol;
            ctx.lineWidth = bw * dpr;
            ctx.stroke();
            ctx.fillStyle = txtCol;
            ctx.font = boldFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(el.label || 'Badge', cx, cy);

        } else if (el.type === 'chat' || el.type === 'chat-body') {
            drawFrame();
            ctx.font = baseFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            var rawMsgs = el.lines || [{name:'Commander', xp:2500, rank:'OWNER', msg:'Hello!', owner:true}];
            var msgs = (rawMsgs.length && typeof rawMsgs[0] === 'string') ? rawMsgs.map(function(s){
                var match = s.match(/^(.+?):\s*(.*)/);
                if (match) return {name:match[1], msg:match[2], xp:Math.round(Math.random()*2000), rank:'', owner:false};
                return {name:s, msg:'', xp:Math.round(Math.random()*2000), rank:'', owner:false};
            }) : rawMsgs;
            for (var ci = 0; ci < msgs.length; ci++) {
                var m = msgs[ci];
                var entryH = fs * 2 + 8;
                var ly = el.y + 10 + ci * entryH;
                if (ly + entryH < el.y + el.h) {
                    ctx.fillStyle = m.owner ? '#ff4444' : txtCol;
                    ctx.globalAlpha = ci === 0 ? 1 : 0.5;
                    var rankStr = (m.rank && m.rank !== '-') ? '[' + m.rank + '] ' : '';
                    var line = rankStr + m.name + ' (' + m.xp + ')';
                    ctx.fillText(line, el.x + 10, ly);
                    if (m.msg) {
                        ctx.fillText(': ' + m.msg, el.x + 10, ly + fs + 6);
                    }
                }
            }
            ctx.globalAlpha = 1;

        } else if (el.type === 'chat-input') {
            ctx.setLineDash(sf ? [4 * dpr, 3 * dpr] : []);
            ctx.strokeStyle = hcol;
            ctx.lineWidth = bw * dpr;
            ctx.strokeRect(el.x, el.y, el.w, el.h);
            ctx.setLineDash([]);
            ctx.fillStyle = txtCol;
            ctx.globalAlpha = 0.3;
            ctx.font = baseFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            var ph = el.label || 'Type a message...';
            ctx.fillText(ph, el.x + 12, el.y + el.h / 2);
            ctx.globalAlpha = 1;
            var blink = Math.floor(Date.now() / 530) % 2;
            if (blink) {
                ctx.fillStyle = txtCol;
                ctx.fillRect(el.x + 12 + ctx.measureText(ph).width + 3, el.y + el.h * 0.2, 2 * dpr, el.h * 0.6);
            }

        } else if (el.type === 'chat-send') {
            ctx.setLineDash(sf ? [4 * dpr, 4 * dpr] : []);
            ctx.strokeStyle = hcol;
            ctx.lineWidth = bw * dpr;
            ctx.strokeRect(el.x, el.y, el.w, el.h);
            ctx.setLineDash([]);
            ctx.fillStyle = txtCol;
            ctx.font = boldFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(el.label || 'Send', el.x + el.w / 2, el.y + el.h / 2);

        } else if (el.type === 'member') {
            drawFrame();
            ctx.font = baseFont;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            var rawM = el.lines || [{name:'Commander', xp:2500, rank:'OWNER'}, {name:'Captain', xp:1800}, {name:'Recruit', xp:500}];
            var items = (rawM.length && typeof rawM[0] === 'string') ? rawM.map(function(s,i){ return {name:s, xp:Math.round((rawM.length-i)*500+Math.random()*200)}; }) : rawM.slice();
            var sortBy = this._clanSortBy || 'name';
            if (sortBy === 'xp') { items.sort(function(a,b){ return b.xp - a.xp; }); }
            else { items.sort(function(a,b){ return a.name.localeCompare(b.name); }); }
            var maxP = el.maxPlayers || 20;
            for (var mi = 0; mi < Math.min(items.length, maxP); mi++) {
                var my = el.y + 10 + mi * (fs + 14);
                if (my + fs + 6 < el.y + el.h) {
                    var it = items[mi];
                    ctx.fillStyle = it.owner ? '#ff4444' : txtCol;
                    var rStr = (it.rank && it.rank !== '-') ? '[' + it.rank + '] ' : '';
                    var disp = rStr + it.name + ' (' + it.xp + ')';
                    ctx.globalAlpha = Math.max(0.3, 0.8 - mi * 0.04);
                    ctx.fillText(disp, el.x + 10, my);
                }
            }
            ctx.globalAlpha = 1;

        } else if (el.type === 'progress-bar') {
            ctx.strokeStyle = hcol;
            ctx.lineWidth = bw * dpr;
            ctx.strokeRect(el.x, el.y, el.w, el.h);
            var pct = Math.max(0, Math.min(100, el.progress || 50));
            var fillW = (el.w - 4) * (pct / 100);
            var fillCol = el.fillColor || '#ffb12b';
            ctx.fillStyle = fillCol;
            ctx.fillRect(el.x + 2, el.y + 2, fillW, el.h - 4);
            ctx.fillStyle = txtCol;
            ctx.font = boldFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(Math.round(pct) + '%', el.x + el.w / 2, el.y + el.h / 2);

        } else if (el.type === 'xp-counter') {
            drawFrame();
            ctx.fillStyle = txtCol;
            ctx.font = 'bold ' + ((el.fontSize || 28) * dpr) + 'px Segoe UI';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            var val = el.value || '5';
            ctx.fillText(val, el.x + el.w / 2, el.y + el.h * 0.4);
            ctx.globalAlpha = 0.55;
            ctx.font = ((el.fontSize || 14) * dpr) + 'px Segoe UI';
            ctx.fillText(el.label || 'collected', el.x + el.w / 2, el.y + el.h * 0.75);
            ctx.globalAlpha = 1;

        } else if (el.type === 'clan-count') {
            drawFrame();
            ctx.fillStyle = txtCol;
            ctx.font = boldFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            var cnt = el.value || '0';
            ctx.fillText(cnt, el.x + el.w / 2, el.y + el.h / 2);

        } else if (el.type === 'sort-buttons') {
            drawFrame();
            var curSort = this._clanSortBy || 'name';
            var btnPad = 20, bh = fs + 10;
            var totalW = Math.max(el.w, btnPad + 2);
            var btnW = (totalW - btnPad) / 2;
            var by = el.y + (el.h - bh) / 2;
            ['Name','XP'].forEach(function(label, idx) {
                var bx = el.x + (idx === 0 ? 10 : 10 + btnW + 4);
                var isActive = (label.toLowerCase() === curSort);
                ctx.fillStyle = isActive ? '#ffb12b' : '#252a32';
                var radius = 4 * dpr;
                var bw3 = btnW, bh3 = bh;
                ctx.beginPath();
                ctx.moveTo(bx + radius, by);
                ctx.lineTo(bx + bw3 - radius, by);
                ctx.quadraticCurveTo(bx + bw3, by, bx + bw3, by + radius);
                ctx.lineTo(bx + bw3, by + bh3 - radius);
                ctx.quadraticCurveTo(bx + bw3, by + bh3, bx + bw3 - radius, by + bh3);
                ctx.lineTo(bx + radius, by + bh3);
                ctx.quadraticCurveTo(bx, by + bh3, bx, by + bh3 - radius);
                ctx.lineTo(bx, by + radius);
                ctx.quadraticCurveTo(bx, by, bx + radius, by);
                ctx.closePath();
                ctx.fill();
                ctx.fillStyle = isActive ? '#14181e' : '#aaa';
                ctx.font = 'bold ' + (fs * 0.7) + 'px Segoe UI';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx + bw3 / 2, by + bh3 / 2);
            });

        } else if (el.type === 'clan-name') {
            drawFrame();
            ctx.fillStyle = txtCol;
            ctx.font = boldFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(el.label || '[Clan Name]', el.x + el.w / 2, el.y + el.h / 2);

        } else if (el.type === 'time-left') {
            drawFrame();
            ctx.fillStyle = txtCol;
            ctx.font = baseFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            var now = new Date();
            var dayOfWeek = now.getDay();
            var daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
            var nextMonday = new Date(now);
            nextMonday.setDate(now.getDate() + daysUntilMonday);
            nextMonday.setHours(0, 0, 0, 0);
            var msUntilMonday = nextMonday - now;
            var days = Math.floor(msUntilMonday / 86400000);
            var hrs = Math.floor((msUntilMonday % 86400000) / 3600000);
            var mins = Math.floor((msUntilMonday % 3600000) / 60000);
            ctx.fillText(days + 'd ' + hrs + 'h ' + mins + 'm', el.x + el.w / 2, el.y + el.h / 2);

        } else if (el.type === 'text') {
            drawFrame();
            ctx.fillStyle = txtCol;
            var style = '';
            if (el.bold) style += 'bold ';
            if (el.italic) style += 'italic ';
            ctx.font = style + fs + 'px Segoe UI';
            ctx.textAlign = el.align || 'center';
            ctx.textBaseline = 'middle';
            var tx = el.x;
            if (ctx.textAlign === 'center') tx = el.x + el.w / 2;
            else if (ctx.textAlign === 'right') tx = el.x + el.w;
            ctx.fillText(el.label || 'Text', tx, el.y + el.h / 2);

        } else if (el.type === 'image') {
            if (el.imageData && this._clanImages[el.imageData]) {
                var img = this._clanImages[el.imageData];
                ctx.drawImage(img, el.x, el.y, el.w, el.h);
                if (sf) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
                    ctx.lineWidth = 1 * dpr;
                    ctx.strokeRect(el.x, el.y, el.w, el.h);
                }
            } else {
                drawFrame();
                ctx.fillStyle = txtCol;
                ctx.font = (13 * dpr) + 'px Segoe UI';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(el.label || 'Image', el.x + el.w / 2, el.y + el.h / 2);
            }
        }

        if (el === this._clanSelected) {
            ctx.strokeStyle = '#ffb12b';
            ctx.lineWidth = bw * dpr;
            ctx.setLineDash([4 * dpr, 4 * dpr]);
            ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4);
            ctx.setLineDash([]);
            var hs = 8 * dpr;
            ctx.fillStyle = '#ffb12b';
            var handles = [
                { x: el.x, y: el.y },
                { x: el.x + el.w, y: el.y },
                { x: el.x, y: el.y + el.h },
                { x: el.x + el.w, y: el.y + el.h },
                { x: el.x + el.w / 2, y: el.y },
                { x: el.x + el.w / 2, y: el.y + el.h },
                { x: el.x, y: el.y + el.h / 2 },
                { x: el.x + el.w, y: el.y + el.h / 2 }
            ];
            handles.forEach(function (h) {
                ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
            });
        }
        ctx.restore();
    },

    _wireClanEditor: function () {
        var canvas = this._clanCanvas;
        var self = this;

        var getPos = function (e) {
            var r = canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        };

        var getHandleType = function (pos, el) {
            if (!el) return null;
            var hs = 12;
            var handles = [
                { x: el.x, y: el.y, type: 'nw' },
                { x: el.x + el.w, y: el.y, type: 'ne' },
                { x: el.x, y: el.y + el.h, type: 'sw' },
                { x: el.x + el.w, y: el.y + el.h, type: 'se' },
                { x: el.x + el.w / 2, y: el.y, type: 'n' },
                { x: el.x + el.w / 2, y: el.y + el.h, type: 's' },
                { x: el.x, y: el.y + el.h / 2, type: 'w' },
                { x: el.x + el.w, y: el.y + el.h / 2, type: 'e' }
            ];
            for (var i = 0; i < handles.length; i++) {
                var h = handles[i];
                if (pos.x >= h.x - hs / 2 && pos.x <= h.x + hs / 2 && pos.y >= h.y - hs / 2 && pos.y <= h.y + hs / 2) {
                    return h.type;
                }
            }
            return null;
        };

        var updateProps = function () {
            var el = self._clanSelected;
            var propsDiv = document.getElementById('ce-props');
            var delHint = document.getElementById('ce-delete-hint');
            var progExtra = document.getElementById('ce-progress-extra');
            var memberExtra = document.getElementById('ce-member-extra');
            var sortbuttonsExtra = document.getElementById('ce-sortbuttons-extra');
            var textExtra = document.getElementById('ce-text-extra');
            if (!el || el.type === 'image') {
                propsDiv.style.display = 'none';
                if (progExtra) progExtra.style.display = 'none';
                if (memberExtra) memberExtra.style.display = 'none';
                if (sortbuttonsExtra) sortbuttonsExtra.style.display = 'none';
                if (textExtra) textExtra.style.display = 'none';
                if (delHint) delHint.style.display = el ? 'block' : 'none';
                return;
            }
            propsDiv.style.display = 'block';
            if (delHint) delHint.style.display = 'block';

            var colorPicker = document.getElementById('ce-color-picker');
            var borderPicker = document.getElementById('ce-border-picker');
            var borderOp = document.getElementById('ce-border-opacity');
            var labelInput = document.getElementById('ce-label-input');
            var fillPicker = document.getElementById('ce-fill-picker');
            var fillSlider = document.getElementById('ce-progress-fill');

            colorPicker.value = rgbToHex(el.color || '#ffffff');
            var curBorder = el.borderColor || 'rgba(255,200,50,0.5)';
            var borderHex = '#ffc832';
            var borderOpacity = 50;
            var m = curBorder.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
            if (m) {
                borderHex = rgbToHex('rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')');
                borderOpacity = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 100) : 100;
            }
            borderPicker.value = borderHex;
            borderOp.value = borderOpacity;
            labelInput.value = el.label || '';

            if (el.type === 'progress-bar') {
                if (progExtra) { progExtra.style.display = 'block';
                fillSlider.value = el.progress || 50;
                fillPicker.value = rgbToHex(el.fillColor || '#ffb12b');
                fillSlider.oninput = function () { el.progress = parseInt(fillSlider.value); self._saveClanLayout(); };
                fillPicker.onchange = function () { el.fillColor = fillPicker.value; self._saveClanLayout(); }; }
            } else if (progExtra) { progExtra.style.display = 'none'; }

            var fsSlider = document.getElementById('ce-font-size');
            if (fsSlider) { fsSlider.value = el.fontSize || 14;
            fsSlider.oninput = function(){ el.fontSize = parseInt(fsSlider.value); self._saveClanLayout(); }; }

            var frameCheck = document.getElementById('ce-show-frame');
            if (frameCheck) { frameCheck.checked = el.showFrame !== false;
            frameCheck.onchange = function(){ el.showFrame = frameCheck.checked; self._saveClanLayout(); }; }

            if (el.type === 'member') {
                if (memberExtra) { memberExtra.style.display = 'block';
                var sd = document.getElementById('ce-sort-display');
                if (sd) sd.textContent = self._clanSortBy === 'xp' ? 'XP' : 'Name'; }
            } else if (memberExtra) { memberExtra.style.display = 'none'; }

            if (el.type === 'sort-buttons') {
                if (sortbuttonsExtra) { sortbuttonsExtra.style.display = 'block';
                var sbn = document.getElementById('ce-sb-name');
                var sbx = document.getElementById('ce-sb-xp');
                var cur = self._clanSortBy || 'name';
                if (sbn) { sbn.style.borderColor = cur !== 'xp' ? '#ffb12b' : '#252a32';
                sbn.onclick = function(){ self._clanSortBy = 'name'; self._saveClanLayout(); updateProps(); }; }
                if (sbx) { sbx.style.borderColor = cur === 'xp' ? '#ffb12b' : '#252a32';
                sbx.onclick = function(){ self._clanSortBy = 'xp'; self._saveClanLayout(); updateProps(); }; } }
            } else if (sortbuttonsExtra) { sortbuttonsExtra.style.display = 'none'; }

            if (el.type === 'text') {
                if (textExtra) { textExtra.style.display = 'block';
                var tb = document.getElementById('ce-text-bold');
                var ti = document.getElementById('ce-text-italic');
                if (tb) { tb.style.borderColor = el.bold ? '#ffb12b' : '#252a32';
                tb.onclick = function(){ el.bold = !el.bold; self._saveClanLayout(); updateProps(); }; }
                if (ti) { ti.style.borderColor = el.italic ? '#ffb12b' : '#252a32';
                ti.onclick = function(){ el.italic = !el.italic; self._saveClanLayout(); updateProps(); }; } }
            } else if (textExtra) { textExtra.style.display = 'none'; }

            colorPicker.onchange = function () {
                el.color = colorPicker.value;
                el.placeholderColor = colorPicker.value;
                self._rebuildBorderColor(el, borderPicker.value, borderOp.value);
                self._saveClanLayout();
            };
            borderPicker.onchange = function () {
                self._rebuildBorderColor(el, borderPicker.value, borderOp.value);
                self._saveClanLayout();
            };
            borderOp.oninput = function () {
                self._rebuildBorderColor(el, borderPicker.value, borderOp.value);
                self._saveClanLayout();
            };
            labelInput.oninput = function () {
                el.label = labelInput.value;
                self._saveClanLayout();
            };
        };

        var rgbToHex = function (rgb) {
            var d = document.createElement('canvas').getContext('2d');
            d.fillStyle = rgb;
            return d.fillStyle;
        };

        canvas.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            var pos = getPos(e);
            var hit = self._clanHitTest(pos.x, pos.y);
            if (hit) {
                self._clanSelected = hit;
                self._clanDragMode = 'move';
                self._clanDragStart = { x: pos.x - hit.x, y: pos.y - hit.y };
                self._clanDragElm = hit;
                self._clanDragHandleType = null;
                var htype = getHandleType(pos, hit);
                if (htype) {
                    self._clanDragMode = 'resize';
                    self._clanDragHandleType = htype;
                    self._clanDragStart = { x: pos.x, y: pos.y, ow: hit.w, oh: hit.h, ox: hit.x, oy: hit.y };
                }
                updateProps();
            } else {
                self._clanSelected = null;
                self._clanDragMode = null;
                self._clanDragHandleType = null;
                updateProps();
            }
        });

        canvas.addEventListener('mousemove', function (e) {
            if (!self._clanDragMode || !self._clanDragElm) return;
            var pos = getPos(e);
            var el = self._clanDragElm;
            if (self._clanDragMode === 'move') {
                el.x = Math.max(0, pos.x - self._clanDragStart.x);
                el.y = Math.max(0, pos.y - self._clanDragStart.y);
            } else if (self._clanDragMode === 'resize') {
                var dx = pos.x - self._clanDragStart.x;
                var dy = pos.y - self._clanDragStart.y;
                var min = 20;
                var ht = self._clanDragHandleType;
                if (ht === 'se') { el.w = Math.max(min, self._clanDragStart.ow + dx); el.h = Math.max(min, self._clanDragStart.oh + dy); }
                else if (ht === 'sw') { el.w = Math.max(min, self._clanDragStart.ow - dx); el.h = Math.max(min, self._clanDragStart.oh + dy); el.x = self._clanDragStart.ox + (self._clanDragStart.ow - el.w); }
                else if (ht === 'ne') { el.w = Math.max(min, self._clanDragStart.ow + dx); el.h = Math.max(min, self._clanDragStart.oh - dy); el.y = self._clanDragStart.oy + (self._clanDragStart.oh - el.h); }
                else if (ht === 'nw') { el.w = Math.max(min, self._clanDragStart.ow - dx); el.h = Math.max(min, self._clanDragStart.oh - dy); el.x = self._clanDragStart.ox + (self._clanDragStart.ow - el.w); el.y = self._clanDragStart.oy + (self._clanDragStart.oh - el.h); }
                else if (ht === 'e') { el.w = Math.max(min, self._clanDragStart.ow + dx); }
                else if (ht === 'w') { el.w = Math.max(min, self._clanDragStart.ow - dx); el.x = self._clanDragStart.ox + (self._clanDragStart.ow - el.w); }
                else if (ht === 's') { el.h = Math.max(min, self._clanDragStart.oh + dy); }
                else if (ht === 'n') { el.h = Math.max(min, self._clanDragStart.oh - dy); el.y = self._clanDragStart.oy + (self._clanDragStart.oh - el.h); }
                if (el.type === 'badge') { var sz = Math.max(min, (el.w + el.h) / 2); el.w = sz; el.h = sz; }
            }
        });

        window.addEventListener('mouseup', function () {
            if (self._clanDragElm) self._saveClanLayout();
            self._clanDragMode = null;
            self._clanDragElm = null;
            self._clanDragHandleType = null;
        });

        document.getElementById('ce-add-badge').onclick = function () {
            self._clanElements.push({ type:'badge', x:100, y:100, w:60, h:60, label:'Badge', color:'#ffb12b', borderColor:'rgba(255,200,50,0.5)' });
            self._saveClanLayout(); Editor123.toast('Badge added');
        };
        document.getElementById('ce-add-chat-body').onclick = function () {
            self._clanElements.push({ type:'chat-body', x:80, y:160, w:300, h:200, label:'Chat', color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', lines:[{name:'Commander', xp:2500, rank:'OWNER', msg:'Hello everyone!', owner:true},{name:'Captain', xp:1800, msg:'Good game!'}] });
            self._saveClanLayout(); Editor123.toast('Chat body added');
        };
        document.getElementById('ce-add-chat-input').onclick = function () {
            self._clanElements.push({ type:'chat-input', x:80, y:370, w:300, h:44, label:'Type a message...', color:'#ffffff', borderColor:'rgba(255,200,50,0.4)' });
            self._saveClanLayout(); Editor123.toast('Chat input added');
        };
        document.getElementById('ce-add-chat-send').onclick = function () {
            self._clanElements.push({ type:'chat-send', x:390, y:370, w:70, h:44, label:'Send', color:'#ffffff', borderColor:'rgba(255,200,50,0.4)' });
            self._saveClanLayout(); Editor123.toast('Send button added');
        };
        document.getElementById('ce-add-member').onclick = function () {
            self._clanElements.push({ type:'member', x:440, y:160, w:180, h:240, label:'Members', color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', lines:[{name:'Commander', xp:2500, rank:'OWNER'},{name:'Captain', xp:1800},{name:'Recruit', xp:500}], maxPlayers:20 });
            self._saveClanLayout(); Editor123.toast('Member list added');
        };
        document.getElementById('ce-add-progress').onclick = function () {
            self._clanElements.push({ type:'progress-bar', x:80, y:80, w:300, h:36, color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', fillColor:'#ffb12b', progress:50 });
            self._saveClanLayout(); Editor123.toast('XP bar added');
        };
        document.getElementById('ce-add-xpcounter').onclick = function () {
            self._clanElements.push({ type:'xp-counter', x:420, y:60, w:120, h:70, label:'collected', value:'5', color:'#ffffff' });
            self._saveClanLayout(); Editor123.toast('XP counter added');
        };
        document.getElementById('ce-add-clancount').onclick = function () {
            self._clanElements.push({ type:'clan-count', x:80, y:360, w:200, h:44, label:'Members', value:'0', max:20, color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', fontSize:14 });
            self._saveClanLayout(); Editor123.toast('Clan count added');
        };
        document.getElementById('ce-add-sortbuttons').onclick = function () {
            self._clanElements.push({ type:'sort-buttons', x:80, y:410, w:200, h:32, color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', fontSize:14 });
            self._saveClanLayout(); Editor123.toast('Sort buttons added');
        };
        document.getElementById('ce-add-clan-name').onclick = function () {
            self._clanElements.push({ type:'clan-name', x:80, y:460, w:200, h:36, label:'[Clan Name]', color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', fontSize:16 });
            self._saveClanLayout(); Editor123.toast('Clan name added');
        };
        document.getElementById('ce-add-time-left').onclick = function () {
            self._clanElements.push({ type:'time-left', x:80, y:510, w:200, h:36, label:'[Time Left]', color:'#ffffff', borderColor:'rgba(255,200,50,0.4)', fontSize:14 });
            self._saveClanLayout(); Editor123.toast('Time left added');
        };
        document.getElementById('ce-add-text').onclick = function () {
            self._clanElements.push({ type:'text', x:80, y:260, w:200, h:44, label:'Your text', color:'#ffffff', fontSize:16, bold:false, italic:false, align:'center' });
            self._saveClanLayout(); Editor123.toast('Text added');
        };
        document.getElementById('ce-add-image').onclick = function () {
            document.getElementById('ce-file-input').click();
        };
        document.getElementById('ce-file-input').onchange = function (e) {
            var file = e.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (ev) {
                var dataUrl = ev.target.result;
                var img = new Image();
                img.onload = function () {
                    var w = Math.min(img.width, 200);
                    var h = Math.min(img.height, 200);
                    self._clanImages[dataUrl] = img;
                    self._clanElements.push({ type:'image', x:80, y:300, w:w, h:h, imageData:dataUrl, label:'Image' });
                    self._saveClanLayout(); Editor123.toast('Image imported');
                };
                img.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        };

        document.getElementById('ce-save').onclick = function () {
            self._saveClanLayout();
            Editor123.toast('Layout saved to localStorage');
        };

        document.getElementById('ce-export').onclick = function () {
            var code = '// Clan UI Layout — paste into your game\nvar clanLayout = ' + JSON.stringify(self._clanElements, null, 2) + ';\n';
            try { navigator.clipboard.writeText(code).then(function () { Editor123.toast('Script copied to clipboard!'); }).catch(function () { fallbackCopy(code); }); }
            catch (e) { fallbackCopy(code); }
            function fallbackCopy(t) { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); Editor123.toast('Script copied!'); }
        };

        // "Install to game": download the layout as js/clan-default-layout.js
        // so the design works on ANY origin (local file, deployed site, etc.)
        var installBtn = document.createElement('button');
        installBtn.className = 'e123-tbtn';
        installBtn.id = 'ce-install';
        installBtn.style.cssText = 'font-size:11px;padding:6px 10px;background:#27ae60;color:#fff';
        installBtn.textContent = '\u2B07\uFE0F Install to game';
        installBtn.onclick = function () {
            var code =
                '// Clan UI default layout — embedded in the game so it works on ANY origin\n' +
                '// (local file, deployed site, any browser). Loaded when no layout is saved\n' +
                '// in localStorage yet.\n' +
                'var CLAN_DEFAULT_LAYOUT = ' + JSON.stringify(self._clanElements, null, 2) + ';\n';
            var blob = new Blob([code], { type: 'text/javascript' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'clan-default-layout.js';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
            Editor123.toast('Downloaded! Save it as js/clan-default-layout.js in your game folder.');
        };
        document.getElementById('ce-export').parentElement.appendChild(installBtn);

        document.getElementById('ce-back').onclick = function () { Editor123._renderLauncher(); };

        window.addEventListener('keydown', function (e) {
            if (Editor123._mode !== 'clan') return;
            if (e.code === 'Delete' || e.code === 'Backspace') {
                if (Editor123._clanSelected) {
                    var sel = Editor123._clanSelected;
                    if (sel.type === 'image' && sel.imageData && Editor123._clanImages) {
                        delete Editor123._clanImages[sel.imageData];
                    }
                    Editor123._clanElements = Editor123._clanElements.filter(function (el) { return el !== sel; });
                    Editor123._clanSelected = null;
                    Editor123._saveClanLayout();
                    updateProps();
                }
            }
            if (e.code === 'Escape') {
                Editor123._clanSelected = null;
                updateProps();
            }
        });
    },

    _rebuildBorderColor: function (el, hex, opacity) {
        var o = Math.round(parseInt(opacity)) / 100;
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        el.borderColor = 'rgba(' + r + ',' + g + ',' + b + ',' + o + ')';
    },

    _clanHitTest: function (x, y) {
        for (var i = this._clanElements.length - 1; i >= 0; i--) {
            var el = this._clanElements[i];
            if (x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h) return el;
        }
        return null;
    },

    _saveClanLayout: function () {
        try {
            var meta = { type:'_meta', sortBy: this._clanSortBy || 'name', version: (typeof CLAN_LAYOUT_VERSION !== 'undefined' ? CLAN_LAYOUT_VERSION : 1) };
            var data = [meta].concat(this._clanElements.map(function (el) {
                var copy = {};
                for (var k in el) {
                    if (k === 'imageData' && el.type !== 'image') continue;
                    copy[k] = el[k];
                }
                return copy;
            }));
            var json = JSON.stringify(data);
            try {
                localStorage.setItem('tankparty_clan_layout', json);
            } catch (e1) {
                // Quota exceeded (usually a big background image):
                // store each image under its own key and reference it by key in the layout
                var stripped = data.map(function (el, i) {
                    if (el.type === 'image' && el.imageData) {
                        try {
                            localStorage.setItem('tankparty_clan_img_' + i, el.imageData);
                            var c = {};
                            for (var k in el) { if (k !== 'imageData') c[k] = el[k]; }
                            c.imageData = 'tankparty_clan_img_' + i;
                            return c;
                        } catch (e2) {
                            var c2 = {};
                            for (var k2 in el) { if (k2 !== 'imageData') c2[k2] = el[k2]; }
                            return c2;
                        }
                    }
                    return el;
                });
                localStorage.setItem('tankparty_clan_layout', JSON.stringify(stripped));
                console.warn('Clan layout saved: images stored separately (localStorage quota).');
            }
        } catch (e) {
            console.error('Save clan layout failed:', e);
        }
    },

    _loadClanLayout: function () {
        try {
            var data = JSON.parse(localStorage.getItem('tankparty_clan_layout'));
            var els;
            if (!data) {
                // Fall back to the embedded default layout so the editor starts
                // from the installed design instead of an empty canvas
                if (typeof CLAN_DEFAULT_LAYOUT !== 'undefined' && CLAN_DEFAULT_LAYOUT && CLAN_DEFAULT_LAYOUT.length) {
                    return JSON.parse(JSON.stringify(CLAN_DEFAULT_LAYOUT));
                }
                return [];
            }
            if (data.length && data[0].type === '_meta') {
                this._clanSortBy = data[0].sortBy || 'name';
                els = data.slice(1);
            } else {
                els = data;
            }
            // Saved design is older than the installed default: start from the updated default
            var meta0 = (data.length && data[0].type === '_meta') ? data[0] : null;
            if (typeof CLAN_LAYOUT_VERSION !== 'undefined' && (!meta0 || (meta0.version || 0) < CLAN_LAYOUT_VERSION)) {
                if (typeof CLAN_DEFAULT_LAYOUT !== 'undefined' && CLAN_DEFAULT_LAYOUT && CLAN_DEFAULT_LAYOUT.length) {
                    return JSON.parse(JSON.stringify(CLAN_DEFAULT_LAYOUT));
                }
            }
            // Resolve separately-stored images back into data URLs
            return els.map(function (el) {
                if (el && el.type === 'image' && typeof el.imageData === 'string' && el.imageData.indexOf('tankparty_clan_img_') === 0) {
                    try {
                        var d = localStorage.getItem(el.imageData);
                        if (d) {
                            var c = {};
                            for (var k in el) { if (k !== 'imageData') c[k] = el[k]; }
                            c.imageData = d;
                            return c;
                        }
                    } catch (e) {}
                }
                return el;
            });
        } catch (e) {
            return [];
        }
    },

    /* ═══════════════════════════
       COLLECTION EDITOR
       ═══════════════════════════ */

    _renderCollectionEditor: function () {
        this._mode = 'collections';
        var c = document.getElementById('editor123-content');

        var allTanks = [];
        if (typeof TANKS === 'object') {
            Object.keys(TANKS).forEach(function (k) {
                if (k !== 'tankdisplay' && k !== 'dummy' && TANKS[k] && TANKS[k].name) {
                    allTanks.push({ id: k, name: TANKS[k].name, color: TANKS[k].color, turretColor: TANKS[k].turretColor });
                }
            });
            allTanks.sort(function (a, b) { return a.name.localeCompare(b.name); });
        }

        // Deep-clone so edits don't affect live data until Save
        var collections = (typeof Menu !== 'undefined' && Menu._COLLECTIONS)
            ? JSON.parse(JSON.stringify(Menu._COLLECTIONS)) : [];

        this._colEditDraft = collections;

        var html = '<div style="max-width:900px;margin:0 auto;padding:20px">';
        html += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:28px">';
        html += '<div id="e123-col-back" style="padding:8px 16px;background:#2a2f36;border-radius:8px;cursor:pointer;color:#888;font-size:13px">← Back</div>';
        html += '<h2 style="color:#ffb12b;margin:0;font-size:20px">Collection Editor</h2>';
        html += '<div style="flex:1"></div>';
        html += '<div id="e123-col-save" style="padding:8px 20px;background:#ffb12b;border-radius:8px;cursor:pointer;color:#111;font-size:13px;font-weight:700">Save</div>';
        html += '</div>';

        collections.forEach(function (col, ci) {
            html += '<div style="margin-bottom:28px">';
            html += '<div style="color:#888;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px">Collection ' + col.id + '</div>';

            // Top row: 3 slots
            html += '<div style="display:flex;gap:12px;margin-bottom:8px">';
            for (var ti = 0; ti < 3; ti++) {
                html += Editor123._colSlotHtml(ci, ti, col.tanks[ti], allTanks);
            }
            html += '</div>';

            // Bottom row: 2 slots (left-aligned)
            html += '<div style="display:flex;gap:12px">';
            for (var ti = 3; ti < 5; ti++) {
                html += Editor123._colSlotHtml(ci, ti, col.tanks[ti], allTanks);
            }
            html += '</div>';

            html += '</div>';
        });

        html += '</div>';
        c.innerHTML = html;

        // Wire slot clicks
        c.querySelectorAll('.e123-col-slot').forEach(function (slot) {
            slot.onmouseover = function () { this.style.borderColor = '#ffb12b'; this.style.transform = 'translateY(-2px)'; };
            slot.onmouseout = function () { this.style.transform = ''; };
            slot.onclick = function (e) {
                if (e.target.classList.contains('e123-col-clear')) return;
                var ci = parseInt(this.dataset.col);
                var ti = parseInt(this.dataset.slot);
                Editor123._pickTankForSlot(ci, ti, allTanks);
            };
        });

        // Wire clear buttons
        c.querySelectorAll('.e123-col-clear').forEach(function (btn) {
            btn.onclick = function (e) {
                e.stopPropagation();
                var ci = parseInt(this.dataset.col);
                var ti = parseInt(this.dataset.slot);
                Editor123._colEditDraft[ci].tanks[ti] = null;
                Editor123._renderCollectionEditor();
            };
        });

        document.getElementById('e123-col-back').onclick = function () { Editor123._renderLauncher(); };
        document.getElementById('e123-col-save').onclick = function () { Editor123._saveCollections(); };
    },

    _colSlotHtml: function (ci, ti, tankId, allTanks) {
        var tDef = (tankId && typeof TANKS !== 'undefined' && TANKS[tankId]) ? TANKS[tankId] : null;
        var bodyColor = tDef ? '#' + tDef.color.toString(16).padStart(6, '0') : '';
        var turtColor = tDef ? '#' + tDef.turretColor.toString(16).padStart(6, '0') : '';
        var borderC = tDef ? 'rgba(255,177,43,0.6)' : '#333';
        var bgStyle = tDef
            ? 'background:rgba(0,0,0,0.4)'
            : 'background:rgba(0,0,0,0.25)';

        var h = '<div class="e123-col-slot" data-col="' + ci + '" data-slot="' + ti + '" style="width:150px;height:90px;border:2px solid ' + borderC + ';border-radius:14px;' + bgStyle + ';cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:.2s;position:relative;overflow:hidden">';

        if (tDef) {
            // Tank body preview
            h += '<div style="width:60px;height:28px;border-radius:6px;background:' + bodyColor + ';margin-bottom:5px"></div>';
            // Turret preview
            h += '<div style="width:30px;height:14px;border-radius:4px;background:' + turtColor + ';margin-bottom:4px"></div>';
            // Barrel
            h += '<div style="width:24px;height:5px;border-radius:3px;background:#2a2a2e;margin-bottom:4px"></div>';
            // Name
            h += '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.85);text-shadow:0 1px 4px rgba(0,0,0,.7)">' + tDef.name + '</div>';
            // Clear button
            h += '<div class="e123-col-clear" data-col="' + ci + '" data-slot="' + ti + '" style="position:absolute;top:4px;right:6px;font-size:10px;color:rgba(255,255,255,0.4);cursor:pointer" title="Remove">✕</div>';
        } else {
            h += '<div style="font-size:24px;color:#444">+</div>';
            h += '<div style="font-size:10px;color:#555;margin-top:4px">Empty</div>';
        }

        h += '</div>';
        return h;
    },

    _pickTankForSlot: function (ci, ti, allTanks) {
        var c = document.getElementById('editor123-content');
        var collections = this._colEditDraft || [];
        var currentId = collections[ci] ? collections[ci].tanks[ti] : null;

        var html = '<div style="max-width:900px;margin:0 auto;padding:20px">';
        html += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">';
        html += '<div id="e123-pick-back" style="padding:8px 16px;background:#2a2f36;border-radius:8px;cursor:pointer;color:#888;font-size:13px">← Back</div>';
        html += '<h2 style="color:#ffb12b;margin:0;font-size:18px">Pick Tank — Collection ' + collections[ci].id + ', Slot ' + (ti + 1) + '</h2>';
        html += '</div>';

        html += '<div style="display:flex;flex-wrap:wrap;gap:10px">';
        allTanks.forEach(function (t) {
            var bodyColor = '#' + t.color.toString(16).padStart(6, '0');
            var turtColor = '#' + t.turretColor.toString(16).padStart(6, '0');
            var selected = t.id === currentId;
            var borderC = selected ? '#4caf50' : '#333';
            html += '<div class="e123-pick-tank" data-tank="' + t.id + '" style="width:140px;padding:14px 10px;border:2px solid ' + borderC + ';border-radius:12px;background:rgba(255,255,255,0.04);cursor:pointer;text-align:center;transition:.2s">';
            html += '<div style="width:48px;height:22px;border-radius:5px;background:' + bodyColor + ';margin:0 auto 4px"></div>';
            html += '<div style="width:24px;height:11px;border-radius:3px;background:' + turtColor + ';margin:0 auto 4px"></div>';
            html += '<div style="width:18px;height:4px;border-radius:2px;background:#2a2a2e;margin:0 auto 8px"></div>';
            html += '<div style="font-size:12px;color:#ddd;font-weight:600">' + t.name + '</div>';
            if (selected) html += '<div style="font-size:10px;color:#4caf50;margin-top:4px">✓ Current</div>';
            html += '</div>';
        });
        html += '</div></div>';
        c.innerHTML = html;

        c.querySelectorAll('.e123-pick-tank').forEach(function (el) {
            el.onmouseover = function () { this.style.borderColor = '#ffb12b'; };
            el.onmouseout = function () {
                var tid = this.dataset.tank;
                var isCurrent = tid === currentId;
                this.style.borderColor = isCurrent ? '#4caf50' : '#333';
            };
            el.onclick = function () {
                var tankId = this.dataset.tank;
                Editor123._colEditDraft[ci].tanks[ti] = tankId;
                Editor123._renderCollectionEditor();
            };
        });

        document.getElementById('e123-pick-back').onclick = function () { Editor123._renderCollectionEditor(); };
    },

    _saveCollections: function () {
        if (!this._colEditDraft) {
            this.toast('No changes to save');
            return;
        }
        if (typeof Menu === 'undefined') {
            this.toast('Menu not loaded');
            return;
        }
        try {
            Menu._COLLECTIONS = this._colEditDraft;
            localStorage.setItem('tankparty_collections', JSON.stringify(this._colEditDraft));
            this.toast('Collections saved!');
        } catch (e) {
            this.toast('Save failed: ' + e.message);
        }
    },

};

