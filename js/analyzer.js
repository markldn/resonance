// In-browser instrument analyzer (same algorithm as tools/analyze_instrument.py):
// onset -> pre-roll noise floor -> release detection -> f0 + inharmonicity (or free peaks for bars/bells)
// -> per-partial demodulated energy envelope -> two-stage decay fit (grid + local refinement).
// Pure functions: usable in a Worker or on the main thread.

function fftInPlace(re, im) {                       // iterative radix-2, length power of two
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function spectrum(seg, sr, pad = 4) {               // Hann-windowed magnitude spectrum, zero-padded
  let N = 1; while (N < seg.length * pad) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N), L = seg.length;
  for (let i = 0; i < L; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)));
  fftInPlace(re, im);
  const X = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) X[k] = Math.hypot(re[k], im[k]);
  return { X, df: sr / N };
}
const log10 = x => Math.log10(Math.max(x, 1e-30));

function onset(x, sr) {
  const w = Math.max(1, Math.round(0.002 * sr)); let s = 0, pk = 0; const e = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; if (i >= w) s -= x[i - w] * x[i - w]; e[i] = s; if (s > pk) pk = s; }
  for (let i = 0; i < x.length; i++) if (e[i] > pk * 0.01) return Math.max(0, i - w);
  return 0;
}
function releaseTime(x, sr) {
  const hop = Math.round(0.01 * sr), w = Math.round(0.03 * sr), db = [];
  for (let i = 0; i + w < x.length; i += hop) { let s = 0; for (let k = i; k < i + w; k++) s += x[k] * x[k]; db.push(10 * log10(s / w)); }
  const sm = db.map((_, i) => { let s = 0, c = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < db.length) { s += db[k]; c++; } return s / c; });
  const mx = Math.max(...sm), sl = sm.map((v, i) => (i && i < sm.length - 1 ? (sm[i + 1] - sm[i - 1]) / 0.02 : 0));
  const med = a => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1] || 0; };
  for (let i = 100; i < sl.length - 20; i++) {
    const before = med(sl.slice(Math.max(0, i - 100), i));
    if (sl[i] < -40 && med(sl.slice(i, i + 15)) < Math.min(-40, before * 4) && sm[i] > mx - 60) return (i - 3) * 0.01;
  }
  return null;
}
function fitF0B(x, sr, midi, a4) {
  const fNom = a4 * Math.pow(2, (midi - 69) / 12), s0 = Math.round(0.05 * sr);
  const len = Math.round(Math.min(1.5, x.length / sr - 0.1) * sr); if (len < 256) return { f0: fNom, B: 0, peaks: {} };
  const { X, df } = spectrum(x.subarray(s0, s0 + len), sr);
  let ref = 0; for (const v of X) if (v > ref) ref = v; const refDb = 20 * log10(ref);
  let B = midi > 40 ? 1e-4 : 3e-4, f0 = fNom, peaks = {};
  for (let it = 0; it < 3; it++) {
    const pts = []; peaks = {};
    for (let n = 1; n < 60; n++) {
      const fg = n * f0 * Math.sqrt(1 + B * n * n); if (fg > Math.min(0.45 * sr, 9000)) break;
      const lo = Math.floor(fg * 0.985 / df), hi = Math.ceil(fg * 1.015 / df); if (hi - lo < 3) continue;
      let k = lo; for (let j = lo; j <= hi; j++) if (X[j] > X[k]) k = j;
      if (k > 0 && k < X.length - 1 && 20 * log10(X[k]) > refDb - 55) {
        const a = Math.log(X[k - 1] + 1e-12), b = Math.log(X[k] + 1e-12), c = Math.log(X[k + 1] + 1e-12), den = a - 2 * b + c;
        const d = Math.abs(den) > 1e-9 ? 0.5 * (a - c) / den : 0;
        if (Math.abs(d) <= 1) { const f = (k + d) * df; pts.push([n, f]); peaks[n] = f; }
      }
    }
    if (pts.length >= 4) {                          // (f_n/n)^2 = f0^2 + f0^2 B n^2  -> linear fit in n^2
      let sx = 0, sy = 0, sxx = 0, sxy = 0; const m = pts.length;
      for (const [n, f] of pts) { const X2 = n * n, Y = (f / n) ** 2; sx += X2; sy += Y; sxx += X2 * X2; sxy += X2 * Y; }
      const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), c0 = (sy - slope * sx) / m;
      if (c0 > 0) { f0 = Math.sqrt(c0); B = Math.max(0, slope / c0); }
    } else if (pts.length) f0 = pts[0][1] / pts[0][0];
  }
  return { f0, B, peaks };
}
function harmonicShare(x, sr, f0, B) {
  const s0 = Math.round(0.05 * sr), len = Math.round(Math.min(1.0, x.length / sr - 0.1) * sr); if (len < 256) return 1;
  const { X, df } = spectrum(x.subarray(s0, s0 + len), sr, 1);
  let tot = 0, hit = 0; const lo = Math.floor(0.45 * f0 / df);
  for (let k = lo; k < X.length; k++) tot += X[k] * X[k];
  for (let n = 1; n < 80; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n); if (fn / df >= X.length) break;
    for (let k = Math.floor(fn * 0.98 / df); k <= Math.ceil(fn * 1.02 / df) && k < X.length; k++) hit += X[k] * X[k];
  }
  return hit / (tot + 1e-30);
}
function freePeaks(x, sr, midi, a4, maxPeaks = 24) {
  const fNom = a4 * Math.pow(2, (midi - 69) / 12), s0 = Math.round(0.02 * sr), len = Math.round(Math.min(1.0, x.length / sr - 0.05) * sr);
  const { X, df } = spectrum(x.subarray(s0, s0 + len), sr);
  let ref = 0; for (const v of X) if (v > ref) ref = v; const refDb = 20 * log10(ref);
  const cand = [];
  for (let k = Math.max(1, Math.floor(fNom * 0.45 / df)); k < X.length - 1; k++)
    if (X[k] > X[k - 1] && X[k] >= X[k + 1] && 20 * log10(X[k]) > refDb - 50 && k * df < Math.min(0.45 * sr, 16000)) cand.push(k);
  cand.sort((a, b) => X[b] - X[a]);
  const picked = [];
  for (const k of cand) { if (picked.every(j => Math.abs(k - j) * df > j * df * 0.03)) picked.push(k); if (picked.length >= maxPeaks) break; }
  const freqs = picked.map(k => k * df).sort((a, b) => a - b);
  const f0 = freqs.length ? freqs.reduce((b, f) => (Math.abs(Math.log(f / fNom)) < Math.abs(Math.log(b / fNom)) ? f : b)) : fNom;
  return { f0, freqs };
}
// demodulated amplitude envelope of the component at f, sampled every hop samples
function envelope(x, sr, f, hop) {
  const w = Math.max(Math.round(0.02 * sr), Math.round(2.5 * sr / Math.max(f, 20)));
  const n = x.length; if (n <= w) return { t: [], a: [] };
  // Hann-weighted frames (a rectangular moving average leaks loud low partials into every high slot, ~-45 dB)
  const zr = new Float64Array(n), zi = new Float64Array(n), dw = 2 * Math.PI * f / sr;
  const c = Math.cos(dw), s = Math.sin(dw); let pr = 1, pi = 0;
  for (let i = 0; i < n; i++) {
    zr[i] = x[i] * pr; zi[i] = -x[i] * pi;
    const t = pr * c - pi * s; pi = pr * s + pi * c; pr = t;
    if ((i & 4095) === 0) { const g = 1 / Math.hypot(pr, pi); pr *= g; pi *= g; }
  }
  const h = new Float64Array(w); let hs = 0;
  for (let k = 0; k < w; k++) { h[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (k + 1) / (w + 1)); hs += h[k]; }
  const t = [], a = [];
  for (let i = 0; i + w <= n; i += hop) {
    let sr_ = 0, si = 0;
    for (let k = 0; k < w; k++) { sr_ += h[k] * zr[i + k]; si += h[k] * zi[i + k]; }
    t.push((i + w / 2) / sr); a.push(2 * Math.hypot(sr_, si) / hs);
  }
  return { t, a };
}
// two-stage fit of an energy envelope (dB) -> [levelDb, t60d, t60r, remanentDb]
function fitDecay(t, db) {
  const n = t.length; if (n < 6) return null;
  const a = db.map(v => Math.pow(10, v / 20));
  const solve = (kd, kr) => {                      // weighted LS (weights 1/a) for Ad, Ar
    let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) { const e1 = Math.exp(-kd * t[i]) / a[i], e2 = Math.exp(-kr * t[i]) / a[i]; s11 += e1 * e1; s12 += e1 * e2; s22 += e2 * e2; b1 += e1; b2 += e2; }
    const det = s11 * s22 - s12 * s12; if (Math.abs(det) < 1e-30) return null;
    const Ad = Math.max((b1 * s22 - b2 * s12) / det, 1e-9), Ar = Math.max((b2 * s11 - b1 * s12) / det, 1e-12);
    let err = 0; for (let i = 0; i < n; i++) { const m = 20 * log10(Ad * Math.exp(-kd * t[i]) + Ar * Math.exp(-kr * t[i])); err += (m - db[i]) ** 2; }
    return { err: err / n, Ad, Ar, kd, kr };
  };
  const geo = (a, b, k) => Array.from({ length: k }, (_, i) => a * Math.pow(b / a, i / (k - 1)));
  let best = null;
  for (const kd of geo(0.08, 60, 22)) for (const kr of geo(0.002, 8, 22)) {
    if (kr >= kd * 0.85) continue; const r = solve(kd, kr); if (r && (!best || r.err < best.err)) best = r;
  }
  if (!best) return null;
  for (let pass = 0; pass < 2; pass++) {             // local refinement around the best grid point
    const { kd: d0, kr: r0 } = best;
    for (const kd of geo(d0 / 1.4, d0 * 1.4, 9)) for (const kr of geo(r0 / 1.4, r0 * 1.4, 9)) {
      if (kr >= kd) continue; const r = solve(kd, kr); if (r && r.err < best.err) best = r;
    }
  }
  const { Ad, Ar, kd, kr } = best;
  return [20 * log10(Ad + Ar), 6.908 / kd, 6.908 / kr, 20 * log10(Ar / (Ad + Ar))];
}

