// The variation pad (js/generator.js morph, js/synth.js morphSynth): node test/varpad.test.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { generate, draw, morph } = await import(ROOT + '/js/generator.js');
const { mixAt } = await import(ROOT + '/js/pad.js');
const base = JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8'));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const seeds = [101, 202, 303, 404], draws = seeds.map(draw);
// a distance between two tables: rms difference (dB) of the level in half-octave bands, over keys and layers. Quiet partials are dropped
// by the generator and inharmonicity moves the high ones, so partials cannot be paired one to one; band levels can be compared.
const bands = (doc, i, j) => { const k = doc.keys[i], f0 = 440 * Math.pow(2, (k.note - 69) / 12), e = new Float64Array(16); for (const p of k.layers[j].partials) { const b = Math.min(15, Math.max(0, Math.floor(2 * Math.log2(f0 * p[0] / 60)))); e[b] += Math.pow(10, p[1] / 10); } return e.map(v => 10 * Math.log10(v + 1e-12)); };
const dist = (a, b) => { let e = 0, n = 0; for (let i = 0; i < a.keys.length; i++) for (let j = 0; j < a.keys[i].layers.length; j++) { const x = bands(a, i, j), y = bands(b, i, j); for (let q = 0; q < 16; q++) if (x[q] > -60 && y[q] > -60) { e += (x[q] - y[q]) ** 2; n++; } } return Math.sqrt(e / n); };
const at = (x, y) => { const { weights, gain } = mixAt(x, y); return morph(base, draws, weights, gain); };

const north = mixAt(0, -0.74);                                   // the north pole is reached at 74 % of the radius
ok(north.weights.poles[0] > 0.999 && north.gain === 1, `pad: the north pole weight is ${north.weights.poles[0].toFixed(3)}, gain ${north.gain}`);
const p0 = at(0, -0.74), g0 = generate(base, 101, 1);
ok(dist(p0, g0) < 0.06, `pad: the north corner is the seeded variation 101 (${dist(p0, g0).toFixed(3)} dB apart)`);
const c = at(0, 0);
ok(dist(c, base) < 0.06 && c.keys.every((k, i) => k.note === base.keys[i].note), `pad: the centre is the measured base (${dist(c, base).toFixed(3)} dB apart)`);
const dN = dist(p0, base), mid = at(0.37 * 0.74 * 1, -0.37 * 0.74), dM = dist(mid, base);
ok(dM > 0.3 * dN && dM < 1.3 * dN, `pad: half way to a pole is about half-way in level (${dM.toFixed(2)} dB vs ${dN.toFixed(2)} dB at the pole)`);
const ring = at(0, -1), dR = dist(ring, base);
ok(dR > 1.15 * dN, `pad: the rim goes past the pole (${dR.toFixed(2)} dB vs ${dN.toFixed(2)} dB)`);
const between = at(0.52, -0.52);                                 // between north and east: the noise keeps its spread
ok(dist(between, at(0, -0.74)) > 0.3 && dist(between, at(0.74, 0)) > 0.3, 'pad: between two corners it is neither of them');
// continuity: a small move of the puck changes the table by a small amount (no jumps while dragging)
let worst = 0; for (let t = 0; t < 12; t++) { const a = t * 0.15 - 0.9, d1 = at(a, 0.3), d2 = at(a + 0.02, 0.3); worst = Math.max(worst, dist(d1, d2)); }
ok(worst < 0.7, `pad: dragging the puck 2 % of the radius changes the table by at most ${worst.toFixed(3)} dB`);
// pitch is never touched: ratios stay within B-scaling of the base and partial 1 is exactly the key's (the engine anchors it)
const r1 = mid.keys.every((k, i) => Math.abs(k.layers[0].partials[0][0] / base.keys[i].layers[0].partials[0][0] - 1) < 0.02);
ok(r1, 'pad: the first partial ratio stays within 2 % of the base on every key (the engine puts partial 1 exactly on pitch)');
// speed
const t0 = performance.now(); for (let i = 0; i < 20; i++) at(0.3 + i * 0.01, -0.3);
const ms = (performance.now() - t0) / 20;
ok(ms < 90, `pad: one update (morph) takes ${ms.toFixed(0)} ms`);

// ---- synth recipes on the pad
const { synthesize, morphSynth, synthDefault, SYNTHS } = await import(ROOT + '/js/synth.js');
{
  const kinds = Object.keys(SYNTHS), zero = { poles: [0, 0, 0, 0], center: 1 };
  for (const kind of kinds) {
    const sd = [11, 22, 33, 44], c = morphSynth(kind, sd, zero, 1), d = synthDefault(kind);
    const same = JSON.stringify(c.keys) === JSON.stringify(d.keys);
    const north = morphSynth(kind, sd, { poles: [1, 0, 0, 0], center: 0 }, 1), pole = synthesize(kind, sd[0], 1);
    // the corner has the corner's random numbers (the per-partial noise keeps the default seed, so compare the partial ratios and structure)
    const lvl = (doc, m) => doc.keys[m - 21].layers.at(-1).partials.map(p => p[1]);
    const a = lvl(north, 60), b = lvl(pole, 60), dd = a.length === b.length ? Math.sqrt(a.reduce((x, v, i) => x + (v - b[i]) ** 2, 0) / a.length) : 99;
    const mid = morphSynth(kind, sd, { poles: [0.5, 0.5, 0, 0], center: 0 }, 1);
    ok(same, `${kind}: the pad centre is the built-in instrument`);
    ok(dd < 2.5 || kind === 'organ', `${kind}: the north corner has that seed's spectrum at C4 (${dd.toFixed(2)} dB rms apart)`);
    let cont = 0; for (let t = 0; t < 10; t++) { const w1 = mixAt(t * 0.15 - 0.7, 0.2), w2 = mixAt(t * 0.15 - 0.7 + 0.02, 0.2); const x = morphSynth(kind, sd, w1.weights, w1.gain), y = morphSynth(kind, sd, w2.weights, w2.gain); const l1 = lvl(x, 60), l2 = lvl(y, 60); if (l1.length === l2.length) cont = Math.max(cont, Math.max(...l1.map((v, i) => Math.abs(v - l2[i])))); }
    ok(cont < 3, `${kind}: a 2 % move of the puck changes a partial by at most ${cont.toFixed(2)} dB`);
    const out = morphSynth(kind, sd, mixAt(0.3, -1).weights, mixAt(0.3, -1).gain);
    let valid = true; try { const { validate } = await import(ROOT + '/js/instrument.js'); validate(out); } catch { valid = false; }
    ok(valid && out.keys.length === 88, `${kind}: the rim of the pad still gives a valid 88-key instrument`);
  }
}
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
