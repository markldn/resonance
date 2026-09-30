// The engine's synth-voice features against their specifications, on synthetic instruments: node test/synthdsp.test.mjs
// vibrato, glide, pitch envelope, swept resonant filter, band noise, noise-driven resonator bank, mono, choke, fixed pitch, rotary speaker.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.sampleRate = 48000; globalThis.currentFrame = 0;
let seed = 7; Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let Proc; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() { } }; } };
globalThis.registerProcessor = (n, c) => { if (n === 'piano-engine') Proc = c; };
(0, eval)(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const { compile } = await import(ROOT + '/js/instrument.js');
const SR = 48000;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

// ---- a synthetic instrument: the same partials on every key
function mk(partials, engine = {}, keySynth = null, extraKeys = {}) {
  const keys = []; for (let m = 21; m <= 108; m++) keys.push({ note: m, B: 1e-7, strings: 1, level_db: 0, layers: [{ velocity: 64, gain_db: 0, partials }], ...(keySynth ? { synth: keySynth(m) } : {}), ...extraKeys });
  return compile({ format: 'resonance-instrument/1', name: 'synthetic', keys, engine: { dampers: 'all', release_s: 0.1, ...engine } });
}
const P1 = [[1, 0, 3000, 3000, -120]];
const harm = n => Array.from({ length: n }, (_, i) => [i + 1, 0, 3000, 3000, -120]);
const BASE = { globalRes: 0, sympRes: 0, hammerNoise: 0, keyNoise: 0, unison: 0, character: 0, stretch: 0, quadratic: 0 };   // character 0 and quadratic 0: random partial detune and 2f components would smear amplitude measurements
function run(inst, events, secs, params = {}) {
  seed = 7;
  const p = new Proc({ processorOptions: { inst, params: { ...BASE, ...params } } });
  const o = [[new Float32Array(128), new Float32Array(128)]], n = Math.ceil(secs * SR / 128), L = new Float64Array(n * 128), R = new Float64Array(n * 128), ev = [...events].sort((a, b) => a.t - b.t);
  let e = 0;
  for (let b = 0; b < n; b++) {
    while (e < ev.length && ev[e].t * SR <= b * 128) { const m = ev[e++]; if (m.params) p.setParams({ ...BASE, ...params, ...m.params }); else p.handle(m); }
    p.process([], o); currentFrame += 128; L.set(o[0][0], b * 128); R.set(o[0][1], b * 128);
  }
  return { L, R, x: L.map((v, i) => 0.5 * (v + R[i])) };
}
const on = (t, note, vel = 64) => ({ t, type: 'on', note, vel }), off = (t, note) => ({ t, type: 'off', note });
const play = (inst, note, secs, params, extra = []) => run(inst, [on(0, note), ...extra], secs, params);

// ---- analysis helpers
// instantaneous frequency deviation in cents from f0: demodulate, smooth 6 ms twice, unwrap the phase
function devCents(x, f0, hop = 48) {
  const n = x.length, re = new Float64Array(n), im = new Float64Array(n), w = 2 * Math.PI * f0 / SR;
  for (let i = 0; i < n; i++) { re[i] = x[i] * Math.cos(w * i); im[i] = -x[i] * Math.sin(w * i); }
  const sm = a => { const N = 288, o = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { s += a[i]; if (i >= N) s -= a[i - N]; o[i] = s / Math.min(i + 1, N); } return o; };
  const r = sm(sm(re)), q = sm(sm(im)), out = []; let prev = Math.atan2(q[0], r[0]), acc = 0;
  for (let i = 1; i < n; i++) { let d = Math.atan2(q[i], r[i]) - prev; prev = Math.atan2(q[i], r[i]); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; acc += d; if (i % hop === 0) out.push([i / SR, 1200 * Math.log2(1 + (acc - (out.length ? out.lastAcc : 0) * 0) / 1e9)]); }
  // frequency = derivative of the unwrapped phase over a 20 ms span
  const ph = []; prev = Math.atan2(q[0], r[0]); acc = 0;
  for (let i = 1; i < n; i++) { let d = Math.atan2(q[i], r[i]) - prev; prev = Math.atan2(q[i], r[i]); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; acc += d; ph.push(acc); }
  const span = 480, res = [];
  for (let i = span; i < ph.length; i += hop) res.push([(i - span / 2) / SR, 1200 * Math.log2(1 + (ph[i] - ph[i - span]) / span * SR / (2 * Math.PI) / f0)]);
  return res;
}
const at = (series, t0, t1) => series.filter(([t]) => t >= t0 && t <= t1).map(([, v]) => v);
const domRate = (a, dt, lo = 0.3, hi = 12) => {            // dominant frequency of a series: scan a sine fit
  const m = a.reduce((x, y) => x + y, 0) / a.length; let bf = lo, bv = -1;
  for (let f = lo; f <= hi; f += 0.02) { let re = 0, im = 0; for (let i = 0; i < a.length; i++) { const w = 2 * Math.PI * f * i * dt; re += (a[i] - m) * Math.cos(w); im += (a[i] - m) * Math.sin(w); } const v = re * re + im * im; if (v > bv) { bv = v; bf = f; } }
  return bf;
};
const zeroRate = (a, dt) => { const m = a.reduce((x, y) => x + y, 0) / a.length; let z = 0; for (let i = 1; i < a.length; i++) if ((a[i - 1] - m) * (a[i] - m) < 0) z++; return z / 2 / (a.length * dt); };
function fft(re, im) {                                             // in place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
}
const psd = (x, t0, t1, N = 1 << 15) => {                          // Welch, Hann, 50 % overlap: [Hz, power] per bin
  const seg = x.subarray(Math.floor(t0 * SR), Math.floor(t1 * SR)), P = new Float64Array(N / 2); let cnt = 0;
  for (let s = 0; s + N <= seg.length; s += N / 2) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = seg[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fft(re, im); for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]; cnt++; }
  return { P: P.map(v => v / cnt), df: SR / N };
};
const amp = (x, f, t0, t1) => { const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR); let re = 0, im = 0, w = 2 * Math.PI * f / SR, ws = 0; for (let i = a; i < b; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a)); re += x[i] * h * Math.cos(w * i); im += x[i] * h * Math.sin(w * i); ws += h; } return 2 * Math.hypot(re, im) / ws; };
const rms = (x, t0, t1) => { const q = x.subarray(Math.floor(t0 * SR), Math.floor(t1 * SR)); let e = 0; for (const v of q) e += v * v; return Math.sqrt(e / q.length); };
const db = v => 20 * Math.log10(v + 1e-30);

