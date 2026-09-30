// Synth recipes (js/synth.js) through the real engine: node test/synth.test.mjs
// For every recipe: a valid table, finite audible output that does not clip, the lowest partial exactly on the key,
// and no piano behaviour left over (a held organ note does not decay, every key releases, including those above the 88th).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let s = 7; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile, validate } = await import(ROOT + '/js/instrument.js');
const { synthesize, SYNTHS } = await import(ROOT + '/js/synth.js');
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fails++; };
const SR = 48000;

function render(inst, note, vel, secs, offAt, params = {}) {
  const p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, ...params } } });
  p.handle({ type: 'on', note, vel });
  const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(secs * SR / 128), x = new Float64Array(n * 128);
  for (let b = 0; b < n; b++) {
    if (offAt != null && b === Math.round(offAt * SR / 128)) p.handle({ type: 'off', note });
    p.process([], o); for (let i = 0; i < 128; i++) x[b * 128 + i] = (o[0][0][i] + o[0][1][i]) / 2;
  }
  return { x, p };
}
const rms = (x, a, b) => { const q = x.subarray(Math.floor(a * SR), Math.floor(b * SR)); let e = 0; for (const v of q) e += v * v; return 20 * Math.log10(Math.sqrt(e / q.length) + 1e-12); };
function centsOff(x, f) {                                    // partial 1 against f, Hann-windowed DFT, golden-ish search over +-40 cents
  const N = 1 << 15, w = 2 * Math.PI / SR, mag = c => { const ff = f * Math.pow(2, c / 1200); let re = 0, im = 0; for (let i = 0; i < N; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N), v = x[i + 2000] * h; re += v * Math.cos(w * ff * i); im += v * Math.sin(w * ff * i); } return re * re + im * im; };
  let best = 0, bc = -40; for (let c = -40; c <= 40; c += 2) { const v = mag(c); if (v > best) { best = v; bc = c; } }
  let lo = bc - 2, hi = bc + 2; for (let i = 0; i < 20; i++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (mag(a) < mag(b)) lo = a; else hi = b; }
  return (lo + hi) / 2;
}

