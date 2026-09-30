// Sound pad: a circle with four sounds at north / east / south / west and a neutral sound in the middle.
// The puck blends them, so one gesture moves through hardness, resonance, space and character together.
//
// Only continuous parameters blend (sliders, and the 8-band spectrum profile). Discrete choices (instrument model, room
// type, lid, perspective, temperament, switches) are left as they are: switching them while dragging would reload
// the instrument or rebuild the reverb.

export const POLES = [[0, -1], [1, 0], [0, 1], [-1, 0]];        // screen coordinates: north is up (y < 0)

// Weight of each pole at puck position (x, y) in the unit disc; the rest goes to the centre sound.
// A pole's weight is the projection of the puck on its direction; when two neighbouring poles sum past 1 they share it.
export function poleWeights(x, y) {
  const r = Math.hypot(x, y);
  if (r > 1) { x /= r; y /= r; }
  const t = POLES.map(([dx, dy]) => Math.max(0, x * dx + y * dy));
  const s = t.reduce((a, b) => a + b, 0);
  const w = s > 1 ? t.map(v => v / s) : t;
  return { poles: w, center: Math.max(0, 1 - w.reduce((a, b) => a + b, 0)) };
}

// The pole sounds are reached at 74% of the radius. The outer ring pushes past them: the change from the centre sound grows
// to 1.35 times the pole's, clamped to each slider's range, so the ends of the pad are more extreme than any stored sound.
export const REACH = 0.74;
export function mixAt(x, y) {
  const qx = x / REACH, qy = y / REACH, r = Math.hypot(qx, qy);
  return { weights: poleWeights(qx, qy), gain: Math.min(Math.max(r, 1), 1 / REACH) };
}

// Blend resolved parameter objects. `base` is the centre sound, `poles` the four pole sounds (same shape as base),
// `params` the PARAMS list (for the log flag). Returns only the values that differ between the sounds.
export function blend(base, poles, weights, params, gain = 1) {
  const out = {}, w = [weights.center, ...weights.poles], all = [base, ...poles];
  const mix = (vals, log) => {                                   // base + gain * (blend - base), geometric for log sliders
    if (log && vals.every(v => v > 0)) return Math.exp(Math.log(vals[0]) + gain * (vals.reduce((a, v, i) => a + w[i] * Math.log(v), 0) - Math.log(vals[0])));
    return vals[0] + gain * (vals.reduce((a, v, i) => a + w[i] * v, 0) - vals[0]);
  };
  for (const d of params) {
    const vals = all.map(o => o[d.id]);
    if (!vals.every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    if (vals.every(v => v === vals[0])) continue;
    out[d.id] = Math.min(d.max, Math.max(d.min, mix(vals, d.log)));
  }
  const prof = all.map(o => o.profile);
  if (prof.every(a => Array.isArray(a)) && prof.some(a => a.some((v, i) => v !== prof[0][i]))) out.profile = prof[0].map((_, i) => Math.round(mix(prof.map(a => a[i]), false) * 100) / 100);
  return out;
}

// ---------------------------------------------------------------------------------------------------- UI
const NS = 'http://www.w3.org/2000/svg';
export function initPad({ root, presets, menu, presetParams, params, state, onStart, onMove, onEnd, save }) {
  // state: { x, y, poles: [presetName x4], center: presetName }
  const size = 220, c = size / 2, R = 84;
  root.innerHTML = `
    <div class="pad-wrap">
      <select class="pad-sel n" aria-label="North sound"></select>
      <div class="pad-mid">
        <select class="pad-sel w" aria-label="West sound"></select>
        <svg viewBox="0 0 ${size} ${size}" class="pad-svg" tabindex="0" role="slider" aria-label="Sound pad. Arrow keys move, Home centres." style="touch-action:none"></svg>
        <select class="pad-sel e" aria-label="East sound"></select>
      </div>
      <select class="pad-sel s" aria-label="South sound"></select>
      <div class="pad-read"></div>
    </div>`;
  const svg = root.querySelector('svg'), sels = ['n', 'e', 's', 'w'].map(k => root.querySelector('.pad-sel.' + k)), read = root.querySelector('.pad-read');
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  el('circle', { cx: c, cy: c, r: R, class: 'pad-ring' });
  el('circle', { cx: c, cy: c, r: R * REACH, class: 'pad-ring faint' });
  el('line', { x1: c - R, y1: c, x2: c + R, y2: c, class: 'pad-axis' }); el('line', { x1: c, y1: c - R, x2: c, y2: c + R, class: 'pad-axis' });
  const puck = el('circle', { r: 9, class: 'pad-puck' });
  const names = () => menu().map(p => p.name);
  const fill = () => sels.forEach((s, i) => { s.innerHTML = names().map(n => `<option>${n}</option>`).join(''); s.value = state.poles[i]; s.title = state.poles[i]; });
  fill();
  const resolve = name => presetParams(presets().find(p => p.name === name) || presets()[0]);
  const current = () => {
    const { weights: w, gain } = mixAt(state.x, state.y);
    return { w, gain, values: blend(resolve(state.center), state.poles.map(resolve), w, params, gain) };
  };
  const draw = () => {
    puck.setAttribute('cx', c + state.x * R); puck.setAttribute('cy', c + state.y * R);
    const { w, gain } = current(), parts = [['center', w.center, state.center], ...w.poles.map((v, i) => [['north', 'east', 'south', 'west'][i], v, state.poles[i]])];
    read.textContent = parts.filter(p => p[1] >= 0.02).sort((a, b) => b[1] - a[1]).map(p => `${Math.round(p[1] * 100)}% ${p[2]}`).join(' · ') + (gain > 1.01 ? ` · pushed ${Math.round((gain - 1) * 100)}% past` : '');
  };
  const move = (x, y) => { const r = Math.hypot(x, y); if (r > 1) { x /= r; y /= r; } state.x = x; state.y = y; draw(); onMove(current().values); save(); };
  const at = e => { const b = svg.getBoundingClientRect(), k = size / b.width; return [((e.clientX - b.left) * k - c) / R, ((e.clientY - b.top) * k - c) / R]; };
  let drag = false;
  svg.onpointerdown = e => { drag = true; svg.setPointerCapture(e.pointerId); svg.focus({ preventScroll: true }); onStart(); move(...at(e)); };
  svg.onpointermove = e => { if (drag) move(...at(e)); };
  svg.onpointerup = svg.onpointercancel = () => { if (drag) { drag = false; onEnd(); } };
  svg.ondblclick = () => { onStart(); move(0, 0); onEnd(); };
  svg.onkeydown = e => {
    const step = e.shiftKey ? 0.2 : 0.05, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (e.key === 'Home') { e.preventDefault(); onStart(); move(0, 0); onEnd(); }
    else if (d) { e.preventDefault(); onStart(); move(state.x + d[0], state.y + d[1]); onEnd(); }
  };
  sels.forEach((s, i) => s.onchange = () => { state.poles[i] = s.value; s.title = s.value; draw(); onStart(); onMove(current().values); onEnd(); save(); });
  draw();
  return { redraw: draw, refill: fill, current };
}