// ============ vibrato ============
{
  const inst = mk(P1, { synth: { vibrato: { hz: 5.5, cents: 30, delay_s: 0.3, rise_s: 0.2 } } }), f0 = hz(60);
  const d = devCents(play(inst, 60, 3.5).x, f0), pre = at(d, 0.05, 0.25), win = at(d, 1.0, 3.2);
  const amplitude = (a) => (Math.max(...a) - Math.min(...a)) / 2;
  ok(Math.max(...pre.map(Math.abs)) < 4, `vibrato: none before its delay (max ${Math.max(...pre.map(Math.abs)).toFixed(1)} cents in the first 0.25 s, delay 0.3 s)`);
  ok(Math.abs(amplitude(win) - 30) < 4, `vibrato: depth ${amplitude(win).toFixed(1)} cents (spec 30)`);
  ok(Math.abs(domRate(win, 0.001, 3, 9) - 5.5) < 0.25, `vibrato: rate ${domRate(win, 0.001, 3, 9).toFixed(2)} Hz (spec 5.5)`);
  const half = amplitude(at(devCents(play(inst, 60, 3.5).x, f0), 0.42, 0.5));
  const d0 = devCents(play(inst, 60, 3.5, { modulation: 0 }).x, f0), d2 = devCents(play(inst, 60, 3.5, { modulation: 2 }).x, f0);
  ok(Math.max(...at(d0, 1, 3.2).map(Math.abs)) < 2, 'vibrato: the Modulation slider at 0 removes it');
  ok(Math.abs(amplitude(at(d2, 1, 3.2)) - 60) < 8, `vibrato: the Modulation slider at 2 doubles it (${amplitude(at(d2, 1, 3.2)).toFixed(1)} cents)`);
  // the mean pitch stays on the key: vibrato is symmetric around it
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  ok(Math.abs(mean) < 3, `vibrato: centred on the key's pitch (mean ${mean.toFixed(1)} cents)`);
}

