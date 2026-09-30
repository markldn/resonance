// Batch offline renderer used by tools/calibrate_to_recordings.py.
//   node test/render_batch.mjs instrument.json jobs.json out.f32
// jobs: [{note, vel, secs, params?}] -> out.f32 = mono float32 (48 kHz) of all jobs back to back.
// Engine as shipped, deterministic (seeded Math.random); cabinet/sympathetic/hammer noise off (partial model only).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let s = 7; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile } = await import(ROOT + '/js/instrument.js');
const inst = compile(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
const jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const o = [[new Float32Array(128), new Float32Array(128)]];
const chunks = [];
for (const j of jobs) {
  currentFrame = 0; s = 7;
  const p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, hammerNoise: 0, keyNoise: 0, ...(j.params || {}) } } });
  p.handle({ type: 'on', note: j.note, vel: j.vel });
  const n = Math.ceil(j.secs * 48000 / 128) * 128, buf = new Float32Array(n);
  let off = j.off != null;
  for (let b = 0; b * 128 < n; b++) { if (off && b * 128 / 48000 >= j.off) { p.handle({ type: 'off', note: j.note }); off = false; } p.process([], o); currentFrame += 128; for (let i = 0; i < 128; i++) buf[b * 128 + i] = (o[0][0][i] + o[0][1][i]) / 2; }
  chunks.push(Buffer.from(buf.buffer));
}
fs.writeFileSync(process.argv[4], Buffer.concat(chunks));