/** Loudness of a note's attack in dB: the mean square over 0.15 s starting at the loudest 50 ms of the first 0.4 s after the onset
 *  (a soft key's onset detector can fire on the key thump, before the tone). With a noise power (mean square of the room) that power is
 *  subtracted first; null when the note is less than 6 dB above it. The same measure as tools/calibrate_levels.py. */
export function attackLevel(input, sr, noise = null) {
  const x = input.subarray ? input.subarray(onset(input, sr)) : Float32Array.from(input).subarray(onset(input, sr));
  const w = Math.round(0.05 * sr), hop = Math.round(0.01 * sr); let best = 0, bp = -1;
  for (let i = 0; i < 40; i++) { const a = i * hop; if (a + w > x.length) break; let s = 0; for (let k = a; k < a + w; k++) s += x[k] * x[k]; if (s > bp) { bp = s; best = a; } }
  const seg = x.subarray(best, best + Math.round(0.15 * sr)); if (seg.length < 1000) return null;
  let p = 0; for (let k = 0; k < seg.length; k++) p += seg[k] * seg[k]; p /= seg.length;
  if (noise != null) { if (p < 4 * noise) return null; p -= noise; }
  return 10 * log10(p + 1e-24);
}
function noisePower(x, sr) {
  const o = onset(x, sr), pre = x.subarray(Math.max(0, o - Math.round(0.5 * sr)), Math.max(0, o - Math.round(0.01 * sr)));
  if (pre.length > 0.1 * sr) { let s = 0; for (const v of pre) s += v * v; return s / pre.length; }
  const n = Math.round(0.1 * sr), m = Math.floor(x.length / n); let mn = Infinity;
  for (let j = 0; j < m; j++) { let s = 0; for (let k = j * n; k < (j + 1) * n; k++) s += x[k] * x[k]; mn = Math.min(mn, s / n); }
  return m ? mn : 0;
}

