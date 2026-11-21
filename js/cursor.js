(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:0;z-index:100;pointer-events:none;will-change:transform;opacity:0;transition:opacity .15s ease;transform:translate3d(-100px,-100px,0)';
  var inner = document.createElement('div');
  inner.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;transition:transform .2s cubic-bezier(.3,1.5,.5,1)';
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-8 -8 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.style.cssText = 'position:absolute;left:-8px;top:-8px;display:block';
  var star = document.createElementNS(NS, 'path');
  star.setAttribute('d', 'M0 -7L1.9 -1.9L7 0L1.9 1.9L0 7L-1.9 1.9L-7 0L-1.9 -1.9Z');
  star.setAttribute('fill', '#fff');
  star.setAttribute('stroke', '#fff');
  star.setAttribute('stroke-width', '1');
  star.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(star);
  inner.appendChild(svg);
  el.appendChild(inner);
  document.body.appendChild(el);

  var link = false, down = false;
  function state() {
    inner.style.transform = down ? 'scale(.75)' : link ? 'rotate(45deg) scale(1.3)' : '';
  }
  function move(e) {
    if (e.pointerType === 'touch') return;
    el.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0)';
    el.style.opacity = '1';
  }
  function hide() { el.style.opacity = '0'; down = false; state(); }

  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') return;
    down = true; state(); move(e);
  }, { passive: true });
  window.addEventListener('pointerup', function (e) {
    if (e.pointerType === 'touch') return;
    down = false; state();
  }, { passive: true });
  window.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    var next = !!(e.target.closest && e.target.closest('a,button'));
    if (next !== link) { link = next; state(); }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', hide);
  window.addEventListener('blur', hide);

  document.documentElement.classList.add('cursor-on');
})();
