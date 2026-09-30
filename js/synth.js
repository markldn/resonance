// Synthesised instruments: recipes that write a resonance-instrument/1 table from physics and formulas instead of a recording.
//
//   import { synthesize, SYNTHS } from './js/synth.js';
//   const doc = synthesize('bell', 12345, 1);        // same recipe + seed + amount = same instrument
//
// The engine plays any table of decaying partials. A recipe says, for a key and a strike strength s (0 soft .. 1 hard), which
// partials exist (ratio to a fixed reference, level, two decay times, slow-tail level). Everything a table cannot say lives in
// the `engine` block (docs/INSTRUMENT_FORMAT.md): which partial sits on the key's pitch (anchor), rise time, key click,
// tremolo / auto-pan, and what does not apply to this instrument (hammer knock, sympathetic strings, key noise, the missing dampers
// above key 88). `engine.params` are the recommended slider values (tuning stretch 0, cabinet resonance, hammer thump); they act
// as defaults and every slider still works.
//
// What this cannot do, and does not pretend to: filters or envelopes that move during a note, vibrato (only tremolo and
// auto-pan), noise-based sounds, glide. Each recipe below states what its model is and what it leaves out.
//
// Pitch: the anchor partial of every key is exactly on the key (the engine places it), in equal temperament. Beating comes from
// the engine's own unison strings (`strings` + `detune_cents`), which keep the median string on pitch.

const A4 = 440;
const hz = (m, r) => A4 * Math.pow(2, (m - 69) / 12) * r;
const ET = st => Math.pow(2, st / 12);                                       // an equal-tempered interval of st semitones

function rng(seed) {                                                          // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = r => { let s = 0; for (let i = 0; i < 6; i++) s += r(); return (s - 3) * Math.SQRT2; };   // ~N(0,1)
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];

