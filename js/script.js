(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  var NEAR = 200;
  var RANGE = 280;
  var REACH = 7;
  var FAR = 420;
  var MAGNET = 190;
  var MAX_PULL = 11;
  var MAX_BLOB = 16;
  var PRESS_SCALE = 0.93;

  var REST_SIGMA = 7.5;
  var PEAK_SIGMA = 15;
  var RIM_AT_11 = 0.1;

  var FILL = [112, 89, 196];
  var SHADOW_DY = 8;
  var SHADOW_ALPHA = 0.5;
  var RIM_ALPHA = 0.38;
  var GLOSS_ALPHA = 0.26;
  var GLOSS_RX = 140;
  var GLOSS_RY = 38;
  var GLOW_RADIUS = 150;
  var START_SCALE = 0.7;
  var GL_GRID_SCALE = 0.6;
  var MAX_OUTPUT_RATIO = 3;
  var MIN_SCALE = 0.45;
  var SLOW_FRAME_MS = 9;
  var GL_MIN_SCALE = 0.35;
  var ADAPT_DELAY_MS = 2500;
  var adaptAfter = Infinity;
  function armAdapt() { adaptAfter = performance.now() + ADAPT_DELAY_MS; }
  if (document.readyState === 'complete') armAdapt(); else window.addEventListener('load', armAdapt);

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function createSpring(value) { return { x: value, v: 0 }; }
  function stepSpring(s, target, stiffness, damping, dt) {
    s.v += (stiffness * (target - s.x) - damping * s.v) * dt;
    s.x += s.v * dt;
  }
  function isAtRest(s, target, eps) {
    return Math.abs(target - s.x) < eps && Math.abs(s.v) < eps * 6;
  }

  var pointers = (function () {
    var points = {};
    var listeners = [];
    var queued = 0;

    function flush() {
      queued = 0;
      for (var i = 0; i < listeners.length; i++) listeners[i](points);
    }
    function queue() {
      if (!queued) queued = requestAnimationFrame(flush);
    }
    function setMouse(e) {
      if (e.pointerType === 'touch' || !finePointer.matches) return;
      points.mouse = { x: e.clientX, y: e.clientY };
      queue();
    }
    function syncTouches(e) {
      var seen = {}, i, key;
      for (i = 0; i < e.touches.length; i++) {
        var touch = e.touches[i];
        var id = 't' + touch.identifier;
        seen[id] = true;
        points[id] = { x: touch.clientX, y: touch.clientY };
      }
      for (key in points) if (key !== 'mouse' && !seen[key]) delete points[key];
      queue();
    }

    if (!reducedMotion) {
      window.addEventListener('pointermove', setMouse, { passive: true });
      window.addEventListener('pointerdown', setMouse, { passive: true });
      window.addEventListener('pointerout', function (e) {
        if (e.pointerType === 'touch' || e.relatedTarget) return;
        delete points.mouse;
        queue();
      }, { passive: true });
      ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (type) {
        window.addEventListener(type, syncTouches, { passive: true });
      });
      window.addEventListener('blur', function () { points = {}; queue(); });
    }

    return { subscribe: function (fn) { listeners.push(fn); } };
  })();

  var engine = (function () {
    var active = [];
    var fields = [];
    var frame = 0;
    var lastTime = 0;

    function loop(now) {
      frame = 0;
      var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.032) : 0.016;
      lastTime = now;

      var next = [];
      for (var i = 0; i < active.length; i++) {
        var button = active[i];
        button.queued = false;
        var keep = false;
        try {
          keep = button.update(dt);
        } catch (err) {
          button.fail();
        }
        if (keep) { button.queued = true; next.push(button); }
      }
      active = next;

      var pending = false;
      for (var f = 0; f < fields.length; f++) {
        if (fields[f].dirty) fields[f].draw();
        if (fields[f].dirty) pending = true;
      }
      if (active.length || pending) frame = requestAnimationFrame(loop);
      else lastTime = 0;
    }

    return {
      addField: function (field) { fields.push(field); },
      busy: function () { return frame !== 0; },
      wake: function () { if (!frame) frame = requestAnimationFrame(loop); },
      schedule: function (button) {
        if (!button.queued) { button.queued = true; active.push(button); }
        if (!frame) frame = requestAnimationFrame(loop);
      }
    };
  })();

  function boxRadii(sigma, passes) {
    var ideal = Math.sqrt(12 * sigma * sigma / passes + 1);
    var lower = Math.floor(ideal);
    if (lower % 2 === 0) lower--;
    var upper = lower + 2;
    var lowerCount = Math.round((12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4));
    var radii = [];
    for (var i = 0; i < passes; i++) radii.push(((i < lowerCount ? lower : upper) - 1) / 2);
    return radii;
  }

  function blurRows(src, dst, width, height, radius) {
    var weight = 1 / (radius * 2 + 1);
    for (var y = 0; y < height; y++) {
      var row = y * width;
      var sum = 0;
      for (var x = 0; x <= radius && x < width; x++) sum += src[row + x];
      for (x = 0; x < width; x++) {
        dst[row + x] = sum * weight;
        var enter = x + radius + 1;
        var leave = x - radius;
        sum += (enter < width ? src[row + enter] : 0) - (leave >= 0 ? src[row + leave] : 0);
      }
    }
  }

  function blurColumns(src, dst, width, height, radius) {
    var weight = 1 / (radius * 2 + 1);
    for (var x = 0; x < width; x++) {
      var sum = 0;
      for (var y = 0; y <= radius && y < height; y++) sum += src[y * width + x];
      for (y = 0; y < height; y++) {
        dst[y * width + x] = sum * weight;
        var enter = y + radius + 1;
        var leave = y - radius;
        sum += (enter < height ? src[enter * width + x] : 0) - (leave >= 0 ? src[leave * width + x] : 0);
      }
    }
  }

  var VERTEX_SOURCE = 'attribute vec2 aPosition; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }';
  var FRAGMENT_SOURCE = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uField;',
    'uniform vec2 uOutput;',
    'uniform vec2 uCss;',
    'uniform float uShadowDy;',
    'uniform float uRimThreshold;',
    'uniform float uCount;',
    'uniform vec3 uFill;',
    'uniform vec4 uGlow[2];',
    'uniform vec4 uGloss[2];',
    'void main() {',
    '  vec2 position = vec2(gl_FragCoord.x, uOutput.y - gl_FragCoord.y) / uOutput * uCss;',
    '  vec2 uv = position / uCss;',
    '  float field = texture2D(uField, uv).r;',
    '  float shadowField = texture2D(uField, uv - vec2(0.0, uShadowDy / uCss.y)).r;',
    '  float shape = clamp(26.0 * field - 11.0, 0.0, 1.0);',
    '  float inner = clamp(26.0 * field - uRimThreshold, 0.0, 1.0);',
    '  float rim = ' + RIM_ALPHA + ' * shape * (1.0 - inner);',
    '  float shadow = ' + SHADOW_ALPHA + ' * shadowField;',
    '  float alpha = shape + shadow * (1.0 - shape);',
    '  vec3 color = uFill * shape;',
    '  float keep = 1.0 - rim;',
    '  alpha = rim + alpha * keep;',
    '  color = vec3(rim) + color * keep;',
    '  if (shape > 0.0) {',
    '    float mask = 0.0;',
    '    for (int i = 0; i < 2; i++) {',
    '      if (float(i) >= uCount) break;',
    '      float glow = 0.0;',
    '      if (uGlow[i].z > 0.002) {',
    '        float distance = length(position - uGlow[i].xy) / uGlow[i].w;',
    '        glow = uGlow[i].z * clamp(1.0 - distance, 0.0, 1.0);',
    '      }',
    '      vec2 e = (position - uGloss[i].xy) / uGloss[i].zw;',
    '      float gloss = ' + GLOSS_ALPHA + ' * clamp(1.0 - length(e), 0.0, 1.0);',
    '      float one = glow + gloss - glow * gloss;',
    '      mask = mask + one - mask * one;',
    '    }',
    '    float highlight = shape * mask;',
    '    alpha = highlight + alpha * (1.0 - highlight);',
    '    color = vec3(highlight) + color * (1.0 - highlight);',
    '  }',
    '  gl_FragColor = vec4(color, alpha);',
    '}'
  ].join('\n');

  function createGLPresenter(canvas) {
    var gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false
    });
    if (!gl) return null;

    var presenter = { gl: gl, ready: false };
    var program, texture, uniforms;

    function compile(type, source) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    }

    function init() {
      var vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
      var fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
      if (!vertex || !fragment) return false;
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);

      var buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var position = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      uniforms = {};
      ['uField', 'uOutput', 'uCss', 'uShadowDy', 'uRimThreshold', 'uCount', 'uFill', 'uGlow', 'uGloss'].forEach(function (name) {
        uniforms[name] = gl.getUniformLocation(program, name);
      });
      gl.uniform1i(uniforms.uField, 0);
      gl.uniform3f(uniforms.uFill, FILL[0] / 255, FILL[1] / 255, FILL[2] / 255);
      gl.clearColor(0, 0, 0, 0);
      return true;
    }

    presenter.init = function () { presenter.ready = init(); return presenter.ready; };
    presenter.draw = function (bytes, gridWidth, gridHeight, params) {
      if (!presenter.ready || gl.isContextLost()) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gridWidth, gridHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
      gl.uniform2f(uniforms.uOutput, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uCss, params.cssWidth, params.cssHeight);
      gl.uniform1f(uniforms.uShadowDy, SHADOW_DY);
      gl.uniform1f(uniforms.uRimThreshold, params.rimThreshold);
      gl.uniform1f(uniforms.uCount, params.glow.length / 4);
      var glow = new Float32Array(8), gloss = new Float32Array(8);
      glow.set(params.glow); gloss.set(params.gloss);
      gl.uniform4fv(uniforms.uGlow, glow);
      gl.uniform4fv(uniforms.uGloss, gloss);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); presenter.ready = false; });
    canvas.addEventListener('webglcontextrestored', function () { presenter.init(); presenter.onRestore(); });

    return presenter.init() ? presenter : null;
  }

  function createField(el) {
    function createCanvas() {
      var element = document.createElement('canvas');
      element.setAttribute('aria-hidden', 'true');
      el.appendChild(element);
      return element;
    }
    var canvas = createCanvas();
    var presenter = createGLPresenter(canvas);
    var context = null;
    if (!presenter) {
      canvas.remove();
      canvas = createCanvas();
      context = canvas.getContext('2d');
    }
    var bytes = null;

    var members = [];
    var scale = presenter ? GL_GRID_SCALE : START_SCALE;
    var sigma = Number(el.dataset.sigma) || 11;
    var width = 0, height = 0;
    var coverage = null, scratch = null, image = null;
    var cost = 0, slowFrames = 0;

    var field = { el: el, dirty: true };

    function resize() {
      var rect = el.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width * scale));
      height = Math.max(1, Math.round(rect.height * scale));
      coverage = new Float32Array(width * height);
      scratch = new Float32Array(width * height);
      if (presenter) {
        var ratio = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_RATIO);
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        bytes = new Uint8Array(width * height);
        field.cssWidth = rect.width;
        field.cssHeight = rect.height;
      } else {
        canvas.width = width;
        canvas.height = height;
        image = context.createImageData(width, height);
      }
      field.dirty = true;
      engine.wake();
    }

    function splat(circles, count) {
      for (var c = 0; c < count; c++) {
        var cx = circles[c * 3] * scale, cy = circles[c * 3 + 1] * scale, r = circles[c * 3 + 2] * scale;
        if (r < 0.2) continue;
        var x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(width - 1, Math.ceil(cx + r + 1));
        var y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(height - 1, Math.ceil(cy + r + 1));
        for (var y = y0; y <= y1; y++) {
          var dy = y + 0.5 - cy;
          for (var x = x0; x <= x1; x++) {
            var dx = x + 0.5 - cx;
            var value = r - Math.sqrt(dx * dx + dy * dy) + 0.5;
            if (value <= 0) continue;
            if (value > 1) value = 1;
            var index = y * width + x;
            if (value > coverage[index]) coverage[index] = value;
          }
        }
      }
    }

    function blur() {
      var radii = boxRadii(Math.max(sigma * scale, 0.5), 3);
      var a = coverage, b = scratch, tmp;
      for (var i = 0; i < 3; i++) { blurRows(a, b, width, height, radii[i]); tmp = a; a = b; b = tmp; }
      for (i = 0; i < 3; i++) { blurColumns(a, b, width, height, radii[i]); tmp = a; a = b; b = tmp; }
    }

    function present() {
      var length = width * height;
      for (var i = 0; i < length; i++) {
        var value = coverage[i] * 255 + 0.5;
        bytes[i] = value > 255 ? 255 : value;
      }
      var glow = [], gloss = [];
      for (var m = 0; m < members.length && m < 2; m++) {
        var shine = members[m].shine;
        glow.push(shine.gx, shine.gy, shine.ga, GLOW_RADIUS);
        gloss.push(shine.lx, shine.ly, GLOSS_RX, GLOSS_RY);
      }
      presenter.draw(bytes, width, height, {
        cssWidth: field.cssWidth, cssHeight: field.cssHeight,
        rimThreshold: 11 + 26 * RIM_AT_11 * 11 / sigma, glow: glow, gloss: gloss
      });
    }

    function shade() {
      var rimThreshold = 11 + 26 * RIM_AT_11 * 11 / sigma;
      var shadowRows = Math.round(SHADOW_DY * scale);
      var out = image.data;
      var shines = [];
      for (var m = 0; m < members.length; m++) {
        var shine = members[m].shine;
        shines.push({
          gx: shine.gx * scale, gy: shine.gy * scale, glow: shine.ga, glowRadius: GLOW_RADIUS * scale,
          lx: shine.lx * scale, ly: shine.ly * scale, rx: GLOSS_RX * scale, ry: GLOSS_RY * scale
        });
      }

      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          var index = y * width + x;
          var o = index * 4;
          var blurred = coverage[index];
          var shadowSource = y >= shadowRows ? coverage[index - shadowRows * width] : 0;
          if (blurred < 0.004 && shadowSource < 0.004) { out[o + 3] = 0; continue; }

          var shape = 26 * blurred - 11;
          shape = shape < 0 ? 0 : shape > 1 ? 1 : shape;
          var inner = 26 * blurred - rimThreshold;
          inner = inner < 0 ? 0 : inner > 1 ? 1 : inner;
          var rim = RIM_ALPHA * shape * (1 - inner);
          var shadow = SHADOW_ALPHA * shadowSource;

          var alpha = shape + shadow * (1 - shape);
          var red = FILL[0] * shape, green = FILL[1] * shape, blue = FILL[2] * shape;
          var keep = 1 - rim;
          alpha = rim + alpha * keep;
          red = 255 * rim + red * keep; green = 255 * rim + green * keep; blue = 255 * rim + blue * keep;

          if (shape > 0) {
            var mask = 0;
            for (m = 0; m < shines.length; m++) {
              var s = shines[m];
              var glow = 0;
              if (s.glow > 0.002) {
                var gd = Math.sqrt((x - s.gx) * (x - s.gx) + (y - s.gy) * (y - s.gy)) / s.glowRadius;
                if (gd < 1) glow = s.glow * (1 - gd);
              }
              var ex = (x - s.lx) / s.rx, ey = (y - s.ly) / s.ry;
              var ed = Math.sqrt(ex * ex + ey * ey);
              var gloss = ed < 1 ? GLOSS_ALPHA * (1 - ed) : 0;
              var one = glow + gloss - glow * gloss;
              mask = mask + one - mask * one;
            }
            var highlight = shape * mask;
            if (highlight > 0) {
              var under = 1 - highlight;
              alpha = highlight + alpha * under;
              red = 255 * highlight + red * under; green = 255 * highlight + green * under; blue = 255 * highlight + blue * under;
            }
          }

          out[o] = red / alpha;
          out[o + 1] = green / alpha;
          out[o + 2] = blue / alpha;
          out[o + 3] = alpha * 255;
        }
      }
    }

    field.addMember = function (count) {
      var member = {
        circles: new Float32Array((count + 2) * 3), count: 0,
        shine: { gx: 0, gy: 0, ga: 0, lx: 0, ly: 0 }
      };
      members.push(member);
      return member;
    };
    field.setSigma = function (value) {
      sigma = value;
      field.dirty = true;
      engine.wake();
    };
    field.draw = function () {
      var started = performance.now();
      coverage.fill(0);
      for (var m = 0; m < members.length; m++) splat(members[m].circles, members[m].count);
      blur();
      if (presenter) {
        present();
      } else {
        shade();
        context.putImageData(image, 0, 0);
      }
      field.dirty = false;

      cost += (performance.now() - started - cost) * 0.1;
      if (performance.now() < adaptAfter) { cost = 0; slowFrames = 0; return; }
      slowFrames = cost > SLOW_FRAME_MS ? slowFrames + 1 : 0;
      var floor = presenter ? GL_MIN_SCALE : MIN_SCALE;
      if (slowFrames > 20 && scale > floor) {
        scale = Math.max(floor, scale - 0.1);
        slowFrames = 0; cost = 0;
        resize();
        field.dirty = true;
      }
    };

    if (presenter) {
      presenter.onRestore = function () { field.dirty = true; engine.wake(); };
    }
    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(el);
    engine.addField(field);
    return field;
  }

  function createButton(btn) {
    var field = fieldsById[btn.dataset.group];
    var label = btn.querySelector('.label');
    var gate = btn.closest('.menu');
    var origin = btn.dataset.origin ? document.getElementById(btn.dataset.origin) : null;
    var frozenBy = btn.dataset.freeze ? document.getElementById(btn.dataset.freeze) : null;

    var count = Number(btn.dataset.nodes) || 3;
    var nodeRadius = btn.offsetHeight / 2;
    var member = field.addMember(count);
    var i;
    btn.classList.add('soft');
    field.el.classList.add('soft');

    var nodes = [];
    for (i = 0; i < count; i++) {
      nodes.push({ x: createSpring(0), y: createSpring(0), s: createSpring(1), targetX: 0, targetY: 0, targetS: 1 });
    }

    var pointer = null;
    var pressed = false;
    var leadX = null, leadY = null, leadScale = createSpring(0);
    var tailX = null, tailY = null, tailScale = createSpring(0);
    var shiftX = createSpring(0), shiftY = createSpring(0);
    var press = createSpring(1);
    var glow = 0;
    var labelAlpha = origin ? 0 : 1;
    var hitX = null, hitY = null;
    var handle = { queued: false, update: update, fail: fail };

    function update(dt) {

      var w = btn.offsetWidth, h = btn.offsetHeight;
      var rect = btn.getBoundingClientRect();
      var fieldRect = field.el.getBoundingClientRect();
      var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      hitX = cx; hitY = cy;
      var baseX = cx - shiftX.x, baseY = cy - shiftY.x;
      if (leadX === null) { leadX = tailX = cx; leadY = tailY = cy; }

      var ox = cx - fieldRect.left, oy = cy - fieldRect.top;
      var scale = press.x;
      var gap = (w - nodeRadius * 2) / (count - 1);
      function restOffset(index) { return (nodeRadius + index * gap - w / 2) * scale; }

      var targetShiftX = 0, targetShiftY = 0, targetLead = 0, near = false;
      var aimX = leadX, aimY = leadY;
      var curX = null, curY = null;

      if (pointer) {
        curX = pointer.x - fieldRect.left;
        curY = pointer.y - fieldRect.top;
        var left = baseX - w / 2, top = baseY - h / 2;
        var outX = pointer.x - clamp(pointer.x, left, left + w);
        var outY = pointer.y - clamp(pointer.y, top, top + h);
        var magnetDist = Math.hypot(outX, outY);
        if (magnetDist < MAGNET) {
          var pull = Math.pow(smoothstep(1 - magnetDist / MAGNET), 0.8);
          targetShiftX = clamp((pointer.x - baseX) * 0.2, -MAX_PULL, MAX_PULL) * pull;
          targetShiftY = clamp((pointer.y - baseY) * 0.2, -MAX_PULL, MAX_PULL) * pull;
        }
        var edgeX = clamp(pointer.x, rect.left, rect.right);
        var edgeY = clamp(pointer.y, rect.top, rect.bottom);
        var dx = pointer.x - edgeX, dy = pointer.y - edgeY;
        var edgeDist = Math.hypot(dx, dy);
        if (edgeDist === 0) {
          aimX = pointer.x; aimY = pointer.y; targetLead = 1; near = true;
        } else if (edgeDist < NEAR) {
          var strength = Math.pow(smoothstep(1 - edgeDist / NEAR), 0.6);
          var offset = Math.min(edgeDist, 6 + MAX_BLOB * strength * 1.35);
          aimX = edgeX + dx / edgeDist * offset;
          aimY = edgeY + dy / edgeDist * offset;
          targetLead = strength; near = true;
        }
      }

      var folded = !!(gate && origin && !gate.classList.contains('open'));
      var originRect = folded ? origin.getBoundingClientRect() : null;
      var slow = folded || !!(frozenBy && frozenBy.classList.contains('open'));
      if (folded) {
        aimX = originRect.left + originRect.width / 2;
        aimY = originRect.top + originRect.height / 2;
        targetLead = 0;
      }

      for (i = 0; i < count; i++) {
        var node = nodes[i];
        node.targetX = 0; node.targetY = 0; node.targetS = 1;
        if (folded) {
          node.targetX = originRect.left + originRect.width / 2 - (rect.left + nodeRadius + i * gap);
          node.targetY = originRect.top + originRect.height / 2 - cy;
          node.targetS = 0.4;
        } else if (curX !== null) {
          var vx = curX - (ox + restOffset(i)), vy = curY - oy;
          var distance = Math.hypot(vx, vy) || 1;
          if (distance < RANGE) {
            var influence = Math.pow(smoothstep(1 - distance / RANGE), 0.7);
            var reach = Math.min(distance * 0.75, REACH) * influence;
            node.targetX = vx / distance * reach;
            node.targetY = vy / distance * reach;
            node.targetS = 1 + 0.015 * influence;
          }
        }
      }

      for (var sub = 0; sub < 2; sub++) {
        var d = dt / 2;
        for (i = 0; i < count; i++) {
          var a = nodes[i];
          var prev = nodes[Math.max(i - 1, 0)], next = nodes[Math.min(i + 1, count - 1)];
          var far = clamp((Math.hypot(a.targetX - a.x.x, a.targetY - a.y.x) - 12) / 60, 0, 1);
          var stiffness = 230 - 125 * far, damping = 26 - 10 * far;
          a.x.v += (stiffness * (a.targetX - a.x.x) - damping * a.x.v + 90 * ((prev.x.x + next.x.x) / 2 - a.x.x)) * d;
          a.y.v += (stiffness * (a.targetY - a.y.x) - damping * a.y.v + 90 * ((prev.y.x + next.y.x) / 2 - a.y.x)) * d;
        }
        for (i = 0; i < count; i++) {
          var b = nodes[i];
          b.x.x = clamp(b.x.x + b.x.v * d, -400, 400);
          b.y.x = clamp(b.y.x + b.y.v * d, -400, 400);
          stepSpring(b.s, b.targetS, 260, 24, d);
        }
        leadX += (aimX - leadX) * 0.24; leadY += (aimY - leadY) * 0.24;
        stepSpring(leadScale, targetLead, slow ? 100 : 260, slow ? 16 : 22, d);
        tailX += (leadX - tailX) * 0.12; tailY += (leadY - tailY) * 0.12;
        stepSpring(tailScale, leadScale.x * 0.7, slow ? 70 : 140, slow ? 12 : 15, d);
        stepSpring(shiftX, targetShiftX, 170, 17, d);
        stepSpring(shiftY, targetShiftY, 170, 17, d);
        stepSpring(press, pressed ? PRESS_SCALE : 1, 280, 17, d);
      }

      btn.style.transform = 'translate(' + shiftX.x.toFixed(2) + 'px,' + shiftY.x.toFixed(2) + 'px) scale(' + press.x.toFixed(4) + ')';

      var midX = 0, midY = 0, midCount = 0, displaced = 0;
      var circles = member.circles;
      for (i = 0; i < count; i++) {
        var q = nodes[i];
        circles[i * 3] = ox + restOffset(i) + q.x.x;
        circles[i * 3 + 1] = oy + q.y.x;
        circles[i * 3 + 2] = nodeRadius * q.s.x * scale;
        if (i > count * 0.3 && i < count * 0.7) { midX += q.x.x; midY += q.y.x; midCount++; }
        displaced = Math.max(displaced, Math.hypot(q.x.x, q.y.x) + Math.abs(1 - q.s.x) * 60);
      }

      circles[count * 3] = leadX - fieldRect.left;
      circles[count * 3 + 1] = leadY - fieldRect.top;
      circles[count * 3 + 2] = MAX_BLOB * Math.max(leadScale.x, 0);
      circles[count * 3 + 3] = tailX - fieldRect.left;
      circles[count * 3 + 4] = tailY - fieldRect.top;
      circles[count * 3 + 5] = MAX_BLOB * Math.max(tailScale.x, 0);
      member.count = count + 2;

      var shine = member.shine;
      if (pointer && near) { shine.gx = curX; shine.gy = curY; }
      var glowTarget = near ? 0.13 : 0;
      glow += (glowTarget - glow) * 0.2;
      shine.ga = glow;
      shine.lx = ox + midX / midCount;
      shine.ly = oy - h / 2 * scale + midY / midCount;
      field.dirty = true;

      var labelTarget = 1;
      if (origin) {
        var arrived = 1 - clamp((displaced - 12) / 12, 0, 1);
        labelTarget = folded ? 0 : arrived * arrived;
        labelAlpha += (labelTarget - labelAlpha) * (folded ? 0.5 : 0.35);
        label.style.opacity = labelAlpha.toFixed(3);
      }

      var settled = isAtRest(leadScale, targetLead, 0.004) && isAtRest(tailScale, leadScale.x * 0.7, 0.004) &&
        isAtRest(shiftX, targetShiftX, 0.05) && isAtRest(shiftY, targetShiftY, 0.05) &&
        isAtRest(press, pressed ? PRESS_SCALE : 1, 0.0008) &&
        Math.abs(glowTarget - glow) < 0.002 && Math.abs(labelTarget - labelAlpha) < 0.01 &&
        Math.abs(aimX - leadX) < 0.1 && Math.abs(aimY - leadY) < 0.1 &&
        Math.abs(leadX - tailX) < 0.1 && Math.abs(leadY - tailY) < 0.1;
      for (i = 0; i < count && settled; i++) {
        var z = nodes[i];
        if (!isAtRest(z.x, z.targetX, 0.05) || !isAtRest(z.y, z.targetY, 0.05) || !isAtRest(z.s, z.targetS, 0.002)) settled = false;
      }

      return !settled;
    }

    function fail() {
      btn.classList.remove('soft');
      field.el.classList.remove('soft');
    }
    function schedule() {
      engine.schedule(handle);
    }

    function onPoints(points) {
      if ((gate && !gate.classList.contains('open')) || (frozenBy && frozenBy.classList.contains('open'))) {
        if (pointer) { pointer = null; schedule(); }
        return;
      }
      if (hitX === null) {
        var rect = btn.getBoundingClientRect();
        hitX = rect.left + rect.width / 2;
        hitY = rect.top + rect.height / 2;
      }
      var best = null, bestDist = Infinity, key;
      for (key in points) {
        var dist = Math.hypot(points[key].x - hitX, points[key].y - hitY);
        if (dist < bestDist) { bestDist = dist; best = points[key]; }
      }
      var next = best && bestDist < FAR ? { x: best.x, y: best.y } : null;
      if (next || pointer) { pointer = next; schedule(); }
    }

    function release() { pressed = false; schedule(); }

    if (!reducedMotion) {
      pointers.subscribe(onPoints);
      label.addEventListener('pointerdown', function () { pressed = true; schedule(); });
      label.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { pressed = true; schedule(); }
      });
      label.addEventListener('keyup', release);
      window.addEventListener('pointerup', function () { if (pressed) release(); });
      window.addEventListener('pointercancel', release);
      window.addEventListener('blur', release);
      window.addEventListener('scroll', schedule, { passive: true });
    }
    window.addEventListener('menutoggle', schedule);
    if (window.ResizeObserver) new ResizeObserver(schedule).observe(btn);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    schedule();
  }

  function initMenu() {
    var menuBtn = document.getElementById('menu-btn');
    var menu = document.getElementById('menu');
    if (!menuBtn || !menu) return;
    var toggle = menuBtn.querySelector('.label');

    var field = fieldsById[menuBtn.dataset.group];
    var rangeFrame = 0, rangeStart = 0;

    function setRange(sigma) {
      field.setSigma(sigma);
    }
    function rangeFrameStep(now) {
      var t = (now - rangeStart) / 900;
      if (t >= 1.5) { rangeFrame = 0; setRange(REST_SIGMA); return; }
      var envelope = t < 0.12 ? t / 0.12 : Math.exp(-(t - 0.12) * 4.2);
      setRange(REST_SIGMA + (PEAK_SIGMA - REST_SIGMA) * envelope);
      rangeFrame = requestAnimationFrame(rangeFrameStep);
    }
    function pulseRange() {
      if (reducedMotion) return;
      rangeStart = performance.now();
      if (!rangeFrame) rangeFrame = requestAnimationFrame(rangeFrameStep);
    }

    function setOpen(open) {
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      window.dispatchEvent(new Event('menutoggle'));
      pulseRange();
    }

    setRange(REST_SIGMA);
    toggle.addEventListener('click', function () { setOpen(!menu.classList.contains('open')); });
    document.addEventListener('pointerdown', function (e) {
      if (menu.classList.contains('open') && !menu.contains(e.target) && !menuBtn.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('open')) { setOpen(false); toggle.focus(); }
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
  }

  function loadCursor() {
    if (reducedMotion || !finePointer.matches) return;
    var current = document.currentScript;
    var script = document.createElement('script');
    script.src = current && current.src ? current.src.replace(/[^\/]*$/, 'cursor.js') : 'js/cursor.js';
    document.body.appendChild(script);
  }

  function initLoader() {
    var root = document.documentElement;
    var loader = document.getElementById('loader');
    var fill = document.getElementById('loader-fill');
    if (!loader || !fill) return;

    var total = 4;
    var done = 0;
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      fill.style.width = '100%';
      loader.setAttribute('aria-valuenow', '100');
      setTimeout(function () { root.classList.add('loaded'); }, reducedMotion ? 0 : 380);
    }
    function step() {
      if (finished) return;
      done++;
      var percent = Math.round(done / total * 100);
      fill.style.width = percent + '%';
      loader.setAttribute('aria-valuenow', String(percent));
      if (done >= total) finish();
    }
    function onImage(url) {
      var img = new Image();
      img.onload = img.onerror = step;
      img.src = url;
    }

    var avatar = document.querySelector('.avatar img');
    if (avatar && !avatar.complete) {
      avatar.addEventListener('load', step);
      avatar.addEventListener('error', step);
    } else {
      step();
    }

    var banner = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(document.querySelector('.banner')).backgroundImage);
    if (banner) onImage(banner[1]); else step();

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(step); else step();

    if (document.readyState === 'complete') step();
    else window.addEventListener('load', step);

    setTimeout(finish, 5000);
  }

  function initAscii() {
    var canvas = document.getElementById('ascii');
    var ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;

    var CELL_W = 10, CELL_H = 17, FONT_PX = 14;
    var GLYPHS = [
      ['.', ',', '`'], [':', ';', '!'], ['-', '~', '_'], ['=', '+', '^'], ['+', '*', 'x'],
      ['*', 'o', '%'], ['#', '&', '$'], ['%', '8', 'B'], ['@', 'M', 'W']
    ];
    var VARIANTS = 3;
    var ALPHAS = [0.16, 0.2, 0.25, 0.3, 0.36, 0.42, 0.48, 0.54, 0.6];
    var COLOR_EDGE = [128, 104, 214], COLOR_CORE = [226, 178, 255];
    var FADE = 0.42, PUSH = 34;
    var FPS_IDLE = 14, FPS_BUSY = 7, FPS_MIN = 5;
    var CLUSTERS = 3, PER_CLUSTER = 4, BALLS = CLUSTERS * PER_CLUSTER;
    var golden = 0.6180339887;
    function frac(x) { return x - Math.floor(x); }
    var ORBIT_FX = [], ORBIT_FY = [], ORBIT_PX = [], ORBIT_PY = [], SIZE = [];
    var DRIFT_FX = [], DRIFT_FY = [], DRIFT_PX = [], DRIFT_PY = [];
    var k0;
    for (k0 = 0; k0 < BALLS; k0++) {
      ORBIT_FX.push(0.28 + 0.4 * frac(k0 * golden));
      ORBIT_FY.push(0.24 + 0.4 * frac(k0 * golden * 2.7 + 0.3));
      ORBIT_PX.push(6.28 * frac(k0 * golden * 3.1));
      ORBIT_PY.push(6.28 * frac(k0 * golden * 5.3 + 0.5));
      SIZE.push(0.7 + 0.6 * frac(k0 * golden * 1.9 + 0.2));
    }
    DRIFT_FX = [0.07, 0.055, 0.09];
    DRIFT_FY = [0.06, 0.085, 0.05];
    DRIFT_PX = [0, 2.2, 4.3];
    DRIFT_PY = [1, 3.1, 5.2];

    var ballX = new Float32Array(BALLS), ballY = new Float32Array(BALLS), ballR2 = new Float32Array(BALLS);
    var orbitRadius = 0, warpAmount = 0, rowWarp = null, colWarp = null;
    var width = 0, height = 0, ratio = 1, cols = 0, rows = 0, cellW = 0, cellH = 0;
    var cellX = null, cellY = null, hidden = null, atlas = null, cellHash = null;
    var trail = !reducedMotion;
    var pointerX = 0, pointerY = 0, pushX = 0, pushY = 0, pushTarget = 0, pushLevel = 0, pushRadius = 120;
    var interval = 1000 / FPS_IDLE, cost = 0, slowFrames = 0, clock = 0;

    function buildAtlas() {
      atlas = document.createElement('canvas');
      atlas.width = cellW * GLYPHS.length * VARIANTS;
      atlas.height = cellH;
      var a = atlas.getContext('2d');
      a.font = (FONT_PX * ratio) + 'px ui-monospace, Menlo, Consolas, "Courier New", monospace';
      a.textAlign = 'center';
      a.textBaseline = 'middle';
      for (var g = 0; g < GLYPHS.length; g++) {
        var mix = g / (GLYPHS.length - 1);
        var red = Math.round(COLOR_EDGE[0] + (COLOR_CORE[0] - COLOR_EDGE[0]) * mix);
        var green = Math.round(COLOR_EDGE[1] + (COLOR_CORE[1] - COLOR_EDGE[1]) * mix);
        var blue = Math.round(COLOR_EDGE[2] + (COLOR_CORE[2] - COLOR_EDGE[2]) * mix);
        a.fillStyle = 'rgba(' + red + ',' + green + ',' + blue + ',' + ALPHAS[g] + ')';
        for (var v = 0; v < VARIANTS; v++) {
          a.fillText(GLYPHS[g][v], (g * VARIANTS + v) * cellW + cellW / 2, cellH / 2 + ratio);
        }
      }
    }

    function layout() {
      width = canvas.clientWidth || window.innerWidth;
      height = canvas.clientHeight || window.innerHeight;
      ratio = (window.devicePixelRatio || 1) >= 1.5 ? 2 : 1;
      cellW = CELL_W * ratio;
      cellH = CELL_H * ratio;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      cols = Math.ceil(width / CELL_W);
      rows = Math.ceil(height / CELL_H);
      cellX = new Float32Array(cols);
      cellY = new Float32Array(rows);
      var c, r;
      for (c = 0; c < cols; c++) cellX[c] = c * CELL_W + CELL_W / 2;
      for (r = 0; r < rows; r++) cellY[r] = r * CELL_H + CELL_H / 2;

      hidden = new Uint8Array(cols * rows);
      cellHash = new Uint8Array(cols * rows);
      for (r = 0; r < rows; r++) {
        for (c = 0; c < cols; c++) cellHash[r * cols + c] = (Math.imul(c + 1, 73856093) ^ Math.imul(r + 1, 19349663)) >>> 7 & 255;
      }
      var card = document.querySelector('.card');
      if (card) {
        var box = card.getBoundingClientRect();
        var left = box.left - 12, right = box.right + 2, top = box.top - 2, bottom = box.bottom + 12;
        for (r = 0; r < rows; r++) {
          for (c = 0; c < cols; c++) {
            if (c * CELL_W >= left && (c + 1) * CELL_W <= right && r * CELL_H >= top && (r + 1) * CELL_H <= bottom) {
              hidden[r * cols + c] = 1;
            }
          }
        }
      }

      var base = (width + height) / 2;
      pushRadius = Math.max(110, base * 0.16);
      orbitRadius = base * 0.1;
      warpAmount = base * 0.02;
      rowWarp = new Float32Array(rows);
      colWarp = new Float32Array(cols);
      for (var k = 0; k < BALLS; k++) {
        var radius = base * 0.064 * SIZE[k];
        ballR2[k] = radius * radius;
      }
      buildAtlas();
    }

    function draw(t) {
      var k, r, c;
      for (k = 0; k < BALLS; k++) {
        var cl = (k / PER_CLUSTER) | 0;
        var cx = width * (0.5 + 0.5 * Math.sin(t * DRIFT_FX[cl] + DRIFT_PX[cl]));
        var cy = height * (0.5 + 0.5 * Math.cos(t * DRIFT_FY[cl] + DRIFT_PY[cl]));
        ballX[k] = cx + orbitRadius * Math.cos(t * ORBIT_FX[k] + ORBIT_PX[k]);
        ballY[k] = cy + orbitRadius * 0.8 * Math.sin(t * ORBIT_FY[k] + ORBIT_PY[k]);
      }
      for (r = 0; r < rows; r++) {
        rowWarp[r] = warpAmount * (Math.sin(cellY[r] * 0.045 + t * 0.9) + 0.5 * Math.sin(cellY[r] * 0.11 - t * 1.3));
      }
      for (c = 0; c < cols; c++) {
        colWarp[c] = warpAmount * (Math.sin(cellX[c] * 0.04 - t * 0.8) + 0.5 * Math.sin(cellX[c] * 0.1 + t * 1.2));
      }
      if (trail) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,' + FADE + ')';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      pushLevel += (pushTarget - pushLevel) * 0.3;
      pushX += (pointerX - pushX) * 0.4;
      pushY += (pointerY - pushY) * 0.4;
      var pushing = pushLevel > 0.02;
      var pushRadius2 = pushRadius * pushRadius;
      var shimmer = t * 2.2;
      for (r = 0; r < rows; r++) {
        var y = cellY[r], row = r * cols, shiftX = rowWarp[r];
        for (c = 0; c < cols; c++) {
          if (hidden[row + c]) continue;
          var x = cellX[c] + shiftX, f = 0, yy = y + colWarp[c];
          if (pushing) {
            var px = cellX[c] - pushX, py = y - pushY, pd2 = px * px + py * py;
            if (pd2 < pushRadius2) {
              var pd = Math.sqrt(pd2) || 1, pw = 1 - pd / pushRadius;
              var amount = pw * pw * PUSH * pushLevel;
              x -= px / pd * amount;
              yy -= py / pd * amount;
            }
          }
          for (k = 0; k < BALLS; k++) {
            var dx = x - ballX[k], dy = yy - ballY[k];
            f += ballR2[k] / (dx * dx + dy * dy + 1);
          }
          if (f < 0.5) continue;
          var level = Math.min(GLYPHS.length - 1, Math.floor(Math.log(f * 2) * 3.2));
          var hash = cellHash[row + c];
          var variant = ((hash >> 4) + ((shimmer + (hash & 15) * 0.37) | 0)) % VARIANTS;
          if (trail) ctx.clearRect(c * cellW, r * cellH, cellW, cellH);
          ctx.drawImage(atlas, (level * VARIANTS + variant) * cellW, 0, cellW, cellH, c * cellW, r * cellH, cellW, cellH);
        }
      }
    }

    function frame(now) {
      var started = performance.now();
      clock = now / 1000 + 6;
      draw(clock);
      var spent = performance.now() - started;
      cost += (spent - cost) * 0.15;
      if (performance.now() > adaptAfter && cost > 3.5 && interval < 1000 / FPS_MIN) {
        slowFrames++;
        if (slowFrames > 12) { interval = Math.min(1000 / FPS_MIN, interval * 1.3); slowFrames = 0; }
      } else {
        slowFrames = 0;
      }
      var wait = engine.busy() ? Math.max(interval, 1000 / FPS_BUSY) : interval;
      setTimeout(function () { requestAnimationFrame(frame); }, Math.max(0, wait - spent));
    }

    if (!reducedMotion && finePointer.matches) {
      window.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        pointerX = e.clientX;
        pointerY = e.clientY;
        if (!pushTarget) { pushX = pointerX; pushY = pointerY; }
        pushTarget = 1;
      }, { passive: true });
      document.documentElement.addEventListener('pointerleave', function () { pushTarget = 0; });
      window.addEventListener('blur', function () { pushTarget = 0; });
    }

    var resizeQueued = 0;
    window.addEventListener('resize', function () {
      if (resizeQueued) return;
      resizeQueued = requestAnimationFrame(function () {
        resizeQueued = 0;
        layout();
        if (reducedMotion) draw(clock);
      });
    });

    function start() {
      layout();
      clock = 6;
      draw(clock);
      canvas.classList.add('on');
      if (!reducedMotion) setTimeout(function () { requestAnimationFrame(frame); }, interval);
    }

    if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
  }

  var fieldsById = {};
  var fieldEls = document.querySelectorAll('.goo-field');
  for (var f = 0; f < fieldEls.length; f++) fieldsById[fieldEls[f].id] = createField(fieldEls[f]);
  var buttons = document.querySelectorAll('.btn');
  for (var b = 0; b < buttons.length; b++) createButton(buttons[b]);
  initLoader();
  initMenu();
  initAscii();
  loadCursor();
})();
