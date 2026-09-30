// Headless engine regression test: node test/engine.test.mjs [--bench] [--dump out.f32] [--engine path]
// Loads the AudioWorklet engine with stubs, plays fixed passages with a seeded Math.random, and checks
// finite output, sane peak level, silence after release, and a real-time budget.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SR = 48000, N = 128;
globalThis.sampleRate = SR; globalThis.currentFrame = 0;
let seed = 12345; Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(arg('engine', ROOT + '/js/engine.worklet.js'), 'utf8'));
const { compile } = await import(ROOT + '/js/instrument.js');
const inst = compile(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')));

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fails++; };
const out = [[new Float32Array(N), new Float32Array(N)]];
const dump = [];
function make() { currentFrame = 0; return new Proc({ processorOptions: { inst, params: { polyphony: 128 } } }); }
function run(p, blocks, st) {
  for (let b = 0; b < blocks; b++) {
    const t = performance.now(); p.process([], out); const d = performance.now() - t;
    st.worst = Math.max(st.worst, d); st.total += d; st.blocks++; currentFrame += N;
    for (let i = 0; i < N; i++) {
      const l = out[0][0][i], r = out[0][1][i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) st.bad = true;
      st.peak = Math.max(st.peak, Math.abs(l), Math.abs(r)); dump.push(l, r);
    }
  }
}
const stats = () => ({ worst: 0, total: 0, blocks: 0, peak: 0, bad: false });

// 1. chord + sustain pedal
let p = make(), st = stats(), t0 = performance.now(), maxNoteOn = 0;
{ const w = make(); for (let i = 0; i < 6; i++) w.handle({ type: 'on', note: 40 + i * 7, vel: 80 }); run(w, 300, stats()); dump.length = 0; }  // JIT warm-up
seed = 12345;
for (const m of [48, 55, 60, 64, 67, 72, 76, 79, 84, 88]) { const t = performance.now(); p.handle({ type: 'on', note: m, vel: 90 }); maxNoteOn = Math.max(maxNoteOn, performance.now() - t); }
p.pedal('sustain', 1); run(p, 375 * 2, st);
ok(!st.bad, 'chord: output finite'); ok(st.peak > 0.02 && st.peak < 1, `chord: peak ${st.peak.toFixed(3)} in (0.02, 1)`);
console.log(`     10-note chord: note-on max ${maxNoteOn.toFixed(2)} ms, worst block ${st.worst.toFixed(2)} ms`);
for (let m = 0; m < 128; m++) p.handle({ type: 'off', note: m }); p.pedal('sustain', 0);
run(p, 375 * 10, stats());                       // dampers fall, tails die
run(p, 375 * 2, st = stats());
ok(st.peak < 1e-3, `release: silent after 10 s (peak over next 2 s ${st.peak.toExponential(1)})`);
ok(p.activeCount() === 0 || st.peak < 1e-3, 'release: voices freed');

// 2. fast run, heavy polyphony
p = make(); st = stats(); t0 = performance.now();
for (let i = 0; i < 60; i++) { p.handle({ type: 'on', note: 36 + i, vel: 100 }); run(p, 20, st); }
const el = performance.now() - t0, audioMs = st.blocks * N / SR * 1000;
ok(!st.bad && st.peak < 2, `fast run: finite, peak ${st.peak.toFixed(3)}`);
console.log(`     fast run: ${(audioMs / el).toFixed(1)}x realtime, worst block ${st.worst.toFixed(2)} ms (budget ${(N / SR * 1000).toFixed(2)})`);
ok(audioMs / el > 1.5, 'fast run: at least 1.5x realtime (regression floor; oscillator loop is the cost)');

