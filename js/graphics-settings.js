/* ============================================================
   graphics-settings.js — Ctrl+O in-battle graphics settings
   Full control over renderer, shadows, lighting, fog, PBR,
   textures, effects, and post-processing.
   ============================================================ */

const GraphicsSettings = (() => {
  let _game = null;
  let _overlay = null;
  let _open = false;
  let _values = {};

  const DEFAULTS_VERSION = 2;
  const DEFAULTS = {
    // Renderer
    pixelRatio: 1.5,
    toneMapping: 'none',
    exposure: 1.0,
    antialias: true,
    // Shadows
    shadowsEnabled: true,
    shadowMapSize: 2048,
    shadowBias: -0.001,
    shadowNormalBias: 0.0005,
    shadowColor: '#99aabb',
    // Lighting
    hemiIntensity: 1.0,
    hemiSkyColor: '#dde8f5',
    hemiGroundColor: '#9a9a80',
    sunIntensity: 1.8,
    sunColor: '#fff5e8',
    fillIntensity: 0.35,
    fillColor: '#d0e0f0',
    ambientIntensity: 0.2,
    ambientColor: '#b0b8c0',
    // Fog
    fogEnabled: true,
    fogType: 'linear',
    fogDensity: 0.015,
    fogColor: '#c8ddf0',
    fogNear: 350,
    fogFar: 500,
    // PBR
    metalnessMul: 1.0,
    roughnessMul: 1.0,
    envMapIntensity: 0.0,
    // Textures
    anisotropy: 8,
    // Effects
    particleDensity: 1.0,
    muzzleFx: true,
    screenShake: 100,
    // Post-processing (CSS filters)
    brightness: 1.0,
    contrast: 1.0,
    saturation: 1.0,
    hueRotate: 0,
    sepia: 0,
  };

  function init(game) {
    _game = game;
    _values = Object.assign({}, DEFAULTS);
    _loadSaved();
    _buildUI();
    _bindKeys();
  }

  function _loadSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem('graphicsSettings'));
      if (saved && saved._ver === DEFAULTS_VERSION) Object.assign(_values, saved);
    } catch (e) {}
  }

  function _save() {
    try {
      const data = Object.assign({_ver: DEFAULTS_VERSION}, _values);
      localStorage.setItem('graphicsSettings', JSON.stringify(data));
    } catch (e) {}
  }

  function _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        toggle();
      }
      if (_open && e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
  }

  function toggle() {
    if (_open) close(); else open();
  }

  function open() {
    if (!_overlay) return;
    _open = true;
    _overlay.classList.remove('hidden');
    _syncUI();
  }

  function close() {
    if (!_overlay) return;
    _open = false;
    _overlay.classList.add('hidden');
  }

  function isOpen() { return _open; }

  /* ---------- Apply all values to the renderer/scene ---------- */
  function applyAll() {
    if (!_game || !_game.renderer) return;
    if (_game._graphicsLocked) return;
    const r = _game.renderer;
    const s = _game.scene;
    const w = _game.world;

    // Renderer
    r.setPixelRatio(Math.min(window.devicePixelRatio, _values.pixelRatio));
    r.toneMapping = _toneMapConst(_values.toneMapping);
    r.toneMappingExposure = _values.exposure;

    // Shadows
    r.shadowMap.enabled = _values.shadowsEnabled;
    if (w && w.sunLight) {
      const sun = w.sunLight;
      const size = _values.shadowMapSize;
      if (sun.shadow.mapSize.width !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map = null;
        sun.shadow.needsUpdate = true;
      }
      sun.shadow.bias = _values.shadowBias;
      sun.shadow.normalBias = _values.shadowNormalBias;
      sun.shadow.color.set(_values.shadowColor);
    }

    // Lighting
    if (s) {
      s.children.forEach(c => {
        if (c.isHemisphereLight) {
          c.intensity = _values.hemiIntensity;
          c.color.set(_values.hemiSkyColor);
          c.groundColor.set(_values.hemiGroundColor);
        }
        if (c.isDirectionalLight && c !== (w && w.sunLight) && c !== _findFill()) {
          // skip sun, handled separately
        }
        if (c.isAmbientLight) {
          c.intensity = _values.ambientIntensity;
          c.color.set(_values.ambientColor);
        }
      });
      // Sun
      if (w && w.sunLight) {
        w.sunLight.intensity = _values.sunIntensity;
        w.sunLight.color.set(_values.sunColor);
      }
      // Fill
      const fill = _findFill();
      if (fill) {
        fill.intensity = _values.fillIntensity;
        fill.color.set(_values.fillColor);
      }
    }

    // Fog
    if (s) {
      if (_values.fogEnabled) {
        const fogCol = new THREE.Color(_values.fogColor);
        if (_values.fogType === 'exp2') {
          s.fog = new THREE.FogExp2(fogCol, _values.fogDensity);
        } else {
          s.fog = new THREE.Fog(fogCol, _values.fogNear, _values.fogFar);
        }
        r.setClearColor(fogCol);
      } else {
        s.fog = null;
        r.setClearColor(new THREE.Color(0xc8ddf0));
      }
    }

    // PBR — traverse scene and adjust materials
    if (s) {
      s.traverse(obj => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
            if (m.metalness !== undefined) m.metalness = Math.min(1, Math.max(0, m.metalness * _values.metalnessMul));
            if (m.roughness !== undefined) m.roughness = Math.min(1, Math.max(0, m.roughness * _values.roughnessMul));
            if (m.envMapIntensity !== undefined) m.envMapIntensity = _values.envMapIntensity;
          }
        });
      });
    }

    // Textures — anisotropy
    if (s) {
      s.traverse(obj => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          if (m.map) m.map.anisotropy = Math.min(r.capabilities.getMaxAnisotropy(), _values.anisotropy);
          if (m.normalMap) m.normalMap.anisotropy = Math.min(r.capabilities.getMaxAnisotropy(), _values.anisotropy);
        });
      });
    }

    // Effects
    if (_game._noParticles !== undefined) {
      // particleDensity handled via _noParticles threshold
    }

    // Post-processing (CSS filter on canvas)
    const canvas = r.domElement;
    const filters = [];
    if (_values.brightness !== 1.0) filters.push('brightness(' + _values.brightness + ')');
    if (_values.contrast !== 1.0) filters.push('contrast(' + _values.contrast + ')');
    if (_values.saturation !== 1.0) filters.push('saturate(' + _values.saturation + ')');
    if (_values.hueRotate !== 0) filters.push('hue-rotate(' + _values.hueRotate + 'deg)');
    if (_values.sepia !== 0) filters.push('sepia(' + _values.sepia + ')');
    canvas.style.filter = filters.length ? filters.join(' ') : 'none';
  }

  function _findFill() {
    if (!_game || !_game.world || !_game.scene) return null;
    for (const c of _game.scene.children) {
      if (c.isDirectionalLight && c !== _game.world.sunLight) return c;
    }
    return null;
  }

  function _toneMapConst(name) {
    switch (name) {
      case 'aces': return THREE.ACESFilmicToneMapping;
      case 'reinhard': return THREE.ReinhardToneMapping;
      case 'cineon': return THREE.CineonToneMapping;
      case 'linear': return THREE.LinearToneMapping;
      default: return THREE.NoToneMapping;
    }
  }

  /* ---------- Build UI ---------- */
  function _buildUI() {
    _overlay = document.createElement('div');
    _overlay.id = 'gs-overlay';
    _overlay.className = 'hidden';
    _overlay.innerHTML = `
      <div class="gs-panel" onclick="event.stopPropagation()">
        <div class="gs-header">
          <span class="gs-title">GRAPHICS SETTINGS</span>
          <span class="gs-hint">Ctrl+O to toggle</span>
          <span class="gs-close" id="gs-close">&times;</span>
        </div>
        <div class="gs-body">
          ${_section('RENDERER', 'renderer', [
            _slider('pixelRatio', 'Pixel Ratio', 0.5, 3.0, 0.1),
            _select('toneMapping', 'Tone Mapping', [['none','None'],['aces','ACES Filmic'],['reinhard','Reinhard'],['cineon','Cineon'],['linear','Linear']]),
            _slider('exposure', 'Exposure', 0.1, 3.0, 0.05),
          ])}
          ${_section('SHADOWS', 'shadows', [
            _toggle('shadowsEnabled', 'Shadows'),
            _select('shadowMapSize', 'Shadow Map Size', [[512,'512'],[1024,'1024'],[2048,'2048'],[4096,'4096']]),
            _slider('shadowBias', 'Shadow Bias', -0.01, 0.01, 0.0005),
            _slider('shadowNormalBias', 'Normal Bias', 0, 0.01, 0.0001),
            _color('shadowColor', 'Shadow Color'),
          ])}
          ${_section('LIGHTING', 'lighting', [
            _slider('hemiIntensity', 'Hemisphere', 0, 3, 0.05),
            _color('hemiSkyColor', 'Sky Color'),
            _color('hemiGroundColor', 'Ground Color'),
            _slider('sunIntensity', 'Sun', 0, 5, 0.05),
            _color('sunColor', 'Sun Color'),
            _slider('fillIntensity', 'Fill Light', 0, 3, 0.05),
            _color('fillColor', 'Fill Color'),
            _slider('ambientIntensity', 'Ambient', 0, 3, 0.05),
            _color('ambientColor', 'Ambient Color'),
          ])}
          ${_section('FOG', 'fog', [
            _toggle('fogEnabled', 'Enable Fog'),
            _select('fogType', 'Fog Type', [['exp2','Exponential'],['linear','Linear']]),
            _slider('fogDensity', 'Density', 0, 0.1, 0.001),
            _color('fogColor', 'Fog Color'),
            _slider('fogNear', 'Near (Linear)', 1, 500, 1),
            _slider('fogFar', 'Far (Linear)', 10, 1000, 5),
          ])}
          ${_section('PBR / MATERIALS', 'pbr', [
            _slider('metalnessMul', 'Metalness', 0, 2, 0.05),
            _slider('roughnessMul', 'Roughness', 0, 2, 0.05),
            _slider('envMapIntensity', 'Env Map', 0, 3, 0.05),
          ])}
          ${_section('TEXTURES', 'textures', [
            _slider('anisotropy', 'Anisotropy', 1, 16, 1),
          ])}
          ${_section('POST-PROCESSING', 'post', [
            _slider('brightness', 'Brightness', 0.2, 2.0, 0.05),
            _slider('contrast', 'Contrast', 0.2, 2.0, 0.05),
            _slider('saturation', 'Saturation', 0, 2.0, 0.05),
            _slider('hueRotate', 'Hue Shift', -180, 180, 1),
            _slider('sepia', 'Sepia', 0, 1.0, 0.05),
          ])}
          <div class="gs-footer">
            <button class="gs-btn gs-apply" id="gs-apply">APPLY ALL</button>
            <button class="gs-btn gs-reset" id="gs-reset">RESET DEFAULTS</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(_overlay);

    // Events
    _overlay.addEventListener('click', close);
    document.getElementById('gs-close').addEventListener('click', close);
    document.getElementById('gs-apply').addEventListener('click', () => { _readUI(); _save(); applyAll(); });
    document.getElementById('gs-reset').addEventListener('click', () => {
      _values = Object.assign({}, DEFAULTS);
      _syncUI();
      _save();
      applyAll();
    });

    // Bind all inputs
    _overlay.querySelectorAll('[data-key]').forEach(el => {
      el.addEventListener('input', () => {
        _readUI();
        applyAll();
        _save();
      });
    });
  }

  function _section(title, id, controls) {
    return `<div class="gs-section">
      <div class="gs-section-title" onclick="this.parentElement.classList.toggle('gs-collapsed')">
        <span class="gs-arrow">&#9660;</span> ${title}
      </div>
      <div class="gs-section-body">${controls.join('')}</div>
    </div>`;
  }

  function _slider(key, label, min, max, step) {
    return `<div class="gs-row">
      <label>${label}</label>
      <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${_values[key]}">
      <span class="gs-val" data-val="${key}">${_values[key]}</span>
    </div>`;
  }

  function _toggle(key, label) {
    return `<div class="gs-row">
      <label>${label}</label>
      <label class="gs-switch">
        <input type="checkbox" data-key="${key}" ${_values[key] ? 'checked' : ''}>
        <span class="gs-slider"></span>
      </label>
    </div>`;
  }

  function _select(key, label, opts) {
    const html = opts.map(([v, t]) => `<option value="${v}" ${String(_values[key]) === String(v) ? 'selected' : ''}>${t}</option>`).join('');
    return `<div class="gs-row">
      <label>${label}</label>
      <select data-key="${key}">${html}</select>
    </div>`;
  }

  function _color(key, label) {
    return `<div class="gs-row">
      <label>${label}</label>
      <input type="color" data-key="${key}" value="${_values[key]}">
    </div>`;
  }

  /* ---------- Read UI into values ---------- */
  function _readUI() {
    _overlay.querySelectorAll('[data-key]').forEach(el => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') {
        _values[k] = el.checked;
      } else if (el.type === 'range' || el.type === 'number') {
        _values[k] = parseFloat(el.value);
      } else if (el.tagName === 'SELECT') {
        const v = el.value;
        _values[k] = isNaN(v) ? v : parseFloat(v);
      } else if (el.type === 'color') {
        _values[k] = el.value;
      }
      // Update display value
      const valEl = _overlay.querySelector(`[data-val="${k}"]`);
      if (valEl) valEl.textContent = _values[k];
    });
  }

  /* ---------- Sync UI from values ---------- */
  function _syncUI() {
    if (!_overlay) return;
    _overlay.querySelectorAll('[data-key]').forEach(el => {
      const k = el.dataset.key;
      if (_values[k] === undefined) return;
      if (el.type === 'checkbox') {
        el.checked = _values[k];
      } else {
        el.value = _values[k];
      }
      const valEl = _overlay.querySelector(`[data-val="${k}"]`);
      if (valEl) valEl.textContent = _values[k];
    });
  }

  return { init, open, close, toggle, isOpen, applyAll };
})();
