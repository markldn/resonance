# The model and the literature behind it

Resonance is an additive, partial-by-partial model of a struck string instrument, plus a few physical layers around it. This
page states the mathematics the engine uses, says which parts follow the published literature and which are our own choices or
fits, and lists the papers. Every reference below was looked up (title, authors, journal, pages and DOI or link); none is quoted
from memory. The papers support the physics. They do not contain our constants, and where a formula is ours it says so.

Contents: [signal flow](#signal-flow) · [1 Partial frequencies](#1-partial-frequencies-and-tuning) · [2 Oscillator bank](#2-the-oscillator-bank) ·
[3 Decay](#3-two-stage-decay-and-unison-strings) · [4 Hammer and velocity](#4-hammer-velocity-and-hardness) ·
[5 Noise, body, air](#5-hammer-knock-body-and-air) · [6 Nonlinear partials](#6-the-quadratic-effect) · [7 Pedals and resonance](#7-pedals-and-sympathetic-resonance) ·
[8 Cabinet and room](#8-cabinet-resonance-and-room) · [9 Measuring](#9-measuring-an-instrument) · [10 Instrument variations](#10-instrument-variations) ·
[11 Sound pad](#11-the-sound-pad) · [References](#references)

## Signal flow

```
instrument data (per key, per velocity layer: partial ratios, levels, two-stage decays, string count, detune)
   -> interpolate between keys and layers      -> velocity law and hardness (section 4)
   -> bank of decaying phasors, one per partial and string (sections 2 and 3)
   -> + hammer knock, body thump, air noise (5)  + quadratic components (6)
   -> sympathetic and pedal resonance (7)   -> cabinet FDN (8)   -> lid / microphone shaping -> room convolution (8)
```

## 1 Partial frequencies and tuning

A real string is stiff, so its overtones are slightly sharp of the harmonic series. For a string pinned at both ends,
Fletcher's result is

```
f_n = n * f_0 * sqrt(1 + B * n^2)          B: inharmonicity coefficient, rises steeply towards the treble
```

The engine uses exactly this (`partialFreq`, for sympathetic strings). For a measured instrument each key stores its own `B`
(fitted from the recording), and when the *String length* control changes it, the partial frequencies are rescaled by
`sqrt((1 + B_new n^2) / (1 + B_old n^2))`, so the measured pitch is kept. Bars, bells and tines are not harmonic at all, so
their measured non-integer ratios are stored and played as they are.

The tuning across the keyboard is equal temperament or one of the historic temperaments (Werckmeister III, Zarlino, Pythagorean,
mesotonic, well-tempered) as cent offsets per note name, then **octave stretching**: real tuners tune the bass flat and the
treble sharp of the equal-tempered pitch, the effect Railsback measured in 1938. The engine adds

```
cents(m) = s * sign(m - 64) * 26 * (|m - 64| / 44)^2.3          s = the Tuning stretch control (1 by default)
```

so the stretch is zero at the middle of the keyboard and +-26 cents at the ends. The direction (flat bass, sharp treble) follows
Railsback's observation. The power-law form and the constants are ours and were not fitted to his data.

## 2 The oscillator bank

Each partial of each string is a decaying complex phasor. With `w = 2 pi f / f_s`, one sample is

```
z[n+1] = z[n] * exp(j w)          (stored as cos w and sin w; a complex multiply)
y[n]   = Re(z[n]) * a[n]          a[n+1] = a[n] * exp(-r / f_s)
```

so a partial costs about four multiplications and needs no table lookup or trigonometry per sample. Rounding error would slowly
change the phasor's length, so it is renormalised with the first-order step `z <- z * (1.5 - 0.5 |z|^2)`. This is the standard
recursive-oscillator form of additive synthesis (Smith, *Spectral Audio Signal Processing*); Bank, Zambon and Fontana build a
real-time piano the same way, with resonators in a modal formulation. The trade-off is that the sound is a sum of sinusoids: it
reproduces what was measured and what the data describe, and it has no string or hammer model underneath. Changing a control
means recomputing the phasor rotations and rates of the sounding notes (that is how the pitch wheel works: rotation
recomputed, phase kept).

## 3 Two-stage decay and unison strings

A piano note first drops quickly (the *prompt sound*) and then continues on a much slower slope (the *aftersound*). Weinreich
explained this with coupled strings: the strings of a unison start in phase and drive the bridge together, which loses energy
fast; the mode in which they move against each other radiates little and lives longer. Woodhouse later stated when the double
decay appears for other instruments (a necessary condition on the body admittance and the string coupling), and found it over
most of the piano's range.

Each partial therefore has an envelope with two exponentials, in the units the file format uses (T60 = time to fall 60 dB):

```
env(t) = (1 - w) * exp(-ln(1000) * t / T60_direct) + w * exp(-ln(1000) * t / T60_remanent)     w = 10^(remanent_dB / 20)
```

The engine splits the partial's amplitude `a` into `a (1 - w)` on the fast phasor and `a w` on the slow one
(`addOsc(..., a * (1 - ws), a * ws, ...)`). The *Initial ring time*, *Board loading*, *High-ring cut-off* and *High-ring slope* controls scale the two
T60s (the cut-off and Q shape a frequency-dependent loss, `1 + (f / fc)^q`). That loss law and the way the controls act are our
design; Weinreich and Woodhouse give the mechanism, not this parametrisation.

**Beats.** The strings of a unison are tuned a few hundredths of a cent apart, which produces the slow amplitude beating of real
notes and, through the coupling, the aftersound. Measured instruments carry the fitted detune per string (`detune_cents`,
fitted by `tools/calibrate_to_recordings.py` for the Iowa Grand's treble). The strings start together, so each partial has one start
phase shared by its strings and they beat coherently from the strike.

## 4 Hammer, velocity and hardness

**Literature.** The hammer is a nonlinear spring. A power law between force and felt compression, `F = K * delta^p`, is the standard
description in string simulations (Chaigne and Askenfelt; Hall and Askenfelt), although Giordano and Winans show that measured
hammers do not follow a single power law exactly. In simulations and measurements alike a harder blow shortens the contact time
and puts more energy into the high partials (Hall and Askenfelt 1988; Askenfelt and Jansson 1993 measured string spectra at three
dynamic levels). Conklin's tutorial covers hammer voicing and its tonal effect.

For `F = K delta^p` and a hammer of mass `m` striking at speed `v`, energy balance gives `delta_max ~ v^(2/(p+1))` and so a contact
time `T ~ v^(-(p-1)/(p+1))` (`v^-0.5` for `p = 3`). The spectrum of the force pulse falls off above about `1/T`.

**What the engine does.** An instrument stores a few velocity layers (typically pp, mf, ff). Between them, levels are
interpolated in dB and T60s in log. Outside them, and for the *Felt* controls, the engine applies a law that is **ours**, fitted
on data:

```
level_k(v) - level_k(v_ref) = 8.686 * kappa(note) * (f_k / 1 kHz) * ln(v / v_ref)       kappa = 1.5 * 2^(-(note - 60) / 32)
i.e.   amplitude_k  ~  (v / v_ref) ^ (kappa * f_k / 1 kHz)
```

Each partial's amplitude follows a power of the strike speed whose exponent grows with the partial's frequency, limited to +30 / -60 dB.
The two constants (1.5 and a halving distance of 32 semitones) are fitted to the University of Iowa recordings with
`tools/velocity_law_check.py`: the instrument is reduced to its mezzo layer, played at the soft and loud velocities, and the share of
its energy above 1, 2 and 4 kHz is compared with the real soft and loud notes (171 note/velocity pairs). The optimum is broad (k 1.3 to
1.7, halving distance 28 to 36 semitones) and the same on even and odd keys. The remaining error is large: 8.4 dB rms, against
10.7 dB with no velocity-dependent tilt and 8.8 dB with the constants used before (1 and 48, which were fitted on a modelled piano and
can be selected with the `velK` and `velHalve` parameters). Soft notes are the worst (10.7 dB, against 6.0 dB for loud ones): a real
pp is darker than any straight tilt gives. Inside the measured velocity range the three recorded layers carry the real behaviour, and
this law only extrapolates beyond them. It is an empirical fit, not a derivation from the hammer model. Hardness `H` acts as a velocity
warp, `v -> v H^1.7` (contact-time reasoning gives exponent 2; 1.7 was chosen to keep the strength of the earlier control), and keeps
its own kappa with the earlier halving distance of 48 semitones so that the slider's strength does not depend on the fit above.

## 5 Hammer knock, body and air

Three noise components are added at each strike, following the idea in spectral modelling synthesis (Serra and Smith) of a
deterministic sinusoidal part plus a stochastic part.

- **Knock:** a short band-passed noise burst (3 to 9 ms), centre frequency rising with strike speed and hardness.
- **Body thump:** a decaying low resonance (about 100 Hz for a grand, 150 Hz for an upright) rung by every strike whatever the
  pitch, at a level tied to the note's loudness. Its frequency, level and decay are measured from the recording's low-passed
  attack and stored in the instrument's `body` block.
- **Air:** faint broadband hiss above about 3 kHz (`air` block).

The slider maps 1:1 up to its default of 0.8 and grows with the square above it, because uncorrelated noise added under a hard
strike's own high partials was inaudible with a linear law (measured: less than 0.2 dB change in the 2 to 8 kHz band at velocity 80
and up, even at the maximum).

Instruments without a real soundboard in their data can carry a bank of damped modes that stands in for it (`soundboard.amount`).
Real soundboards are well described by their mechanical impedance, measured by Giordano; Conklin's *Part II* covers the structure.
The bank is a plausible stand-in, not a fit to those measurements.

## 6 The quadratic effect

At high amplitude a string's tension changes, which makes longitudinal vibration and *phantom partials* at sums of transverse
partial frequencies (Bank and Sujbert). The engine adds components at `2 f_k` for the first six partials, with an amplitude that
grows with `v^2` and with hardness (the *Overtone doubling* control). Only the doubled frequencies are modelled, not the full
set of sums `f_i + f_j` or the free longitudinal modes; the level law is ours.

## 7 Pedals and sympathetic resonance

Undamped strings vibrate when other notes sound. Lehtonen, Penttinen, Rauhala and Välimäki analysed and modelled the sustain
pedal: it lengthens the decay of mid-range partials and adds a resonance from all strings. The engine does it by events, not by
simulating every string. When a note starts, each undamped key (every key while the sustain pedal is down, the top octave always)
is scored by how closely its partials coincide with the struck note's: a struck partial `k` drives string partial `y` with weight
`exp(-(c / 14)^2)`, where `c` is their distance in cents, times the struck partial's amplitude. The ten best-scoring keys get a
resonance voice of 16 partials that decays 1.15 times more slowly than that string's own note (these voices count against the
polyphony). Four pedals are modelled: sustain (with half-pedal), sostenuto, una corda and the harmonic pedal. The Gaussian
coincidence rule and its width are our design, not taken from the paper.

## 8 Cabinet resonance and room

The global (harp and cabinet) resonance is an eight-line feedback delay network of the kind Jot and Chaigne described: delay
lines of 3.1, 4.37, 5.93, 7.71, 11.3, 13.7, 17.9 and 23.3 ms (mutually incommensurate), a Householder feedback matrix
`A = I - (2/8) 1 1^T` (energy preserving), per-line gains `g_i = 10^(-3 L_i / (T60 f_s))` that give every line the same decay time
`T60`, and a one-pole low-pass in each loop for frequency-dependent loss. `T60` moves from 0.25 s towards 3.45 s as the sustain (or harmonic) pedal
lifts the dampers, and the *Cabinet resonance* control scales the return. It is used for a short, coloured body resonance, not for a room.
The room is a convolution with a generated impulse response (`ConvolverNode`); the lid acts as a gain and low-pass and the microphone
perspective as low and high shelves. The impulse responses are synthetic, not measured.

## 9 Measuring an instrument

`tools/analyze_instrument.py` and `js/analyzer.js` (the same algorithm) find the onset, use the silence before it as the noise
floor, detect the key release, fit `f_0` and `B` from the partial peaks, demodulate each partial into an energy envelope, and fit the
two-stage decay of section 3 by a grid search with local refinement. `tools/calibrate_to_recordings.py` then renders every key through
the engine and corrects decay scales, levels and detunes until the rendered envelope matches the recording (analysis by
synthesis). This procedure is ours; the measurements it makes are the ones the papers above describe. The tests check it against
a synthetic tone with known truth (levels within 3 dB, slow decay times within 15%).

## 10 Instrument variations

A variation takes the measured table and moves its numbers: smooth random curves across the keyboard for brightness, sustain,
level and inharmonicity, plus independent noise on every partial (see [GENERATOR.md](GENERATOR.md)). Changing `B` shifts the
partial ratios by the same factor as section 1, so the frequencies stay consistent. The spreads are hand-chosen, not fitted.

## 11 The sound pad

The pad blends continuous settings between four stored sounds around a neutral centre. With weights `w_i` (a pole's weight is the
projection of the puck on its direction; neighbouring poles share it) and a radial gain `g` (1 up to 74% of the radius, rising to
1.35 at the rim), a setting `x` becomes

```
x = x_c + g * sum_i w_i * (x_i - x_c)                (linear sliders)
ln x = ln x_c + g * sum_i w_i * (ln x_i - ln x_c)    (logarithmic sliders: a geometric mean, so 0.5 and 2 meet at 1)
```

clamped to each slider's range. This is ordinary interpolation, close to the "vector synthesis" of the 1980s; there is nothing
acoustical in it.

## References

Each entry was checked against the publisher's or an archive's page.

1. H. Fletcher, "Normal vibration frequencies of a stiff piano string," *J. Acoust. Soc. Am.* **36**(1), 203-209 (1964). <https://pubs.aip.org/asa/jasa/article/36/1/203/621081/Normal-Vibration-Frequencies-of-a-Stiff-Piano>
2. G. Weinreich, "Coupled piano strings," *J. Acoust. Soc. Am.* **62**(6), 1474-1484 (1977). doi:10.1121/1.381677
3. J. Woodhouse, "A necessary condition for double-decay envelopes in stringed instruments," *J. Acoust. Soc. Am.* **150**(6), 4375-4384 (2021). <https://pubs.aip.org/asa/jasa/article/150/6/4375/994397/A-necessary-condition-for-double-decay-envelopes>
4. D. E. Hall and A. Askenfelt, "Piano string excitation V: Spectra for real hammers and strings," *J. Acoust. Soc. Am.* **83**(4), 1627-1638 (1988). doi:10.1121/1.395917
5. A. Chaigne and A. Askenfelt, "Numerical simulations of piano strings. I. A physical model for a struck string using finite difference methods," *J. Acoust. Soc. Am.* **95**(2), 1112-1118 (1994). doi:10.1121/1.408459 (Part II, comparisons with measurements: **95**(3), 1631.)
6. A. Askenfelt and E. V. Jansson, "From touch to string vibrations. III: String motion and spectra," *J. Acoust. Soc. Am.* **93**(4), 2181-2196 (1993). doi:10.1121/1.406680
7. N. Giordano and J. P. Winans II, "Piano hammers and their force compression characteristics: Does a power law make sense?," *J. Acoust. Soc. Am.* **107**(4), 2248-2255 (2000). <https://pubs.aip.org/asa/jasa/article/107/4/2248/555444/Piano-hammers-and-their-force-compression>
8. H. A. Conklin Jr., "Design and tone in the mechanoacoustic piano. Part I: Piano hammers and tonal effects," *J. Acoust. Soc. Am.* **99**(6), 3286-3296 (1996); "Part II: Piano structure," **100**(2), 695-708 (1996); "Part III: Piano strings and scale design," **100**(3), 1286-1298 (1996). doi:10.1121/1.416017 (Part III)
9. N. Giordano, "Mechanical impedance of a piano soundboard," *J. Acoust. Soc. Am.* **103**(4), 2128-2133 (1998). doi:10.1121/1.421358
10. B. Bank and L. Sujbert, "Generation of longitudinal vibrations in piano strings: From physics to sound synthesis," *J. Acoust. Soc. Am.* **117**(4), 2268-2278 (2005). <https://pubs.aip.org/asa/jasa/article/117/4/2268/541382/Generation-of-longitudinal-vibrations-in-piano>
11. B. Bank, S. Zambon and F. Fontana, "A modal-based real-time piano synthesizer," *IEEE Trans. Audio, Speech, Lang. Process.* **18**(4), 809-821 (2010). <https://home.mit.bme.hu/~bank/publist/taslp-piano/index.html>
12. H.-M. Lehtonen, H. Penttinen, J. Rauhala and V. Välimäki, "Analysis and modeling of piano sustain-pedal effects," *J. Acoust. Soc. Am.* **122**(3), 1787-1797 (2007). doi:10.1121/1.2756172
13. J.-M. Jot and A. Chaigne, "Digital delay networks for designing artificial reverberators," Audio Engineering Society 90th Convention, Paris, preprint 3030 (1991). <https://aes2.org/publications/elibrary-page/?id=5663>
14. X. Serra and J. O. Smith III, "Spectral modeling synthesis: A sound analysis/synthesis system based on a deterministic plus stochastic decomposition," *Computer Music J.* **14**(4), 12-24 (1990).
15. J. O. Smith III, *Spectral Audio Signal Processing*, W3K Publishing (2011), online edition: <https://www.dsprelated.com/freebooks/sasp/>
16. O. L. Railsback, "Scale temperament as applied to piano tuning," *J. Acoust. Soc. Am.* **9**(3, suppl.), 274 (1938). doi:10.1121/1.1902056
17. N. H. Fletcher and T. D. Rossing, *The Physics of Musical Instruments*, 2nd ed., Springer (1998). A general textbook for the mode ratios of bars, bells and tubes in section 10; not checked page by page here.
