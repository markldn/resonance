// Building an instrument from audio files: node test/importaudio.test.mjs
//   File-name parsing, pitch detection for files with no name, and the whole road audio -> analyzer -> instrument -> engine:
//   notes rendered by the shipped engine (the Iowa Grand) at 9 keys x 3 strengths are treated as recordings of "some piano",
//   measured, assembled, and the new instrument must reproduce the notes it was made from and the keys it never heard.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
import { parseName } from '../js/importaudio.js';
import { analyzeNote, assemble, guessMidi } from '../js/analyzer.js';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

// ---- names
const P = parseName;
ok(P('C4.wav').midi === 60 && P('C4.wav').vel === null, 'C4 is key 60, no strength');
ok(P('Piano.mf.Eb3.aiff').midi === 51 && P('Piano.mf.Eb3.aiff').vel === 72, 'Piano.mf.Eb3: key 51, mf = 72');
ok(P('A0_v40.flac').midi === 21 && P('A0_v40.flac').vel === 40, 'A0_v40: key 21, velocity 40');
ok(P('steinway-F#5-ff.mp3').midi === 78 && P('steinway-F#5-ff.mp3').vel === 104, 'F#5 ff');
ok(P('note_c-1.wav').midi === 0, 'C-1 is key 0');
ok(P('Kawai upright 03.wav').midi === null && P('take 7.wav').midi === null, 'names without a note give none');
ok(P('Bb2 pp.wav').midi === 46 && P('Bb2 pp.wav').vel === 32, 'flat and dynamic with a space');
ok(P('Grand_Piano_G7.wav').midi === 103, 'a note name at the end');