// A recipe:
//   lowest   ratio of its lowest partial (the table is written relative to it)
//   anchor   ratio of the partial that sits on the key's pitch
//   layers   [[velocity, strike strength s, gain_db relative to the loudest layer]]
//   random   (rng) -> per-instrument numbers, the same for every key
//   key      (m, s, R) -> { partials: [[ratio, level_dB, t60_direct_s, t60_remanent_s, remanent_dB]], strings, detune }
//            R = { r: rng seeded per key (same in all layers of a key), a: amount, k: the per-instrument numbers }
export const SYNTHS = {
  // ---------------------------------------------------------------------------------------------------------------
  epiano: {
    label: 'Electric piano (tine and pickup)',
    lowest: 1, anchor: 1,
    engine: { sympathetic: false, key_noise: false, dampers: 'all', release_s: 0.22, tremolo: { hz: 5.4, depth: 0.2, pan: 1 },
      params: { stretch: 0, globalRes: 0.5, hammerNoise: 0.35, quadratic: 0.6, keyNoise: 0 } },
    soundboard: 0.25,                                                          // the case and tone-bar body, as broad damped modes
    layers: [[28, 0.1, -17], [64, 0.4, -9], [100, 0.75, -3], [127, 1, 0]],
    // A struck tine is a clamped-free (cantilever) beam, whose modes stand at 1 : 6.267 : 17.55 : 34.4 times the fundamental
    // (beam theory: 1.875^2, 4.694^2, 7.855^2, 10.996^2). A magnetic pickup is not linear: the harder the tine swings, the more
    // harmonics it makes (2nd, 3rd ... of the fundamental), which is the growl of a hard-played e-piano. Level of the "bark"
    // (the 6.27x mode) rises steeply with strike strength. Decay is long in the bass and short in the treble, two-stage
    // (tine, then the tone bar it is coupled to). Tremolo: a suitcase e-piano's stereo auto-pan.
    random: r => ({ mode2: 6.267 * (1 + 0.012 * gauss(r)), mode3: 17.55 * (1 + 0.012 * gauss(r)), sus: 0.8 + 0.5 * r(), growl: 0.75 + 0.5 * r() }),
    clamp: k => { k.sus = Math.max(0.3, k.sus); k.growl = Math.max(0.15, k.growl); k.mode2 = Math.max(4, k.mode2); k.mode3 = Math.max(k.mode2 + 3, k.mode3); },
    key(m, s, R) {
      const { k, r } = R, a = R.a, x = (m - 21) / 87;
      const t = 9 * k.sus * Math.pow(2, -(m - 48) / 24);                      // direct T60: 9 s at C3, 3 s at C6 (times the sustain factor)
      const g = k.growl, jit = () => gauss(r) * 1.2 * a;
      return { strings: 1, detune: null, partials: [
        [1, 0, t, t * 2.4, -16],
        [2, -33 + 22 * s * g - 6 * x + jit(), t * 0.55, t * 1.1, -22],
        [3, -46 + 24 * s * g - 8 * x + jit(), t * 0.4, t * 0.8, -26],
        [4, -58 + 26 * s * g - 10 * x + jit(), t * 0.3, t * 0.6, -30],
        [5, -66 + 26 * s * g - 10 * x + jit(), t * 0.25, t * 0.5, -34],
        [k.mode2, -52 + 32 * s * g - 12 * x + jit(), Math.max(0.12, 0.18 * t), Math.max(0.2, 0.35 * t), -30],
        [k.mode3, -64 + 32 * s * g - 14 * x + jit(), Math.max(0.06, 0.05 * t), Math.max(0.1, 0.1 * t), -40],
      ] };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  bell: {
    label: 'Church bell',
    lowest: 0.5, anchor: 1,
    engine: { knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.8,
      click: { amp: 0.014, fc: 2600, q: 0.7, tau: 0.006 }, params: { stretch: 0, globalRes: 0.35, hammerNoise: 0.8, keyNoise: 0 } },
    layers: [[30, 0.15, -12], [80, 0.55, -4], [125, 1, 0]],
    // The partials of a tuned church bell, in units of the strike note (the "prime", which is what you hear as its pitch):
    // hum 0.5 (an octave below), prime 1, tierce 1.2 (the minor third that makes a bell sound like a bell), quint 1.5,
    // nominal 2, then the upper partials 2.5, 3, 4 that are set by the profile. Above these the clang: a scatter of
    // inharmonic partials that ring for a second or two. A bell is never quite round, so each partial is a close pair:
    // the engine's second string carries it at 1-4 cents, and the beat rate changes from one partial to the next.
    // The prime sits exactly on the key. Hum longest, high partials shortest; small (high) bells ring shorter.
    random: r => ({ tierce: 1.2 + 0.03 * (r() - 0.3), quint: 1.5 * (1 + 0.004 * gauss(r)), split: 1.2 + 2.6 * r(), ring: 0.8 + 0.5 * r(), clang: Array.from({ length: 6 }, () => r()) }),
    clamp: k => { k.tierce = Math.min(1.3, Math.max(1.15, k.tierce)); k.split = Math.max(0.2, k.split); k.ring = Math.max(0.3, k.ring); k.clang = k.clang.map(v => Math.min(1, Math.max(0, v))); },
    key(m, s, R) {
      const { k, r } = R, a = R.a, T = 34 * k.ring * Math.pow(2, -(m - 48) / 15) + 0.4;
      const up = 8 * s;                                                        // hard blow: the upper partials start louder
      const P = [
        [0.5, -12, T, T * 2.2, -8],
        [1, -3 - 0.5 * up, T * 0.8, T * 1.8, -8],
        [k.tierce, -6, T * 0.55, T * 1.3, -10],
        [k.quint, -8, T * 0.45, T * 1.1, -10],
        [2, 0.3 * up, T * 0.4, T * 0.9, -12],
        [2.5, -12 + up, T * 0.28, T * 0.6, -14],
        [3, -14 + up, T * 0.22, T * 0.5, -16],
        [4, -17 + 1.2 * up, T * 0.15, T * 0.35, -20],
      ];
      k.clang.forEach((c, i) => P.push([4.6 + 0.55 * i + 0.3 * c + gauss(r) * 0.02 * a, -22 - 2 * i + 1.6 * up + gauss(r) * 2 * a, 0.9 + 0.5 * c, 1.6, -30]));
      return { strings: 2, detune: [0, k.split * (0.7 + 0.6 * ((m * 7) % 5) / 5)], partials: P };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  organ: {
    label: 'Tonewheel organ (Hammond drawbars)',
    lowest: 0.5, anchor: 1,
    engine: { knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.035,
      attack_s: 0.006, click: { amp: 0.006, fc: 3200, q: 0.9, tau: 0.003 },
      rotary: { crossover_hz: 800, mics_deg: 80, horn: { slow_hz: 0.8, fast_hz: 6.6, depth_ms: 0.28, amp: 0.3, accel: 5 }, drum: { slow_hz: 0.66, fast_hz: 5.7, depth_ms: 0.35, amp: 0.2, accel: 1 } },
      params: { stretch: 0, globalRes: 0.3, hammerNoise: 0.8, keyNoise: 0, rotary: 0.35 } },
    layers: [[30, 0, 0], [80, 0, 0], [127, 0, 0]],                             // an organ has no touch: identical layers
    // Nine drawbars at 16' 5 1/3' 8' 4' 2 2/3' 2' 1 3/5' 1 1/3' 1' = 0.5 1.5 1 2 3 4 5 6 8 times the key's pitch, where the
    // tonewheels are equal tempered (so the 5 1/3' is 2^(7/12), not exactly 3/2). Each drawbar step is 3 dB; a registration is
    // nine numbers 0-8. Percussion is a short decaying 2nd or 3rd harmonic. A held key does not decay (T60 3000 s).
    // The rotary speaker is modelled (engine.rotary): a horn and a drum rotating at their own speeds with two microphones, so the tone gets
    // both the amplitude swirl and the Doppler vibrato. The Rotary speed slider goes from slow (chorale) to fast (tremolo); the rotors take
    // about a second (horn) and several (drum) to change speed.
    random: r => {
      const regs = [[8, 8, 8, 0, 0, 0, 0, 0, 0], [8, 8, 8, 8, 0, 0, 0, 0, 0], [8, 0, 8, 8, 0, 0, 0, 0, 0], [0, 0, 8, 0, 0, 0, 0, 0, 0],
        [8, 8, 8, 8, 8, 8, 8, 8, 8], [8, 3, 8, 0, 0, 0, 0, 0, 8], [6, 0, 8, 8, 6, 0, 0, 0, 0], [8, 7, 8, 6, 5, 0, 0, 0, 0]];
      return { bars: pick(r, regs), perc: pick(r, [0, 0, 3, 2]) };
    },
    discrete: ['perc'],                                                        // a choice of percussion harmonic, not a quantity
    clamp: k => { k.bars = k.bars.map(v => Math.min(8, Math.max(0, v))); },
    key(m, s, R) {
      const { k } = R, ratios = [0.5, ET(7), 1, 2, ET(19), 4, ET(28), ET(31), 8], P = [];
      k.bars.forEach((v, i) => { if (v > 0) P.push([ratios[i], -3 * (8 - v), 3000, 3000, -120]); });
      if (!P.some(p => p[0] === 0.5)) P.push([0.5, -90, 3000, 3000, -120]);    // keeps the table's lowest partial fixed
      if (!P.some(p => p[0] === 1)) P.push([1, -90, 3000, 3000, -120]);        // ... and an 8' partial for the anchor
      if (k.perc === 2) P.push([2, -5, 0.28, 0.28, -120]); else if (k.perc === 3) P.push([ET(19), -4, 0.28, 0.28, -120]);
      return { strings: 1, detune: null, partials: P };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  pad: {
    label: 'Soft pad (detuned saw ensemble)',
    lowest: 1, anchor: 1,
    engine: { knock: 0, sympathetic: false, key_noise: false, quadratic: 0, inharm: true, dampers: 'all', release_s: 0.65, attack_s: 0.45,
      tremolo: { hz: 0.31, depth: 0.07, pan: 0.7 }, params: { stretch: 0, globalRes: 0.4, keyNoise: 0 } },
    layers: [[40, 0.3, -5], [100, 1, 0]],
    // A sawtooth (harmonics at 1/n) or, if "hollow", a square (odd harmonics only), as three detuned oscillators: the
    // engine's three strings carry the whole spectrum at -d, 0, +d cents (the String spread slider widens or narrows the chorus).
    // A low-pass tilt makes it darker; a harder touch opens it. Slow rise, slow release, a slow drifting auto-pan; a held note stays level.
    random: r => ({ tilt: 0.85 + 0.35 * r(), det: 3 + 5 * r(), n: 26 + Math.floor(r() * 8), hollow: r() < 0.3, open: 0.5 + r() }),
    clamp: k => { k.tilt = Math.max(0.3, k.tilt); k.det = Math.max(0.5, k.det); k.n = Math.min(40, Math.max(8, Math.round(k.n))); k.open = Math.max(0.1, k.open); },
    key(m, s, R) {
      const { k, r } = R, a = R.a, f1 = hz(m, 1), P = [];
      const nmax = Math.min(k.n, Math.floor(16000 / f1));
      const fc = 900 * Math.pow(2, 2.4 * s * k.open) * Math.pow(2, (m - 60) / 30);   // low-pass corner, Hz
      for (let n = 1; n <= nmax; n++) {
        if (k.hollow && n % 2 === 0) continue;
        const f = f1 * n, lv = -20 * Math.log10(n) * k.tilt - 10 * Math.log10(1 + Math.pow(f / fc, 4)) + gauss(r) * 0.5 * a;
        P.push([n, lv, 3000, 3000, -120]);
      }
      return { strings: 3, detune: [-k.det, 0, k.det], partials: P };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  marimba: {
    label: 'Marimba (rosewood bars)',
    lowest: 1, anchor: 1,
    engine: { knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.1,
      click: { amp: 0.012, fc: 2200, q: 0.8, tau: 0.004 }, params: { stretch: 0, globalRes: 0.5, hammerNoise: 0.8, keyNoise: 0 } },
    soundboard: 0.15,
    layers: [[30, 0.1, -13], [70, 0.45, -6], [105, 0.8, -2], [127, 1, 0]],
    // A marimba bar is cut away underneath so that its first two overtones stand at 4 and about 10 times the fundamental
    // (a plain bar would give 2.76 and 5.40). The fundamental is strong and rings for seconds in the bass, a fraction of a second
    // in the treble; the overtones die in a tenth of that. A harder mallet or blow raises the overtones. The mallet tick is the click.
    // The resonator tubes are not modelled (they would add loudness and a slightly longer fundamental).
    random: r => ({ o2: 3.96 + 0.06 * r(), o3: 9.7 + 0.5 * r(), ring: 0.75 + 0.6 * r() }),
    clamp: k => { k.o2 = Math.min(4.1, Math.max(3.85, k.o2)); k.o3 = Math.min(10.4, Math.max(9.3, k.o3)); k.ring = Math.max(0.3, k.ring); },
    key(m, s, R) {
      const { k, r } = R, a = R.a, t = Math.max(0.16, 2.6 * k.ring * Math.pow(2, -(m - 48) / 11)), jit = () => gauss(r) * a;
      // The resonator tube under the bar is tuned to its fundamental, a quarter-wave air column with a Q of about 25: it is driven by the bar,
      // adds a strong, short-lived copy of the fundamental (T60 = 6.9 Q / 2 pi f), and, being closed at one end, a weak resonance at three times
      // its frequency that is not one of the bar's own (a nasal edge). A tube is never tuned exactly: a small random offset per key. The
      // lowest bars use folded tubes, and above about C6 the tube is too short to matter, so its level falls away with pitch.
      const f1 = hz(m, 1), tube = 4 * Math.max(0, Math.min(1, (98 - m) / 40)), tt = Math.min(0.5, 6.9 * 25 / (2 * Math.PI * f1)), off = 1 + 0.0007 * gauss(r);
      return { strings: 1, detune: null, partials: [
        [1, 0, t, t * 1.5, -20],
        [off, tube - 3, tt, tt * 1.2, -60],
        [3 * off, tube - 22, tt * 0.5, tt * 0.6, -70],
        [k.o2, -22 + 16 * s + jit(), t * 0.22, t * 0.3, -40],
        [k.o3, -36 + 18 * s + jit(), t * 0.07, t * 0.1, -60],
        [6.9, -50 + 16 * s + jit(), t * 0.03, t * 0.04, -70],
      ] };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  vibraphone: {
    label: 'Vibraphone (aluminium bars, motor)',
    lowest: 1, anchor: 1,
    engine: { knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.32,
      click: { amp: 0.01, fc: 3000, q: 0.8, tau: 0.003 }, tremolo: { hz: 5.6, depth: 0.32, pan: 0.15 },
      params: { stretch: 0, globalRes: 0.5, hammerNoise: 0.8, keyNoise: 0 } },
    layers: [[30, 0.1, -12], [70, 0.45, -6], [105, 0.8, -2], [127, 1, 0]],
    // Aluminium bars tuned like a marimba's (overtones near 4x and 10x) but ringing for many seconds; the motor-driven fans
    // in the resonator tubes open and close them about 5-6 times a second, which is the tremolo (Modulation slider = motor depth).
    random: r => ({ o2: 3.98 + 0.04 * r(), o3: 10.0 + 0.4 * r(), ring: 0.8 + 0.5 * r() }),
    clamp: k => { k.o2 = Math.min(4.1, Math.max(3.9, k.o2)); k.o3 = Math.min(10.5, Math.max(9.6, k.o3)); k.ring = Math.max(0.3, k.ring); },
    key(m, s, R) {
      const { k, r } = R, a = R.a, t = Math.max(0.6, 11 * k.ring * Math.pow(2, -(m - 48) / 15)), jit = () => gauss(r) * a;
      return { strings: 2, detune: [0, 0.4 + 0.5 * (((m * 13) % 7) / 7)], partials: [   // a hair of splitting: the bar is not perfectly symmetric
        [1, 0, t, t * 1.6, -14],
        [k.o2, -24 + 14 * s + jit(), t * 0.1, t * 0.2, -40],
        [k.o3, -38 + 16 * s + jit(), t * 0.04, t * 0.08, -60],
      ] };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  lead: {
    label: 'Analog lead (mono, glide, filter sweep)',
    lowest: 0.5, anchor: 1,
    // Two detuned sawtooth oscillators and a square sub-oscillator an octave down, through a resonant 24 dB/oct low-pass whose cutoff
    // is swept by an envelope, follows the key and opens with touch. One voice at a time; a key struck while another is held slides
    // (legato portamento); vibrato comes in after a short delay. Everything here is done by the engine's synth voice (engine.synth).
    engine: k => ({ knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.18, attack_s: 0.004,
      synth: { mono: true, glide: { time_s: k.glide, legato: true }, vibrato: { hz: 5.6, cents: k.vib, delay_s: 0.25, rise_s: 0.35, jitter: 0.25 },
        filter: { type: 'lp', poles: 4, q: k.q, cutoff_hz: k.cutoff, key_track: 0.75, vel_oct: 1.6, env: { oct: k.fenv, attack_s: 0.004, decay_s: 0.35, sustain: 0.25, release_s: 0.3 } } },
      params: { stretch: 0, globalRes: 0.3, keyNoise: 0 } }),
    layers: [[40, 0.2, -8], [90, 0.6, -2], [127, 1, 0]],
    random: r => ({ cutoff: 500 + 500 * r(), q: 1.6 + 1.4 * r(), fenv: 2.8 + 1.6 * r(), det: 4 + 6 * r(), sub: -9 + 6 * r(), vib: 16 + 12 * r(), glide: 0.05 + 0.1 * r() }),
    clamp: k => { k.cutoff = Math.max(150, k.cutoff); k.q = Math.min(4.5, Math.max(0.6, k.q)); k.fenv = Math.max(0, k.fenv); k.det = Math.max(0.5, k.det); k.vib = Math.max(0, k.vib); k.glide = Math.max(0.01, k.glide); },
    key(m, s, R) {
      const { k } = R, f1 = hz(m, 1), P = [], nmax = Math.min(48, Math.floor(16000 / f1));
      for (let n = 1; n <= nmax; n++) P.push([n, -20 * Math.log10(n), 3000, 3000, -120]);                        // sawtooth
      for (let n = 1; 0.5 * n * f1 < 16000 && n <= 23; n += 2) P.push([0.5 * n, k.sub - 20 * Math.log10(n), 3000, 3000, -120]);   // square, an octave down
      return { strings: 2, detune: [-k.det, k.det], partials: P };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  strings: {
    label: 'String ensemble (bowed)',
    lowest: 1, anchor: 1,
    // A bowed string moves as a sawtooth (Helmholtz motion): harmonics falling as 1/n. An ensemble is several players a few cents apart
    // (three detuned strings), each with a slow bow attack, a vibrato that starts after the note has begun, a filter that opens a little at
    // the bow change and follows the key, and the rosin noise of the bow (band noise, brighter with the filter).
    engine: k => ({ knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.45, attack_s: k.attack,
      synth: { vibrato: { hz: 5.3, cents: k.vib, delay_s: 0.35, rise_s: 0.6, jitter: 0.4 },
        filter: { type: 'lp', poles: 2, q: 0.8, cutoff_hz: k.cut, key_track: 1, vel_oct: 1.4, env: { oct: 1.1, attack_s: 0.22, decay_s: 0.9, sustain: 0.55, release_s: 0.3 } },
        noise: [{ type: 'band', kind: 'bp', fc: 3400, q: 0.7, level_db: k.bow, sustain: 1, attack_s: 0.12, follow: 0.3 }] },
      params: { stretch: 0, globalRes: 0.4, keyNoise: 0 } }),
    layers: [[35, 0.2, -8], [80, 0.6, -3], [127, 1, 0]],
    random: r => ({ attack: 0.22 + 0.25 * r(), vib: 10 + 8 * r(), cut: 1800 + 1400 * r(), bow: -31 + 8 * r(), det: 5 + 5 * r(), tilt: 0.8 + 0.3 * r() }),
    clamp: k => { k.attack = Math.max(0.03, k.attack); k.vib = Math.max(0, k.vib); k.cut = Math.max(500, k.cut); k.det = Math.max(0.5, k.det); k.tilt = Math.max(0.3, k.tilt); },
    key(m, s, R) {
      const { k } = R, f1 = hz(m, 1), nmax = Math.min(48, Math.floor(16000 / f1)), P = [];
      for (let n = 1; n <= nmax; n++) P.push([n, -20 * k.tilt * Math.log10(n), 3000, 3000, -120]);
      return { strings: 3, detune: [-k.det, 0, k.det], partials: P };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  flute: {
    label: 'Flute (breath and vibrato)',
    lowest: 1, anchor: 1,
    // A flute tone is nearly a sine with weak harmonics that grow with the strength of the blow, sitting in breath noise. The breath is
    // noise filtered by the tube's own resonances, so it is made here by a bank of resonators at the note's partials (engine noise `bank`),
    // plus a little unpitched air above 4 kHz. One voice at a time; vibrato is a slow pulse of the blow that comes in after the note starts.
    engine: k => ({ knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.12, attack_s: 0.07,
      synth: { mono: true, vibrato: { hz: 5.0, cents: k.vib, delay_s: 0.5, rise_s: 0.7, jitter: 0.3 },
        noise: [{ type: 'bank', q: k.q, level_db: k.breath, sustain: 1, attack_s: 0.05 }, { type: 'band', kind: 'hp', fc: 4500, q: 0.7, level_db: k.air, sustain: 1, attack_s: 0.05 }] },
      params: { stretch: 0, globalRes: 0.35, keyNoise: 0 } }),
    layers: [[40, 0.15, -9], [85, 0.55, -3], [127, 1, 0]],
    random: r => ({ vib: 12 + 10 * r(), q: 35 + 25 * r(), breath: -18 + 6 * r(), air: -31 + 6 * r(), h2: -13 + 4 * r() }),
    clamp: k => { k.vib = Math.max(0, k.vib); k.q = Math.max(8, k.q); },
    key(m, s, R) {
      const { k } = R, up = 14 * s;                                            // a harder blow: more harmonics
      return { strings: 1, detune: null, partials: [[1, 0, 3000, 3000, -120], [2, k.h2 + up, 3000, 3000, -120], [3, k.h2 - 12 + up, 3000, 3000, -120], [4, k.h2 - 20 + up, 3000, 3000, -120], [5, k.h2 - 30 + up, 3000, 3000, -120], [6, k.h2 - 38 + up, 3000, 3000, -120]] };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  brass: {
    label: 'Brass (swell and vibrato)',
    lowest: 1, anchor: 1,
    // A brass tone is rich in harmonics, and the "blat" is that the harmonics open up faster than the fundamental as the lips start
    // buzzing: a low-pass whose cutoff swells on the attack (engine filter envelope), stronger and higher with a harder blow. A burst of
    // noise for the tongue, vibrato from mid-note.
    engine: k => ({ knock: 0, sympathetic: false, key_noise: false, quadratic: 0, dampers: 'all', release_s: 0.14, attack_s: 0.045,
      synth: { vibrato: { hz: 5.4, cents: k.vib, delay_s: 0.55, rise_s: 0.6, jitter: 0.3 },
        filter: { type: 'lp', poles: 2, q: 1.3, cutoff_hz: k.cut, key_track: 0.9, vel_oct: 2.4, env: { oct: k.swell, attack_s: 0.06, decay_s: 0.3, sustain: 0.5, release_s: 0.1 } },
        noise: [{ type: 'band', kind: 'bp', fc: 2500, q: 1.2, level_db: -33, attack_s: 0.02, decay_s: 0.18, sustain: 0.25 }] },
      params: { stretch: 0, globalRes: 0.35, keyNoise: 0 } }),
    layers: [[35, 0.2, -12], [80, 0.6, -4], [127, 1, 0]],
    random: r => ({ vib: 8 + 8 * r(), cut: 380 + 250 * r(), swell: 2.5 + 1.2 * r() }),
    clamp: k => { k.vib = Math.max(0, k.vib); k.cut = Math.max(120, k.cut); k.swell = Math.max(0.3, k.swell); },
    key(m, s, R) {
      const { k } = R, f1 = hz(m, 1), nmax = Math.min(40, Math.floor(16000 / f1)), P = [];
      for (let n = 1; n <= nmax; n++) P.push([n, -20 * 0.55 * Math.log10(n), 3000, 3000, -120]);
      return { strings: 1, detune: null, partials: P };
    },
  },

  // ---------------------------------------------------------------------------------------------------------------
  drums: {
    label: 'Drum kit (General MIDI layout)',
    fixed: true, lowest: 1, anchor: 1,
    // The keys are drums, not pitches (General MIDI: 36 kick, 38 snare, 39 clap, 42/44/46 hi-hats, 41-50 toms, 49/57 crash, 51 ride ...),
    // so partial "ratios" are frequencies in Hz (engine.fixed) and a struck key rings out (engine.oneshot); the hi-hat keys are one choke
    // group. A drum head is a circular membrane: its modes stand at 1 : 1.594 : 2.136 : 2.296 : 2.653 : 2.918 times the fundamental, and
    // it drops in pitch as the head relaxes after the blow (pitch envelope). A snare adds the noise of its wires, a kick the click of the
    // beater, an 808-style hi-hat six metal frequencies (205.3 304.4 369.6 522.7 540 800 Hz) with their harmonics through a high-pass.
    engine: { knock: 0, sympathetic: false, key_noise: false, quadratic: 0, fixed: true, oneshot: true, dampers: 'all', release_s: 0.5,
      params: { stretch: 0, globalRes: 0.3, hammerNoise: 0.8, keyNoise: 0 } },
    layers: [[25, 0.2, -14], [70, 0.55, -6], [110, 0.85, -1.5], [127, 1, 0]],
    random: r => ({ tune: 1 + 0.12 * (r() - 0.5), snap: -2 + 6 * r(), decay: 0.85 + 0.35 * r(), metal: r() }),
    clamp: k => { k.tune = Math.min(1.4, Math.max(0.7, k.tune)); k.decay = Math.max(0.3, k.decay); k.metal = Math.min(1, Math.max(0, k.metal)); },
    key(m, s, R) {
      const { k } = R, up = 8 * (s - 0.5), MEM = [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.5], MEML = [0, -4, -8, -9, -12, -14, -16, -18];
      const membrane = (f, td, drop = 0.5, top = 8) => MEM.slice(0, top).map((r, i) => [f * k.tune * r, MEML[i] + (i ? up * i / 4 : 0), td * k.decay * Math.pow(drop, i * 0.5), td * k.decay * Math.pow(drop, i * 0.5) * 1.3, -14]);
      const noise = (fc, q, dB, decay, kind = 'bp', extra = {}) => ({ type: 'band', kind, fc, q, level_db: dB + up, decay_s: decay * k.decay, sustain: 0, ...extra });
      const click = (fc, dB, decay = 0.006) => noise(fc, 1.0, dB, decay);
      // 808 hi-hat / cymbal partials: the square waves' odd harmonics between 3 and 16 kHz, each a little different
      const metal = (T, top = 3000) => { const P = []; [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].forEach((b, i) => { for (let n = 1; b * n < 16000; n += 2) if (b * n > top) P.push([b * n * (1 + 0.004 * (k.metal - 0.5) * i), -20 * Math.log10(n) - 3 * i, T * (1 + 0.15 * i), T * (1 + 0.15 * i), -30]); }); return P; };
      const dummy = [[1000, -90, 0.01, 0.01, -120]];                                 // a table needs a tonal part; noise-only sounds carry a silent one
      let P, synth = {};
      const tom = f => { P = membrane(f, 0.55); synth = { pitch_env: { cents: 240, tau_s: 0.06 }, noise: [click(3200, -14)] }; };
      if (m <= 35) { const f = 46 * Math.pow(2, (m - 35) / 12); P = [[f * k.tune, 0, 0.6, 0.7, -16], [f * 2.4 * k.tune, -12, 0.25, 0.3, -30]]; synth = { pitch_env: { cents: 1500, tau_s: 0.03 }, noise: [click(2800, -14 + up, 0.012)] }; }
      else if (m === 36) { P = [[54 * k.tune, 0, 0.5 * k.decay, 0.6 * k.decay, -16], [54 * 2.5 * k.tune, -12, 0.22, 0.28, -30], [54 * 4.1 * k.tune, -22, 0.1, 0.12, -40]]; synth = { pitch_env: { cents: 1800, tau_s: 0.03 }, noise: [click(2800, -14 + up, 0.012)] }; }
      else if (m === 37) { P = [[1750 * k.tune, 0, 0.05, 0.06, -30], [520 * k.tune, -6, 0.07, 0.08, -30], [3100 * k.tune, -12, 0.03, 0.04, -40]]; synth = { noise: [click(4500, -8, 0.008)] }; }
      else if (m === 38 || m === 40) { P = membrane(m === 38 ? 185 : 200, 0.2, 0.55, 6); synth = { pitch_env: { cents: 160, tau_s: 0.015 }, noise: [noise(3800, 0.55, k.snap, 0.21), noise(6500, 0.7, k.snap - 5, 0.14, 'hp'), click(4500, -4, 0.006)] }; }
      else if (m === 39) { P = dummy; synth = { noise: [0, 0.011, 0.022, 0.034].map(d => noise(1300, 1.3, 0, 0.014, 'bp', { delay_s: d })).concat([noise(1300, 1.1, -4, 0.2, 'bp', { delay_s: 0.034 })]) }; }
      else if (m === 41) tom(80); else if (m === 43) tom(95); else if (m === 45) tom(115); else if (m === 47) tom(135); else if (m === 48) tom(155); else if (m === 50) tom(180);
      else if (m === 42 || m === 44 || m === 46) { const T = m === 42 ? 0.07 : m === 44 ? 0.1 : 0.55; P = metal(T * k.decay); synth = { choke: 1, filter: { type: 'hp', poles: 4, q: 0.7, cutoff_hz: 6000 }, noise: [noise(8500, 0.7, -3, T, 'hp')] }; }
      else if (m === 49 || m === 52 || m === 55 || m === 57) { const T = m === 55 ? 1.0 : m === 52 ? 1.6 : 2.6; P = metal(T * k.decay, 800).slice(0, 90); synth = { noise: [noise(6000, 0.6, -2, T * 0.8, 'hp')] }; }
      else if (m === 51 || m === 53 || m === 59) { const T = 2.0; P = metal(T * k.decay, 1200).slice(0, 80); if (m === 53) { P.push([1150, -2, 1.4, 1.6, -20], [2350, -8, 1.0, 1.2, -20]); } synth = { noise: [noise(7000, 0.6, -6, 1.2, 'hp')] }; }
      else if (m === 54) { P = [5500, 7200, 9400, 11800].map((f, i) => [f * k.tune, -3 * i, 0.16, 0.2, -30]); synth = { noise: [noise(6500, 0.8, -1, 0.25, 'hp')] }; }
      else if (m === 56) { P = [[540 * k.tune, 0, 0.35, 0.4, -20], [1620 * k.tune, -9.5, 0.25, 0.3, -30], [2700 * k.tune, -14, 0.2, 0.24, -30], [800 * k.tune, -1, 0.22, 0.28, -20], [2400 * k.tune, -10.5, 0.16, 0.2, -30], [4000 * k.tune, -15, 0.12, 0.15, -30]]; synth = { noise: [click(3500, -14, 0.006)] }; }
      else if (m === 60 || m === 61) { P = membrane(m === 60 ? 320 : 240, 0.18, 0.6, 4); synth = { pitch_env: { cents: 200, tau_s: 0.02 }, noise: [click(3500, -8, 0.007)] }; }
      else if (m === 62 || m === 63 || m === 64) { const f = m === 62 ? 185 : m === 63 ? 165 : 130; P = membrane(f, m === 62 ? 0.1 : 0.4, 0.6, 4); synth = { pitch_env: { cents: 120, tau_s: 0.03 }, noise: [click(3000, -8, 0.006)] }; }
      else if (m === 65 || m === 66) { P = membrane(m === 65 ? 330 : 250, 0.3, 0.55, 5).concat([[m === 65 ? 1900 : 1500, -10, 0.12, 0.15, -30]]); synth = { pitch_env: { cents: 150, tau_s: 0.02 }, noise: [click(5000, -6, 0.006)] }; }
      else if (m === 67 || m === 68) { const f = m === 67 ? 890 : 660; P = [[f * k.tune, 0, 0.5, 0.6, -20], [f * 2.63 * k.tune, -8, 0.3, 0.4, -30], [f * 4.9 * k.tune, -16, 0.15, 0.2, -30]]; synth = { noise: [click(4000, -14, 0.005)] }; }
      else if (m === 69 || m === 70) { P = dummy; synth = { noise: [{ type: 'band', kind: 'bp', fc: m === 69 ? 5500 : 6500, q: 0.7, level_db: m === 69 ? 0 : -3, attack_s: m === 69 ? 0.015 : 0.03, decay_s: 0.07, sustain: 0 }] }; }
      else if (m === 75) { P = [[2500 * k.tune, 0, 0.09, 0.1, -30], [5000 * k.tune, -14, 0.04, 0.05, -40]]; synth = { noise: [click(6000, -12, 0.003)] }; }
      else if (m === 76 || m === 77) { const f = m === 76 ? 1100 : 780; P = [[f * k.tune, 0, 0.07, 0.08, -30], [f * 2.41 * k.tune, -8, 0.03, 0.04, -40]]; synth = { noise: [click(4000, -14, 0.004)] }; }
      else if (m === 80 || m === 81) { const T = m === 80 ? 0.08 : 3.0; P = [2000, 5400, 9400, 12200].map((f, i) => [f * k.tune, -[0, 9, 14, 18][i], T * (1 - 0.15 * i), T * (1 - 0.1 * i), -30]); synth = { noise: [click(8000, -14, 0.003)] }; }
      else if (m < 60) tom(180 + 10 * (m - 50));                                    // the gaps between the toms
      else if (m < 75) { P = membrane(300 - 5 * (m - 60), 0.2, 0.6, 4); synth = { pitch_env: { cents: 150, tau_s: 0.02 }, noise: [click(3500, -8, 0.007)] }; }
      else { const f = 1200 * Math.pow(2, (m - 82) / 12); P = [[f * k.tune, 0, 0.6, 0.8, -20], [f * 2.76 * k.tune, -8, 0.4, 0.5, -30], [f * 5.4 * k.tune, -16, 0.2, 0.3, -30]]; synth = { noise: [click(8000, -14, 0.003)] }; }
      return { strings: 1, detune: null, partials: P, synth };
    },
  },
};

// The seed of each recipe's built-in entry in the instrument menu (organ: a full 8' 16' 5 1/3' 4' registration, not a lone sine)
export const DEFAULT_SEED = { organ: 3 };   // (registration 16' 5 1/3' 8' 4' with 2 2/3' percussion)
export const synthDefault = kind => synthesize(kind, DEFAULT_SEED[kind] ?? 1, 1);

export const SYNTH_LIST = Object.entries(SYNTHS).map(([id, r]) => [id, r.label]);

// amount: 0.5 subtle, 1 medium, 2 wild: scales the per-partial irregularity
export function synthesize(kind, seed = 1, amount = 1) {
  const rec = SYNTHS[kind];
  if (!rec) throw new Error('unknown synth recipe: ' + kind);
  const sd = seed >>> 0;
  return build(kind, rec.random(rng(sd ^ 0x51ed270b)), sd, amount, `${rec.label.replace(/ \(.*/, '')} #${sd % 100000}`, `synth recipe ${kind}, seed ${sd}, amount ${amount}`);
}

// The variation pad for a synth: the recipe's random numbers of the four corner seeds are blended by the puck weights and the table is
// built from the blend. Centre = the built-in instrument (DEFAULT_SEED). Numbers move linearly (gain > 1 goes past the corners, clamped
// to what the recipe can use), arrays element by element, and choices (a boolean or a number the recipe declares `discrete`) take the
// value of whichever of the five has the largest weight. The per-partial noise of the table keeps its seed, so it does not flicker.
export function morphSynth(kind, seeds, weights, gain = 1) {
  const rec = SYNTHS[kind], sd = DEFAULT_SEED[kind] ?? 1;
  const k0 = rec.random(rng(sd ^ 0x51ed270b)), ks = seeds.map(x => rec.random(rng((x >>> 0) ^ 0x51ed270b)));
  const w = weights.poles, wc = weights.center, disc = new Set(rec.discrete || []);
  const pickIdx = () => { let bi = -1, bw = wc; w.forEach((v, i) => { if (v > bw) { bw = v; bi = i; } }); return bi; };
  const mix = (key, v0) => {
    const vs = ks.map(o => o[key]);
    if (typeof v0 === 'number' && !disc.has(key)) return v0 + gain * vs.reduce((a, v, i) => a + w[i] * (v - v0), 0);
    if (Array.isArray(v0) && v0.every(x => typeof x === 'number')) return v0.map((x, j) => x + gain * vs.reduce((a, v, i) => a + w[i] * (v[j] - x), 0));
    const i = pickIdx(); return i < 0 ? v0 : vs[i];
  };
  const k = {}; for (const key of Object.keys(k0)) k[key] = mix(key, k0[key]);
  if (rec.clamp) rec.clamp(k);
  return build(kind, k, sd, 1, `${rec.label.replace(/ \(.*/, '')} morph`, `synth recipe ${kind}, pad seeds ${seeds.join(',')}`);
}

function build(kind, k, sd, amount, name, source) {
  const rec = SYNTHS[kind], keys = [], eng0 = typeof rec.engine === 'function' ? rec.engine(k) : rec.engine;
  for (let m = 21; m <= 108; m++) {                                           // every key, so per-key beating always applies
    let strings = 1, detune = null, ksynth = null;
    const layers = rec.layers.map(([vel, s, gain]) => {
      const R = { r: rng((Math.imul(sd, 2654435761) + m * 977) >>> 0), a: amount, k };   // same random draws in every layer of a key
      const out = rec.key(m, s, R); strings = out.strings; detune = out.detune; ksynth = out.synth || null;
      // the lowest partial always stays (the engine indexes by it); others above 16 kHz (at the played pitch) are dropped
      const ps = out.partials.filter(p => rec.fixed ? p[0] < 16000 : (p[0] === rec.lowest || hz(m, p[0] / rec.anchor) < 16000)).slice(0, 100);
      const top = Math.max(...ps.map(p => p[1]));
      return { velocity: vel, gain_db: gain, partials: ps.map(p => [+(p[0] / rec.lowest).toFixed(5), +(p[1] - top).toFixed(1), +p[2].toFixed(3), +p[3].toFixed(3), +p[4].toFixed(1)]) };
    });
    const key = { note: m, B: 1e-7, strings, level_db: 0, layers };
    if (detune) key.detune_cents = detune.map(c => +c.toFixed(3));
    if (ksynth) key.synth = ksynth;
    keys.push(key);
  }
  const engine = { ...eng0, anchor: +(rec.anchor / rec.lowest).toFixed(5) };
  const doc = {
    format: 'resonance-instrument/1', name, author: 'Resonance synth recipes', license: 'CC0',
    source, a4_hz: A4, keys, engine,
  };
  if (rec.soundboard) doc.soundboard = { amount: rec.soundboard };
  return doc;
}
