(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  var NEAR = 200;
  var RANGE = 280;
  var REACH = 7;
  var FAR = 420;
  var MAGNET = 190;
  var MAX_PULL = 11;
  var MAX_BLOB = 16;
  var BLOB_RADIUS = 22;
  var PRESS_SCALE = 0.93;

  var REST_SIGMA = 7.5;
  var PEAK_SIGMA = 15;
  var RIM_AT_11 = 0.1;

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

  function svgElement(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var name in attrs) el.setAttribute(name, attrs[name]);
    return el;
  }

  function buildLayer(specs, filterId, className, owner) {
    var svg = svgElement('svg', { 'class': className, 'aria-hidden': 'true', focusable: 'false' });
    if (owner) svg.setAttribute('data-owner', owner);
    var group = svgElement('g', { filter: 'url(#' + filterId + ')' });
    specs.forEach(function (spec) {
      for (var i = 0; i < spec.count; i++) {
        group.appendChild(svgElement('circle', { 'class': 'node', r: spec.radius, 'data-owner': spec.id }));
      }
      group.appendChild(svgElement('circle', { 'class': 'blob', r: BLOB_RADIUS, 'data-owner': spec.id }));
      group.appendChild(svgElement('circle', { 'class': 'blob tail', r: BLOB_RADIUS, 'data-owner': spec.id }));
    });
    svg.appendChild(group);
    return svg;
  }

  function buildField(field) {
    var buttons = document.querySelectorAll('.btn[data-group="' + field.id + '"]');
    var specs = Array.prototype.map.call(buttons, function (btn) {
      return { id: btn.id, count: Number(btn.dataset.nodes) || 3, radius: btn.offsetHeight / 2 };
    });
    var filter = field.dataset.filter;
    field.appendChild(buildLayer(specs, filter, 'goo'));
    specs.forEach(function (spec) {
      field.appendChild(buildLayer(specs, filter + 'Glow', 'goo shine', spec.id));
    });
  }

  function createButton(btn) {
    var field = document.getElementById(btn.dataset.group);
    var own = '[data-owner="' + btn.id + '"]';
    var layers = field.querySelectorAll('.goo');
    var shine = field.querySelector('.goo.shine' + own);
    var label = btn.querySelector('.label');
    var gate = btn.closest('.menu');
    var origin = btn.dataset.origin ? document.getElementById(btn.dataset.origin) : null;
    var frozenBy = btn.dataset.freeze ? document.getElementById(btn.dataset.freeze) : null;

    var count = layers[0].querySelectorAll('.node' + own).length;
    var nodeRadius = btn.offsetHeight / 2;
    var nodeEls = [], leadEls = [], tailEls = [];
    var i, l;
    for (i = 0; i < count; i++) nodeEls[i] = [];
    for (l = 0; l < layers.length; l++) {
      var found = layers[l].querySelectorAll('.node' + own);
      for (i = 0; i < count; i++) nodeEls[i].push(found[i]);
      leadEls.push(layers[l].querySelector('.blob:not(.tail)' + own));
      tailEls.push(layers[l].querySelector('.blob.tail' + own));
    }
    btn.classList.add('soft');
    field.classList.add('soft');

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
    var frame = 0, lastTime = 0;

    function setTransform(els, x, y, scale) {
      var value = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
      for (var k = 0; k < els.length; k++) els[k].style.transform = value;
    }

    function update(now) {
      frame = 0;
      var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.032) : 0.016;
      lastTime = now;

      var w = btn.offsetWidth, h = btn.offsetHeight;
      var rect = btn.getBoundingClientRect();
      var fieldRect = field.getBoundingClientRect();
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
        stepSpring(press, pressed ? PRESS_SCALE : 1, 300, 26, d);
      }

      btn.style.transform = 'translate(' + shiftX.x.toFixed(2) + 'px,' + shiftY.x.toFixed(2) + 'px) scale(' + press.x.toFixed(4) + ')';

      var midX = 0, midY = 0, midCount = 0, displaced = 0;
      for (i = 0; i < count; i++) {
        var q = nodes[i];
        var px = ox + restOffset(i) + q.x.x, py = oy + q.y.x;
        var value = 'translate(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px) scale(' + (q.s.x * scale).toFixed(3) + ')';
        for (var e = 0; e < nodeEls[i].length; e++) nodeEls[i][e].style.transform = value;
        if (i > count * 0.3 && i < count * 0.7) { midX += q.x.x; midY += q.y.x; midCount++; }
        displaced = Math.max(displaced, Math.hypot(q.x.x, q.y.x) + Math.abs(1 - q.s.x) * 60);
      }

      var blobScale = MAX_BLOB / BLOB_RADIUS;
      setTransform(leadEls, (leadX - fieldRect.left).toFixed(2), (leadY - fieldRect.top).toFixed(2), (Math.max(leadScale.x, 0) * blobScale).toFixed(3));
      setTransform(tailEls, (tailX - fieldRect.left).toFixed(2), (tailY - fieldRect.top).toFixed(2), (Math.max(tailScale.x, 0) * blobScale).toFixed(3));

      if (pointer && near) {
        shine.style.setProperty('--gx', curX.toFixed(1) + 'px');
        shine.style.setProperty('--gy', curY.toFixed(1) + 'px');
      }
      var glowTarget = near ? 0.13 : 0;
      glow += (glowTarget - glow) * 0.2;
      shine.style.setProperty('--ga', glow.toFixed(3));
      shine.style.setProperty('--lx', (ox + midX / midCount).toFixed(1) + 'px');
      shine.style.setProperty('--ly', (oy - h / 2 * scale + midY / midCount).toFixed(1) + 'px');

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

      if (!settled) {
        schedule();
      } else {
        lastTime = 0;
        if (leadScale.x < 0.004) {
          setTransform(leadEls, ox, oy, 0);
          setTransform(tailEls, ox, oy, 0);
        }
      }
    }

    function tick(now) {
      try {
        update(now);
      } catch (err) {
        btn.classList.remove('soft');
        field.classList.remove('soft');
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(tick);
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

    var blurs = document.querySelectorAll('[data-range-blur]');
    var rim = document.getElementById('wideRim');
    var rangeFrame = 0, rangeStart = 0;

    function setRange(sigma) {
      for (var i = 0; i < blurs.length; i++) blurs[i].setAttribute('stdDeviation', sigma.toFixed(2));
      var threshold = 26 * (11 / 26 + RIM_AT_11 * 11 / sigma);
      rim.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -' + threshold.toFixed(2));
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

  var fields = document.querySelectorAll('.goo-field');
  for (var f = 0; f < fields.length; f++) buildField(fields[f]);
  var buttons = document.querySelectorAll('.btn');
  for (var b = 0; b < buttons.length; b++) createButton(buttons[b]);
  initLoader();
  initMenu();
  loadCursor();
})();