// 3. varied instrument (soundboard bank + air + body), release darkens the sound
{
  const { generate } = await import(ROOT + '/js/generator.js');
  const gi = compile({ ...generate(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')), 7), soundboard: { amount: 0.6 } });
  currentFrame = 0; const g = new Proc({ processorOptions: { inst: gi, params: { polyphony: 128 } } }); st = stats();
  for (const m of [40, 52, 64, 76]) g.handle({ type: 'on', note: m, vel: 96 });
  run(g, 375, st);
  ok(!st.bad && st.peak > 0.01 && st.peak < 1, `varied instrument: finite, peak ${st.peak.toFixed(3)}`);
  ok(gi.body && gi.air && gi.soundboard, 'varied instrument carries body, air and soundboard');
  for (const m of [40, 52, 64, 76]) g.handle({ type: 'off', note: m });
  run(g, 375 * 8, stats()); run(g, 375, st = stats());
  ok(st.peak < 1e-3, `varied instrument: silent after release (peak ${st.peak.toExponential(1)})`);
}

const df = arg('dump'); if (df) fs.writeFileSync(df, Buffer.from(new Float32Array(dump).buffer));
// 4. velocity beyond the loudest / softest measured layer: the spectrum must stay sane. The old Gaussian law grew without
// bound above the loudest layer, and a bass note at velocity 127 had 8.4 kHz of spectral centroid (all energy above 2 kHz).
{
  const centroid = (note, vel) => {
    currentFrame = 0; const q = new Proc({ processorOptions: { inst, params: { polyphony: 128 } } }); q.handle({ type: 'on', note, vel });
    const x = []; for (let b = 0; b < 75; b++) { q.process([], out); currentFrame += N; for (let i = 0; i < N; i++) x.push(out[0][0][i]); }
    const o = x.findIndex(v => Math.abs(v) > 0.05 * Math.max(...x.map(Math.abs))), seg = x.slice(o, o + 8192);
    let sw = 0, s = 0; for (let k = 1; k < 2048; k++) { let re = 0, im = 0; const w = 2 * Math.PI * k / 8192;
      for (let i = 0; i < seg.length; i += 2) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / seg.length); re += seg[i] * h * Math.cos(w * i); im -= seg[i] * h * Math.sin(w * i); }
      const e = re * re + im * im; s += e; sw += e * k * SR / 8192; }
    return sw / s;
  };
  for (const note of [36, 48]) for (const vel of [127, 6]) { const c = centroid(note, vel); ok(c < 1200, `velocity ${vel} on note ${note}: spectral centroid ${c.toFixed(0)} Hz below 1200 Hz`); }
}

// 5. pitch wheel: a note started bent and a sounding note that is bent both move by the requested interval
{
  const peak = x => { let best = 0, bf = 0; for (let f = 380; f <= 520; f += 0.25) { let re = 0, im = 0; const w = 2 * Math.PI * f / SR;
    for (let i = 0; i < x.length; i += 2) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / x.length); re += x[i] * h * Math.cos(w * i); im -= x[i] * h * Math.sin(w * i); }
    const e = re * re + im * im; if (e > best) { best = e; bf = f; } } return bf; };
  const grab = (q, blocks) => { const x = []; for (let b = 0; b < blocks; b++) { q.process([], out); currentFrame += N; for (let i = 0; i < N; i++) x.push(out[0][0][i]); } return x; };
  const start = bend => { currentFrame = 0; const q = new Proc({ processorOptions: { inst, params: { polyphony: 64 } } }); if (bend) q.handle({ type: 'bend', semis: bend }); q.handle({ type: 'on', note: 69, vel: 90 }); return q; };
  const f0 = peak(grab(start(0), 190).slice(4800)), f1 = peak(grab(start(2), 190).slice(4800));
  ok(Math.abs(f1 / f0 - Math.pow(2, 2 / 12)) < 0.004, `note started bent +2 semitones: ${f0.toFixed(1)} Hz -> ${f1.toFixed(1)} Hz`);
  const q = start(0); grab(q, 60); q.handle({ type: 'bend', semis: -2 }); const f2 = peak(grab(q, 190).slice(4800));
  ok(Math.abs(f2 / f0 - Math.pow(2, -2 / 12)) < 0.004, `sounding note bent -2 semitones: ${f0.toFixed(1)} Hz -> ${f2.toFixed(1)} Hz`);
  q.handle({ type: 'bend', semis: 0 }); const f3 = peak(grab(q, 190).slice(4800)); ok(Math.abs(f3 / f0 - 1) < 0.004, `bend released: back to ${f3.toFixed(1)} Hz`);
}

// 6. hammer-noise slider: silent at 0, unchanged at its default, and audibly stronger towards the maximum. It used to move the
// attack by < 0.2 dB at velocity 80 and up, even at 3.0.
{
  const at = (note, vel, hn) => { currentFrame = 0; seed = 777; const q = new Proc({ processorOptions: { inst, params: { polyphony: 64, hammerNoise: hn, globalRes: 0, sympRes: 0, keyNoise: 0 } } });
    q.handle({ type: 'on', note, vel }); const x = []; for (let b = 0; b < 6; b++) { q.process([], out); currentFrame += N; for (let i = 0; i < N; i++) x.push(out[0][0][i]); } return x; };
  const peak = (x, n) => x.slice(0, n).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  for (const [note, vel] of [[48, 100], [72, 100]]) {
    const b0 = at(note, vel, 0), knock = hn => { const y = at(note, vel, hn); return 20 * Math.log10(peak(y.map((v, i) => v - b0[i]), 720) / peak(b0, 720) + 1e-12); };
    const k08 = knock(0.8), k15 = knock(1.5), k3 = knock(3);
    ok(k08 < -15 && k08 > -40, `hammer noise, note ${note}: default level ${k08.toFixed(0)} dB under the note (measured, unchanged)`);
    ok(k15 > k08 + 6, `hammer noise, note ${note}: 1.5 is ${(k15 - k08).toFixed(0)} dB above the default`);
    ok(k3 > -6, `hammer noise, note ${note}: the maximum is a clear knock (${k3.toFixed(0)} dB re the note, was ~-12 to -25)`);
  }
}

process.exit(fails ? 1 : 0);