// ============ glide (mono, legato) ============
{
  const inst = mk(P1, { synth: { mono: true, glide: { time_s: 0.2, legato: true } } });
  const r = run(inst, [on(0, 60), on(1.0, 67)], 2.2), f67 = hz(67);
  // frequency of the second note over time: peak of a 40 ms spectrum near the two pitches
  const freqAt = t => { const N = 1 << 16, a = Math.floor((t - 0.02) * SR), re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < 1920; i++) re[i] = r.x[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 1920)); fft(re, im); let bk = 0, bv = 0; for (let k = Math.floor(200 * N / SR); k < Math.floor(500 * N / SR); k++) { const v = re[k] ** 2 + im[k] ** 2; if (v > bv) { bv = v; bk = k; } } const l = Math.hypot(re[bk - 1], im[bk - 1]), c = Math.hypot(re[bk], im[bk]), rr = Math.hypot(re[bk + 1], im[bk + 1]); return (bk + 0.5 * (l - rr) / (l - 2 * c + rr)) * SR / N; };
  const tau = 0.2 / 2.3, res = [0.08, 0.12, 0.2, 0.3].map(dt => [dt, 1200 * Math.log2(freqAt(1.0 + dt) / f67), -700 * Math.exp(-dt / tau)]);
  ok(res.every(([, m, e]) => Math.abs(m - e) < 55), `glide: from a fifth below, 90 % of the way in 0.2 s (cents measured/predicted: ${res.map(([dt, m, e]) => `${dt}s ${m.toFixed(0)}/${e.toFixed(0)}`).join(', ')})`);
  ok(Math.abs(1200 * Math.log2(freqAt(1.6) / f67)) < 10, 'glide: settles exactly on the new key');
  const solo = run(inst, [on(0, 60), off(0.5, 60), on(1.0, 67)], 1.6);
  const s0 = (() => { const N = 1 << 16, a = Math.floor(1.03 * SR), re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < 1920; i++) re[i] = solo.x[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 1920)); fft(re, im); let bk = 0, bv = 0; for (let k = Math.floor(200 * N / SR); k < Math.floor(500 * N / SR); k++) { const v = re[k] ** 2 + im[k] ** 2; if (v > bv) { bv = v; bk = k; } } return bk * SR / N; })();
  ok(Math.abs(1200 * Math.log2(s0 / f67)) < 15, `glide: legato only, a note struck after the last was released starts on pitch (${(1200 * Math.log2(s0 / f67)).toFixed(0)} cents)`);
}

// ============ pitch envelope ============
{
  const inst = mk(P1, { synth: { pitch_env: { cents: 1200, tau_s: 0.05 } } }), f0 = hz(48), x = play(inst, 48, 1.2).x;
  const d = devCents(x, f0, 24), at50 = at(d, 0.045, 0.06).map(v => v);
  const m = at50.reduce((a, b) => a + b, 0) / at50.length;
  const pk = (() => { let best = -1, bc = 0; for (let c = -30; c <= 30; c += 0.5) { const v = amp(x, f0 * Math.pow(2, c / 1200), 0.6, 1.1); if (v > best) { best = v; bc = c; } } return bc; })();
  ok(Math.abs(m - 1200 * Math.exp(-0.052 / 0.05)) < 130, `pitch envelope: ${m.toFixed(0)} cents high at 52 ms (spec ${(1200 * Math.exp(-0.052 / 0.05)).toFixed(0)})`);
  ok(Math.abs(pk) < 3, `pitch envelope: settled on the key after 0.6 s (${pk} cents)`);
}