export function analyzeNote(input, sr, midi, { a4 = 440, maxPartials = 100, inharmonic = null } = {}) {
  let x = Float64Array.from(input);
  let mx = 0; for (const v of x) mx = Math.max(mx, Math.abs(v)); if (mx < 1e-5) return null;
  const recLevel = attackLevel(x, sr, noisePower(x, sr));
  const o = onset(x, sr);
  const pre = x.subarray(Math.max(0, o - Math.round(0.51 * sr)), Math.max(0, o - Math.round(0.01 * sr)));
  x = x.subarray(o);
  const rel = releaseTime(x, sr); if (rel) x = x.subarray(0, Math.round(rel * sr));
  let { f0, B, peaks } = fitF0B(x, sr, midi, a4);
  if (inharmonic === null) {
    let share = harmonicShare(x, sr, f0, B);
    if (share < 0.5) for (let i = 0; i < 40; i++) {         // weak fundamentals / poor B fit: search B first
      const Bc = 1e-6 * Math.pow(5e3, i / 39), sc = harmonicShare(x, sr, f0, Bc);
      if (sc > share) { share = sc; B = Bc; }
    }
    inharmonic = share < 0.5;
  }
  let freqs = null;
  if (inharmonic) { const fp = freePeaks(x, sr, midi, a4, Math.min(24, maxPartials)); f0 = fp.f0; freqs = fp.freqs; B = 0; }
  const hop = Math.round(0.01 * sr), parts = [];
  let preMax = 0; for (const v of pre) preMax = Math.max(preMax, Math.abs(v));
  const count = freqs ? freqs.length : maxPartials;
  for (let n = 1; n <= count; n++) {
    const fn = freqs ? freqs[n - 1] : (peaks[n] || n * f0 * Math.sqrt(1 + B * n * n));
    if (!(fn > 0) || !isFinite(fn)) continue;
    if (fn > Math.min(0.45 * sr, 12000)) break;
    const { t, a } = envelope(x, sr, fn, hop); if (t.length < 10) continue;
    const pw = a.map(v => v * v), db = pw.map((_, i) => { let s = 0, c = 0; for (let k = i - 12; k <= i + 12; k++) if (k >= 0 && k < pw.length) { s += pw[k]; c++; } return 10 * log10(s / c); });   // edge-normalised
    let floor;
    if (pre.length > 0.02 * sr && preMax > 0) { const e = envelope(pre, sr, fn, Math.max(1, hop >> 2)).a.slice().sort((p, q) => p - q); floor = 20 * log10(e[e.length >> 1] || 1e-12); }
    else floor = Math.max(...db) - 100;
    const t0 = 3; let end = t0; for (let i = db.length - 1; i >= t0; i--) if (db[i] > floor + 6) { end = i; break; }
    if (end - t0 < 8) continue;
    let pk = t0; for (let i = t0; i < Math.min(end, t0 + 150); i++) if (db[i] > db[pk]) pk = i;
    // log-spaced sample points: every decade of time weighs the same
    if (end - pk < 8) continue;
    const span = end - pk, idx = [...new Set(Array.from({ length: 150 }, (_, i) => Math.min(end - 1, pk - 1 + Math.round(Math.pow(span, i / 149)))))].filter(i => i >= pk);
    const tt = idx.map(i => t[i] - t[pk]), dd = idx.map(i => db[i]);
    const r = fitDecay(tt, dd); if (!r) continue;
    parts.push([+(fn / f0).toFixed(4), r[0], +r[1].toFixed(3), +r[2].toFixed(3), +r[3].toFixed(1)]);
  }
  if (!parts.length) return null;
  const top = Math.max(...parts.map(p => p[1]));
  const out = parts.map(p => [p[0], +(p[1] - top).toFixed(1), p[2], p[3], p[4]]).filter(p => p[1] > -70);
  return { f0_hz: +f0.toFixed(3), B: +B.toExponential(3), partials: out, peak_db: +top.toFixed(1), level_db: recLevel == null ? null : +recLevel.toFixed(2), inharmonic: !!inharmonic, released_at: rel };
}

