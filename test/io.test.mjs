// File formats and the in-browser analyzer: node test/io.test.mjs
//   MIDI file read/write, WAV encoding, and analyzeNote on a synthetic string tone with known truth. When python3 with
//   numpy, scipy and soundfile is available, the JavaScript and Python analyzers are also compared on the same tone.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMidi, writeMidi, encodeWav } from '../js/midifile.js';
import { analyzeNote } from '../js/analyzer.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, e) => Math.abs(a - b) <= e;
const ab = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// ---- MIDI file
const evs = [{ time: 0, type: 'cc', cc: 64, value: 127 }, { time: 0.5, type: 'on', note: 60, vel: 90 }, { time: 1.25, type: 'off', note: 60, vel: 40 }, { time: 1.25, type: 'on', note: 64, vel: 1 }, { time: 2, type: 'off', note: 64, vel: 64 }];
let m = parseMidi(ab(writeMidi(evs)));
ok(m.notes === 2 && m.events.length === 5, 'write then read: same number of events');
ok(evs.every(e => m.events.some(r => r.type === e.type && (r.note ?? r.cc) === (e.note ?? e.cc) && near(r.time, e.time, 1e-3))), 'write then read: every event comes back with its time within 1 ms');
ok(m.events.find(e => e.type === 'on' && e.note === 60).vel === 90 && m.events.find(e => e.type === 'off' && e.note === 60).vel === 40, 'velocities survive');
ok(near(m.duration, 2, 1e-3), 'duration');
// hand-made type 1 file: two tracks, tempo change to 1 s per beat at tick 480, running status, a pitch-bend event
const trk = bytes => [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, bytes.length, ...bytes];
const t0 = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0x83, 0x60, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, 0, 0xff, 0x2f, 0];         // 0.5 s/beat, then 1 s/beat from tick 480
const t1 = [0, 0x90, 60, 100, 0x83, 0x60, 62, 100, 0x83, 0x60, 0xe0, 0x00, 0x60, 0, 0x80, 60, 0, 0, 0xff, 0x2f, 0];        // note on 60, running-status note on 62 at tick 480, bend up at tick 960, note off
const smf = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0x01, 0xe0, ...trk(t0), ...trk(t1)]);
m = parseMidi(ab(smf));
ok(m.format === 1 && m.tracks === 2, 'type 1 file: two tracks');
const n62 = m.events.find(e => e.type === 'on' && e.note === 62);
ok(n62 && near(n62.time, 0.5, 1e-6), 'running status is decoded (second note on)');
const bend = m.events.find(e => e.type === 'bend');
ok(bend && bend.value === 0x60 * 128 - 8192 + 0 && near(bend.time, 1.5, 1e-6), `pitch bend is read (${bend?.value}) and the tempo change is applied (${bend?.time} s)`);
let threw = ''; try { parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer); } catch (e) { threw = e.message; } ok(/Not a MIDI file/.test(threw), 'garbage is rejected');
threw = ''; try { parseMidi(ab(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 0x28]))); } catch (e) { threw = e.message; } ok(/SMPTE/.test(threw), 'SMPTE time division is rejected with a message');