// ============ filter: steady state against the analytic response ============
const fmag = (type, poles, q, u) => { const u2 = u * u, d = (1 - u2) * (1 - u2) + u2 / (q * q), m2 = type === 'hp' ? u2 * u2 / d : type === 'bp' ? (u2 / (q * q)) / d : 1 / d; return poles === 4 ? m2 : Math.sqrt(m2); };
{
  const f0 = hz(48);
  for (const [type, poles, q, fc] of [['lp', 2, 0.707, 1000], ['lp', 4, 0.707, 1500], ['lp', 2, 6, 1200], ['hp', 2, 0.9, 800], ['bp', 2, 4, 1000]]) {
    const inst = mk(harm(22), { synth: { filter: { type, poles, q, cutoff_hz: fc } } }), x = play(inst, 48, 3).x;
    let worst = 0;
    for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]) {
      const want = db(fmag(type, poles, q, k * f0 / fc)) - db(fmag(type, poles, q, f0 / fc)), got = db(amp(x, k * f0, 1, 3)) - db(amp(x, f0, 1, 3));
      if (want > -60) worst = Math.max(worst, Math.abs(want - got));
    }
    ok(worst < 0.6, `filter: ${type} ${poles * 6} dB/oct, Q ${q}, ${fc} Hz follows the analytic response over 20 partials (worst ${worst.toFixed(2)} dB)`);
  }
}

// ============ filter: envelope sweep and release ============
{
  const f0 = hz(48), env = { oct: 4, attack_s: 0.05, decay_s: 0.5, sustain: 0.3, release_s: 0.2 };
  const inst = mk(harm(24), { release_s: 8, synth: { filter: { type: 'lp', poles: 2, q: 0.9, cutoff_hz: 200, env } } }), x = play(inst, 48, 3, {}, [off(2.0, 48)]).x;   // slow damper: only the filter darkens the released note
  const e = t => (1 - Math.exp(-t / (0.05 / 2.2))) * (0.3 + 0.7 * Math.exp(-t / (0.5 / 2.3))), eOff = e(2.0);
  const cut = t => 200 * Math.pow(2, 4 * (t < 2 ? e(t) : eOff * Math.exp(-(t - 2) / (0.2 / 2.3))));
  const out = [0.06, 0.15, 0.4, 1.5, 2.15, 2.5].map(t => {
    const want = db(fmag('lp', 2, 0.9, 8 * f0 / cut(t))) - db(fmag('lp', 2, 0.9, f0 / cut(t))), got = db(amp(x, 8 * f0, t - 0.02, t + 0.02)) - db(amp(x, f0, t - 0.02, t + 0.02));
    return [t, got, want];
  });
  ok(out.every(([, g, w]) => Math.abs(g - w) < 2.5), `filter sweep: partial 8 against partial 1 follows the envelope (dB got/spec: ${out.map(([t, g, w]) => `${t}s ${g.toFixed(1)}/${w.toFixed(1)}`).join(', ')})`);
  ok(out[0][1] > out[3][1] + 3 && out[3][1] > out[5][1] + 3, 'filter sweep: it opens on the attack, settles to the sustain, and closes again on release');
}