// assemble recordings [{midi, velocity, result}] into a resonance-instrument/1 document
// Which key is this recording? The YIN pitch detector (de Cheveigne and Kawahara 2002) on the 0.4 s after the attack: the difference function
// d(tau) = sum (x[i] - x[i+tau])^2, normalised by its running mean, dips to ~0 at the period of the tone even when the fundamental itself is weak
// (a piano's lowest octave), and the first dip below the threshold is taken, which avoids the octave errors of a plain autocorrelation.
// Returns { midi, cents } (the key nearest the pitch and how far the pitch is from it) or null for a silent or pitchless file. Used to place
// files that carry no note name.
export function guessMidi(input, sr, a4 = 440) {
  const x = Float64Array.from(input); let mx = 0; for (const v of x) mx = Math.max(mx, Math.abs(v)); if (mx < 1e-5) return null;
  const s0 = onset(x, sr) + Math.round(0.03 * sr), tmin = Math.max(2, Math.round(sr / 4700));
  const yin = (tmax, secs) => {                       // normalised difference function over `secs` of signal, lags 1..tmax
    const W = Math.min(Math.round(secs * sr), x.length - s0 - tmax); if (W < 4 * tmin) return null;
    const n = new Float64Array(tmax + 1); n[0] = 1; let run = 0;
    for (let t = 1; t <= tmax; t++) { let sum = 0; for (let i = 0; i < W; i++) { const df = x[s0 + i] - x[s0 + i + t]; sum += df * df; } run += sum; n[t] = run > 0 ? sum * t / run : 1; }
    return n;
  };
  // the first dip below 0.15 (then its bottom): the shortest period that repeats, so not a multiple of it
  const pick = (n, thr) => {
    if (!n) return -1;
    for (let t = tmin; t < n.length - 1; t++) if (n[t] < thr) { while (t + 1 < n.length - 1 && n[t + 1] < n[t]) t++; return t; }
    return -1;
  };
  let n = yin(Math.round(sr / 90), 0.05), tau = pick(n, 0.15);                                // above ~90 Hz a short window (a fast-decaying treble note is not stationary for long)
  if (tau < 0) { n = yin(Math.round(sr / 90), 0.05); tau = pick(n, 0.3); }
  if (tau < 0 || tau > sr / 130) { const n2 = yin(Math.min(Math.round(sr / 24), 4096), 0.4), t2 = pick(n2, 0.15); if (t2 >= 0) { n = n2; tau = t2; } else if (tau < 0) { n = n2; tau = pick(n2, 0.4); } }   // below it a long one
  if (tau < 0) return null;
  const tmax = n.length - 1;
  const a = n[tau - 1], b = n[tau], c = n[Math.min(tau + 1, tmax)], den = a - 2 * b + c, fine = den ? tau + 0.5 * (a - c) / den : tau;   // parabolic refinement
  const f = sr / fine, m = 69 + 12 * Math.log2(f / a4), midi = Math.round(m);
  if (midi < 21 || midi > 108) return null;
  return { midi, cents: (m - midi) * 100 };
}