// ---- WAV
const wav = new Uint8Array(await encodeWav(new Float32Array([0, 1, -1, 0.5]), new Float32Array([0, -1, 1, 0.25]), 44100).arrayBuffer()), dv = new DataView(wav.buffer);
ok(String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE' && dv.getUint32(24, true) === 44100 && dv.getUint16(22, true) === 2 && dv.getUint16(34, true) === 16, 'WAV header: RIFF/WAVE, 44.1 kHz, stereo, 16 bit');
ok(wav.length === 44 + 16 && dv.getInt16(48, true) === 32767 && dv.getInt16(50, true) === -32767, 'WAV data: length, and full-scale samples land left / right');

// ---- analyzer on a synthetic string tone with known truth
const sr = 44100, f0 = 261.6256, B = 3e-4, N = Math.round(12 * sr), pre = Math.round(0.5 * sr);
const parts = []; for (let n = 1; n <= 14; n++) parts.push({ n, f: f0 * n * Math.sqrt(1 + B * n * n), a: 10 ** ((-3 * Math.log2(n) - (n % 3) * 1.5) / 20), td: 2.2 / (1 + 0.15 * n), tr: 11 / (1 + 0.08 * n), rem: 0.18 });
let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const x = new Float64Array(pre + N);
for (const p of parts) { const ph = rnd() * 6.28; for (let i = 0; i < N; i++) { const t = i / sr; x[pre + i] += p.a * ((1 - p.rem) * Math.exp(-6.9078 * t / p.td) + p.rem * Math.exp(-6.9078 * t / p.tr)) * Math.sin(2 * Math.PI * p.f * t + ph) * (i < 20 ? i / 20 : 1); } }
for (let i = 0; i < x.length; i++) x[i] = x[i] * 0.3 + (rnd() - 0.5) * 2e-5;
const top = Math.max(...parts.map(p => p.a));
const near1 = (res, n) => res.partials.reduce((b, p) => Math.abs(p[0] - n) < Math.abs(b[0] - n) ? p : b);
const js = analyzeNote(x, sr, 60);
ok(js && near(js.f0_hz / f0, 1, 5e-4), `analyzer: fundamental ${js?.f0_hz} Hz (true ${f0})`);
ok(near(js.B / B, 1, 0.1), `analyzer: inharmonicity ${js.B} (true ${B})`);
const lvlErr = Math.max(...parts.slice(0, 8).map(p => Math.abs(near1(js, p.n)[1] - 20 * Math.log10(p.a / top))));
ok(lvlErr < 3, `analyzer: first 8 partial levels within ${lvlErr.toFixed(1)} dB of the truth (limit 3)`);
const trErr = Math.max(...parts.slice(0, 8).map(p => Math.abs(near1(js, p.n)[3] / p.tr - 1)));
ok(trErr < 0.15, `analyzer: slow decay times within ${(trErr * 100).toFixed(0)}% (limit 15%)`);
const tdErr = Math.max(...parts.slice(0, 8).map(p => Math.abs(near1(js, p.n)[2] / p.td - 1)));
ok(tdErr < 0.7, `analyzer: fast decay times within ${(tdErr * 100).toFixed(0)}% (limit 70%; the fast stage is the hardest to fit)`);
ok(js.partials.filter(p => p[0] > 14.6 && p[1] > -45).length === 0, 'analyzer: no invented partials above the 14 that exist');

// ---- JavaScript and Python analyzers agree
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resonance-io-'));
try {
  fs.writeFileSync(path.join(tmp, 'C4_v80.wav'), Buffer.from(await encodeWav(x, x, sr).arrayBuffer()));
  execFileSync('python3', [path.join(ROOT, 'tools/analyze_instrument.py'), '--name', 't', '--out', path.join(tmp, 'py.json'), path.join(tmp, 'C4_v80.wav')], { stdio: 'pipe' });
  const py = JSON.parse(fs.readFileSync(path.join(tmp, 'py.json'), 'utf8')).keys[0], pp = py.layers[0].partials;
  const nearP = n => pp.reduce((b, p) => Math.abs(p[0] - n) < Math.abs(b[0] - n) ? p : b);
  ok(near(py.f0_hz / js.f0_hz, 1, 2e-4) && near(py.B / js.B, 1, 0.05), `JS and Python agree on f0 (${js.f0_hz} / ${py.f0_hz} Hz) and B (${js.B} / ${py.B})`);
  const dl = Math.max(...parts.slice(0, 8).map(p => Math.abs(near1(js, p.n)[1] - nearP(p.n)[1])));
  const dr = Math.max(...parts.slice(0, 8).map(p => Math.abs(near1(js, p.n)[3] / nearP(p.n)[3] - 1)));
  ok(dl < 3 && dr < 0.2, `JS and Python agree: partial levels within ${dl.toFixed(1)} dB, slow decays within ${(dr * 100).toFixed(0)}%`);
} catch (e) { console.log('skip JS/Python comparison (needs python3 with numpy, scipy, soundfile):', String(e.message).split('\n')[0]); }
finally { fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(fails ? 1 : 0);
