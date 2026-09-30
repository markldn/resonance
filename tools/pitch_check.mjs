// node tools/pitch_check.mjs ['{"param":value}'] [vel]  -> per-note cents error of partial 1 against the engine's own target pitch
// (diapason * 2^((m-69)/12) * temperament * stretch). Renders every key, then scans a Hann-windowed DFT around the target.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let s = 7; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile } = await import(ROOT + '/js/instrument.js');
let doc = JSON.parse(fs.readFileSync(ROOT + '/data/measured/' + (process.env.INST || 'iowa_grand') + '.json', 'utf8'));   // INST=salamander_grand for the other built-in
if (process.env.VAR) { const [seed, amt] = process.env.VAR.split(',').map(Number); doc = (await import(ROOT + '/js/generator.js')).generate(doc, seed, amt); }   // VAR=seed,amount checks a generated variation
if (process.env.SYNTH) { const [kind, seed, amt] = process.env.SYNTH.split(','); doc = (await import(ROOT + '/js/synth.js')).synthesize(kind, +seed || 1, +amt || 1); }   // SYNTH=kind,seed,amount checks a synth recipe
const inst = compile(doc);
const extra = process.argv[2] ? JSON.parse(process.argv[2]) : {}, vel = +(process.argv[3] || 80);
const SR = 48000, N = 1 << 16;
// ET=1 reports the error against exact equal temperament instead of the engine's (stretched) target
const ET = process.env.ET === '1';
let worst = 0, sum = 0, n = 0; const bad = [];
for (let m = 21; m <= 108; m++) {
  const p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, hammerNoise: 0, keyNoise: 0, ...extra } } });
  p.handle({ type: 'on', note: m, vel });
  const o = [[new Float32Array(128), new Float32Array(128)]], buf = new Float64Array(N);
  for (let b = 0; b * 128 < N; b++) { p.process([], o); for (let i = 0; i < 128; i++) buf[b * 128 + i] = o[0][0][i] + o[0][1][i]; }
  const f1 = ET ? 440 * Math.pow(2, (m - 69) / 12) : p.ftab[m];
  const mag = f => { let re = 0, im = 0; const w = 2 * Math.PI * f / SR; for (let i = 0; i < N; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N), x = buf[i] * h; re += x * Math.cos(w * i); im += x * Math.sin(w * i); } return re * re + im * im; };
  let best = -1, bc = 0;
  for (let c = -60; c <= 60; c += 2) { const v = mag(f1 * Math.pow(2, c / 1200)); if (v > best) { best = v; bc = c; } }
  let lo = bc - 2, hi = bc + 2;
  for (let it = 0; it < 24; it++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (mag(f1 * Math.pow(2, a / 1200)) < mag(f1 * Math.pow(2, b / 1200))) lo = a; else hi = b; }
  const c = (lo + hi) / 2; sum += Math.abs(c); n++; worst = Math.max(worst, Math.abs(c));
  if (Math.abs(c) > 0.5) bad.push(`${m}:${c.toFixed(2)}`);
}
console.log(`params ${JSON.stringify(extra)} vel ${vel}: mean |err| ${(sum / n).toFixed(3)} cents, worst ${worst.toFixed(2)}, >0.5c: ${bad.join(' ') || 'none'}`);
