/* ============================================================
   missions-bg.js — WebGL Tactical Background for Missions Panel
   Subtle animated grid + particles + scanlines, reacts to mouse
   ============================================================ */

window.MissionsBG = (function(){
  var canvas, gl, program, buffers, uniforms, attributes;
  var particles = [];
  var mouse = { x: 0, y: 0, inside: false };
  var time = 0;
  var animationId = null;
  var container = null;
  var resizeObserver = null;
  var prefersReducedMotion = false;
  var _posBuf, _sizeBuf, _colorBuf, _alphaBuf;

  var VERT_SRC = `
    attribute vec2 a_position;
    attribute float a_size;
    attribute vec3 a_color;
    attribute float a_alpha;
    uniform vec2 u_resolution;
    uniform float u_time;
    varying vec3 v_color;
    varying float v_alpha;
    void main(){
      vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
      clipSpace.y *= -1.0;
      gl_Position = vec4(clipSpace, 0.0, 1.0);
      gl_PointSize = a_size * (1.0 + 0.5 * sin(u_time * 2.0 + a_position.x * 0.01));
      v_color = a_color;
      v_alpha = a_alpha;
    }
  `;

  var FRAG_SRC = `
    precision mediump float;
    varying vec3 v_color;
    varying float v_alpha;
    void main(){
      float dist = length(gl_PointCoord - vec2(0.5));
      float alpha = smoothstep(0.5, 0.0, dist) * v_alpha;
      gl_FragColor = vec4(v_color, alpha);
    }
  `;

  function createShader(gl, type, source){
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vert, frag){
    var prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
      console.error('Program link error:', gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  function initGL(){
    canvas = document.createElement('canvas');
    canvas.className = 'ms-bg-canvas';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
    
    gl = canvas.getContext('webgl', { alpha: true, antialias: true, preserveDrawingBuffer: false });
    if(!gl){
      console.warn('WebGL not available for missions background');
      return false;
    }

    var vert = createShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    var frag = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    program = createProgram(gl, vert, frag);
    if(!program) return false;

    attributes = {
      position: gl.getAttribLocation(program, 'a_position'),
      size: gl.getAttribLocation(program, 'a_size'),
      color: gl.getAttribLocation(program, 'a_color'),
      alpha: gl.getAttribLocation(program, 'a_alpha')
    };
    uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      time: gl.getUniformLocation(program, 'u_time')
    };

    buffers = {
      position: gl.createBuffer(),
      size: gl.createBuffer(),
      color: gl.createBuffer(),
      alpha: gl.createBuffer()
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    return true;
  }

  function spawnParticles(count){
    particles = [];
    var w = canvas.width, h = canvas.height;
    var types = [
      { color: [1.0, 0.69, 0.17], count: count * 0.4, size: 1.5 },  // gold
      { color: [0.48, 0.83, 0.43], count: count * 0.25, size: 1.2 }, // green
      { color: [0.49, 0.78, 1.0], count: count * 0.2, size: 1.0 },   // blue
      { color: [1.0, 0.48, 0.85], count: count * 0.15, size: 1.8 }   // pink
    ];
    var idx = 0;
    types.forEach(function(t){
      for(var i = 0; i < t.count; i++){
        var x = Math.random() * w;
        var y = Math.random() * h;
        var vx = (Math.random() - 0.5) * 0.3;
        var vy = (Math.random() - 0.5) * 0.3;
        var phase = Math.random() * Math.PI * 2;
        particles.push({
          x: x, y: y, vx: vx, vy: vy,
          color: t.color, size: t.size,
          alpha: 0.15 + Math.random() * 0.25,
          phase: phase,
          wander: Math.random() * 0.02
        });
      }
    });
  }

  function updateParticles(dt){
    var w = canvas.width, h = canvas.height;
    var mx = mouse.x * w;
    var my = mouse.y * h;
    
    particles.forEach(function(p){
      // Gentle wander
      p.phase += dt * 0.5;
      p.vx += Math.sin(p.phase) * p.wander;
      p.vy += Math.cos(p.phase * 1.3) * p.wander;
      
      // Mouse attraction (very subtle)
      if(mouse.inside){
        var dx = mx - p.x;
        var dy = my - p.y;
        var dist2 = dx*dx + dy*dy;
        if(dist2 < 15000 && dist2 > 1){
          var force = 0.00008 / dist2;
          p.vx += dx * force;
          p.vy += dy * force;
        }
      }
      
      // Damping
      p.vx *= 0.995;
      p.vy *= 0.995;
      
      // Update position
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      
      // Wrap around
      if(p.x < 0) p.x = w;
      if(p.x > w) p.x = 0;
      if(p.y < 0) p.y = h;
      if(p.y > h) p.y = 0;
    });
  }

  function uploadBuffers(){
    var n = particles.length;
    if(!_posBuf || _posBuf.length < n * 2) _posBuf = new Float32Array(n * 2);
    if(!_sizeBuf || _sizeBuf.length < n) _sizeBuf = new Float32Array(n);
    if(!_colorBuf || _colorBuf.length < n * 3) _colorBuf = new Float32Array(n * 3);
    if(!_alphaBuf || _alphaBuf.length < n) _alphaBuf = new Float32Array(n);
    
    for(var i = 0; i < n; i++){
      var p = particles[i];
      _posBuf[i*2] = p.x;
      _posBuf[i*2+1] = p.y;
      _sizeBuf[i] = p.size;
      _colorBuf[i*3] = p.color[0];
      _colorBuf[i*3+1] = p.color[1];
      _colorBuf[i*3+2] = p.color[2];
      _alphaBuf[i] = p.alpha;
    }
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.bufferData(gl.ARRAY_BUFFER, _posBuf, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attributes.position);
    gl.vertexAttribPointer(attributes.position, 2, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.size);
    gl.bufferData(gl.ARRAY_BUFFER, _sizeBuf, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attributes.size);
    gl.vertexAttribPointer(attributes.size, 1, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color);
    gl.bufferData(gl.ARRAY_BUFFER, _colorBuf, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attributes.color);
    gl.vertexAttribPointer(attributes.color, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.alpha);
    gl.bufferData(gl.ARRAY_BUFFER, _alphaBuf, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(attributes.alpha);
    gl.vertexAttribPointer(attributes.alpha, 1, gl.FLOAT, false, 0, 0);
  }

  function render(){
    if(!gl) return;
    
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.useProgram(program);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, time);
    
    uploadBuffers();
    gl.drawArrays(gl.POINTS, 0, particles.length);
  }

  function resize(){
    if(!canvas || !gl) return;
    var rect = container.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    spawnParticles(Math.max(60, Math.min(180, Math.floor((canvas.width * canvas.height) / 15000))));
  }

  function loop(now){
    if(!animationId) return;
    var dt = (now - time) / 1000;
    time = now;
    if(dt > 0.1) dt = 0.1;
    
    updateParticles(dt);
    render();
    animationId = requestAnimationFrame(loop);
  }

  function onMouseMove(e){
    if(!container) return;
    var rect = container.getBoundingClientRect();
    mouse.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    mouse.y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    mouse.inside = true;
  }

  function onMouseLeave(){
    mouse.inside = false;
  }

  function mount(target){
    if(!target) return;
    // Prevent duplicate mounts
    if(animationId) unmount();
    container = target;
    prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    
    if(prefersReducedMotion){
      // Just add a static gradient background instead
      var staticBg = document.createElement('div');
      staticBg.className = 'ms-bg-static';
      staticBg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;' +
        'background:radial-gradient(ellipse at 20% 0%,rgba(255,177,43,0.04) 0%,transparent 50%),' +
        'radial-gradient(ellipse at 80% 100%,rgba(123,211,110,0.03) 0%,transparent 50%);';
      container.insertBefore(staticBg, container.firstChild);
      return;
    }
    
    if(initGL()){
      container.insertBefore(canvas, container.firstChild);
      resize();
      spawnParticles(120);
      
      container.addEventListener('mousemove', onMouseMove);
      container.addEventListener('mouseleave', onMouseLeave);
      
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      
      time = performance.now();
      animationId = requestAnimationFrame(loop);
    }
  }

  function unmount(){
    if(animationId) cancelAnimationFrame(animationId);
    animationId = null;
    if(resizeObserver) resizeObserver.disconnect();
    if(container){
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mouseleave', onMouseLeave);
    }
    if(canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if(gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
    gl = null; canvas = null; program = null; buffers = null;
    _posBuf = _sizeBuf = _colorBuf = _alphaBuf = null;
    var staticBg = container && container.querySelector('.ms-bg-static');
    if(staticBg) staticBg.remove();
    container = null;
  }

  function triggerClaimBurst(x, y, color){
    // Could spawn temporary burst particles here
    // For now just a visual flash via CSS
  }

  return {
    mount: mount,
    unmount: unmount,
    triggerClaimBurst: triggerClaimBurst
  };
})();