// ---- which key does a recording really play? (a file name is a label, not a measurement: a flute named A4 sounds an octave higher) ----
// Evidence for the named pitch and the octaves around it, from the first 0.6 s after the attack:
//   pres[k]  the fundamental of (named + 12 k) is really there: a peak at f (+-1.5 %), 10 dB over the spectrum around it, at most 25 dB under the
//            strongest of the first 8 harmonics. A weak fundamental alone (a piano's bass, a contrabassoon) does not make the name wrong.
//   yin[k]   the period detector (YIN) hears that pitch. It is blind to which harmonic is strongest but can land an octave off.
// resolveKey picks the octave: the named one when its fundamental is there; another only when its fundamental is there AND YIN hears it, or when it is
// the octave most of the instrument's files need (`prefer`: name errors are uniform within an instrument, every flute file is an octave low).
export function yinPitch(x, sr, s0) {
  const tmax = Math.min(Math.floor(sr / 24), 4096), tmin = Math.max(2, Math.floor(sr / 4700)), W = Math.min(Math.floor(0.3 * sr), x.length - s0 - tmax - 1);
  if (W < 4 * tmin) return null;
  const d = new Float64Array(tmax + 1); let c0 = 0; for (let i = 0; i < W; i++) c0 += x[s0 + i] * x[s0 + i];
  const cs = new Float64Array(W + tmax + 2); for (let i = 0; i < W + tmax + 1; i++) cs[i + 1] = cs[i] + x[s0 + i] * x[s0 + i];
  for (let t = 1; t <= tmax; t++) { let r = 0; for (let i = 0; i < W; i++) r += x[s0 + i] * x[s0 + i + t]; d[t] = c0 + (cs[W + t] - cs[t]) - 2 * r; }
  const nd = new Float64Array(tmax + 1); let run = 0;
  for (let t = 1; t <= tmax; t++) { run += d[t]; nd[t] = run > 0 ? d[t] * t / run : 1; }
  for (let t = tmin; t < tmax; t++) if (nd[t] < 0.15) { while (t + 1 < tmax && nd[t + 1] < nd[t]) t++; return sr / t; }
  return null;
}
export function pitchEvidence(input, sr, named, a4 = 440) {
  const x = Float64Array.from(input), o = onset(x, sr), s0 = o + Math.round(0.03 * sr), len = Math.min(Math.round(0.6 * sr), x.length - s0);
  const ev = { named, pres: {}, yin: {}, yinMidi: null };
  if (len < Math.round(0.15 * sr)) return ev;
  const { X, df } = spectrum(x.subarray(s0, s0 + len), sr, 4), pw = f => { const lo = Math.max(0, Math.floor(f * 0.985 / df)), hi = Math.min(X.length - 1, Math.ceil(f * 1.015 / df)); let m = 0; for (let i = lo; i <= hi; i++) if (X[i] > m) m = X[i]; return m; };
  const around = f => { const lo = Math.max(0, Math.floor(f * 0.7 / df)), hi = Math.min(X.length - 1, Math.ceil(f * 1.4 / df)); const v = Array.from(X.subarray(lo, hi + 1), a => a * a).sort((p, q) => p - q); return (v[v.length >> 1] || 0) + 1e-30; };
  const fy = yinPitch(x, sr, s0); if (fy) ev.yinMidi = 69 + 12 * Math.log2(fy / a4);
  for (let k = -2; k <= 2; k++) {
    const f = a4 * Math.pow(2, (named + 12 * k - 69) / 12); if (f < 25 || f > 4500) { ev.pres[k] = false; ev.yin[k] = false; continue; }
    let top = 0; for (let n = 1; n <= 8 && f * n < sr * 0.45; n++) top = Math.max(top, pw(f * n));
    const p = pw(f); ev.pres[k] = top > 0 && p >= top * Math.pow(10, -1.25) && p * p > 10 * around(f);
    ev.yin[k] = fy != null && Math.abs(12 * Math.log2(fy / f)) < 0.7;
  }
  return ev;
}
/** the octave shift k (named + 12 k is the key that sounds) */
export function resolveKey(ev, prefer = 0) {
  for (const k of [-1, -2]) if (ev.pres[k] && ev.yin[k]) return k;          // the named pitch is an overtone of a lower note that really is there and that YIN hears
  for (const k of (prefer ? [prefer] : []).concat([0, 1, -1, 2, -2])) if (ev.pres[k] && (k === 0 || k === prefer || ev.yin[k])) return k;
  return 0;
}
export function assemble(takes, meta) {
  const keys = {};
  for (const tk of takes) {
    if (!tk.result) continue;
    const k = keys[tk.midi] ||= { note: tk.midi, layers: [], _f0: [], _B: [] };
    k._f0.push(tk.result.f0_hz); k._B.push(tk.result.B);
    k.layers.push({ velocity: tk.velocity, peak_db: tk.result.peak_db, partials: tk.result.partials });
  }
  const med = a => [...a].sort((p, q) => p - q)[a.length >> 1];
  const out = Object.values(keys).sort((a, b) => a.note - b.note).map(k => {
    k.layers.sort((a, b) => a.velocity - b.velocity);
    const r = { note: k.note, f0_hz: med(k._f0), B: med(k._B), layers: k.layers };
    return r;
  });
  if (!out.length) throw new Error('no usable recordings');
  const ref = Math.max(...out.flatMap(k => k.layers.map(l => l.peak_db)));
  for (const k of out) {
    const lp = k.layers[k.layers.length - 1].peak_db;
    k.level_db = +(lp - ref).toFixed(1);
    for (const l of k.layers) { l.gain_db = +(l.peak_db - lp).toFixed(1); delete l.peak_db; }
  }
  return regularize({ format: 'resonance-instrument/1', name: meta.name || 'My instrument', author: meta.author || '', license: meta.license || '',
    source: meta.source || 'recorded with the Resonance recording wizard', a4_hz: meta.a4 || 440, keys: out });
}