for (const kind of Object.keys(SYNTHS)) {
  const doc = synthesize(kind, 4242, 1);
  let valid = true; try { validate(doc); } catch { valid = false; }
  ok(valid, `${kind}: valid table (${doc.keys.length} keys)`);
  ok(JSON.stringify(doc) === JSON.stringify(synthesize(kind, 4242, 1)) && JSON.stringify(doc) !== JSON.stringify(synthesize(kind, 4243, 1)), `${kind}: same seed same table, other seed other table`);
  const inst = compile(doc);
  const problems = [], off = [];
  for (const note of [24, 48, 72, 96, 105]) for (const vel of [30, 110]) {
    const { x } = render(inst, note, vel, 1.2, null, vel === 110 ? { unison: 0 } : {});   // string spread 0: the beating strings would split the peak
    let peak = 0, bad = false; for (const v of x) { if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); }
    if (bad || peak < 3e-4 || peak > 1) problems.push(`n${note} v${vel} peak ${peak.toExponential(1)}${bad ? ' NaN' : ''}`);
    if (vel === 110 && !SYNTHS[kind].fixed) { const c = centsOff(x, 440 * Math.pow(2, (note - 69) / 12)); if (Math.abs(c) > 3) off.push(`n${note} ${c.toFixed(1)}c`); }   // a drum kit's keys are drums, not pitches
  }
  ok(!problems.length, `${kind}: finite, audible, not clipping` + (problems.length ? ' ' + problems.join(', ') : ''));
  ok(!off.length, `${kind}: lowest partial within 3 cents of the key at stretch default` + (off.length ? ' ' + off.join(', ') : ''));
  // released keys stop, on every key (a piano has no dampers above key 88)
  const slow = [], oneShot = !!doc.engine.oneshot, need = Math.min(30, 0.7 * 8.686 * 1.6 / (doc.engine.release_s || 0.2));   // the damper's own time constant, with a margin

  for (const note of [40, 70, 100, 106]) {
    const { x } = render(inst, note, 90, 3.2, 1.0);
    const before = rms(x, 0.6, 1.0), after = rms(x, 2.6, 3.2);
    if (!oneShot && before > -60 && before - after < need) slow.push(`n${note} ${(before - after).toFixed(0)} dB`);
  }
  ok(!slow.length, `${kind}: every key falls by its damper's rate (${need.toFixed(0)} dB) in the 1.6 s after release` + (slow.length ? ' ' + slow.join(', ') : ''));
}
// organ: a held note does not decay
{
  const inst = compile(synthesize('organ', 1, 1)), { x } = render(inst, 60, 90, 4);
  const d = rms(x, 1.5, 2) - rms(x, 3.4, 3.9);
  ok(Math.abs(d) < 1.5, `organ: level moves ${d.toFixed(2)} dB between 1.7 s and 3.6 s (a held organ note stays)`);
}
// engine features an instrument can switch on
function stereo(kind, note, vel, secs, params = {}) {
  const inst = compile(synthesize(kind, 7, 1)), p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, unison: 0, ...params } } });
  p.handle({ type: 'on', note, vel });
  const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(secs * SR / 128), L = new Float64Array(n * 128), R = new Float64Array(n * 128);
  for (let b = 0; b < n; b++) { p.process([], o); for (let i = 0; i < 128; i++) { L[b * 128 + i] = o[0][0][i]; R[b * 128 + i] = o[0][1][i]; } }
  return { L, R };
}
const HOP = 480, envDb = x => { const e = []; for (let i = 0; i + HOP <= x.length; i += HOP) { let a = 0; for (let j = 0; j < HOP; j++) a += x[i + j] ** 2; e.push(10 * Math.log10(a / HOP + 1e-20)); } return e; };
function swing(e) {                                              // dominant 1-12 Hz component of the dB envelope (trend removed): [Hz, dB swing]
  const w = 30, x = e.slice(150, 500), c = x.map((v, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - w); j < Math.min(x.length, i + w + 1); j++) { a += x[j]; n++; } return v - a / n; }).slice(w, x.length - w);
  let bf = 0, bm = 0; for (let f = 1; f <= 12; f += 0.05) { let re = 0, im = 0; for (let i = 0; i < c.length; i++) { re += c[i] * Math.cos(2 * Math.PI * f * i * HOP / SR); im += c[i] * Math.sin(2 * Math.PI * f * i * HOP / SR); } const m = Math.hypot(re, im) * 2 / c.length; if (m > bm) { bm = m; bf = f; } }
  return [bf, bm];
}
{
  const rise = (kind) => { const { L } = stereo(kind, 60, 100, 2), a = envDb(L).map(v => Math.pow(10, v / 20)); let pk = 0, pi = 0; for (let i = 0; i < 150; i++) if (a[i] > pk) { pk = a[i]; pi = i; } let t10 = 0, t90 = 0; for (let i = 0; i <= pi; i++) { if (!t10 && a[i] > 0.1 * pk) t10 = i; if (!t90 && a[i] > 0.9 * pk) t90 = i; } return (t90 - t10) * HOP / SR * 1000; };
  const rp = rise('pad'), ro = (() => { const { L } = stereo('organ', 60, 100, 2, { modulation: 0 }), a = envDb(L).map(v => Math.pow(10, v / 20)); let pk = 0, pi = 0; for (let i = 0; i < 150; i++) if (a[i] > pk) { pk = a[i]; pi = i; } let t10 = 0, t90 = 0; for (let i = 0; i <= pi; i++) { if (!t10 && a[i] > 0.1 * pk) t10 = i; if (!t90 && a[i] > 0.9 * pk) t90 = i; } return (t90 - t10) * HOP / SR * 1000; })();
  ok(rp > 300 && rp < 700, `attack_s: the pad rises in ${rp.toFixed(0)} ms (engine.attack_s 450)`);
  ok(ro < 40, `attack_s: the organ rises in ${ro.toFixed(0)} ms (engine.attack_s 6)`);
  for (const [kind, hz, depthDb] of [['epiano', 5.4, 1.2], ['vibraphone', 5.6, 2]]) {
    const { L, R } = stereo(kind, 60, 100, 6), [fl, ml] = swing(envDb(L)), [fr, mr] = swing(envDb(R));
    ok(Math.abs(fl - hz) < 0.3 && Math.abs(fr - hz) < 0.3 && ml > depthDb && mr > depthDb, `tremolo: ${kind} moves both channels at ${fl.toFixed(2)} / ${fr.toFixed(2)} Hz (spec ${hz}), swing ${ml.toFixed(1)} / ${mr.toFixed(1)} dB`);
    const off = stereo(kind, 60, 100, 6, { modulation: 0 }), [, m0] = swing(envDb(off.L));
    ok(m0 < 0.3, `tremolo: ${kind} with the Modulation slider at 0 has ${m0.toFixed(2)} dB swing`);
  }
  // epiano tremolo is an auto-pan: the two channels move in opposite directions (their levels are anti-correlated)
  const { L, R } = stereo('epiano', 60, 100, 6), eL = envDb(L).slice(150, 450), eR = envDb(R).slice(150, 450), avg = a => a.reduce((x, y) => x + y) / a.length;
  const dl = eL.map((v, i) => v - avg(eL.slice(Math.max(0, i - 30), i + 31))), dr = eR.map((v, i) => v - avg(eR.slice(Math.max(0, i - 30), i + 31)));
  const corr = dl.reduce((a, v, i) => a + v * dr[i], 0) / Math.sqrt(dl.reduce((a, v) => a + v * v, 0) * dr.reduce((a, v) => a + v * v, 0));
  ok(corr < -0.8, `epiano: channel levels are anti-correlated (${corr.toFixed(2)}): an auto-pan`);
  // anchor: the bell's prime is on the key and its hum one octave below; the organ's 8' on the key and its 16' an octave below
  for (const kind of ['bell', 'organ']) {
    const { x } = render(compile(synthesize(kind, 7, 1)), 60, 100, 1.2, null, { unison: 0 });
    const f = 440 * Math.pow(2, -9 / 12), c1 = centsOff(x, f), c0 = centsOff(x, f / 2);
    ok(Math.abs(c1) < 3 && Math.abs(c0) < 3, `anchor: ${kind} has its key pitch (${c1.toFixed(1)} c) and a partial one octave below (${c0.toFixed(1)} c)`);
  }
  // the instrument's recommended slider values sit under explicit ones: no params -> its defaults; explicit -> those
  const inst = compile(synthesize('epiano', 7, 1)), pd = new Proc({ processorOptions: { inst, params: {} } }), pe = new Proc({ processorOptions: { inst, params: { stretch: 1, globalRes: 2 } } });
  ok(pd.p.stretch === 0 && pd.p.globalRes === 0.5 && pd.p.hammerNoise === 0.35, `engine.params: defaults come from the instrument (stretch ${pd.p.stretch}, cabinet ${pd.p.globalRes}, thump ${pd.p.hammerNoise})`);
  ok(pe.p.stretch === 1 && pe.p.globalRes === 2, 'engine.params: an explicit slider value wins over the instrument default');
  pd.port.onmessage({ data: { type: 'inst', data: compile(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8'))) } });   // the message the page sends
  ok(pd.p.stretch === 1 && pd.p.globalRes === 1, `engine.params: switching to a piano gives the piano defaults back (stretch ${pd.p.stretch}, cabinet ${pd.p.globalRes})`);
}
// the engine block: an instrument without one plays exactly as before (piano defaults), one that says knock 0 has no noise part
{
  const t = JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8'));
  const a = render(compile(t), 100, 80, 1.5, null, { hammerNoise: 1 }).x, b = render(compile({ ...t, engine: { knock: 0, dampers: 'all' } }), 100, 80, 1.5, null, { hammerNoise: 1 }).x;
  let diff = 0; for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  ok(diff > 0, 'engine block: knock 0 changes the note (the hammer noise is gone)');
}
// layered instruments (the instrument mix pad): inst.multi = [{ inst, w }]
{
  const { mixCompiled } = await import(ROOT + '/js/instrument.js');
  const piano = compile(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8'))), organ = compile(synthesize('organ', 3, 1)), bell = compile(synthesize('bell', 1, 1));
  const rmsAll = x => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  const r = (inst, secs = 1.5, off = null) => { s = 7; return render(inst, 60, 100, secs, off, { globalRes: 0, sympRes: 0, hammerNoise: 0, unison: 0 }).x; };
  const plain = r(piano), solo = r(mixCompiled([{ inst: piano, w: 1 }, { inst: bell, w: 0 }]));
  let same = 0; for (let i = 0; i < plain.length; i++) same = Math.max(same, Math.abs(plain[i] - solo[i]));
  ok(same < 1e-9, `mix: a single part at weight 1 is the plain instrument (max difference ${same.toExponential(1)})`);
  const a = r(piano), b = r(bell), both = r(mixCompiled([{ inst: piano, w: 0.5 }, { inst: bell, w: 0.5 }]));
  const ra = rmsAll(a), rb = rmsAll(b), rm = rmsAll(both), expect = Math.sqrt(0.5 * ra * ra + 0.5 * rb * rb);
  ok(Math.abs(20 * Math.log10(rm / expect)) < 1.5, `mix: 50/50 has the power of the two parts (${(20 * Math.log10(rm / expect)).toFixed(2)} dB from equal-power sum)`);
  const f = 440 * Math.pow(2, -9 / 12);
  ok(Math.abs(centsOff(both, f)) < 3 && Math.abs(centsOff(both, f / 2)) < 3, 'mix: the piano note and the bell hum an octave below are both present, in tune');
  // release: piano part and organ part each release by their own rule (organ 35 ms, piano its own damper)
  const rel = (inst) => { const x = r(inst, 3.2, 1.0); return rms(x, 0.6, 1.0) - rms(x, 2.6, 3.2); };
  const dOrgan = rel(mixCompiled([{ inst: organ, w: 1 }])), dMix = rel(mixCompiled([{ inst: piano, w: 0.5 }, { inst: organ, w: 0.5 }]));
  ok(dOrgan > 30 && dMix > 30, `mix: released notes of a piano+organ mix fall ${dMix.toFixed(0)} dB (organ alone ${dOrgan.toFixed(0)} dB)`);
  // live weights: {type:'mixw'} changes the next note
  const m = mixCompiled([{ inst: piano, w: 1 }, { inst: bell, w: 0 }]);
  s = 7; const pw = new Proc({ processorOptions: { inst: m, params: { globalRes: 0, sympRes: 0, hammerNoise: 0, unison: 0 } } });
  pw.port.onmessage({ data: { type: 'mixw', w: [0, 1] } });
  const o = [[new Float32Array(128), new Float32Array(128)]], xs = new Float64Array(SR); pw.handle({ type: 'on', note: 60, vel: 100 });
  for (let bl = 0; bl * 128 < SR; bl++) { pw.process([], o); for (let i = 0; i < 128 && bl * 128 + i < SR; i++) xs[bl * 128 + i] = o[0][0][i]; }
  let dd = 0; for (let i = 0; i < SR; i++) dd = Math.max(dd, Math.abs(xs[i] - b[i]));
  ok(rmsAll(xs) > 1e-4 && Math.abs(20 * Math.log10(rmsAll(xs) / rmsAll(b.subarray(0, SR)))) < 1.5, 'mix: mixw [0, 1] turns the next note into the bell alone');
}
// ---- the recipes that use the synth-voice features
{
  const { synthDefault } = await import(ROOT + '/js/synth.js');
  const R = (kind, note, vel, secs, ev = [], params = {}) => { s = 7; const inst = compile(synthDefault(kind)), p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, hammerNoise: 0.8, keyNoise: 0, unison: 0, ...params } } }); const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(secs * SR / 128), x = new Float64Array(n * 128), e = [{ t: 0, m: { type: 'on', note, vel } }, ...ev].sort((a, b) => a.t - b.t); let k = 0; for (let b = 0; b < n; b++) { while (k < e.length && e[k].t * SR <= b * 128) p.handle(e[k++].m); p.process([], o); for (let i = 0; i < 128; i++) x[b * 128 + i] = 0.5 * (o[0][0][i] + o[0][1][i]); } return x; };
  const amp = (x, f, t0, t1) => { const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR); let re = 0, im = 0, w = 2 * Math.PI * f / SR, ws = 0; for (let i = a; i < b; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a)); re += x[i] * h * Math.cos(w * i); im += x[i] * h * Math.sin(w * i); ws += h; } return 2 * Math.hypot(re, im) / ws; };
  const lin = (x, a, b) => Math.pow(10, rms(x, a, b) / 20);        // rms() above is in dB
  // drums: every General MIDI key of the kit
  {
    const bad = [];
    for (let note = 35; note <= 81; note++) for (const vel of [25, 80, 127]) {
      const x = R('drums', note, vel, 4.5); let pk = 0, nan = false; for (const v of x) { if (!Number.isFinite(v)) nan = true; pk = Math.max(pk, Math.abs(v)); }
      if (nan || pk < 2e-3 || pk > 1 || lin(x, 4.0, 4.5) > 1e-3) bad.push(`n${note} v${vel} peak ${pk.toFixed(3)} tail ${lin(x, 4, 4.5).toExponential(1)}`);
    }
    ok(!bad.length, `drums: keys 35-81 at three velocities are finite, audible, not clipping and finished by 4 s` + (bad.length ? ' ' + bad.slice(0, 4).join('; ') : ''));
    const off = R('drums', 38, 100, 1.2, [{ t: 0.1, m: { type: 'off', note: 38 } }]), held = R('drums', 38, 100, 1.2);
    ok(Math.abs(rms(off, 0.3, 0.5) - rms(held, 0.3, 0.5)) < 0.5, 'drums: a struck drum rings out whether the key is released or not (oneshot)');
    const kick = R('drums', 36, 110, 0.8), f = (x, t) => { let best = 0, bf = 0; for (let fr = 30; fr < 400; fr += 1) { const a = amp(x, fr, t, t + 0.04); if (a > best) { best = a; bf = fr; } } return bf; };
    ok(f(kick, 0.005) > 1.5 * f(kick, 0.35), `drums: the kick drops in pitch (${f(kick, 0.005)} Hz at 5 ms, ${f(kick, 0.35)} Hz at 350 ms)`);
    const snare = R('drums', 38, 100, 0.6), cent = x => { let a = 0, b = 0; for (let fr = 200; fr < 12000; fr += 100) { const v = amp(x, fr, 0.02, 0.12); a += v * fr; b += v; } return a / b; };
    ok(cent(snare) > 1800, `drums: the snare has its wires (spectral centroid ${cent(snare).toFixed(0)} Hz in the first 120 ms)`);
    const open = R('drums', 46, 100, 1.3, [{ t: 0.4, m: { type: 'on', note: 42, vel: 100 } }]), open2 = R('drums', 46, 100, 1.3);
    const hi = x => { let e = 0; for (const fr of [7000, 9000, 11000, 13000]) e += amp(x, fr, 0.55, 0.65); return e; };
    ok(20 * Math.log10(hi(open) / hi(open2)) < -12, `drums: the closed hi-hat chokes the open one (${(20 * Math.log10(hi(open) / hi(open2))).toFixed(0)} dB)`);
    const clap = R('drums', 39, 110, 0.3), env = []; for (let i = 0; i < 30; i++) env.push(lin(clap, i * 0.01, i * 0.01 + 0.01));
    let peaks = 0; for (let i = 1; i < 6; i++) if (env[i] > env[i - 1] * 1.15 && env[i] >= env[i + 1]) peaks++;
    ok(peaks >= 2, `drums: the clap is a burst of separate hits (${peaks} peaks in the first 60 ms)`);
  }
  // flute: breath between the partials
  {
    const withB = R('flute', 72, 90, 3), without = (() => { s = 7; const d = synthDefault('flute'); d.engine.synth.noise = []; const inst = compile(d), p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, hammerNoise: 0.8, keyNoise: 0, unison: 0 } } }); const o = [[new Float32Array(128), new Float32Array(128)]], x = new Float64Array(Math.ceil(3 * SR / 128) * 128); p.handle({ type: 'on', note: 72, vel: 90 }); for (let b = 0; b * 128 < x.length; b++) { p.process([], o); for (let i = 0; i < 128; i++) x[b * 128 + i] = 0.5 * (o[0][0][i] + o[0][1][i]); } return x; })();
    const f0 = 440 * Math.pow(2, 3 / 12), between = x => { let e = 0; for (let fr = f0 * 1.3; fr < f0 * 1.7; fr += 7) e += amp(x, fr, 1, 2.9) ** 2; return e; };
    ok(10 * Math.log10(between(withB) / between(without)) > 12, `flute: breath fills the gaps between the partials (+${(10 * Math.log10(between(withB) / between(without))).toFixed(0)} dB)`);
  }
  // lead: the filter opens on the attack and closes down to the sustain
  {
    const x = R('lead', 60, 110, 1.5), cent = (t) => { let a = 0, b = 0; for (let k = 1; k <= 40; k++) { const v = amp(x, k * 261.63, t, t + 0.03); a += v * k; b += v; } return a / b; };
    ok(cent(0.01) > 1.5 * cent(0.9), `lead: the filter sweep (harmonic centroid ${cent(0.01).toFixed(1)} at 10 ms, ${cent(0.9).toFixed(1)} at 0.9 s)`);
  }
  // strings: bow attack and delayed vibrato
  {
    const d = synthDefault('strings'), att = d.engine.attack_s, x = R('strings', 60, 100, 3), e = []; for (let i = 0; i < 250; i++) e.push(lin(x, i * 0.01, i * 0.01 + 0.02));
    const plateau = e.slice(150, 250).reduce((a, b) => a + b) / 100, t10 = e.findIndex(v => v > 0.1 * plateau) * 0.01, t90 = e.findIndex(v => v > 0.9 * plateau) * 0.01;
    ok(Math.abs((t90 - t10) / att - 1) < 0.5, `strings: the bow attack rises in ${(t90 - t10).toFixed(2)} s (engine.attack_s ${att.toFixed(2)})`);
  }
}
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