// ============ noise ============
{
  const tone = mk(P1, {}), f0 = hz(48);
  const noisy = nz => mk(P1, { synth: { noise: nz } });
  const pair = (nz, secs = 3, params = {}) => { const a = play(noisy(nz), 48, secs, params).x, b = play(tone, 48, secs, params).x; return { n: a.map((v, i) => v - b[i]), tone: b }; };
  // band noise: level relative to the note's own RMS, centre and width
  {
    const { n, tone: b } = pair([{ type: 'band', kind: 'bp', fc: 2000, q: 3, level_db: -6, sustain: 1 }]);
    const rel = db(rms(n, 0.5, 2.9) / rms(b, 0.5, 2.9));
    ok(Math.abs(rel + 6) < 1.5, `noise band: level ${rel.toFixed(1)} dB relative to the tone (spec -6)`);
    const { P, df } = psd(n, 0.5, 2.9, 1 << 14), sm = f => { const c = Math.round(f / df), w = Math.round(120 / df); let t = 0; for (let i = c - w; i <= c + w; i++) t += P[i]; return t / (2 * w + 1); };
    const shape = f => db(Math.sqrt(sm(f) / sm(2000)));
    const want = f => db(fmag('bp', 2, 3, f / 2000));
    const worst = Math.max(...[1000, 1400, 2800, 4000].map(f => Math.abs(shape(f) - want(f))));
    ok(worst < 2.5, `noise band: spectrum follows the band-pass shape at 1, 1.4, 2.8, 4 kHz against 2 kHz (worst ${worst.toFixed(1)} dB from the analytic response)`);
  }
  {   // decay and attack
    const { n } = pair([{ type: 'band', kind: 'lp', fc: 8000, q: 0.7, level_db: 0, decay_s: 0.25, sustain: 0 }], 1.5);
    const a = db(rms(n, 0.05, 0.10)), b = db(rms(n, 0.25, 0.30)), t60 = 60 / ((a - b) / 0.2);
    ok(Math.abs(t60 / 0.25 - 1) < 0.25, `noise decay: T60 ${t60.toFixed(2)} s (spec 0.25)`);
    const r = pair([{ type: 'band', kind: 'lp', fc: 8000, q: 0.7, level_db: 0, attack_s: 0.2, sustain: 1 }], 1.5).n, env = []; for (let i = 0; i < 100; i++) env.push(rms(r, i * 0.01, i * 0.01 + 0.02));
    const plateau = env.slice(60, 100).reduce((a, b) => a + b) / 40, t10 = env.findIndex(v => v > 0.1 * plateau) * 0.01, t90 = env.findIndex(v => v > 0.9 * plateau) * 0.01;
    ok(Math.abs((t90 - t10) / 0.2 - 1) < 0.35, `noise attack: 10-90 % rise ${(t90 - t10).toFixed(2)} s (spec 0.2)`);
  }
  // resonator bank: peaks at the partials, width f/Q, level
  {
    const bank = mk(harm(12).map(p => [p[0], -3 * p[0], 3000, 3000, -120]), { synth: { noise: [{ type: 'bank', q: 60, level_db: -10, sustain: 1 }] } }), plain = mk(harm(12).map(p => [p[0], -3 * p[0], 3000, 3000, -120]), {});
    const a = play(bank, 48, 20).x, b = play(plain, 48, 20).x, n = a.map((v, i) => v - b[i]);
    ok(Math.abs(db(rms(n, 1, 19.9) / rms(b, 1, 19.9)) + 10) < 1.5, `noise bank: level ${db(rms(n, 1, 19.9) / rms(b, 1, 19.9)).toFixed(1)} dB relative to the tone (spec -10)`);
    const { P, df } = psd(n, 1, 19.9, 1 << 16); let worst = 0, neb3 = 0; const per = [];
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const c = Math.round(k * f0 / df), w = Math.round(1.5 * k * f0 / 60 / df); let sw = 0, sf = 0; for (let i = c - w; i <= c + w; i++) { sw += P[i]; sf += P[i] * i * df; }
      per.push(1200 * Math.log2(sf / sw / (k * f0))); worst = Math.max(worst, Math.abs(per.at(-1)));
      if (k === 3) { const pk = Math.max(...P.slice(c - 3, c + 4)); neb3 = sw * df / pk; }
    }
    ok(worst < 10, `noise bank: the spectrum around partials 1-6 is centred on them within ${worst.toFixed(1)} cents (per partial ${per.map(v => v.toFixed(1)).join(", ")})`);
    ok(Math.abs(neb3 / (Math.PI * 3 * f0 / (2 * 60)) - 1) < 0.4, `noise bank: partial 3 has an equivalent bandwidth of ${neb3.toFixed(1)} Hz (spec pi f / 2Q = ${(Math.PI * 3 * f0 / 120).toFixed(1)})`);
  }
}

