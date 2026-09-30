// No silent sliders: node test/sliders.test.mjs [--only synthKind]
// For every instrument and every engine slider: if the page shows it as usable it must change the sound (end points vs the default), and if
// the page greys it (js/instrument.js inertParams) it must not. Sliders that act outside the engine (reverb, pitch-bend range, polyphony cap)
// are not part of this.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let s = 7; const reseed = () => { s = 7; }; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile, inertParams } = await import(ROOT + '/js/instrument.js');
const { synthesize, SYNTHS } = await import(ROOT + '/js/synth.js');
const { PARAMS } = await import(ROOT + '/js/params.js');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const SR = 48000, OUTSIDE = new Set(['wet', 'duration', 'roomSize', 'bendRange', 'polyphony']);
const docs = { iowa_grand: JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')), salamander_grand: JSON.parse(fs.readFileSync(ROOT + '/data/measured/salamander_grand.json', 'utf8')) };
for (const k of Object.keys(SYNTHS)) docs[k] = synthesize(k, 1, 1);
// instruments built from your own recordings (tools/build_sampled_set.py): SAMPLED=dir (optional)
const sdir = process.env.SAMPLED;
if (sdir && fs.existsSync(sdir) && !process.argv.includes('--no-sampled')) for (const f of fs.readdirSync(sdir).filter(f => f.endsWith('.json')).sort()) docs['sampled/' + f.replace('.json', '')] = JSON.parse(fs.readFileSync(sdir + '/' + f, 'utf8'));

// what to play so that a slider has something to act on; the events are engine messages at a time in seconds
function stimulus(id) {
  const play = (note, vel, extra = [], win) => ({ ev: [{ t: 0, m: { type: 'on', note, vel } }, ...extra], secs: 2.5, win });
  switch (id) {
    case 'hardP': return play(52, 32);
    case 'hardM': return play(52, 64);
    case 'hardF': return play(52, 100);
    case 'softSmooth': return { ev: [{ t: 0, m: { type: 'pedal', which: 'soft', value: 1 } }, { t: 0.05, m: { type: 'on', note: 52, vel: 60 } }], secs: 2.5 };
    case 'sympRes': return { ev: [64, 67, 72, 76].map(n => ({ t: 0, m: { type: 'on', note: n, vel: 0, silent: true } })).concat([{ t: 0.1, m: { type: 'on', note: 52, vel: 100 } }]), secs: 3 };
    case 'hammerNoise': return play(52, 110, [], [0, 0.04]);                   // the strike itself, not the whole note
    case 'sbCutoff': return play(100, 120);                                     // the cut-off only reaches high, bright partials
    case 'sbQ': return { ...play(100, 120), base: { sbCutoff: 0.05 } };          // the slope only matters once the corner is low
    case 'direct': case 'impedance': return play(60, 120);
    case 'dynamics': return play(52, 40);                                        // dynamics scales the gap between soft and loud layers
    case 'keyNoise': case 'damperNoise': return play(40, 80, [{ t: 1.0, m: { type: 'off', note: 40 } }], [1.0, 1.05]);   // the release click
    case 'whoosh': return { ev: [{ t: 0, m: { type: 'on', note: 52, vel: 90 } }, { t: 0.8, m: { type: 'pedal', which: 'sustain', value: 1 } }, { t: 1.4, m: { type: 'pedal', which: 'sustain', value: 0 } }], secs: 2.5, win: [0.8, 0.9] };
    case 'unison': case 'width': return play(84, 90);
    default: return play(52, 90);
  }
}
function render(inst, params, st) {
  reseed();
  const p = new Proc({ processorOptions: { inst, params: { polyphony: 96, ...params } } });
  const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(st.secs * SR / 128), x = new Float64Array(n * 256), ev = [...st.ev].sort((a, b) => a.t - b.t);
  let e = 0;
  for (let b = 0; b < n; b++) {
    while (e < ev.length && ev[e].t * SR <= b * 128) p.handle(ev[e++].m);
    p.process([], o); currentFrame += 128;
    for (let i = 0; i < 128; i++) { x[b * 256 + i] = o[0][0][i]; x[b * 256 + 128 + i] = o[0][1][i]; }
  }
  return x;
}
const peakRes = (a, b, win) => { let d = 0, pk = 0; const lo = Math.floor(win[0] * SR / 128) * 256, hi = Math.floor(win[1] * SR / 128) * 256; for (let i = 0; i < a.length; i++) pk = Math.max(pk, Math.abs(a[i])); for (let i = lo; i < hi; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return 20 * Math.log10(d / (pk + 1e-30) + 1e-30); };   // a click against the note's own peak
const residual = (a, b, win) => { let e = 0, r = 0; const lo = win ? Math.floor(win[0] * SR / 128) * 256 : 0, hi = win ? Math.floor(win[1] * SR / 128) * 256 : a.length; for (let i = lo; i < hi; i++) { e += (a[i] - b[i]) ** 2; r += a[i] ** 2; } return 10 * Math.log10(e / (r + 1e-30) + 1e-30); };

let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const NOISY = new Set(['hammerNoise', 'keyNoise', 'whoosh']);       // short clicks: judged by their peak in a short window at the event, against the note's own peak
const sliders = PARAMS.filter(d => typeof d.def === 'number' && d.max !== d.min && !OUTSIDE.has(d.id));
for (const [name, doc] of Object.entries(docs)) {
  if (only && name !== only) continue;
  const inst = compile(doc), inert = inertParams(inst), wrong = [], dead = [];
  for (const d of sliders) {
    const st = stimulus(d.id), b0 = st.base || {}, base = render(inst, b0, st);
    let best = -999;
    for (const v of [d.min, d.max]) if (v !== d.def) best = Math.max(best, NOISY.has(d.id) ? peakRes(base, render(inst, { ...b0, [d.id]: v }, st), st.win) : residual(base, render(inst, { ...b0, [d.id]: v }, st), st.win));
    const acts = best > (NOISY.has(d.id) ? -50 : -30); if (process.env.SHOWDB && NOISY.has(d.id)) console.log("  ", name, d.id, best.toFixed(1));              // 3 % of the sound's own level (a click: 0.3 % of the note's peak): below that it is inaudible
    if (!inert[d.id] && !acts) dead.push(`${d.id} (${best.toFixed(0)} dB)`);
    if (inert[d.id] && acts) wrong.push(`${d.id} (${best.toFixed(0)} dB)`);
  }
  ok(!dead.length, `${name}: every slider not greyed out changes the sound` + (dead.length ? ' - DEAD: ' + dead.join(', ') : ` (${sliders.length - Object.keys(inert).filter(k => sliders.some(d => d.id === k)).length} live, ${Object.keys(inert).filter(k => sliders.some(d => d.id === k)).length} greyed)`));
  ok(!wrong.length, `${name}: no greyed-out slider changes the sound` + (wrong.length ? ' - WRONG: ' + wrong.join(', ') : ''));
}
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
