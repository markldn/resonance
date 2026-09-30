// Sound pad: blend maths. node test/pad.test.mjs
import { PARAMS, PRESETS, VOICINGS, ROOMS, defaults } from '../js/params.js';
import { poleWeights, blend, mixAt, REACH } from '../js/pad.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const resolve = name => { const pr = [...VOICINGS, ...PRESETS].find(p => p.name === name), base = defaults(), o = JSON.parse(JSON.stringify(pr.p)); if (o.room && !('duration' in o)) Object.assign(base, ROOMS[o.room]); return Object.assign(base, o); };
const centre = resolve('Concert Grand'), poles = ['Glass', 'Cathedral Bloom', 'Velvet', 'Tack Upright'].map(resolve);   // N E S W

let w = poleWeights(0, 0); ok(near(w.center, 1) && w.poles.every(v => v === 0), 'centre: all weight on the centre sound');
for (const [i, [x, y]] of [[0, [0, -1]], [1, [1, 0]], [2, [0, 1]], [3, [-1, 0]]]) { w = poleWeights(x, y); ok(near(w.poles[i], 1) && near(w.center, 0), `pole ${i}: full weight`); }
for (const [x, y] of [[0.3, -0.2], [0.7, 0.7], [-0.9, 0.4], [5, 5], [-0.05, 0.02]]) { w = poleWeights(x, y); const s = w.center + w.poles.reduce((a, b) => a + b, 0); ok(near(s, 1) && w.poles.every(v => v >= 0) && w.center >= 0, `weights sum to 1 at (${x}, ${y})`); }
w = poleWeights(0.7071, -0.7071); ok(near(w.poles[0], 0.5, 1e-3) && near(w.poles[1], 0.5, 1e-3), 'diagonal between two poles is shared equally');

let b = blend(centre, poles, poleWeights(0, 0), PARAMS); ok(PARAMS.every(d => !(d.id in b) || near(b[d.id], centre[d.id])), 'centre reproduces the centre sound');
b = blend(centre, poles, poleWeights(0, -1), PARAMS);
ok(near(b.hardM, poles[0].hardM) && near(b.sbCutoff, poles[0].sbCutoff), 'north pole reproduces Glass hardness and cut-off');
ok(b.profile && b.profile.every((v, i) => near(v, poles[0].profile[i])), 'north pole reproduces the spectrum profile');
b = blend(centre, poles, poleWeights(0, 1), PARAMS); ok(near(b.hardM, poles[2].hardM) && b.hardM < centre.hardM, 'south pole is softer than the centre');
b = blend(centre, poles, poleWeights(0, -0.5), PARAMS); ok(near(b.hardM, (centre.hardM + poles[0].hardM) / 2), 'halfway to north is the mean of the two');
b = blend(centre, poles, poleWeights(1, 0), PARAMS); ok(near(b.duration, poles[1].duration), 'east pole reproduces the reverb length (log parameters mix geometrically)');
const d = PARAMS.find(p => p.id === 'direct'), lo = { ...centre, direct: 0.5 }, hi = { ...centre, direct: 2 };
b = blend(lo, [hi, hi, hi, hi], { center: 0.5, poles: [0.5, 0, 0, 0] }, PARAMS); ok(d.log && near(b.direct, 1, 1e-9), 'a log parameter halfway between 0.5 and 2 is 1 (geometric mean)');
ok(!['model', 'room', 'lid', 'perspective', 'temperament', 'reverbOn'].some(k => k in b), 'discrete choices are never touched');
b = blend(centre, poles, poleWeights(0.6, -0.6), PARAMS); ok(PARAMS.every(p => !(p.id in b) || (b[p.id] >= p.min && b[p.id] <= p.max)), 'every blended value stays inside its slider range');

// reach beyond the poles
let m = mixAt(0, -REACH); ok(near(m.weights.poles[0], 1) && near(m.gain, 1), 'pole strength is reached at 74% of the radius, without extrapolation');
m = mixAt(0, -1); ok(near(m.gain, 1 / REACH, 1e-9) && near(m.weights.poles[0], 1), 'rim on an axis: full pole weight, gain 1/0.74');
m = mixAt(0, 0); ok(near(m.gain, 1) && near(m.weights.center, 1), 'centre has no gain');
b = blend(centre, poles, mixAt(0, -1).weights, PARAMS, mixAt(0, -1).gain);
ok(b.hardM >= poles[0].hardM && b.hardM <= 2 && b.hammerNoise >= poles[0].hammerNoise, 'pushed past Glass: harder and noisier than the pole, still inside the slider');
b = blend(centre, poles, mixAt(0, 1).weights, PARAMS, mixAt(0, 1).gain); ok(b.hardM >= 0 && b.hardM <= poles[2].hardM && b.sbCutoff <= poles[2].sbCutoff, 'pushed past Velvet: softer and darker, clamped at 0');
for (const [x, y] of [[0, -1], [1, 0], [0, 1], [-1, 0], [0.7, 0.7], [-0.7, -0.7], [0.3, -0.9]]) { const g = mixAt(x, y); b = blend(centre, poles, g.weights, PARAMS, g.gain); ok(PARAMS.every(p => !(p.id in b) || (b[p.id] >= p.min && b[p.id] <= p.max)), `extreme position (${x}, ${y}) stays inside every slider range`); }
ok(VOICINGS.every(v => Object.entries(v.p).every(([k, x]) => { const d = PARAMS.find(q => q.id === k); return !d || (x >= d.min && x <= d.max); })), 'every stored voicing is inside the slider ranges');
process.exit(fails ? 1 : 0);
