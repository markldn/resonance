# Instrument variation

`js/generator.js` builds a complete `resonance-instrument/1` document by varying a measured instrument (the Iowa
Grand). Open it with **Variation…** under Design → Instrument: a **joystick** (the same idea as the sound pad) whose middle is the
instrument itself and whose four corners are four random variations. The puck blends them live and the sound switches as you drag;
the outer ring goes further than the corners; **New** beside a corner rolls a different variation for it.

```js
import { generate, draw, morph } from './js/generator.js';
const doc = generate(iowaGrandDoc, 12345, 1);   // one seeded variation: same base + seed + amount = same instrument
const draws = [1, 2, 3, 4].map(draw);            // four corners
const at = morph(iowaGrandDoc, draws, { poles: [0.5, 0.5, 0, 0] }, 1);   // the puck between north and east
```

Every effect below is additive in dB or in log time, so the variation pad does not blend tables (they differ in how many partials survive);
it applies the weighted sum of the four draws to the measured base. The centre is the base itself, a corner is the seeded
variation, the noise keeps its spread between corners and fades to nothing at the centre. The synth kinds use the same pad on the
random numbers of their recipe (`morphSynth`); choices such as an organ's percussion harmonic take the nearest corner's value.

There are no recipes and no invented instruments. The output has the structure of the measured table: every key, every
velocity layer and every partial carries its own ratio, level, two decay times and remanent level. The generator moves
those measured numbers.

## What changes

1. **Spectral tilt** (dB per octave above 500 Hz, a random global value plus deviations at knots every 12 semitones): darker
   or brighter. At Medium the tilt has a spread of about 2 dB per octave, so a 4 kHz partial moves by roughly ±6 dB.
2. **Three broad spectral peaks** at random frequencies (300 Hz to 6 kHz, 0.5 to 1.5 octaves wide, about ±4.5 dB), fixed in
   frequency across the keyboard like body and soundboard resonances.
3. **Timbre character**: odd harmonics louder or quieter than even ones (±5 dB at Medium), a hammer-strike comb of random
   position, and a brightness that follows velocity more or less than the measured piano does.
4. **Sustain** (a factor on both decay times, smooth across the keyboard) and a **decay slope** (high partials die sooner
   or later than low ones).
5. **Key level and inharmonicity `B`**: smooth curves. Scaling `B` shifts the partial ratios by
   `sqrt((1 + B'n²) / (1 + Bn²))` so the frequencies stay consistent.
6. **Noise on every partial**, independent per key and partial, shared by the velocity layers of a key because it is the same
   string: level ±1.5 dB, decay times ×e^(0.2·N), remanent level ±3 dB.
7. **Body and air**: body frequency, level and decay, and air level and decay, change by about ±30 % and ±3 dB (body frequency kept within 80–220 Hz, where real piano bodies sit).

`amount` is 0.5 (Subtle), 1 (Medium) or 2 (Wild) times every spread above.

**Pitch never changes.** Fundamentals and harmonic ratios stay on the keys; the tests check every variation is within 60 cents
of the note. What changes is the tone: brightness, harmonic balance, decay and body.

The output is named `<base name> variation #<seed mod 100000>` and its `source` field records the seed and amount.

## How it relates to the sound pad and the sliders

The sound pad and the design sliders change the **playing** of one instrument (hardness, resonance, space, character)
and the table stays the same. A variation changes the **table**. The two combine: pick a variation, then move the pad.

## Checking

```bash
npm run test:generators   # or: node test/generator.test.mjs --seeds 6
```

For each amount and several seeds the variation must be valid, reproducible, different from the base and from other seeds,
and, rendered through the real engine at three notes and two velocities, finite, audible (peak above 3e-4), not
clipping, within 60 cents of the note, and falling at least 1 dB between 0–0.3 s and 2.4–3 s.

## Limits

- **A variation is not a measured piano.** It is the Iowa Grand with plausible changes. The spreads (1.5 dB per partial, 20 % decay,
  a few dB per kHz of brightness) are chosen by hand, not fitted to differences between real pianos, and nothing checks
  that a variation sounds like a piano someone could build.
- **Seeds are stable only for one generator version.** To keep an instrument, use **Save** in the dialog or export the JSON.
- **Only the base instrument's structure is available**: the same 88 keys, layers and string counts as the Iowa Grand.

# The mix pad

**Variation… → Mix instruments** puts a different instrument in the centre and in each corner, from any engine (the measured pianos, the
synths, your own), each optionally a random variation of itself (**New** / **Orig**). The puck layers them: every part strikes with
the note, with amplitude sqrt(weight), so the total power stays the same wherever the puck is. Parts keep their own engine block
(noise, vibrato, release); tremolo and rotary come from the first part that has one and follow its weight. **Mangle** picks four
random engines at once. In the engine this is `inst.multi = [{ inst, w }]` (`mixCompiled` in js/instrument.js), and only the weights
travel while you drag (`{ type: 'mixw' }`). A mix plays live and cannot be saved as one file yet.

