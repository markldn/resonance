// The variation pad: the same joystick as the sound pad (js/pad.js), but its four corners are four random variations of an
// instrument and the middle is the instrument itself. Dragging blends them live (js/generator.js morph, js/synth.js morphSynth).
// This file is only the widget: it reports the puck's weights, the studio dialog builds the instrument.
import { mixAt } from './pad.js';

const NS = 'http://www.w3.org/2000/svg', NAMES = ['north', 'east', 'south', 'west'];

// state: { x, y }. Options: onMove(weights, gain) on every move (a drag is throttled by the caller), onEnd() when the puck is released,
// label(i) the read-out name of corner i (0 north, 1 east, 2 south, 3 west), centre the name of the middle. The four corners are empty
// containers (`.vp-pole`) the caller fills with its own controls. Returns { draw, move, pole(i) }.
export function mountVarPad(root, state, { onMove, onEnd, label, centre = 'original' }) {
  const size = 220, c = size / 2, R = 84;
  root.innerHTML = `
    <div class="pad-wrap vp">
      <div class="vp-pole n"></div>
      <div class="pad-mid">
        <div class="vp-pole w"></div>
        <svg viewBox="0 0 ${size} ${size}" class="pad-svg" tabindex="0" role="slider" aria-label="Variation pad. Arrow keys move, Home centres." style="touch-action:none"></svg>
        <div class="vp-pole e"></div>
      </div>
      <div class="vp-pole s"></div>
      <div class="pad-read"></div>
    </div>`;
  const svg = root.querySelector('svg'), read = root.querySelector('.pad-read');
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  el('circle', { cx: c, cy: c, r: R, class: 'pad-ring' });
  el('circle', { cx: c, cy: c, r: R * 0.74, class: 'pad-ring faint' });
  el('line', { x1: c - R, y1: c, x2: c + R, y2: c, class: 'pad-axis' }); el('line', { x1: c, y1: c - R, x2: c, y2: c + R, class: 'pad-axis' });
  const puck = el('circle', { r: 9, class: 'pad-puck' });
  const draw = () => {
    puck.setAttribute('cx', c + state.x * R); puck.setAttribute('cy', c + state.y * R);
    const { weights: w, gain } = mixAt(state.x, state.y);
    const parts = [[typeof centre === 'function' ? centre() : centre, w.center], ...w.poles.map((v, i) => [NAMES[i] + ' ' + label(i), v])];
    read.textContent = parts.filter(p => p[1] >= 0.02).sort((a, b) => b[1] - a[1]).map(p => `${Math.round(p[1] * 100)}% ${p[0]}`).join(' · ') + (gain > 1.01 ? ` · pushed ${Math.round((gain - 1) * 100)}% past` : '');
  };
  const move = (x, y) => { const r = Math.hypot(x, y); if (r > 1) { x /= r; y /= r; } state.x = x; state.y = y; draw(); const m = mixAt(x, y); onMove(m.weights, m.gain); };
  const at = e => { const b = svg.getBoundingClientRect(), k = size / b.width; return [((e.clientX - b.left) * k - c) / R, ((e.clientY - b.top) * k - c) / R]; };
  let drag = false;
  svg.onpointerdown = e => { drag = true; svg.setPointerCapture(e.pointerId); svg.focus({ preventScroll: true }); move(...at(e)); };
  svg.onpointermove = e => { if (drag) move(...at(e)); };
  svg.onpointerup = svg.onpointercancel = () => { if (drag) { drag = false; onEnd(); } };
  svg.ondblclick = () => { move(0, 0); onEnd(); };
  svg.onkeydown = e => {
    const step = e.shiftKey ? 0.2 : 0.05, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (e.key === 'Home') { e.preventDefault(); move(0, 0); onEnd(); }
    else if (d) { e.preventDefault(); move(state.x + d[0], state.y + d[1]); onEnd(); }
  };
  const poles = ['.vp-pole.n', '.vp-pole.e', '.vp-pole.s', '.vp-pole.w'].map(q => root.querySelector(q));
  draw();
  return { draw, move, pole: i => poles[i] };
}
