// Resonance engine — real-time spectral physical piano model (AudioWorklet).
// Model: each note = strings x partials of exponentially decaying
// sinusoids (phasor rotation), amplitudes in dB, two-stage direct/remanent decay,
// per-note interpolation A0..C8, 3 hammer zones (vel 32/64/96). Plus sympathetic
// resonance voices, harp/cabinet resonance (FDN), dampers, 4 pedals, mechanical noises.

const MAXOSC = 200;
const LN1000 = 6.907755;          // ln(10^3): T60 -> rate
const NOTE_LO = 21, NOTE_HI = 108;

// Stretch of a tuned piano, in cents from equal temperament at stretch 1: a small flat bass and a steeply rising sharp treble
// (stiff strings make the upper partials of every note sharp, so a tuner pulls the octaves apart to match them).
// Two smooth power laws fitted to a measurement of a modelled concert grand: -12 cents at A0, within 1 cent from E2 to
// C4, +4 at C6, +14 at G6, +40 at C8. Not symmetric, which the old +-26 cents law was not either.
const ATK_K = +(globalThis.ATK_K ?? 1.5), ATK_0 = +(globalThis.ATK_0 ?? 0.3);   // hammer-contact rise: scale and the loud-blow floor (tuned against the Iowa recordings)
const NOENG = {};
const stretchCents = m => -11.94 * Math.pow(Math.max(0, 68.47 - m) / 47.47, 3.386) + 39.97 * Math.pow(Math.max(0, m - 50) / 58, 4.761);

// ---------- historical temperaments (ratios relative to equal temperament, A fixed) ----------
function tempRatios(name) {
  const P = Math.pow, et = i => P(2, i / 12);
  let r2c;
  switch (name) {
    case 'pythagore': {
      const d = 1.5 / P(2, 7 / 12), e = [-3, -8, -1, -6, 1, -4, 3, -2, -7, 0, -5, 2];
      return e.map(x => P(d, x));
    }
    case 'zarlino': r2c = [1, 25 / 24, 9 / 8, 32 / 27, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 25 / 16, 5 / 3, 16 / 9, 15 / 8]; break;
    case 'mesotonic': {
      const q = P(5, 0.25);
      r2c = [1, 5 * q ** 3 / 16, q * q / 2, 4 * q / 5, 5 / 4, 2 / q, 5 * q * q / 8, q, 25 / 16, q ** 3 / 2, 4 * q * q / 5, 5 * q / 4];
      break;
    }
    case 'welltempered': {
      let q = 1.5;                                   // max real root of x^4 + 2x - 8
      for (let i = 0; i < 60; i++) q -= (q ** 4 + 2 * q - 8) / (4 * q ** 3 + 2);
      const a = P(128 / q ** 5, 1 / 7);
      r2c = [1, a * a * q ** 5 / 16, q * q / 2, a ** 4 * q ** 5 / 32, q ** 4 / 4, 2 / a, a * q ** 5 / 8, q,
        a ** 3 * q ** 5 / 16, q ** 3 / 2, 4 / (a * a), a * q ** 4 / 4];
      break;
    }
    case 'werckmeister': r2c = [1, 256 / 243, 1.1174, 32 / 27, 1.2528, 4 / 3, 1024 / 729, 1.4949, 128 / 81, 1.6704, 16 / 9, 1.8792]; break;
    default: return new Array(12).fill(1);          // equal, flat
  }
  const r = r2c.map((v, i) => v / et(i)), a = r[9];  // leave A unchanged
  return r.map(v => v / a);
}

// piecewise-linear interpolation over sorted [x,y] points
function interp(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1);
    }
  }
  return pts[pts.length - 1][1];
}

// log10(B) along the keyboard for a 2.7 m concert grand (wound-string break near the tenor)
const LOGB = [[21, -3.35], [33, -4.05], [45, -3.85], [60, -3.55], [72, -3.25], [84, -2.85], [96, -2.4], [108, -1.95]];

// deterministic per-note randomness (character, string jitter) so a note always sounds the same
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185 * v); }


// ---------- synth voices: filter magnitude, noise envelope, noise power ----------
// Magnitude of a resonant 2-pole filter (4-pole = the square) at u = f / cutoff. Passband gain 1 (a band-pass peaks at 1).
function filterMag(type, poles, q, u) {
  const u2 = u * u, d = (1 - u2) * (1 - u2) + u2 / (q * q);
  const m2 = type === 'hp' ? u2 * u2 / d : type === 'bp' ? (u2 / (q * q)) / d : 1 / d;
  return poles === 4 ? m2 : Math.sqrt(m2);
}
// power gain of a noise band relative to white noise: the integral of |H|^2 over frequency, in Hz (log grid)
function bandNeb(type, poles, q, fc, sr) {
  let s = 0; const lo = Math.log(20), hi = Math.log(0.49 * sr), n = 400, dl = (hi - lo) / n;
  for (let i = 0; i < n; i++) { const f = Math.exp(lo + (i + 0.5) * dl), m = filterMag(type, poles, q, f / fc); s += m * m * f * dl; }
  return s;
}
const noiseEnv = (g, t) => { t -= g.delay; if (t < 0) return 0; return (g.ta > 0 ? 1 - Math.exp(-t / g.ta) : 1) * (g.rate > 0 ? g.sus + (1 - g.sus) * Math.exp(-t * g.rate) : 1); };
const smooth = x => x * x * (3 - 2 * x);

class Voice {
  constructor() {
    const F = () => new Float64Array(MAXOSC);
    this.re = F(); this.im = F(); this.c = F(); this.s = F();
    this.ed = F(); this.er = F(); this.kd = F(); this.kr = F();
    this.gl = F(); this.gr = F(); this.fr = F(); this.fg = F();   // fg: the filter gain currently applied to each partial (synth voices)
    this.dampRate = 0;                // damper felt rate (1/s); high partials are damped faster (see renderVoice)
    this.n = 0; this.active = false; this.note = 0; this.res = false;
    this.g = 1; this.gd = 1; this.fading = false; this.level = 0; this.born = 0; this.relTau = 1;
    this.att = 1; this.att1 = 1; this.ka = 0;   // hammer-contact attack ramp: two cascaded one-pole smoothers (att1 -> att, 0 -> 1), so the onset starts with zero slope like a real note's
    this.eng = null;                  // the engine block of the instrument this voice was struck from
    this.sy = null;                   // synth state: pitch modulation, filter, noise (engine.synth), null for a plain voice
    this.mono = true; this.pl = 0; this.pr = 0;   // all partials share one pan (pl, pr): summed once, panned at the end
  }
}

class NoiseEv {
  constructor() { this.active = false; }
}

class PianoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.sr = sampleRate;
    this.voices = []; for (let i = 0; i < 300; i++) this.voices.push(new Voice());
    this.noise = []; for (let i = 0; i < 192; i++) this.noise.push(new NoiseEv());
    this.resVoice = new Array(128).fill(null);
    this.keyDown = new Uint8Array(128); this.sost = new Uint8Array(128);
    this.bendRatio = 1;                                    // pitch wheel: frequency ratio applied to every oscillator
    this.sustain = 0; this.soft = 0; this.sostenuto = false; this.harmonic = false;
    this.tl = new Float64Array(128); this.tr = new Float64Array(128);
    this.nzb = new Float64Array(1024); this.wn = new Float64Array(1024); this.xin = new Float64Array(1024); this.layerGain = 1; this.lastF = 0;   // synth-voice noise scratch, last struck pitch (glide)
    this.dryL = new Float64Array(128); this.dryR = new Float64Array(128);
    this.queue = [];
    this.seed = 22222;
    this.frame = 0;
    // global (harp/cabinet) resonance FDN
    const ms = [3.1, 4.37, 5.93, 7.71, 11.3, 13.7, 17.9, 23.3];
    this.fdnLen = ms.map(m => Math.round(m * this.sr / 1000));
    this.fdnBuf = this.fdnLen.map(l => new Float64Array(l));
    this.fdnPos = new Int32Array(8); this.fdnLp = new Float64Array(8); this.fdnG = new Float64Array(8);
    this.fdnT60 = 0.3; this.hpX = 0; this.hpY = 0;
    this.levels = new Float32Array(128);
    this.meterCount = 0; this.peakL = 0; this.peakR = 0;
    this.cpuAcc = 0; this.cpuBlocks = 0; this.cpu = 0;
    this.lastInfo = null;
    // scratch buffers: nothing on the note-on / render path may allocate (GC stalls the audio thread)
    const SC = () => new Float64Array(256);
    this.sFs = SC(); this.sAs = SC(); this.sRd = SC(); this.sRr = SC(); this.sWs = SC();
    this.fdnO = new Float64Array(8);
    this.lay = { v: 0, g: 0, n: 0, r: SC(), l: SC(), td: SC(), tr: SC(), rm: SC() };
    this.symModel = new Array(128).fill(null);          // per key: model + sympathetic partial frequencies
    this.symAmp = []; for (let i = 0; i < 128; i++) this.symAmp.push(new Float64Array(16));
    this.inst = o.inst || null;               // compiled measured instrument (js/instrument.js)
    this.setParams(o.params || {});
    if (o.events) for (const e of o.events) this.enqueue(e);
    this.port.onmessage = e => {
      const d = e.data;
      if (d.type === 'params') this.setParams(d.p);
      else if (d.type === 'events') for (const ev of d.events) this.enqueue(ev);
      else if (d.type === 'panic') this.panic();
      else if (d.type === 'inst') { this.inst = d.data; this.setParams(this.pUser || {}); }
      else if (d.type === 'mixw') { const W = this.inst && this.inst.multi; if (W) d.w.forEach((w, i) => { if (W[i]) W[i].w = w; }); }
      else this.enqueue(d);
    };
  }

  enqueue(ev) {
    ev.f = ev.t == null ? -1 : Math.round(ev.t * this.sr);
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].f > ev.f) i--;
    q.splice(i, 0, ev);
  }

  // ---------------- parameters -> derived tables ----------------
  setParams(p) {
    this.pUser = p;                                     // explicit values; the instrument's own defaults (engine.params) sit under them
    this.p = Object.assign({
      diapason: 440, temperament: 'equal', unison: 1, stretch: 1, direct: 1,
      hardP: 0.85, hardM: 1, hardF: 1.15, profile: [0, 0, 0, 0, 0, 0, 0, 0], hammerNoise: 1, character: 0.7, softSmooth: 0.5,
      impedance: 1, sbCutoff: 0.5, sbQ: 0.5, size: 2.7, globalRes: 1, sympRes: 1, quadratic: 1,
      eq: [[50, 0], [16000, 0]], vel: [[0, 0], [1, 1]], volume: 0, dynamics: 30, width: 1, mode: 'stereo', polyphony: 96,
      keyNoise: 0.3, damperNoise: true, whoosh: 0.4, fullSympa: true,
    }, this.E.params, p);
    const P = this.p;
    const tr = tempRatios(P.temperament);
    this.ftab = new Float64Array(128); this.Btab = new Float64Array(128);
    for (let m = 0; m < 128; m++) {
      const cents = P.temperament === 'flat' ? 0 : P.stretch * stretchCents(m) + 0.5 * Math.max(0, P.stretch - 1) * (m - 60);   // above 1 the whole keyboard widens (0.5 cent per key from middle C per unit), not only the extremes
      this.ftab[m] = P.diapason * Math.pow(2, (m - 69) / 12) * tr[((m % 12) + 12) % 12] * Math.pow(2, cents / 1200);
      const x = Math.min(1, Math.max(0, (m - 21) / 87));
      this.Btab[m] = Math.pow(10, interp(LOGB, m)) * Math.pow(2.7 / P.size, 2 - x);
    }
    this.volLin = Math.pow(10, P.volume / 20);
    this.eqPts = P.eq.map(([f, db]) => [Math.log2(f), db]);
    if (this.symModel) this.symModel.fill(null);        // tuning / size / impedance changed
  }

  get E() { return (this.inst && this.inst.eng) || NOENG; }   // instrument's engine block: knock, quadratic, sympathetic, key_noise, dampers, release_s, stretch

  // a layered instrument's master effect (tremolo, rotary) comes from one part: its depth follows that part's weight
  multiW(key) { const W = this.inst && this.inst.multi, i = this.E[key + '_from']; return W && i != null && W[i] ? Math.min(1, W[i].w * 1.5) : 1; }

  velCurve(v) { return Math.min(1, Math.max(0, interp(this.p.vel, v))); }
  hardAt(v) {
    const P = this.p;
    return interp([[0.25, P.hardP], [0.5, P.hardM], [0.75, P.hardF]], v);
  }
  eqDb(f) { return interp(this.eqPts, Math.log2(f)); }

  // ---------------- voice allocation ----------------
  activeCount() { let n = 0; for (const v of this.voices) if (v.active && !v.fading) n++; return n; }
  alloc() {
    let free = null;
    for (const v of this.voices) if (!v.active) { free = v; break; }
    const poly = this.p.polyphony | 0;
    if (this.activeCount() >= poly || !free) {
      // steal the quietest non-fading voice
      let q = null;
      for (const v of this.voices) if (v.active && !v.fading && (!q || v.level < q.level)) q = v;
      if (q) this.fade(q, 0.006);
      if (!free) { free = q; if (free && this.resVoice[free.note] === free) this.resVoice[free.note] = null; }
    }
    free.active = true; free.fading = false; free.n = 0; free.g = 1; free.gd = 1; free.res = false;
    free.born = this.frame; free.level = 1; free.relTau = 1; free.att = 1; free.att1 = 1; free.ka = 0; free.mono = true; free.sy = null; free.eng = null;
    return free;
  }
  fade(v, tau) { v.fading = true; v.gd = Math.exp(-1 / (tau * this.sr)); if (this.resVoice[v.note] === v) this.resVoice[v.note] = null; }

  addOsc(v, f, ed, er, kd, kr, gl, gr, phase) {
    if (v.n >= MAXOSC) return -1;
    const i = v.n++, w = 2 * Math.PI * f * this.bendRatio / this.sr, ph = phase !== undefined ? phase : this.phase ? Math.random() * 2 * Math.PI : 0;
    v.re[i] = Math.cos(ph); v.im[i] = Math.sin(ph); v.c[i] = Math.cos(w); v.s[i] = Math.sin(w);
    v.ed[i] = ed; v.er[i] = er; v.kd[i] = kd; v.kr[i] = kr; v.gl[i] = gl; v.gr[i] = gr; v.fr[i] = f; v.fg[i] = 1;
    if (i === 0) { v.pl = gl; v.pr = gr; } else if (gl !== v.pl || gr !== v.pr) v.mono = false;
    return i;
  }

  // partial frequencies + remanent decay rates of note m (shared by strike and sympathetic builders)
  noteModel(m) {
    const P = this.p, sr = this.sr;
    const f1 = this.ftab[m], B = this.Btab[m];
    const f0 = f1 / Math.sqrt(1 + B);                    // tuned so partial 1 lands on pitch
    const x = (m - 21) / 87;
    const u = P.unison;
    let T60r = 60 * Math.pow(2, -(m - 21) / 18.5) * Math.pow(P.impedance, 0.85);
    T60r *= 1 + 0.25 * Math.max(0, 1 - u);                // tighter unison -> slower remanent
    const fc = 1000 * Math.pow(12, P.sbCutoff);          // soundboard cut-off 1..12 kHz
    const qe = 0.6 + 4.4 * P.sbQ;                         // slope above cut-off
    const rate1 = LN1000 / T60r;
    return { f0, B, x, fc, qe, rate1, fmax: Math.min(0.45 * sr, 18000) };
  }
  partialFreq(M, n) { return n * M.f0 * Math.sqrt(1 + M.B * n * n); }
  partialRate(M, n, f) { return M.rate1 * (1 + 0.11 * (n - 1)) * (1 + Math.pow(f / M.fc, M.qe)); }

  pan(m) {
    const p = Math.max(-1, Math.min(1, (m - 64.5) / 43)) * 0.6;
    return p;
  }

  // ---------------- note on: the strike ----------------
  // velocity layer of a compiled measured instrument at MIDI velocity vel (layers sorted by v)
  layerAt(layers, vel) {
    if (vel <= layers[0].v || layers.length === 1) return layers[0];
    const last = layers[layers.length - 1];
    if (vel >= last.v) return last;
    let i = 0; while (layers[i + 1].v < vel) i++;
    const a = layers[i], b = layers[i + 1], t = (vel - a.v) / (b.v - a.v), n = Math.min(a.r.length, b.r.length);
    const o = this.lay; o.v = vel; o.g = a.g + t * (b.g - a.g); o.n = n;
    for (let k = 0; k < n; k++) {
      o.r[k] = a.r[k] + t * (b.r[k] - a.r[k]); o.l[k] = a.l[k] + t * (b.l[k] - a.l[k]);
      o.td[k] = Math.exp(Math.log(a.td[k]) + t * (Math.log(b.td[k]) - Math.log(a.td[k])));
      o.tr[k] = Math.exp(Math.log(a.tr[k]) + t * (Math.log(b.tr[k]) - Math.log(a.tr[k])));
      o.rm[k] = a.rm[k] + t * (b.rm[k] - a.rm[k]);
    }
    return o;
  }

  // A layered instrument (inst.multi = [{ inst, w }], made by the instrument mix pad) strikes every part with the note; each part keeps its own
  // engine block (noise, vibrato, filter, release), and the part's amplitude is sqrt(w), so the total power stays the same wherever the puck is.
  noteOn(m, vel, silent) {
    const W = this.inst && this.inst.multi;
    if (!W || silent || vel <= 0 || m < NOTE_LO || m > NOTE_HI) return this.noteOn1(m, vel, silent, false);
    const wrap = this.inst; let first = true;
    for (const part of W) {
      if (part.w < 1e-4) continue;
      this.inst = part.inst; this.layerGain = Math.sqrt(part.w);
      try { this.noteOn1(m, vel, silent, !first); } finally { this.inst = wrap; this.layerGain = 1; }
      first = false;
    }
  }
  noteOn1(m, vel, silent, keep) {
    if (m < NOTE_LO || m > NOTE_HI) return;
    this.keyDown[m] = 1;
    if (silent || vel <= 0) { this.updateDampingAll(); return; }
    const P = this.p, sr = this.sr;
    if (!keep) for (const v of this.voices) if (v.active && !v.fading && !v.res && v.note === m) this.fade(v, 0.07); // re-strike
    const v = this.velCurve(vel / 127);
    const softAmt = this.soft * (0.3 + 0.7 * P.softSmooth);
    const H = Math.max(0.05, this.hardAt(v) * (1 - 0.4 * softAmt));
    const M = this.noteModel(m), x = M.x;
    const ci = this.inst && this.inst.format === 'compiled-1' ? this.inst.notes[m] : null;
    if (!ci) return;                          // no instrument loaded yet: silent
    const ns = Math.max(1, Math.min(3, ci.s));
    const r = rng(m * 7919 + this.seed);
    const u = P.unison;
    // per-partial: frequency, amplitude, direct & remanent rates (1/s), remanent weight
    const fs = this.sFs, as = this.sAs, rDs = this.sRd, rRs = this.sRr, ws = this.sWs;
    let nf = 0, amax = 0, loud, sumsq = 0;
    {
      // ---- measured instrument (resonance-instrument/1). Defaults reproduce the recording;
      // every parameter acts relative to its default.
      const v127 = Math.max(1, v * 127);
      const L = this.layerAt(ci.layers, v127);
      const vlo = ci.layers[0].v, vhi = ci.layers[ci.layers.length - 1].v;
      const vOut = v127 < vlo ? v127 - vlo : v127 > vhi ? v127 - vhi : 0;
      const Hdef = interp([[0.25, 0.85], [0.5, 1], [0.75, 1.15]], v);
      // Hammer velocity law: a partial's amplitude scales as a power of the strike speed whose exponent grows with its
      // frequency, amp ~ (v/vref)^(kappa * f/1kHz), so a harder blow brightens the spectrum. kappa = velK * 2^(-(note-60)/velHalve).
      // Defaults velK 1.5, velHalve 32 are fitted to the University of Iowa recordings (tools/velocity_law_check.py: mezzo layer
      // only, played at the pp and ff velocities, against the real pp and ff notes; a broad optimum, k 1.3-1.7, halve 28-36).
      // The constants used before, fitted on a modelled piano, were velK 1 and velHalve 48: pass those params to get them back.
      // Hardness acts as a velocity warp: a harder felt is worth a faster blow, v*H^1.7 (contact time ~ v^-0.5 / H would give
      // H^2; 1.7 keeps the strength of the slider what it was with the old Gaussian law, in the least-squares sense over
      // 0.5-6 kHz). The hardness term keeps its own kappa (halve 48) so the slider's strength does not move with the velocity
      // constants. Neutral (0 dB) at default hardness inside the measured velocity range; extrapolates past the loudest / softest layer.
      const vref = Math.min(Math.max(v127, vlo), vhi);
      const feltA = 8.686 * ((P.velK ?? 1.5) * Math.pow(2, -(m - 60) / (P.velHalve ?? 32)) * Math.log(v127 / vref)
        + Math.pow(2, -(m - 60) / 48) * 1.7 * Math.log(H / Hdef));   // dB per kHz
      loud = this.layerGain * Math.pow(10, (L.g * (P.dynamics / 30) + ci.lv + vOut * P.dynamics / 100 - 2.5 * softAmt) / 20);
      // String length. On a piano it rescales the measured inharmonicity B. An instrument with engine.inharm (a synth whose
      // partials are harmonic) has none of its own, so shortening the string (< 2.7 m) adds a stiff-string stretch, 3e-4 at 2.7/size = 1.5
      // (an instrument without stiffness of its own, B < 1e-5, is left alone: a stretch of a few cents on its 48th harmonic is no string length)
      const Beff = ci.B < 1e-5 && !this.E.inharm ? ci.B : ci.B * Math.pow(2.7 / P.size, 2 - x) + (this.E.inharm ? 3e-4 * Math.max(0, Math.pow(2.7 / P.size, 2 - x) - 1) : 0);
      const fc0 = 1000 * Math.pow(12, 0.5), qe0 = 2.8, imp = Math.pow(P.impedance, 0.85);
      for (let k = 0, nk = L.n ?? L.r.length; k < nk; k++) {
        if (L.l[k] < -70) continue;
        // ratios are taken relative to the layer's own lowest partial (or to the instrument's `anchor` ratio: a bell's strike note is
        // its second partial, an organ's 8' drawbar its third), and the string-length rescale is anchored at n = 1, so
        // partial 1 lands exactly on ftab[m] (temperament, stretch, diapason) whatever the recording's offset or size
        const rn = L.r[k] / L.r[0] / (this.E.anchor ?? 1);
        const f = this.E.fixed ? L.r[k] * P.diapason / 440                                    // engine.fixed: the table's ratios are frequencies in Hz
          : this.ftab[m] * rn * Math.sqrt(((1 + Beff * rn * rn) / (1 + Beff)) / ((1 + ci.B * rn * rn) / (1 + ci.B)));
        if (f * 1.004 > M.fmax) break;
        let db = L.l[k] + Math.min(30, Math.max(-60, feltA * f / 1000)) + (k < 8 ? P.profile[k] : 0) + this.eqDb(f);
        if (k > 0) db += Math.max(0, P.character - 0.7) * 2.6 * gauss(r);
        const cut = (1 + Math.pow(f / M.fc, M.qe)) / (1 + Math.pow(f / fc0, qe0));   // 1 at the default cut-off and slope
        const a = Math.pow(10, db / 20) * Math.pow(cut, -0.4);                       // the cut-off also shades the level of the partials above it (a tone control, not only shorter tails)
        const td = L.td[k] * P.direct * imp / cut, tr = L.tr[k] * imp / cut;
        fs[nf] = f; as[nf] = a; rDs[nf] = LN1000 / td; rRs[nf] = LN1000 / tr; ws[nf] = Math.min(1, Math.pow(10, L.rm[k] / 20)); nf++;
        sumsq += a * a; if (a > amax) amax = a;
      }
    }
    if (!nf) return;
    const norm = 0.36 * loud / Math.sqrt(sumsq);
    this.phase = true;
    const voice = this.alloc();
    voice.note = m;
    const tauA = this.E.attack_s ? this.E.attack_s / 3.36                                                  // instrument's own 10-90 % rise time (two cascaded poles: 3.36 tau)
      : (0.0012 + 0.004 * (1 - x)) * ATK_K * (ATK_0 + (1 - ATK_0) * 4 * (1 - v) * (1 - v)) / Math.max(0.5, Math.min(1.6, H));   // hammer contact: the soft the blow, the slower the rise
    voice.att = 0; voice.att1 = 0; voice.ka = Math.exp(-1 / (tauA * sr));
    const pc = this.pan(m);
    let det;
    {
      // measured envelopes already contain the real unison beating: at unison width 1.0 the strings
      // stay in exact unison (= the recording); the slider adds/removes detune relative to that
      const d = (ci.dt && ci.dt.length >= ns ? ci.dt : [0, 0.12, 0.42]).slice(0, ns), mean = d.reduce((a, b) => a + b, 0) / ns;
      // an instrument that carries its own detune_cents (fitted to the recording's beating) plays them at unison width 1
      // (this.p.beat off: exact unison); otherwise the old rule: the slider adds/removes detune relative to exact unison
      // the fitted beat notches are centred on the median string, so the majority of the strings sit exactly on the key's pitch
      const med = [...d].sort((a, b) => a - b)[d.length >> 1];
      det = ci.dtm ? d.map(c => (P.beat === 0 ? 0 : (c - med) * u)) : d.map(c => (c - mean) * Math.max(0, u - 1) * 2);
    }
    let sAmp = ns === 3 ? [1, 1, 1 - 0.8 * softAmt] : ns === 2 ? [1 - 0.5 * softAmt, 1] : [1];
    let nsyn = ns;
    if (det.every(d => Math.abs(d) < 1e-6)) {        // unison at default: the recording holds the strings
      nsyn = 1; det = [0]; sAmp = [ns * (1 - 0.8 * softAmt / Math.max(ns, 1))];
    }
    // the hammer starts all strings of a unison together: one start phase per partial, shared by its strings, so
    // they beat coherently from the strike (deep periodic notches) instead of at random
    const ph0 = nsyn > 1 ? new Float64Array(nf) : null;
    if (ph0) for (let k = 0; k < nf; k++) ph0[k] = Math.random() * 2 * Math.PI;
    for (let s = 0; s < nsyn; s++) {
      const ratio = Math.pow(2, det[s] / 1200);
      const pp = nsyn === 1 ? pc : Math.max(-1, Math.min(1, pc + (s - (ns - 1) / 2) * 0.05));   // one summed string: one pan (fast mono path)
      const gl = Math.cos((pp + 1) * Math.PI / 4), gr = Math.sin((pp + 1) * Math.PI / 4);
      for (let k = 0; k < nf; k++) {
        const a = as[k] * norm * sAmp[s] / ns;   // (nsyn=1 path carries ns in sAmp)
        const jit = k === 0 ? 1 : Math.pow(2, 0.25 * P.character * gauss(r) / 1200);   // the fundamental stays exactly on pitch
        const q = 1 + 0.05 * s;
        this.addOsc(voice, fs[k] * ratio * jit, a * (1 - ws[k]), a * ws[k], Math.exp(-rDs[k] * q / sr), Math.exp(-rRs[k] * q / sr), gl, gr, ph0 ? ph0[k] : undefined);
      }
    }
    // quadratic effect: sum-frequency (2f) components on hard strokes
    if (P.quadratic * (this.E.quadratic ?? 1) > 0) {
      const gl = Math.cos((pc + 1) * Math.PI / 4), gr = Math.sin((pc + 1) * Math.PI / 4);
      for (let k = 0; k < Math.min(6, nf); k++) {
        const f = 2 * fs[k]; if (f > M.fmax) break;
        const a = as[k] * norm * P.quadratic * (this.E.quadratic ?? 1) * 0.45 * v * v * Math.min(H, 1.6) * Math.sqrt(as[k] / amax);
        this.addOsc(voice, f, a, 0, Math.exp(-2 * rDs[k] / sr), 0, gl, gr);
      }
    }
    // hammer knock. The slider is 1:1 up to its default (0.8) and grows with the square above it: the knock is uncorrelated
    // noise added under the note's own high partials, so a linear slider changed the 2-8 kHz band by < 0.2 dB at velocity 80
    // and up, even at its maximum. Squared, the maximum is +23 dB over the default instead of +11.
    const hn = (P.hammerNoise <= 0.8 ? P.hammerNoise : 0.8 * Math.pow(P.hammerNoise / 0.8, 2)) * (this.E.knock ?? 1);
    if (hn > 0) {
      const a = hn * 0.012 * loud * (0.3 + v);
      this.addNoise({ amp: a, fc: Math.min(8000, 1200 + 3500 * v * H + 2 * this.ftab[m]), q: 0.9,
        tau: 0.003 + 0.006 * (1 - x), thump: a * 0.15, thF: 90 + 60 * x, thTau: 0.012, pan: pc });
    }
    // key click (organ contact bounce, a bar's mallet tick): a short filtered noise burst, scaled by the hammer-thump slider
    const ck = this.E.click;
    if (ck && P.hammerNoise > 0) this.addNoise({ amp: ck.amp * loud * (0.5 + 0.5 * v) * P.hammerNoise / 0.8, fc: ck.fc ?? 3000, q: ck.q ?? 0.8, tau: ck.tau ?? 0.004, pan: pc });
    // case / soundboard body: the strike rings a low resonance (grand ~100 Hz, upright ~150 Hz) for about a second
    // at a level tied to the note's own loudness, whatever the pitch (measured on real recordings)
    const bd = ci && this.inst.body;
    if (bd && hn > 0) {
      const A = 0.036 * loud * Math.pow(10, (bd.level + 20) / 20) * hn / 0.8;
      this.addNoise({ amp: 0, fc: 1000, q: 1, tau: 0.01, thump: A, thF: bd.hz, thTau: bd.tau, pan: 0 });
    }
    // air: the faint broadband hiss of felt, strings and room that real notes carry above ~3 kHz
    const ar = ci && this.inst.air;
    if (ar && hn > 0) {
      const A = 0.255 * loud * Math.pow(10, ar.level / 20) / this.airGain() * hn / 0.8;
      this.addNoise({ amp: A, fc: 6500, q: 0.35, tau: ar.tau, pan: pc });
    }
    this.phase = false;
    voice.eng = this.E;
    const S = this.synthFor(ci);
    // the Notes-at-once switch: Chords lifts an instrument's one-note-at-a-time rule, One note imposes it on any instrument
    if (P.voices === 'mono' || (S && S.mono && P.voices !== 'poly')) for (const o of this.voices) if (o !== voice && o.active && !o.fading && !o.res) this.fade(o, 0.03);
    if (S) {
      if (S.choke != null) for (const o of this.voices) if (o !== voice && o.active && !o.fading && !o.res && o.sy && o.sy.choke === S.choke) this.fade(o, 0.02);   // e.g. a closed hi-hat stops an open one
      this.setupSynth(voice, m, S, { v, loud, nf, fs, as });
    }
    this.lastF = this.ftab[m];
    this.updateDamping(voice);
    this.lastInfo = { note: m, vel, v, f1: this.ftab[m], B: ci ? ci.B : M.B, strings: ns, partials: nf,
      freqs: Array.from(fs.subarray(0, 40)), amps: Array.from(as.subarray(0, 40), a => a * norm), hard: H };
    if (this.E.sympathetic !== false) this.sympathetic(m, fs, as, nf, norm);
  }

  // ---------------- sympathetic resonance (event-based, counted as voices) ----------------
  undamped(m) {
    if (m >= 89 && this.E.dampers !== 'all') return true;   // no dampers in the top octave+ (an instrument can ask for them: engine.dampers)
    if (this.keyDown[m] || this.sost[m]) return true;
    if (this.harmonic) return true;
    return this.sustain > 0.5 && this.p.fullSympa;
  }
  symOf(m) {
    let e = this.symModel[m];
    if (!e) {
      const M = this.noteModel(m), fys = new Float64Array(16); let cnt = 0;
      for (let n = 1; n <= 16; n++) { const fy = this.partialFreq(M, n); if (fy > M.fmax) break; fys[cnt++] = fy; }
      e = this.symModel[m] = { m, M, fys, cnt, amps: this.symAmp[m], E: 0 };
    }
    return e;
  }
  sympathetic(mx, fs, as, nf, norm) {
    const P = this.p, sr = this.sr;
    if (P.sympRes <= 0) return;
    const cand = this.symCand || (this.symCand = []);
    cand.length = 0;
    const f1 = fs[0];
    for (let m = NOTE_LO; m <= NOTE_HI; m++) {
      if (m === mx || !this.undamped(m)) continue;
      const c = this.symOf(m), amps = c.amps;
      let E = 0;
      for (let i = 0; i < c.cnt; i++) {
        const fy = c.fys[i];
        const k0 = Math.round(fy / f1) - 1;
        let best = 0;
        for (let k = Math.max(0, k0 - 1); k <= Math.min(nf - 1, k0 + 1); k++) {
          const dc = 1200 * Math.log2(fy / fs[k]);
          const v = as[k] * norm * Math.exp(-(dc / 14) * (dc / 14));
          if (v > best) best = v;
        }
        amps[i] = best;
        E += best * best;
      }
      c.E = E;
      if (E > 1e-10) cand.push(c);
    }
    cand.sort((a, b) => b.E - a.E);
    for (let ci = 0, nc = Math.min(10, cand.length); ci < nc; ci++) {
      const c = cand[ci];
      let rv = this.resVoice[c.m];
      if (!rv || !rv.active || rv.fading || rv.note !== c.m) {
        rv = this.alloc(); rv.res = true; rv.note = c.m; this.resVoice[c.m] = rv;
        const pp = this.pan(c.m);
        const gl = Math.cos((pp + 1) * Math.PI / 4), gr = Math.sin((pp + 1) * Math.PI / 4);
        for (let n = 1; n <= 16; n++) {
          const f = this.partialFreq(c.M, n);
          const i = this.addOsc(rv, f < c.M.fmax ? f : 0, 0, 0, Math.exp(-1 / (0.03 * sr)),
            Math.exp(-this.partialRate(c.M, n, f) * 1.15 / sr), gl, gr);
          if (i < 0) break;
        }
      }
      for (let i = 0; i < c.cnt; i++) {
        const a = c.amps[i]; if (i >= rv.n) continue;
        const add = a * P.sympRes * 0.075;
        rv.er[i] += add; rv.ed[i] -= add;                 // rises over ~30 ms, then remanent decay
      }
      rv.level = Math.max(rv.level, 1e-3);
      this.updateDamping(rv);
    }
  }

  noteOff(m, relVel) {
    if (m < NOTE_LO || m > NOTE_HI) return;
    const wasDown = this.keyDown[m];
    this.keyDown[m] = 0;
    const P = this.p;
    const rv = relVel == null ? 0.5 : relVel / 127;
    let sounding = false;
    for (const v of this.voices) if (v.active && v.note === m) { v.relTau = 1.3 - 0.6 * rv; this.updateDamping(v); if (!v.res) { sounding = true; if (v.sy && v.sy.off < 0) v.sy.off = v.sy.n; } }
    if (!wasDown) return;
    const damped = (m < 89 || this.E.dampers === 'all') && !this.sost[m] && this.sustain < 0.5;
    // the slider is 1:1 up to its default (0.3) and grows with the 1.6th power above it: the release noise is under the decaying note, so a linear
    // slider was 55 dB below the note's peak even at its maximum; now the maximum is +12 dB over what a linear slider gave
    const kn = P.keyNoise <= 0.3 ? P.keyNoise : 0.3 * Math.pow(P.keyNoise / 0.3, 1.6);
    if (kn > 0 && this.E.key_noise !== false) this.addNoise({ amp: kn * 0.0025 * (0.3 + rv), fc: 2200, q: 1.2, tau: 0.002, thump: kn * 0.0006, thF: 140, thTau: 0.01, pan: this.pan(m) });
    if (P.damperNoise && this.E.key_noise !== false && damped && sounding && m < 52) this.addNoise({ amp: 0.0015, fc: 400, q: 0.8, tau: 0.02, thump: 0.004, thF: 55 + (m - 21), thTau: 0.04, pan: this.pan(m) });
  }

  tauDamp(m, E = this.E) { if (E.release_s) return E.release_s; const y = Math.max(0, 1 - (m - 21) / 67); return 0.045 + 0.38 * y * y; }
  updateDamping(v) {
    if (v.fading) return;
    const m = v.note;
    let d;
    const E = v.eng || this.E;
    if (E.oneshot) d = 0;                                          // engine.oneshot: a struck drum rings out whatever the key does (a choke group cuts it)
    else if (m >= 89 && E.dampers !== 'all') d = 0;
    else if (this.keyDown[m] || this.sost[m] || (v.res && this.harmonic)) d = 0;
    else d = 1 - this.sustain;
    const rate = Math.pow(Math.max(0, d), 1.6) / (this.tauDamp(m, E) * v.relTau);
    v.gd = Math.exp(-rate / this.sr); v.dampRate = rate;
  }
  updateDampingAll() { for (const v of this.voices) if (v.active) this.updateDamping(v); }

  pedal(which, val) {
    const P = this.p;
    if (which === 'sustain') {
      const old = this.sustain; this.sustain = Math.max(0, Math.min(1, val));
      if (P.whoosh > 0 && this.E.key_noise !== false && ((old < 0.5) !== (this.sustain < 0.5))) {
        const up = this.sustain >= 0.5;
        this.addNoise({ amp: P.whoosh * (up ? 0.012 : 0.007), fc: up ? 260 : 500, q: 0.6, tau: up ? 0.35 : 0.12, attack: up ? 0.06 : 0.01, thump: P.whoosh * 0.006, thF: 48, thTau: 0.05, pan: 0 });
      }
    } else if (which === 'soft') this.soft = Math.max(0, Math.min(1, val));
    else if (which === 'sostenuto') {
      const on = val >= 0.5;
      if (on && !this.sostenuto) for (let m = 0; m < 128; m++) this.sost[m] = this.keyDown[m];
      if (!on) this.sost.fill(0);
      this.sostenuto = on;
    } else if (which === 'harmonic') this.harmonic = val >= 0.5;
    this.updateDampingAll();
  }

  panic() { for (const v of this.voices) v.active = false; for (const n of this.noise) n.active = false; this.keyDown.fill(0); this.sost.fill(0); this.resVoice.fill(null); this.fdnBuf.forEach(b => b.fill(0)); }

  // rms of the air band-pass output for unit amplitude (so `level` in the instrument file is a real dB figure)
  airGain() {
    if (this._airGain) return this._airGain;
    const w = 2 * Math.PI * Math.min(6500, 0.45 * this.sr) / this.sr, al = Math.sin(w) / (2 * 0.35), a0 = 1 + al;
    const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
    let rs = 12345, x1 = 0, x2 = 0, y1 = 0, y2 = 0, e = 0;
    for (let i = 0; i < 16384; i++) {
      rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
      const x = rs / 2147483648 - 1, y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
      if (i >= 2048) e += y * y;
    }
    return (this._airGain = Math.sqrt(e / 14336));
  }

  // ---------------- soundboard: a bank of damped modes driven by the summed strings ----------------
  // Every instrument measured from a real piano already contains its soundboard in the partial levels; this bank
  // is for instruments that don't (generated ones): 40 two-pole resonators, density rising with frequency,
  // T60 0.03-0.28 s (20-100 Hz wide), fixed pseudo-random gains. Peak gain of each mode is normalised to 1.
  initSoundboard() {
    const N = 40, sr = this.sr, r = rng(4242);
    this.sbN = N; this.sbA1 = new Float64Array(N); this.sbA2 = new Float64Array(N); this.sbIn = new Float64Array(N);
    this.sbGl = new Float64Array(N); this.sbGr = new Float64Array(N); this.sbY1 = new Float64Array(N); this.sbY2 = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const f = 70 * Math.pow(1.085, k) * (1 + 0.05 * (r() - 0.5));
      const t60 = Math.min(0.28, Math.max(0.03, 0.28 * Math.pow(f / 100, -0.35)));      // broad, heavily damped modes
      const rad = Math.exp(-6.908 / (t60 * sr)), th = 2 * Math.PI * Math.min(f, 0.45 * sr) / sr;
      this.sbA1[k] = 2 * rad * Math.cos(th); this.sbA2[k] = -rad * rad; this.sbIn[k] = (1 - rad) * Math.sin(th);
      const g = (0.4 + 0.6 * r()) * (r() < 0.5 ? -1 : 1), pan = r() * 2 - 1;
      this.sbGl[k] = g * Math.cos((pan + 1) * Math.PI / 4); this.sbGr[k] = g * Math.sin((pan + 1) * Math.PI / 4);
    }
  }

  // ---------------- mechanical noises ----------------
  addNoise(o) {
    let ne = null;
    for (const n of this.noise) if (!n.active) { ne = n; break; }
    if (!ne) return;
    const sr = this.sr;
    ne.active = true;
    ne.e1 = o.amp; ne.k1 = Math.exp(-1 / (o.tau * sr));
    ne.e2 = o.attack ? o.amp : 0; ne.k2 = o.attack ? Math.exp(-1 / (o.attack * sr)) : 0;
    const w = 2 * Math.PI * Math.min(o.fc, 0.45 * sr) / sr, al = Math.sin(w) / (2 * o.q), a0 = 1 + al;
    ne.b0 = al / a0; ne.b2 = -al / a0; ne.a1 = -2 * Math.cos(w) / a0; ne.a2 = (1 - al) / a0;
    ne.x1 = ne.x2 = ne.y1 = ne.y2 = 0;
    ne.th = o.thump || 0; ne.thk = Math.exp(-1 / ((o.thTau || 0.02) * sr));
    const tw = 2 * Math.PI * (o.thF || 80) / sr; ne.tc = Math.cos(tw); ne.ts = Math.sin(tw); ne.tre = 1; ne.tim = 0;
    const p = o.pan || 0; ne.gl = Math.cos((p + 1) * Math.PI / 4); ne.gr = Math.sin((p + 1) * Math.PI / 4);
    ne.rs = (Math.random() * 4294967295) >>> 0 || 7;
  }



  // ---------------- rotary speaker (engine.rotary) ----------------
  // A Leslie: the sound goes to a rotating horn (highs) and a rotating drum (lows), split at crossover_hz; two microphones hear each
  // rotor at different angles. A rotor changes what a mic hears in two ways that share one angle: it is louder when it faces the mic
  // (amplitude 1 + amp * cos) and nearer (a delay that is shortest then), and the change of delay with time is the Doppler shift.
  //   engine.rotary = { crossover_hz, mics_deg, horn: { slow_hz, fast_hz, depth_ms, amp, accel }, drum: { ... } }
  // The Rotary speed slider (0 slow "chorale" .. 1 fast "tremolo") sets the target; the rotors follow it with their inertia (accel is
  // in Hz per second: the horn takes about a second, the drum several). Modulation scales depth and amplitude; 0 bypasses the stage.
  rotaryStage(L, R, N) {
    const RT = this.E.rotary, sr = this.sr, P = this.p, md = (P.modulation ?? 1) * this.multiW('rotary');
    if (!this.rot || this.rot.RT !== RT) {
      const svf = () => ({ a: [0, 0], b: [0, 0] });                                   // two cascaded 2-pole sections per band and side
      this.rot = { RT, buf: [new Float64Array(4096), new Float64Array(4096)], w: 0, ph: [Math.random() * 6.283, Math.random() * 6.283], sp: [RT.horn.slow_hz, RT.drum.slow_hz], lp: svf(), hp: svf() };
    }
    const S = this.rot, fx = RT.crossover_hz ?? 800, g = Math.tan(Math.PI * fx / sr), k = Math.SQRT2, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const rotors = [RT.horn, RT.drum], target = rotors.map(r => r.slow_hz + (r.fast_hz - r.slow_hz) * (P.rotary ?? 0)), half = Math.PI * (RT.mics_deg ?? 80) / 360;
    const secLP = (st, i, x) => { const v3 = x - st.b[i], v1 = a1 * st.a[i] + a2 * v3, v2 = st.b[i] + a2 * st.a[i] + a3 * v3; st.a[i] = 2 * v1 - st.a[i]; st.b[i] = 2 * v2 - st.b[i]; return v2; };
    const secHP = (st, i, x) => { const v3 = x - st.b[i], v1 = a1 * st.a[i] + a2 * v3, v2 = st.b[i] + a2 * st.a[i] + a3 * v3; st.a[i] = 2 * v1 - st.a[i]; st.b[i] = 2 * v2 - st.b[i]; return x - k * v1 - v2; };
    const mask = 4095, herm = (b, pos) => {
      const i = Math.floor(pos), f = pos - i, y0 = b[(i - 1) & mask], y1 = b[i & mask], y2 = b[(i + 1) & mask], y3 = b[(i + 2) & mask];
      return y1 + f * (0.5 * (y2 - y0) + f * (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3 + f * (0.5 * (y3 - y0) + 1.5 * (y1 - y2))));
    };
    for (let t = 0; t < N; t++) {
      const x = 0.5 * (L[t] + R[t]);
      const lo = secLP(S.lp, 1, secLP(S.lp, 0, x));                                   // Linkwitz-Riley 4th order: low = lp(lp(x)), high = hp(hp(x))
      const hi = secHP(S.hp, 1, secHP(S.hp, 0, x));
      S.buf[0][S.w & mask] = hi; S.buf[1][S.w & mask] = lo; S.w++;
      let oL = 0, oR = 0;
      for (let b = 0; b < 2; b++) {
        const r = rotors[b], dv = (r.accel ?? (b ? 1 : 5)) / sr, d = target[b] - S.sp[b];
        S.sp[b] += Math.abs(d) < dv ? d : Math.sign(d) * dv; S.ph[b] += 6.283185307 * S.sp[b] / sr;
        const dpp = md * (r.depth_ms ?? (b ? 0.35 : 0.28)) * 1e-3 * sr, am = md * (r.amp ?? (b ? 0.2 : 0.3));
        for (let m = 0; m < 2; m++) {
          const c = Math.cos(S.ph[b] + (m ? -half : half)), del = 4 + dpp * (1 - c) / 2;
          const y = (1 + am * c) * herm(S.buf[b], S.w - 1 - del);
          if (m) oR += y; else oL += y;
        }
      }
      L[t] = oL; R[t] = oR;
    }
  }

  // ---------------- synth voices (engine.synth, or key.synth for one key of the table) ----------------
  // What a table of decaying sines cannot say by itself, done at block rate on the voice:
  //   vibrato, glide, pitch envelope   one rotation update per block for every oscillator of the voice (they keep their phase)
  //   filter                           for stationary sines a filter is a gain per partial, so a swept resonant filter is a per-block
  //                                    gain (the same trick the damper uses); the removal of dead partials looks through it
  //   noise                            filtered band noise, and a bank of resonators at the partials fed with noise (breath, bow)
  synthFor(ci) { const g = this.E.synth, k = ci.sy; return g || k ? Object.assign({}, g, k) : null; }

  setupSynth(voice, m, S, c) {
    const sr = this.sr, y = { S, m, n: 0, t0: 0, off: -1, rho: -1, foct: 0, nz: [], nzLevel: 0, rs: (Math.random() * 4294967295) >>> 0 || 1, choke: S.choke ?? null, v: c.v };
    const V = S.vibrato;
    if (V && V.cents > 0) y.vib = { hz: V.hz ?? 5.5, cents: V.cents, delay: V.delay_s ?? 0, rise: V.rise_s ?? 0, jit: V.jitter ?? 0, ph: Math.random() * 6.283185, ph2: Math.random() * 6.283185 };
    if (S.pitch_env && S.pitch_env.cents) y.penv = { c: S.pitch_env.cents, tau: Math.max(1e-3, S.pitch_env.tau_s ?? 0.05) };
    const Gl = S.glide;
    if (Gl && Gl.time_s > 0 && this.lastF > 0) {
      let others = true; if (Gl.legato) { others = false; for (let k = 0; k < 128; k++) if (this.keyDown[k] && k !== m) { others = true; break; } }   // legato: only while another key is held
      const c0 = 1200 * Math.log2(this.lastF / this.ftab[m]);
      if (others && Math.abs(c0) > 1 && Math.abs(c0) <= (Gl.max_semitones ?? 24) * 100) y.glide = { c0, tau: Gl.time_s / 2.3 };
    }
    const F = S.filter;
    if (F) y.filt = { type: F.type ?? 'lp', poles: F.poles === 4 ? 4 : 2, q: Math.max(0.3, F.q ?? 0.707), fc0: F.cutoff_hz ?? 2000, kt: F.key_track ?? 0, vo: F.vel_oct ?? 0, env: F.env || null, lfo: F.lfo ? { hz: F.lfo.hz, oct: F.lfo.oct, ph: Math.random() * 6.283185 } : null };
    // noise: level_db is the RMS of the noise relative to the RMS of the note's own partials (0 dB = as loud as the tone)
    const ref = 0.36 * c.loud / Math.SQRT2, var_ = 1 / 3, nyq = sr / 2;
    for (const N of S.noise || []) {
      const A = ref * Math.pow(10, (N.level_db ?? -30) / 20);
      const g = { kind: N.type === 'bank' ? 'bank' : 'band', A, delay: N.delay_s ?? 0, ta: (N.attack_s ?? 0) / 2.2, rate: N.decay_s > 0 ? 6.907755 / N.decay_s : 0, sus: N.sustain ?? 0, follow: N.follow ?? 0 };
      if (g.kind === 'band') {
        Object.assign(g, { type: N.kind ?? 'bp', poles: N.poles === 4 ? 4 : 2, q: Math.max(0.3, N.q ?? 1), fc: (N.fc ?? 3000) * Math.pow(2, (N.key_track ?? 0) * (m - 60) / 12), fenv: N.fc_env || null, s1: [0, 0], s2: [0, 0] });
        g.G = A / Math.sqrt(var_ * bandNeb(g.type, g.poles, g.q, g.fc, sr) / nyq);
      } else {
        const nb = Math.min(c.nf, N.max_partials ?? 32), f = new Float64Array(nb), a = new Float64Array(nb); let sa = 0;
        for (let k = 0; k < nb; k++) { f[k] = c.fs[k]; a[k] = c.as[k]; sa += a[k] * a[k]; }
        sa = Math.sqrt(sa) || 1; let pw = 0;
        for (let k = 0; k < nb; k++) { a[k] /= sa; pw += a[k] * a[k] * Math.PI * f[k] / (2 * (N.q ?? 60)); }
        Object.assign(g, { q: Math.max(2, N.q ?? 60), f, a, nb, s1: new Float64Array(nb), s2: new Float64Array(nb) });
        g.G = A / Math.sqrt(var_ * pw / nyq);
      }
      y.nz.push(g);
    }
    voice.sy = y;
  }

  updateSy(v, len) {
    const y = v.sy, sr = this.sr, tm = (y.n + 0.5 * len) / sr, P = this.p, mod = P.modulation ?? 1;
    y.t0 = y.n / sr; y.n += len;
    // ---- pitch: vibrato (delayed, with a slow wander), glide, pitch envelope
    let cents = 0;
    if (y.vib) {
      const V = y.vib, x = tm <= V.delay ? 0 : V.rise > 0 ? Math.min(1, (tm - V.delay) / V.rise) : 1;
      cents += V.cents * mod * smooth(x) * (Math.sin(6.283185 * V.hz * tm + V.ph) + V.jit * 0.5 * Math.sin(6.283185 * V.hz * 0.31 * tm + V.ph2));
    }
    if (y.glide) cents += y.glide.c0 * Math.exp(-tm / y.glide.tau);
    if (y.penv) cents += y.penv.c * Math.exp(-tm / y.penv.tau);
    const rho = Math.pow(2, cents / 1200) * this.bendRatio;
    if (Math.abs(rho - y.rho) > 1e-7) {
      y.rho = rho;
      const n = v.n, fr = v.fr, C = v.c, S = v.s, k = 6.283185307 * rho / sr;
      for (let i = 0; i < n; i++) { const w = fr[i] * k; C[i] = Math.cos(w); S[i] = Math.sin(w); }
    }
    // ---- filter: envelope, key and velocity tracking, LFO -> cutoff -> a gain for every partial
    const F = y.filt;
    if (F) {
      let oct = 0;
      if (F.env) {
        const E = F.env, ta = (E.attack_s ?? 0) / 2.2, td = Math.max(1e-3, (E.decay_s ?? 0.3) / 2.3), tr = Math.max(1e-3, (E.release_s ?? 0.2) / 2.3), su = E.sustain ?? 0;
        const at = t => (ta > 0 ? 1 - Math.exp(-t / ta) : 1) * (su + (1 - su) * Math.exp(-t / td));
        const toff = y.off < 0 ? -1 : y.off / sr;
        oct += E.oct * (toff < 0 || tm < toff ? at(tm) : at(toff) * Math.exp(-(tm - toff) / tr));
      }
      if (F.lfo) oct += F.lfo.oct * mod * Math.sin(6.283185 * F.lfo.hz * tm + F.lfo.ph);
      y.foct = oct;
      const fc = Math.min(0.45 * sr, Math.max(20, F.fc0 * Math.pow(2, F.kt * (y.m - 60) / 12 + F.vo * (y.v - 0.5) + oct)));
      const n = v.n, fr = v.fr, FG = v.fg, ED = v.ed, ER = v.er, ic = 1 / fc;
      for (let i = 0; i < n; i++) {
        const g = Math.max(1e-4, filterMag(F.type, F.poles, F.q, fr[i] * ic)), r = g / FG[i];
        ED[i] *= r; ER[i] *= r; FG[i] = g;
      }
    }
  }

  renderVoiceNoise(v, len) {
    const y = v.sy, sr = this.sr, out = this.nzb, wn = this.wn, xin = this.xin, t0 = y.t0, t1 = y.t0 + len / sr, tm = (t0 + t1) / 2;
    for (let t = 0; t < len; t++) out[t] = 0;
    let rs = y.rs;
    for (let t = 0; t < len; t++) { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; wn[t] = rs / 2147483648 - 1; }
    y.rs = rs;
    let level = 0;
    for (const g of y.nz) {
      const e0 = noiseEnv(g, t0), e1 = noiseEnv(g, t1), l0 = g.G * e0, dl = (g.G * e1 - l0) / len;
      level += g.A * e1;
      if (e0 < 1e-7 && e1 < 1e-7) continue;
      for (let t = 0; t < len; t++) xin[t] = wn[t] * (l0 + dl * t);
      if (g.kind === 'band') {
        const oct = (g.fenv ? g.fenv.oct * Math.exp(-tm / Math.max(1e-3, g.fenv.tau_s)) : 0) + g.follow * y.foct;
        const fc = Math.min(0.45 * sr, Math.max(20, g.fc * Math.pow(2, oct))), gg = Math.tan(Math.PI * fc / sr), k = 1 / g.q, a1 = 1 / (1 + gg * (gg + k)), a2 = gg * a1, a3 = gg * a2;
        const ns = g.poles === 4 ? 2 : 1, kind = g.type;
        for (let t = 0; t < len; t++) {
          let x = xin[t];
          for (let st = 0; st < ns; st++) {
            const v3 = x - g.s2[st], v1 = a1 * g.s1[st] + a2 * v3, v2 = g.s2[st] + a2 * g.s1[st] + a3 * v3;
            g.s1[st] = 2 * v1 - g.s1[st]; g.s2[st] = 2 * v2 - g.s2[st];
            x = kind === 'lp' ? v2 : kind === 'hp' ? x - k * v1 - v2 : k * v1;
          }
          out[t] += x;
        }
      } else {
        const k = 1 / g.q, rho = y.rho > 0 ? y.rho : this.bendRatio;                                  // the resonators follow the note's pitch (vibrato, glide)
        for (let i = 0; i < g.nb; i++) {
          const gg = Math.tan(Math.PI * Math.min(0.45 * sr, g.f[i] * rho) / sr), a1 = 1 / (1 + gg * (gg + k)), a2 = gg * a1, a3 = gg * a2, amp = g.a[i] * k;
          let c1 = g.s1[i], c2 = g.s2[i];
          for (let t = 0; t < len; t++) {
            const v3 = xin[t] - c2, v1 = a1 * c1 + a2 * v3, v2 = c2 + a2 * c1 + a3 * v3;
            c1 = 2 * v1 - c1; c2 = 2 * v2 - c2; out[t] += amp * v1;
          }
          g.s1[i] = c1; g.s2[i] = c2;
        }
      }
    }
    y.nzLevel = level;
  }

  renderNoise(ne, L, R, off, len) {
    let { e1, e2, k1, k2, b0, b2, a1, a2, x1, x2, y1, y2, th, thk, tc, ts, tre, tim, rs } = ne;
    const gl = ne.gl, gr = ne.gr;
    for (let t = 0; t < len; t++) {
      rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
      const x = rs / 2147483648 - 1;
      const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const nr = tre * tc - tim * ts; tim = tre * ts + tim * tc; tre = nr;
      const out = y * (e1 - e2) + tim * th;
      e1 *= k1; e2 *= k2; th *= thk;
      L[off + t] += out * gl; R[off + t] += out * gr;
    }
    Object.assign(ne, { e1, e2, x1, x2, y1, y2, th, tre, tim, rs });
    if (Math.abs(e1) < 1e-6 && Math.abs(th) < 1e-6) ne.active = false;
  }

  // ---------------- the synthesis loop ----------------
  renderVoice(v, L, R, off, len) {
    const tl = this.tl, tr = this.tr;
    if (v.sy) this.updateSy(v, len);
    const thr = 1e-6 / Math.max(v.g, 1e-9);           // ~-120 dBFS: far below 16-bit noise; keeps real tails, retires dead partials
    const RE = v.re, IM = v.im, C = v.c, S = v.s, ED = v.ed, ER = v.er, KD = v.kd, KR = v.kr, GL = v.gl, GR = v.gr;
    const n = v.n;
    if (v.dampRate > 0.5 && !v.fading) {
      // a damper is felt: it takes the high partials first (extra decay grows ~ f^1.5), so a released note
      // darkens before it stops. Applied once per block; the broadband part (gd) stays sample-accurate.
      const k = v.dampRate * 0.6 * len / this.sr;
      const fr = v.fr;
      for (let i = 0; i < n; i++) {
        const f = fr[i]; if (f < 400) continue;
        const x = Math.exp(-k * Math.pow(f / 1500, 1.5));
        ED[i] *= x; ER[i] *= x;
      }
    }
    for (let t = 0; t < len; t++) { tl[t] = 0; tr[t] = 0; }
    const hasNz = v.sy && v.sy.nz.length > 0; if (hasNz) this.renderVoiceNoise(v, len);
    if (v.mono) {
      // one summed signal, four partials per pass (a quarter of the buffer traffic), panned in the output stage
      let i = 0;
      for (; i + 4 <= n; i += 4) {
        let re0 = RE[i], im0 = IM[i], ed0 = ED[i], er0 = ER[i]; const c0 = C[i], s0 = S[i], kd0 = KD[i], kr0 = KR[i];
        let re1 = RE[i + 1], im1 = IM[i + 1], ed1 = ED[i + 1], er1 = ER[i + 1]; const c1 = C[i + 1], s1 = S[i + 1], kd1 = KD[i + 1], kr1 = KR[i + 1];
        let re2 = RE[i + 2], im2 = IM[i + 2], ed2 = ED[i + 2], er2 = ER[i + 2]; const c2 = C[i + 2], s2 = S[i + 2], kd2 = KD[i + 2], kr2 = KR[i + 2];
        let re3 = RE[i + 3], im3 = IM[i + 3], ed3 = ED[i + 3], er3 = ER[i + 3]; const c3 = C[i + 3], s3 = S[i + 3], kd3 = KD[i + 3], kr3 = KR[i + 3];
        for (let t = 0; t < len; t++) {
          let x = re0 * c0 - im0 * s0; im0 = re0 * s0 + im0 * c0; re0 = x;
          const y0 = im0 * (ed0 + er0); ed0 *= kd0; er0 *= kr0;
          x = re1 * c1 - im1 * s1; im1 = re1 * s1 + im1 * c1; re1 = x;
          const y1 = im1 * (ed1 + er1); ed1 *= kd1; er1 *= kr1;
          x = re2 * c2 - im2 * s2; im2 = re2 * s2 + im2 * c2; re2 = x;
          const y2 = im2 * (ed2 + er2); ed2 *= kd2; er2 *= kr2;
          x = re3 * c3 - im3 * s3; im3 = re3 * s3 + im3 * c3; re3 = x;
          const y3 = im3 * (ed3 + er3); ed3 *= kd3; er3 *= kr3;
          tl[t] += (y0 + y1) + (y2 + y3);
        }
        let k = 1.5 - 0.5 * (re0 * re0 + im0 * im0); RE[i] = re0 * k; IM[i] = im0 * k; ED[i] = ed0; ER[i] = er0;
        k = 1.5 - 0.5 * (re1 * re1 + im1 * im1); RE[i + 1] = re1 * k; IM[i + 1] = im1 * k; ED[i + 1] = ed1; ER[i + 1] = er1;
        k = 1.5 - 0.5 * (re2 * re2 + im2 * im2); RE[i + 2] = re2 * k; IM[i + 2] = im2 * k; ED[i + 2] = ed2; ER[i + 2] = er2;
        k = 1.5 - 0.5 * (re3 * re3 + im3 * im3); RE[i + 3] = re3 * k; IM[i + 3] = im3 * k; ED[i + 3] = ed3; ER[i + 3] = er3;
      }
      for (; i < n; i++) {
        let re = RE[i], im = IM[i], ed = ED[i], er = ER[i]; const c = C[i], s = S[i], kd = KD[i], kr = KR[i];
        for (let t = 0; t < len; t++) {
          const x = re * c - im * s; im = re * s + im * c; re = x;
          tl[t] += im * (ed + er); ed *= kd; er *= kr;
        }
        const k = 1.5 - 0.5 * (re * re + im * im); RE[i] = re * k; IM[i] = im * k; ED[i] = ed; ER[i] = er;
      }
      const pl = v.pl, pr = v.pr, nzb = this.nzb;
      if (hasNz) for (let t = 0; t < len; t++) tl[t] += nzb[t];
      for (let t = 0; t < len; t++) { const y = tl[t]; tl[t] = y * pl; tr[t] = y * pr; }
    } else {
      for (let i = 0; i < n; i++) {
        let re = RE[i], im = IM[i], ed = ED[i], er = ER[i];
        const c = C[i], s = S[i], kd = KD[i], kr = KR[i], gl = GL[i], gr = GR[i];
        if (ed === 0 && er === 0) continue;
        for (let t = 0; t < len; t++) {
          const x = re * c - im * s; im = re * s + im * c; re = x;
          const y = im * (ed + er);
          ed *= kd; er *= kr;
          tl[t] += y * gl; tr[t] += y * gr;
        }
        const k = 1.5 - 0.5 * (re * re + im * im);          // phasor renormalisation
        RE[i] = re * k; IM[i] = im * k; ED[i] = ed; ER[i] = er;
      }
    }
    if (hasNz && !v.mono) { const nzb = this.nzb, pl = v.pl, pr = v.pr; for (let t = 0; t < len; t++) { tl[t] += nzb[t] * pl; tr[t] += nzb[t] * pr; } }
    // level, and removal of dead partials (swap-remove, back to front so indices stay valid)
    let lvl = 0;
    for (let i = v.n - 1; i >= 0; i--) {
      const e = (Math.abs(ED[i]) + Math.abs(ER[i])) / v.fg[i];
      if (e < thr) {
        if (v.res) { ED[i] = 0; ER[i] = 0; continue; }    // res partials keep their slot
        const j = --v.n;
        RE[i] = RE[j]; IM[i] = IM[j]; C[i] = C[j]; S[i] = S[j]; ED[i] = ED[j]; ER[i] = ER[j];
        KD[i] = KD[j]; KR[i] = KR[j]; GL[i] = GL[j]; GR[i] = GR[j]; v.fr[i] = v.fr[j]; v.fg[i] = v.fg[j];
        continue;
      }
      lvl += Math.abs(ED[i] + ER[i]);
    }
    if (v.sy) lvl += v.sy.nzLevel;
    let g = v.g; const gd = v.gd;
    if (v.att < 0.9999) {
      let at = v.att, a1 = v.att1; const ka = v.ka, kb = 1 - ka;
      for (let t = 0; t < len; t++) { const a = g * at; L[off + t] += tl[t] * a; R[off + t] += tr[t] * a; g *= gd; a1 += (1 - a1) * kb; at += (a1 - at) * kb; }
      v.att = at; v.att1 = a1;
    } else {
      for (let t = 0; t < len; t++) { L[off + t] += tl[t] * g; R[off + t] += tr[t] * g; g *= gd; }
    }
    v.g = g;
    v.level = lvl * g;
    if (v.level < 1e-7 && !(v.res && this.frame - v.born < this.sr * 0.1)) {
      v.active = false; if (this.resVoice[v.note] === v) this.resVoice[v.note] = null;
    }
  }

  renderSegment(off, len) {
    const L = this.dryL, R = this.dryR;
    for (let t = off; t < off + len; t++) { L[t] = 0; R[t] = 0; }
    if (len <= 0) return;
    for (const v of this.voices) if (v.active) this.renderVoice(v, L, R, off, len);
    for (const n of this.noise) if (n.active) this.renderNoise(n, L, R, off, len);
  }

  handle(ev) {
    switch (ev.type) {
      case 'on': this.noteOn(ev.note, ev.vel, ev.silent); break;
      case 'off': this.noteOff(ev.note, ev.vel); break;
      case 'pedal': this.pedal(ev.which, ev.value); break;
      case 'params': this.setParams(ev.p); break;
      case 'allOff': for (let m = 0; m < 128; m++) if (this.keyDown[m]) this.noteOff(m); break;
      case 'bend': this.setBend(ev.semis); break;
    }
  }

  // Pitch wheel: sounding oscillators keep their phase and change rotation; new ones start already bent (addOsc).
  setBend(semis) {
    const r = Math.pow(2, (Math.max(-24, Math.min(24, semis)) || 0) / 12);
    if (Math.abs(r - this.bendRatio) < 1e-9) return;
    this.bendRatio = r;
    for (const v of this.voices) if (v.active) for (let i = 0; i < v.n; i++) { const w = 2 * Math.PI * v.fr[i] * r / this.sr; v.c[i] = Math.cos(w); v.s[i] = Math.sin(w); }
  }

  process(inputs, outputs) {
    const t0 = Date.now();
    const out = outputs[0], oL = out[0], oR = out[1] || out[0];
    const N = oL.length, sr = this.sr, P = this.p;
    this.frame = currentFrame;
    let pos = 0;
    const q = this.queue;
    while (q.length && q[0].f < currentFrame + N) {
      const ev = q.shift();
      const at = Math.max(pos, Math.min(N, ev.f < 0 ? 0 : ev.f - currentFrame));
      if (at > pos) { this.renderSegment(pos, at - pos); pos = at; }
      this.handle(ev);
    }
    this.renderSegment(pos, N - pos);

    // soundboard modes (generated instruments): strings -> bridge -> resonant bank -> radiated sound
    const L = this.dryL, R = this.dryR;
    const sbAmt = this.inst && this.inst.soundboard ? this.inst.soundboard.amount * (P.sbRes ?? 1) * 2.0 : 0;
    if (sbAmt > 0) {
      if (!this.sbN) this.initSoundboard();
      const A1 = this.sbA1, A2 = this.sbA2, IN = this.sbIn, GL = this.sbGl, GR = this.sbGr, Y1 = this.sbY1, Y2 = this.sbY2, N8 = this.sbN;
      for (let t = 0; t < N; t++) {
        const x = (L[t] + R[t]) * 0.5; let yl = 0, yr = 0;
        for (let k = 0; k < N8; k++) {
          const y = A1[k] * Y1[k] + A2[k] * Y2[k] + IN[k] * x; Y2[k] = Y1[k]; Y1[k] = y;
          yl += y * GL[k]; yr += y * GR[k];
        }
        L[t] += yl * sbAmt; R[t] += yr * sbAmt;
      }
    }

    // harp / cabinet resonance: 8-line FDN, longer when the dampers are up
    const target = 0.25 + 3.2 * Math.max(this.sustain, this.harmonic ? 1 : 0);
    this.fdnT60 += (target - this.fdnT60) * 0.08;
    const gres = P.globalRes;
    if (gres > 0) {
      const G = this.fdnG, lens = this.fdnLen, bufs = this.fdnBuf, pos8 = this.fdnPos, lp = this.fdnLp;
      for (let i = 0; i < 8; i++) G[i] = Math.pow(10, -3 * lens[i] / (this.fdnT60 * sr));
      const send = 0.35, ret = gres * 0.1;
      let hx = this.hpX, hy = this.hpY;
      for (let t = 0; t < N; t++) {
        const xin = (L[t] + R[t]) * 0.5;
        hy = 0.995 * (hy + xin - hx); hx = xin;            // DC/rumble block
        let sum = 0;
        const o = this.fdnO;
        for (let i = 0; i < 8; i++) { o[i] = bufs[i][pos8[i]]; sum += o[i]; }
        sum *= 0.25;                                     // Householder: o - 2/N*sum
        let yl = 0, yr = 0;
        for (let i = 0; i < 8; i++) {
          let fb = (o[i] - sum) * G[i];
          lp[i] += 0.45 * (fb - lp[i]);                  // loss low-pass in the loop
          bufs[i][pos8[i]] = lp[i] + hy * send;
          if (++pos8[i] >= lens[i]) pos8[i] = 0;
          if (i & 1) yr += o[i]; else yl += o[i];
        }
        L[t] += yl * ret; R[t] += yr * ret;
      }
      this.hpX = hx; this.hpY = hy;
    }

    if (this.E.rotary && (P.modulation ?? 1) * this.multiW('rotary') > 0) this.rotaryStage(L, R, N);

    // tremolo / auto-pan of the instrument (engine.tremolo: { hz, depth, pan }): both channels follow a sine of the same depth; `pan`
    // is the phase shift of the right one in half turns (0 = together, 1 = opposite: a suitcase e-piano's auto-pan, 0.5 = a quarter
    // turn apart, like the two ears of a rotating speaker). The Modulation slider scales the depth.
    const tm = this.E.tremolo, mw = this.multiW('tremolo'), md = (P.modulation ?? 1) * (tm ? tm.depth * mw : 0);
    if (tm && md > 0) {
      const dph = 2 * Math.PI * tm.hz / sr, sh = Math.PI * (tm.pan ?? 0); let ph = this.tremPh || 0;
      for (let t = 0; t < N; t++) {
        L[t] *= 1 + md * Math.sin(ph); R[t] *= 1 + md * Math.sin(ph + sh); ph += dph;
      }
      this.tremPh = ph % (2 * Math.PI);
    }

    // output stage: stereo / mono / headphones, width, volume
    const vol = this.volLin;
    const mode = P.mode, width = mode === 'mono' ? 0 : P.width * (mode === 'headphones' ? 0.55 : 1);
    let pkL = this.peakL, pkR = this.peakR;
    for (let t = 0; t < N; t++) {
      const mid = (L[t] + R[t]) * 0.5, side = (L[t] - R[t]) * 0.5 * width;
      let l = (mid + side) * vol, r = (mid - side) * vol;
      if (mode === 'headphones') { const cl = l, cr = r; l = cl * 0.88 + cr * 0.12; r = cr * 0.88 + cl * 0.12; }
      oL[t] = l; if (out[1]) oR[t] = r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pkL) pkL = al; if (ar > pkR) pkR = ar;
    }
    this.peakL = pkL; this.peakR = pkR;

    // meters to the UI (~30 Hz)
    this.cpuAcc += Date.now() - t0; this.cpuBlocks++;
    if (++this.meterCount >= Math.round(sr / N / 30)) {
      this.meterCount = 0;
      const lv = this.levels; lv.fill(0);
      let nv = 0, nres = 0;
      for (const v of this.voices) if (v.active) { if (v.res) nres++; else nv++; if (v.level > lv[v.note]) lv[v.note] = v.level; }
      const cpu = this.cpuAcc / (this.cpuBlocks * N / sr * 1000);
      this.cpuAcc = 0; this.cpuBlocks = 0;
      const msg = { type: 'meter', levels: Array.from(lv), voices: nv, res: nres, cpu, peakL: this.peakL, peakR: this.peakR,
        sustain: this.sustain, soft: this.soft, sostenuto: this.sostenuto, harmonic: this.harmonic };
      if (this.lastInfo) { msg.info = this.lastInfo; this.lastInfo = null; }
      this.port.postMessage(msg);
      this.peakL *= 0.5; this.peakR *= 0.5;
    }
    return true;
  }
}
registerProcessor('piano-engine', PianoProcessor);

// live audio tap for "Record to WAV"
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = e => { this.on = e.data === 'start'; if (!this.on) this.port.postMessage('done'); }; }
  process(inputs) {
    const i = inputs[0];
    if (this.on && i && i.length) this.port.postMessage([i[0].slice(0), (i[1] || i[0]).slice(0)]);
    return true;
  }
}
registerProcessor('wav-recorder', RecorderProcessor);