**Strength** scales how far the corners of a variation go from the original (default 2.2x).

# Synth recipes

`js/synth.js` writes an instrument from formulas instead of a recording: the same 88-key, layered `resonance-instrument/1`
table, plus an `engine` block (docs/INSTRUMENT_FORMAT.md) that turns off the piano-only behaviour. Pick one under Design →
Instrument → Variation… → Kind. Same recipe, seed and amount give the same instrument.

| Recipe | Model |
|---|---|
| Electric piano | A cantilever tine: modes at 1 : 6.27 : 17.5 times the fundamental; a non-linear pickup makes harmonics that grow with strike strength (the growl, and the "bark" of the 6.27x mode). Two-stage decay, long in the bass. Auto-pan tremolo. |
| Church bell | Hum 0.5, prime 1 (on the key), tierce 1.2, quint 1.5, nominal 2, 2.5, 3, 4 and a clang of inharmonic partials; every partial a close pair (the bell is not round) via two strings. Clapper click. |
| Tonewheel organ | Nine drawbars at 16' to 1' with the tonewheels' equal-tempered ratios, 3 dB a step, a random classic registration, optional 2nd or 3rd harmonic percussion. No touch, no decay, key click, rotary-speaker-like tremolo. |
| Soft pad | A saw (or square) spectrum with a low-pass tilt that opens with touch, carried by three detuned strings for the chorus. 0.45 s rise, 0.65 s release, slow drifting auto-pan. |
| Marimba | A bar tuned so its overtones stand at 4x and about 10x, short-ringing, mallet tick, harder blow = brighter; the resonator tube adds a strong, short copy of the fundamental (a quarter-wave air column, Q about 25) and its 3x resonance, its level falling away up the keyboard. |
| Vibraphone | The same bar tuning ringing for seconds, with the motor tremolo (Modulation slider = motor depth). |
| Analog lead | Two detuned saws and a square sub through a resonant 24 dB/oct low-pass swept by an envelope, key- and velocity-tracked; mono, legato glide, delayed vibrato. |
| String ensemble | A sawtooth (Helmholtz motion) on three detuned strings, slow bow attack, delayed vibrato, a filter that opens at the bow change, and rosin noise. |
| Flute | Nearly a sine whose harmonics grow with the blow, in breath noise made by resonators at its own partials, plus air above 4 kHz; mono, delayed vibrato. |
| Brass | A harmonic-rich tone whose low-pass swells on the attack, a burst of tongue noise, delayed vibrato. |
| Drum kit | General MIDI layout on fixed-frequency partials: circular-membrane modes with a pitch drop, snare wires and beater clicks as noise, 808 hi-hat metal, claps as separate noise hits, one-shot voices, hi-hats in one choke group. |
| Organ | (above) now through a real rotary speaker: horn and drum at their own speeds with Doppler, two microphones, inertia; the Rotary speed slider. |

`amount` scales the per-partial irregularity. **Pitch is exact**: the anchor partial of every key is on its equal-tempered
frequency (tests check within 3 cents with the beating strings off, and tools/pitch_check.mjs with `SYNTH=bell,7,1`).

## What a recipe still cannot do

The engine adds up decaying sines and now adds vibrato, glide, a swept filter, noise and a rotary speaker to them. It is still not a
general synthesizer:

- No frequency or ring modulation, no oscillator sync, no waveshaping (apart from the fixed 2f "overtone doubling"): a sound is a sum of
  partials that ring and decay, plus noise. A bell-like FM timbre would have to be written out as partials.
- The filter and noise are per voice at block rate (2.7 ms): fast audio-rate filter modulation is not possible.
- Mono mode fades the earlier note when a new key is struck; it does not go back to a held earlier key when the newer one is released.
- Vibrato is a pitch modulation of the whole voice; a real flute's vibrato also modulates loudness and timbre, a real bowed string's
  varies its bow speed. Bow noise and breath are steady; they do not respond to bow pressure or blow strength during a note.
- The rotary speaker has no cabinet or horn-throat resonance, and both rotors turn at once (real ones can be stopped separately).
- Drums are synthesized from published modes and noise bands; they have not been compared with recordings of any kit.

The recipes follow published physics (beam modes, bell partial ratios, drawbar footages, bar tuning, circular-membrane modes, the 808's metal
frequencies). None has been compared with recordings of the real instrument, and I have not heard them.

Run `node test/synth.test.mjs` and `node test/synthdsp.test.mjs` (both in `npm test`): every recipe must be valid, reproducible, audible, in tune,
release on every key, and every engine feature (vibrato rate and depth, glide time, pitch envelope, filter response against its formula,
noise level, spectrum, decay and attack, resonator bandwidth, mono, choke, fixed pitch, rotary Doppler and inertia) must measure as specified.

