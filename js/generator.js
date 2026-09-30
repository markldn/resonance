// Random instrument = a seeded variation of a measured instrument (the Iowa Grand), as a resonance-instrument/1 document.
// The output has exactly the structure of the measured table: every key, every velocity layer, every partial has its own
// ratio, level, two decay times and remanent level. Nothing is invented from a recipe. The measured numbers are moved by:
//   - smooth curves across the keyboard (brightness, sustain, level, inharmonicity, a few knots each), so the instrument
//     changes character as a whole, the way a different piano would;
//   - independent noise on every partial, shared by the three velocity layers of a key (it is the same string);
//   - a small change to the body and air resonances.
// The same seed and amount give the same instrument (for the same generator version).
//
// A variation is a set of random numbers (`draw`) and a way to apply them to the base (`variation`). Every effect is additive in
// dB or in log time, so several draws can be applied at once with weights: that is the variation pad (`morph`), where the four
// corners are four draws and the puck blends them. The centre has no draw at all: it is the base itself.

function rng(seed) {                       // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = R => Math.sqrt(-2 * Math.log(1 - R())) * Math.cos(2 * Math.PI * R());

// A smooth random curve over notes 21..108: a global offset plus deviations at knots every 12 semitones (stored, not evaluated).
function drawCurve(R, global, local) { const knots = Array.from({ length: 9 }, () => local * gauss(R)); return { knots, g: global * gauss(R) }; }
function curveAt(c, m) {
  const t = Math.min(7.999, Math.max(0, (m - 21) / 12)), i = Math.floor(t), s = (1 - Math.cos(Math.PI * (t - i))) / 2;
  return c.g + c.knots[i] + s * (c.knots[i + 1] - c.knots[i]);
}

export const AMOUNTS = [['Subtle', 0.5], ['Medium', 1], ['Wild', 2]];
const N = 120;

// All random numbers of one variation, at amount 1. The order of the draws is the order of the generator's first version.
export function draw(seed) {
  const R = rng(seed);
  const V = {
    seed,
    tilt: drawCurve(R, 3.0, 1.0),            // dB per octave of partial frequency above 500 Hz: darker or brighter
    sustain: drawCurve(R, 0.7, 0.25),        // natural-log factor on both decay times
    level: drawCurve(R, 0.0, 2.5),           // dB per key
    inharm: drawCurve(R, 0.6, 0.25),         // natural-log factor on B
  };
  V.dslope = 0.5 * gauss(R);                 // decay change per octave: high partials die sooner or later
  V.oddEven = 5 * gauss(R);                  // dB: odd harmonics louder than even (clarinet-like) or the reverse
  V.comb = Math.min(1.5, Math.abs(0.9 * gauss(R))); V.beta = 1 / (4 + 10 * R());   // strength and position of a hammer-strike comb
  V.vtilt = 3 * gauss(R);                    // dB per octave more brightness at full velocity than at half
  V.peaks = Array.from({ length: 3 }, () => ({ c: Math.log2(300 * Math.pow(20, R())), w: 0.5 + R(), g: 4.5 * gauss(R) }));   // broad spectral peaks, fixed in frequency
  V.keys = [];
  for (let k = 0; k < 88; k++) {             // per key (21..108): noise per partial for level, decay and remanent, and a level jitter
    const nl = Array.from({ length: N }, () => gauss(R)), nd = Array.from({ length: N }, () => gauss(R)), nr = Array.from({ length: N }, () => gauss(R));
    V.keys.push({ nl, nd, nr, lv: 0.8 * gauss(R) });
  }
  V.body = [gauss(R), gauss(R), gauss(R)]; V.air = [gauss(R), gauss(R)];
  return V;
}

// Apply weighted draws to a base. poles: [{ V, w }], amount scales every effect (2 = Wild; the variation pad's outer ring uses
// more than 1). With one pole of weight 1 and amount A this is the classic seeded variation.
export function variation(base, poles, amount = 1, name = null) {
  const A = amount, P = poles.filter(q => q.w > 1e-6);
  const wsum = P.reduce((a, q) => a + q.w, 0), w2 = Math.sqrt(P.reduce((a, q) => a + q.w * q.w, 0)) || 1;
  const nz = wsum / w2;                                     // noise: keeps its spread between poles, and fades to nothing at the centre
  const at = (f, m) => P.reduce((a, q) => a + q.w * f(q.V, m), 0);
  const keys = base.keys.map(k => {
    const m = k.note, ki = Math.min(87, Math.max(0, m - 21)), f0 = 440 * Math.pow(2, (m - 69) / 12), B0 = k.B ?? 3e-4;
    const B1 = B0 * Math.exp(A * at(V => curveAt(V.inharm, m)));
    const tl = A * at(V => curveAt(V.tilt, m)), s = A * at(V => curveAt(V.sustain, m));
    const nl = new Float64Array(N), nd = new Float64Array(N), nr = new Float64Array(N);
    for (const q of P) for (let j = 0; j < N; j++) { nl[j] += q.w * q.V.keys[ki].nl[j]; nd[j] += q.w * q.V.keys[ki].nd[j]; nr[j] += q.w * q.V.keys[ki].nr[j]; }
    const vtilt = A * at(V => V.vtilt), dslope = A * at(V => V.dslope), oddEven = A * at(V => V.oddEven);
    return {
      ...k, B: +B1.toExponential(4), level_db: +((k.level_db ?? 0) + A * at(V => curveAt(V.level, m)) + 0.8 * A * nz * at(V => V.keys[ki].lv) / Math.max(wsum, 1e-9)).toFixed(1),
      layers: k.layers.map(l => ({
        ...l,
        partials: l.partials.map((p, i) => {
          const n = Math.max(1, Math.round(p[0])), j = Math.min(i, N - 1);
          const ratio = p[0] * Math.sqrt((1 + B1 * n * n) / (1 + B0 * n * n)), f = f0 * ratio, oct = Math.log2(Math.max(f, 500) / 500);
          const comb = n > 1 ? A * P.reduce((a, q) => a + q.w * q.V.comb * 20 * Math.log10(Math.max(0.15, Math.abs(Math.sin(Math.PI * n * q.V.beta)))), 0) : 0;
          const lf = Math.log2(f), peak = A * P.reduce((a, q) => a + q.w * q.V.peaks.reduce((b, g) => b + g.g * Math.exp(-0.5 * Math.pow((lf - g.c) / g.w, 2)), 0), 0);
          const db = p[1] + (tl + vtilt * (l.velocity / 127 - 0.6)) * oct + (n > 1 ? oddEven * (n % 2 ? 1 : -1) * Math.min(1, n / 4) : 0) + comb + peak + 1.5 * A * nz * nl[j];
          const dk = Math.min(1.6, Math.max(-1.6, s + dslope * oct));
          const td = Math.max(0.05, p[2] * Math.exp(dk + 0.2 * A * nz * nd[j])), tr = Math.max(0.05, (p[3] ?? p[2]) * Math.exp(dk + 0.12 * A * nz * nd[j]));
          return [+ratio.toFixed(4), +db.toFixed(1), +td.toFixed(3), +tr.toFixed(3), +((p[4] ?? -120) + 3 * A * nz * nr[j]).toFixed(1)];
        }).filter(p => p[1] > -70),
      })),
    };
  });
  const out = { ...base, name: name ?? `${base.name.replace(/ \(measured\)$/, '')} variation`, author: 'Resonance generator',
    source: `variation of "${base.name}": seeds=${P.map(q => q.V.seed + '@' + q.w.toFixed(2)).join(',')} amount=${A}`, keys };
  const bw = (i) => A * nz * at(V => V.body[i]) / Math.max(wsum, 1e-9), aw = (i) => A * nz * at(V => V.air[i]) / Math.max(wsum, 1e-9);
  if (base.body) out.body = { ...base.body, hz: +Math.min(220, Math.max(80, base.body.hz * Math.exp(0.3 * bw(0)))).toFixed(1), level_db: +(base.body.level_db + 3 * bw(1)).toFixed(1), t60: +(base.body.t60 * Math.exp(0.3 * bw(2))).toFixed(2) };
  if (base.air) out.air = { ...base.air, level_db: +(base.air.level_db + 3 * aw(0)).toFixed(1), t60: +(base.air.t60 * Math.exp(0.3 * aw(1))).toFixed(2) };
  return out;
}

export function generate(base, seed = (Math.random() * 2 ** 32) >>> 0, amount = 1) {
  seed >>>= 0;
  return variation(base, [{ V: draw(seed), w: 1 }], amount, `${base.name.replace(/ \(measured\)$/, '')} variation #${(seed % 100000).toString().padStart(5, '0')}`);
}

// The variation pad: four draws (north, east, south, west corners) and the puck's weights (js/pad.js mixAt). Centre = the base itself.
export function morph(base, draws, weights, gain = 1, name = null) {
  return variation(base, draws.map((V, i) => ({ V, w: weights.poles[i] })), gain, name);
}
