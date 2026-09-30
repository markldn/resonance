// Variation audit: seeded variations of the measured Iowa Grand (all amounts) must be valid, playable, in-tune, audible, reproducible
// and different from the base and from each other.
//   node test/generator.test.mjs [--seeds 6]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let seed = 99; Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile, validate } = await import(ROOT + '/js/instrument.js');
const { generate, AMOUNTS } = await import(ROOT + '/js/generator.js');
const BASE = JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8'));
const SEEDS = +arg('seeds', 6); let fails = 0;
const out = [[new Float32Array(128), new Float32Array(128)]];
function render(inst, note, vel, secs) {
  currentFrame = 0; const p = new Proc({ processorOptions: { inst, params: {} } }); p.handle({ type: 'on', note, vel });
  const N = Math.ceil(secs * 48000 / 128), x = new Float32Array(N * 128); let bad = false;
  for (let b = 0; b < N; b++) { p.process([], out); currentFrame += 128; for (let i = 0; i < 128; i++) { const v = out[0][0][i]; if (!Number.isFinite(v)) bad = true; x[b * 128 + i] = v; } }
  return { x, bad };
}
const rms = (x, a, b) => { const s = x.subarray(Math.floor(a * 48000), Math.floor(b * 48000)); let e = 0; for (const v of s) e += v * v; return 10 * Math.log10(e / Math.max(s.length, 1) + 1e-20) / 1; };
function pitchHz(x, lo, hi) {                                  // strongest FFT peak in [lo, hi] over 0.05-0.55 s
  const N = 1 << 15, seg = x.subarray(2400, 2400 + N); let best = 0, bf = 0;
  const w = i => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  for (let f = lo; f <= hi; f *= 1.0006) {                     // ~1 cent grid, Goertzel-style direct DFT
    let re = 0, im = 0, ph = 2 * Math.PI * f / 48000;
    for (let i = 0; i < seg.length; i += 2) { const v = seg[i] * w(i), a = ph * i; re += v * Math.cos(a); im -= v * Math.sin(a); }
    const m = re * re + im * im; if (m > best) { best = m; bf = f; }
  }
  return bf;
}
console.log('amount     seeds  worst  (per instrument: valid, finite, level, pitch, tail)');
const sig = d => JSON.stringify(d.keys.map(k => [k.B, k.level_db, k.layers[k.layers.length - 1].partials.slice(0, 6)]));
for (const [label, amt] of AMOUNTS) {
  const issues = [], sigs = new Set();
  for (let s = 1; s <= SEEDS; s++) {
    let doc, inst;
    try {
      doc = generate(BASE, s * 7919, amt); validate(doc); inst = compile(doc);
      if (sig(doc) !== sig(generate(BASE, s * 7919, amt))) issues.push(`seed ${s}: not reproducible`);
      if (sig(doc) === sig(BASE)) issues.push(`seed ${s}: identical to the base`);
      sigs.add(sig(doc));
    } catch (e) { issues.push(`seed ${s}: ${e.message}`); continue; }
    if (doc.keys.length !== BASE.keys.length) issues.push(`seed ${s}: ${doc.keys.length} keys, base has ${BASE.keys.length}`);
    for (const note of [30, 60, 90]) for (const vel of [40, 110]) {
      const { x, bad } = render(inst, note, vel, 3);
      const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0), tag = `seed ${s} n${note} v${vel}`;
      if (bad) issues.push(`${tag}: NaN/inf`);
      else if (peak < 3e-4) issues.push(`${tag}: inaudible (peak ${peak.toExponential(1)})`);
      else if (peak > 1.0) issues.push(`${tag}: clips (peak ${peak.toFixed(2)})`);
      else {
        const f0 = 440 * Math.pow(2, (note - 69) / 12), pf = pitchHz(x, f0 * 0.93, f0 * 1.08);
        const cents = 1200 * Math.log2(pf / f0);
        if (Math.abs(cents) > 60) issues.push(`${tag}: pitch off ${cents.toFixed(0)} cents (${pf.toFixed(1)} vs ${f0.toFixed(1)} Hz)`);
        if (rms(x, 0, 0.3) - rms(x, 2.4, 3) < 1) issues.push(`${tag}: no decay (tail ${(rms(x, 2.4, 3)).toFixed(0)} dB vs start ${(rms(x, 0, 0.3)).toFixed(0)} dB)`);
      }
    }
  }
  if (sigs.size < SEEDS) issues.push(`only ${sigs.size} distinct instruments from ${SEEDS} seeds`);
  console.log((issues.length ? 'FAIL ' : 'ok   ') + label.padEnd(9) + String(SEEDS).padStart(3) + '  ' + (issues.length ? issues.length + ' issue(s)' : ''));
  for (const i of issues.slice(0, 5)) console.log('       ' + i);
  fails += issues.length;
}
process.exit(fails ? 1 : 0);
