// Level trim: renders every layer of a measured instrument through the real engine and corrects its gain_db until the
// note's attack is as loud as the recording it was measured from (the JavaScript twin of tools/calibrate_levels.py).
// The analyzer's peak level and the engine's loudness are different scales and the difference varies with the key and the spectrum
// (4-9 dB across a keyboard), so without this step a measured instrument plays some keys louder than others.
// P is the engine's processor class (js/engine.worklet.js after registerProcessor); used by js/trim.worker.js and the tests.
import { compile } from './instrument.js';
import { attackLevel } from './analyzer.js';

/** evaluate the engine source in this global scope (a Worker or Node) and return its processor class */
export function loadEngine(source) {
  let Proc = null;
  globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
  globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
  (0, eval)(source);
  return Proc;
}
export function renderNote(P, inst, note, vel, secs, params = { globalRes: 1, sympRes: 1, hammerNoise: 0.8, keyNoise: 0 }) {
  globalThis.currentFrame = 0;
  const p = new P({ processorOptions: { inst, params } });
  p.handle({ type: 'on', note, vel });
  const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(secs * 48000 / 128) * 128, x = new Float32Array(n);
  for (let b = 0; b * 128 < n; b++) { p.process([], o); globalThis.currentFrame += 128; for (let i = 0; i < 128; i++) x[b * 128 + i] = (o[0][0][i] + o[0][1][i]) / 2; }
  return x;
}
/** the playing loudness of the shipped Iowa Grand (dB, attack loudness at strength 72 averaged over its keys; tools/normalise_level.py measures the same) */
export const IOWA_LEVEL = -38.7;
/** mean attack loudness of a document at strength 72 (each key's layer nearest to it) */
export function meanLevel(P, doc) {
  const inst = compile(doc), v = [];
  for (const k of doc.keys) {
    const vel = k.layers.reduce((b, L) => Math.abs(L.velocity - 72) < Math.abs(b - 72) ? L.velocity : b, k.layers[0].velocity);
    const l = attackLevel(renderNote(P, inst, k.note, vel, 0.8), 48000); if (l != null && l > -90) v.push(l);
  }
  return v.reduce((a, b) => a + b, 0) / v.length;
}
/** shift every key's level_db so the instrument plays as loud as the Iowa Grand (an instrument built from a hot recording does not jump in volume) */
export function standardise(P, doc) {
  const shift = IOWA_LEVEL - meanLevel(P, doc); for (const k of doc.keys) k.level_db = +((k.level_db ?? 0) + shift).toFixed(2); return shift;
}
/** targets: [{ note, velocity, level }] with level = attackLevel of the recording; changes doc in place, returns { before, after, layers } (rms level error in dB) */
export function trimCore(P, doc, targets, iters = 3) {
  const want = new Map(targets.map(t => [t.note + '/' + t.velocity, t.level])); let report = null;
  for (let it = 0; it <= iters; it++) {
    const inst = compile(doc), d = [];
    for (const k of doc.keys) for (const L of k.layers) {
      const w = want.get(k.note + '/' + L.velocity); if (w == null) continue;
      const got = attackLevel(renderNote(P, inst, k.note, L.velocity, 0.8), 48000); if (got == null) continue;
      d.push({ L, diff: w - got });
    }
    if (!d.length) break;
    const mean = d.reduce((a, r) => a + r.diff, 0) / d.length;          // the overall loudness of the instrument stays what the document says
    const rms = Math.sqrt(d.reduce((a, r) => a + (r.diff - mean) ** 2, 0) / d.length);
    report = { before: report ? report.before : rms, after: rms, layers: d.length };
    if (it === iters) break;
    for (const r of d) r.L.gain_db = +(r.L.gain_db + Math.max(-12, Math.min(12, r.diff - mean))).toFixed(2);
  }
  if (report) report.shift = standardise(P, doc);
  return report;
}
