// node test/render.mjs NOTE VEL SECONDS out.f32  -> mono float32 at 48 kHz (params default, reverb/cabinet off in engine path)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let s = 7; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile } = await import(ROOT + '/js/instrument.js');
const inst = compile(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')));
const [note, vel, secs, out] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5]];
const extra = process.argv[6] ? JSON.parse(process.argv[6]) : {};
const p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, hammerNoise: 0, ...extra } } });
p.handle({ type: 'on', note, vel });
const o = [[new Float32Array(128), new Float32Array(128)]], buf = new Float32Array(Math.ceil(secs * 48000 / 128) * 128);
for (let b = 0; b * 128 < buf.length; b++) { p.process([], o); currentFrame += 128; for (let i = 0; i < 128; i++) buf[b * 128 + i] = (o[0][0][i] + o[0][1][i]) / 2; }
fs.writeFileSync(out, Buffer.from(buf.buffer));