// ============ mono, choke, fixed pitch ============
{
  const mono = mk(P1, { synth: { mono: true } }), poly = mk(P1, {});
  const a = run(mono, [on(0, 60), on(1, 64)], 1.6), b = run(poly, [on(0, 60), on(1, 64)], 1.6);
  const before = amp(a.x, hz(60), 0.5, 0.9), after = amp(a.x, hz(60), 1.15, 1.3), afterPoly = amp(b.x, hz(60), 1.15, 1.3);
  ok(db(after / before) < -40 && db(afterPoly / before) > -3, `mono: a second key silences the first (${db(after / before).toFixed(0)} dB after 150 ms; polyphonic ${db(afterPoly / before).toFixed(1)} dB)`);
  // the Notes-at-once switch in the page: Chords lets a one-note instrument sound in chords, One note cuts the last key on any instrument
  const a2 = run(mono, [on(0, 60), on(1, 64)], 1.6, { voices: 'poly' }), b2 = run(poly, [on(0, 60), on(1, 64)], 1.6, { voices: 'mono' });
  ok(db(amp(a2.x, hz(60), 1.15, 1.3) / before) > -3 && db(amp(b2.x, hz(60), 1.15, 1.3) / before) < -40, `Notes at once: "Chords" keeps the first key of a mono instrument sounding (${db(amp(a2.x, hz(60), 1.15, 1.3) / before).toFixed(1)} dB), "One note" silences it on a polyphonic one (${db(amp(b2.x, hz(60), 1.15, 1.3) / before).toFixed(0)} dB)`);
  const ch = mk(P1, {}, m => ({ choke: m < 65 ? 1 : 2 }));
  const c = run(ch, [on(0, 60), on(1, 62)], 1.6), d = run(ch, [on(0, 60), on(1, 70)], 1.6);
  ok(db(amp(c.x, hz(60), 1.15, 1.3) / amp(c.x, hz(60), 0.5, 0.9)) < -40 && db(amp(d.x, hz(60), 1.15, 1.3) / amp(d.x, hz(60), 0.5, 0.9)) > -3, 'choke: a key of the same group stops the first, a key of another group does not');
  const fx = mk([[1320, 0, 3000, 3000, -120]], { fixed: true });
  const peak = (x, f) => { let best = -1, bc = 0; for (let c2 = -40; c2 <= 40; c2 += 0.5) { const a2 = amp(x, f * Math.pow(2, c2 / 1200), 0.5, 1.4); if (a2 > best) { best = a2; bc = c2; } } return bc; };
  const c40 = peak(play(fx, 40, 1.5).x, 1320), c100 = peak(play(fx, 100, 1.5).x, 1320), c432 = peak(play(fx, 70, 1.5, { diapason: 432 }).x, 1320 * 432 / 440);
  ok(Math.abs(c40) < 2 && Math.abs(c100) < 2 && Math.abs(c432) < 2, `fixed pitch: a 1320 Hz partial stays at 1320 Hz on key 40 (${c40} c) and 100 (${c100} c), and follows concert pitch (${c432} c at 432)`);
}