// ---- engine renders as "recordings"
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let s = 7; Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile } = await import(ROOT + '/js/instrument.js');
const iowa = compile(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')));
const render = (inst, note, vel, secs) => {
  currentFrame = 0; const p = new Proc({ processorOptions: { inst, params: { globalRes: 0, sympRes: 0, hammerNoise: 0.8, keyNoise: 0 } } });
  p.handle({ type: 'on', note, vel }); const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(secs * 48000 / 128) * 128, x = new Float32Array(n);
  for (let b = 0; b * 128 < n; b++) { p.process([], o); currentFrame += 128; for (let i = 0; i < 128; i++) x[b * 128 + i] = (o[0][0][i] + o[0][1][i]) / 2; }
  return x;
};
const rmsDb = (x, a, b) => { let e = 0; const i0 = Math.round(a * 48000), i1 = Math.round(b * 48000); for (let i = i0; i < i1; i++) e += x[i] * x[i]; return 10 * Math.log10(e / (i1 - i0) + 1e-20); };
const KEYS = [24, 33, 42, 51, 60, 69, 78, 87, 96], VELS = [32, 72, 104];

// ---- pitch guess on files that say nothing
let right = 0, tot = 0, worst = 0;
for (const k of KEYS) for (const v of [72]) {
  const x = render(iowa, k, v, 3), g = guessMidi(x, 48000); tot++;
  if (g && g.midi === k) { right++; worst = Math.max(worst, Math.abs(g.cents)); } else console.log('  guess', k, '->', g && g.midi);
}
ok(right === tot, `pitch guess names the right key for ${right} of ${tot} notes across the keyboard (worst tuning error ${worst.toFixed(0)} cents)`);
ok(guessMidi(new Float32Array(48000), 48000) === null, 'silence has no pitch');

// ---- the name is a label, not a measurement: pitch evidence
{
  const { pitchEvidence, resolveKey } = await import(ROOT + '/js/analyzer.js'), { synthesize } = await import(ROOT + '/js/synth.js');
  const flute = compile(synthesize('flute', 1, 1)), ev = (inst, note, named, secs = 2) => pitchEvidence(render(inst, note, 80, secs), 48000, named);
  const cases = [['flute sounding 72, named C4 (60): an octave low', flute, 72, 60, 1], ['flute sounding 81, named A3 (57): two octaves', flute, 81, 57, 2], ['flute named right (69)', flute, 69, 69, 0],
    ['piano E1, named right: its weak bass fundamental is not proof of a wrong name', iowa, 28, 28, 0], ['piano A0, named right', iowa, 21, 21, 0], ['piano C4, named right', iowa, 60, 60, 0], ['piano C6 named C5: an octave low', iowa, 84, 72, 1], ['piano C3 named C4: an octave high', iowa, 48, 60, -1]];
  for (const [what, inst, note, named, want] of cases) { const e = ev(inst, note, named), k = resolveKey(e); ok(k === want, `pitch evidence: ${what} -> shift ${k} (want ${want})`); }
  // a whole instrument named an octave low, with one key whose own evidence is ambiguous: the octave the rest need is preferred
  const e = ev(flute, 72, 60); ok(resolveKey({ ...e, yin: { ...e.yin, 1: false } }, 1) === 1 && resolveKey({ ...e, yin: { ...e.yin, 1: false } }) === 0, 'the instrument\'s majority octave settles a key whose period detector disagrees');
}

// ---- audio -> instrument -> engine
const takes = [];
for (const k of KEYS) for (const v of VELS) {
  const x = render(iowa, k, v, 6), r = analyzeNote(x, 48000, k);
  if (r) takes.push({ midi: k, velocity: v, result: r });
}
ok(takes.length === KEYS.length * VELS.length, `every one of ${KEYS.length * VELS.length} notes was measured (${takes.length})`);
const doc = assemble(takes, { name: 'Round trip' });
ok(doc.keys.length === KEYS.length && doc.keys.every(k => k.layers.length === 3), `assembled: ${doc.keys.length} keys with 3 strengths each`);
const { trimCore, loadEngine } = await import(ROOT + '/js/trimcore.js');
const P2 = Proc;   // the engine is already loaded above; trimCore drives the same class
const rep = trimCore(P2, doc, takes.map(t => ({ note: t.midi, velocity: t.velocity, level: t.result.level_db })));
ok(rep && rep.after < 0.8 * rep.before + 0.2 && rep.after < 1.5, `level trim: rms spread of the notes' loudness against the recordings ${rep.before.toFixed(2)} -> ${rep.after.toFixed(2)} dB over ${rep.layers} layers`);
const { meanLevel, IOWA_LEVEL } = await import(ROOT + '/js/trimcore.js');
const iowaDoc = JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')), ml = meanLevel(Proc, iowaDoc);
ok(Math.abs(ml - IOWA_LEVEL) < 0.6, `the reference loudness is the Iowa Grand's (${ml.toFixed(1)} dB measured, constant ${IOWA_LEVEL})`);
ok(Math.abs(meanLevel(Proc, doc) - IOWA_LEVEL) < 0.6, `an instrument built from audio is brought to that loudness (${meanLevel(Proc, doc).toFixed(1)} dB; shift ${rep.shift.toFixed(1)} dB)`);
const mine = compile(doc);
const dev = (k, v) => { const a = render(iowa, k, v, 2), b = render(mine, k, v, 2); return [rmsDb(b, 0, 0.15) - rmsDb(a, 0, 0.15), rmsDb(b, 0.5, 1.5) - rmsDb(a, 0.5, 1.5) - (rmsDb(b, 0, 0.15) - rmsDb(a, 0, 0.15))]; };
if (process.env.DEV) for (const k of KEYS) console.log(k, VELS.map(v => dev(k, v).map(x => x.toFixed(1)).join('/')).join('   '));
const rows = []; for (const k of KEYS) for (const v of VELS) rows.push(dev(k, v));
const off = rows.map(r => r[0]).sort((a, b) => a - b)[rows.length >> 1];      // the whole instrument is set to the Iowa Grand's loudness on purpose: judge the spread around that
let worstAttack = 0, worstTail = 0;
for (const [a, t] of rows) { worstAttack = Math.max(worstAttack, Math.abs(a - off)); worstTail = Math.max(worstTail, Math.abs(t)); }
ok(worstAttack < 3, `the measured instrument plays its own notes at the right relative loudness (worst attack level ${worstAttack.toFixed(1)} dB off the common shift of ${off.toFixed(1)}; limit 3)`);
ok(worstTail < 9, `and decays like them (worst tail 0.5-1.5 s relative to the attack ${worstTail.toFixed(1)} dB off; limit 9)`);
const between = [30, 45, 65, 82]; let wb = 0;
for (const k of between) { const [a] = dev(k, 72); wb = Math.max(wb, Math.abs(a - off)); }
ok(wb < 6, `keys it never heard (${between.join(', ')}) come out within ${wb.toFixed(1)} dB of the original (limit 6)`);
process.exit(fails ? 1 : 0);