// ---- decay-law regularization (same algorithm as tools/analyze_instrument.py: regularize) ----
// Fits rate_direct(m, n, f) = r1(m)·(1 + a(n-1))·(1 + (f/fc)^q) to all partials (grid over a, fc, q; log r1 as a
// piecewise-linear key curve by least squares, 2 passes with outlier trimming), then shrinks every partial's
// measured decays halfway toward the law and replaces outliers/endless tails by it.
function solveLS(A, y) {                                  // normal equations + Gaussian elimination (small k)
  const k = A[0].length, M = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let r = 0; r < A.length; r++) for (let i = 0; i < k; i++) { if (!A[r][i]) continue; for (let j = 0; j < k; j++) M[i][j] += A[r][i] * A[r][j]; M[i][k] += A[r][i] * y[r]; }
  for (let i = 0; i < k; i++) M[i][i] += 1e-9;
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / M[c][c]; if (f) for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row, i) => row[k] / row[i]);
}
export function regularize(doc) {
  const keys = doc.keys; if (keys.length < 3) return doc;
  const notes = [...new Set(keys.map(k => k.note))].sort((a, b) => a - b), hi = notes[notes.length - 1];
  const bps = [...new Set([...notes.filter((_, i) => i % 2 === 0), hi])];
  const hat = m => { const h = new Array(bps.length).fill(0); if (bps.length === 1) { h[0] = 1; return h; }
    let j = 0; while (j < bps.length - 2 && m >= bps[j + 1]) j++; const t = (m - bps[j]) / (bps[j + 1] - bps[j]); h[j] += 1 - t; h[j + 1] += t; return h; };
  const pts = [];
  for (const k of keys) { const f0 = k.f0_hz || 440 * Math.pow(2, (k.note - 69) / 12);
    for (const L of k.layers) for (const [r, lvl, td, tr, rem] of L.partials)
      if (lvl >= -40 && tr <= 500 && td > 0 && tr >= td) pts.push({ m: k.note, n: Math.max(1, Math.round(r)), f: r * f0, y: Math.log(6.908 / td), lk: Math.log(tr / td), rem, h: hat(k.note) }); }
  if (pts.length < 20) return doc;
  let keep = pts.map(() => true), best = null;
  const med = a => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
  for (let pass = 0; pass < 2; pass++) {
    best = null;
    for (const a of [0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25])
      for (let i = 0; i < 12; i++) { const fc = 800 * Math.pow(15, i / 11);
        for (const q of [0.8, 1.2, 1.6, 2, 2.5, 3, 4]) {
          const g = pts.map(p => Math.log(1 + a * (p.n - 1)) + Math.log(1 + Math.pow(p.f / fc, q)));
          const idx = pts.map((_, j) => j).filter(j => keep[j]);
          const c = solveLS(idx.map(j => pts[j].h), idx.map(j => pts[j].y - g[j]));
          const res = pts.map((p, j) => p.y - g[j] - p.h.reduce((s, v, t) => s + v * c[t], 0));
          const e = med(idx.map(j => Math.abs(res[j])));
          if (!best || e < best.e) best = { e, a, fc, q, c, res };
        } }
    keep = best.res.map(r => Math.abs(r) < Math.max(2.5 * 1.4826 * best.e, 0.15));
  }
  const { e, a, fc, q, c } = best;
  const per = {}; for (const p of pts) (per[p.m] ||= []).push(p);
  const km = Object.keys(per).map(Number).sort((x, y) => x - y);
  const sm = v => v.map((_, i) => { let s = 0, n = 0; for (let j = i - 2; j <= i + 2; j++) { const jj = Math.min(Math.max(j, 0), v.length - 1); s += v[jj]; n++; } return s / n; });
  const Kc = sm(km.map(m => med(per[m].map(p => p.lk)))).map(v => Math.min(Math.max(v, Math.log(1.3)), Math.log(8)));
  const interp = (x, xs, ys) => { if (x <= xs[0]) return ys[0]; for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[ys.length - 1]; };
  const lim = 2.5 * 1.4826 * e + 0.2;
  for (const k of keys) {
    const f0 = k.f0_hz || 440 * Math.pow(2, (k.note - 69) / 12), lr1 = hat(k.note).reduce((s, v, t) => s + v * c[t], 0), K = Math.exp(interp(k.note, km, Kc));
    for (const L of k.layers) {
      const rems = L.partials.filter(p => p[1] > -40 && p[4] > -100).map(p => p[4]), rmed = rems.length ? med(rems) : -18;
      for (const p of L.partials) {
        const n = Math.max(1, Math.round(p[0])), rd = Math.exp(lr1) * (1 + a * (n - 1)) * (1 + Math.pow(p[0] * f0 / fc, q));
        const md = Math.log(6.908 / rd), mr = Math.log(6.908 * K / rd);
        const shrink = (raw, law) => (!(raw > 0) || raw > 500 ? law : Math.abs(Math.log(raw) - law) > lim ? law : law + 0.5 * (Math.log(raw) - law));
        const td = Math.exp(shrink(p[2], md)), tr = Math.exp(shrink(p[3], mr));
        p[2] = +td.toFixed(3); p[3] = +Math.max(tr, td * 1.2).toFixed(3); p[4] = +Math.min(Math.max(p[4], rmed - 8, -60), rmed + 8).toFixed(1);
      }
    }
  }
  doc.decay_model = { a, fc_hz: +fc.toFixed(1), q, fit_mad_log: +e.toFixed(3), note: 'per-partial decays shrunk toward this law' };
  return doc;
}