// ============ rotary speaker ============
{
  const rot = { crossover_hz: 800, mics_deg: 80, horn: { slow_hz: 0.8, fast_hz: 6.6, depth_ms: 0.28, amp: 0.3, accel: 5 }, drum: { slow_hz: 0.66, fast_hz: 5.7, depth_ms: 0.35, amp: 0.2, accel: 1 } };
  const inst = mk(P1, { rotary: rot }), f0 = hz(84);
  const fast = play(inst, 84, 5, { rotary: 1 }), d = devCents(fast.L, f0);
  const w = at(d, 2.5, 4.8), swing = (Math.max(...w) - Math.min(...w)) / 2, want = 1200 * Math.log2(1 + 0.5 * 0.28e-3 * 2 * Math.PI * 6.6);
  ok(Math.abs(swing / want - 1) < 0.3, `rotary: the horn's Doppler swings ${swing.toFixed(1)} cents at fast speed (spec ${want.toFixed(1)} = depth/2 x 2 pi x 6.6 Hz)`);
  ok(Math.abs(domRate(w, 0.001, 3, 10) - 6.6) < 0.4, `rotary: horn speed ${domRate(w, 0.001, 3, 10).toFixed(2)} Hz at fast (spec 6.6)`);
  const env = e => { const o = []; for (let i = 0; i < e.length / 480 - 1; i++) o.push(db(rms(e, i * 0.01, i * 0.01 + 0.01))); return o; };
  const ea = env(fast.L).slice(250, 480), swingAm = (Math.max(...ea) - Math.min(...ea)) / 2;
  ok(swingAm > 1.5 && swingAm < 4.5, `rotary: the level moves +-${swingAm.toFixed(1)} dB with the horn's angle (amplitude 0.3 gives about 2.5)`);
  const slow = devCents(play(inst, 84, 8, { rotary: 0 }).L, f0), ws = at(slow, 1, 7.5), rs = domRate(ws, 0.001, 0.3, 2);
  ok(Math.abs(rs - 0.8) < 0.15, `rotary: horn speed ${rs.toFixed(2)} Hz at slow (spec 0.8)`);
  // inertia: from slow to fast at t = 1 s: the horn is not at speed immediately, and is by 3.5 s
  const ramp = devCents(run(inst, [on(0, 84), { t: 1.0, params: { rotary: 1 } }], 5, { rotary: 0 }).L, f0), early = at(ramp, 1.05, 1.5), late = at(ramp, 3.3, 4.8);
  ok(domRate(early, 0.001, 0.3, 10) < 4 && Math.abs(domRate(late, 0.001, 3, 10) - 6.6) < 0.5, `rotary: inertia (0.45 s after the switch ${domRate(early, 0.001, 0.3, 10).toFixed(1)} Hz, at 3.3 s ${domRate(late, 0.001, 3, 10).toFixed(1)} Hz)`);
  const byp = devCents(play(inst, 84, 5, { rotary: 1, modulation: 0 }).L, f0);
  ok(Math.max(...at(byp, 2.5, 4.8).map(Math.abs)) < 1.5, 'rotary: Modulation 0 bypasses it');
  // the drum takes the low band: a note below the crossover is modulated at the drum's speed
  const lo = devCents(play(mk(P1, { rotary: rot }), 66, 6, { rotary: 1 }).L, hz(66)), wl = at(lo, 4.5, 5.8);
  ok(Math.abs(domRate(wl, 0.001, 3, 10) - 5.7) < 0.5, `rotary: a note below 800 Hz follows the drum (${domRate(wl, 0.001, 3, 10).toFixed(2)} Hz, spec 5.7)`);
  // stereo: the two microphones are a quarter turn apart, so the channels do not move together
  const eL = env(fast.L).slice(250, 480), eR = env(fast.R).slice(250, 480), mL = eL.reduce((a, b) => a + b) / eL.length, mR = eR.reduce((a, b) => a + b) / eR.length;
  const c = eL.reduce((a, v, i) => a + (v - mL) * (eR[i] - mR), 0) / Math.sqrt(eL.reduce((a, v) => a + (v - mL) ** 2, 0) * eR.reduce((a, v) => a + (v - mR) ** 2, 0));
  ok(Math.abs(c) < 0.6, `rotary: the two microphones are not in step (channel correlation ${c.toFixed(2)})`);
}

console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
