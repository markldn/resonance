# Resonance instrument format — `resonance-instrument/1`

An instrument is a JSON file describing how each measured key of a real instrument sounds, as a
set of partials (overtones) with their levels and two-stage decays, at one or more velocities.
The engine interpolates between measured keys and between velocity layers, and all the
sound-design parameters (hardness, unison, impedance, cut-off, Q, size…) act on top of it.

You don't need to measure every key. Every 2–4 semitones is enough. Measure more densely where
the instrument changes character: the bass/tenor string break, and the top octave.

```jsonc
{
  "format": "resonance-instrument/1",
  "name": "My upright",
  "author": "you",
  "license": "CC-BY-4.0",
  "source": "how it was recorded (mic, room, distance)",
  "a4_hz": 440.0,
  "keys": [
    {
      "note": 60,                    // MIDI note (60 = C4)
      "f0_hz": 261.8,                // measured frequency of partial 1 (optional)
      "B": 0.00031,                  // measured inharmonicity: f_n = n·f0·sqrt(1 + B·n²) (optional)
      "strings": 3,                  // optional; default by register (1 / 2 / 3)
      "detune_cents": [0, 0.15, 0.4],// optional; unison detune per string
      "level_db": 0.0,               // optional loudness trim for this key
      "layers": [
        {
          "velocity": 64,            // MIDI velocity this layer was recorded at
          "gain_db": -6.5,           // optional: loudness of this layer relative to the key's loudest layer
          "partials": [
            // [ratio, level_dB, t60_direct_s, t60_remanent_s, remanent_dB]
            [1, 0.0, 6.2, 18.5, -14.0],
            [2, -4.1, 4.9, 15.0, -16.5]
          ]
        }
      ]
    }
  ]
}
```

The example uses `//` comments for explanation, so it is JSONC. Remove them before saving a real file, because
the importer expects plain JSON.

What each partial field means:

| field | meaning |
|---|---|
| `ratio` | frequency ÷ f0. Leave 1, 2, 3 … for strings; the engine applies `B` (or the "String length" setting) to stretch them. Use measured non-integer ratios for bars, bells and tines. |
| `level_dB` | level at the start of the sound, relative to the loudest partial of this layer (0 dB) |
| `t60_direct_s` | time for the fast first ("direct") part of the decay to fall 60 dB |
| `t60_remanent_s` | time for the slow tail ("remanent") to fall 60 dB |
| `remanent_dB` | level of the slow tail relative to the partial's start level. Use `-120` for a single-stage decay. |

Rules the engine applies:
- Optional top-level `"body": {"hz": 110, "level_db": -21, "t60": 1.1}`: the case / soundboard resonance that every
  hammer strike rings, whatever the pitch (grand about 100 Hz, upright about 150 Hz). `level_db` is relative to the
  note's own loudness (default -20), `t60` is its decay in seconds. Measure it from the low-passed (< 250 Hz) attack
  of treble notes, where no string partial lives. The *Hammer thump* control scales it. Without `body` there is none.
- Optional `"air": {"level_db": -47, "t60": 1.5}`: the faint broadband hiss (felt, strings, room) above about 3 kHz that
  real notes carry; `level_db` is relative to the note's own loudness. Measure it as the 4–12 kHz band energy of the
  first half second that the partials do not explain. Scaled by the *Hammer thump* control.
- Optional `"soundboard": {"amount": 0.6}`: for instruments that do NOT already contain their soundboard (a variation inherits
  whatever its base has): a bank of broad damped modes colours the strings by a few dB. Instruments measured from a real piano leave it
  out, because their partial levels already include the soundboard. Scaled by the *Board modes* control.
- Optional `"engine": {...}`: switches for behaviour that belongs to a piano. Absent = a piano (every default below). All keys optional:

  | key | meaning | piano default |
  |---|---|---|
  | `anchor` | ratio (in the table's own ratio units, after the lowest partial is 1) of the partial that sits exactly on the key's pitch. A bell writes its hum as partial 1 and its strike note as `anchor: 2`. | 1 |
  | `attack_s` | 10-90 % rise time in seconds (a pad 0.45, an organ 0.006). Absent = the hammer contact time. | hammer |
  | `release_s` | time constant of the damper when a key is released, seconds. Absent = the piano's (0.05 s treble, 0.4 s bass). | piano |
  | `dampers` | `"all"` = every key releases (a piano has none above key 88). | above 88 undamped |
  | `knock` | scale of the hammer knock, body and air noise (0 = none). | 1 |
  | `click` | `{amp, fc, q, tau}`: a short filtered noise burst at every strike (organ key click, mallet tick), scaled by the Hammer thump slider. | none |
  | `quadratic` | scale of the 2f components on hard strokes. | 1 |
  | `sympathetic` | `false` = strings do not ring each other. | true |
  | `key_noise` | `false` = no key and damper noises. | true |
  | `cabinet` | scale of the harp / cabinet resonance (0 = the slider has no effect). | 1 |
  | `stretch` | scale of the tuning stretch (0 = exact equal temperament whatever the slider says). | 1 |
  | `fixed` | `true` = the table's partial "ratios" are frequencies in Hz (a drum kit), not multiples of the key's pitch. | false |
  | `oneshot` | `true` = a struck voice rings out whatever the key does (a `choke` group can cut it). | false |
  | `synth` | the synth-voice block below, for every key. | none |
  | `rotary` | `{crossover_hz, mics_deg, horn: {slow_hz, fast_hz, depth_ms, amp, accel}, drum: {...}}`: a rotary speaker. The Rotary speed slider goes from slow to fast; `accel` is the rotor's inertia in Hz per second. Modulation scales it. | none |
  | `tremolo` | `{hz, depth, pan}`: both channels follow a sine of that depth (0-1); the right one is `pan` half-turns later (0 together, 1 opposite: an auto-pan, 0.5 a quarter turn: a rotating speaker). Scaled by the Modulation slider. | none |

  **The synth block** (`engine.synth`, or `synth` on one key, which replaces the engine's for that key) does what a table of decaying
  sines cannot: things that change during a note. All of it is done at block rate on the voice:

  | key | meaning |
  |---|---|
  | `vibrato` | `{hz, cents, delay_s, rise_s, jitter}`: pitch modulation, starting after `delay_s` and reaching full depth over `rise_s`; `jitter` adds a slow wander. Scaled by the Modulation slider. |
  | `glide` | `{time_s, legato, max_semitones}`: the note starts at the previous note's pitch and slides in (90 % in `time_s`); `legato` only while another key is held. |
  | `pitch_env` | `{cents, tau_s}`: the note starts `cents` away and settles with that time constant (a kick's pitch drop). |
  | `filter` | `{type: lp\|hp\|bp, poles: 2\|4, q, cutoff_hz, key_track, vel_oct, env: {oct, attack_s, decay_s, sustain, release_s}, lfo: {hz, oct}}`: a resonant filter on the partials, cutoff = `cutoff_hz` x 2^(key_track x (note-60)/12 + vel_oct x (velocity-0.5) + env + lfo). For stationary sines a filter is a gain per partial, applied every block. |
  | `noise` | a list of `{type: band, kind: bp\|lp\|hp, fc, q, poles, key_track, fc_env: {oct, tau_s}, follow}` (filtered noise) or `{type: bank, q, max_partials}` (noise through a resonator at each partial: breath, bow), each with `level_db` (RMS relative to the note's own tone), `attack_s`, `decay_s` (T60), `sustain`, `delay_s`. |
  | `mono` | one voice at a time (a new key fades the others in 30 ms). |
  | `choke` | a group number: a struck key stops every other sounding key of the same group. |

  Beating comes from `strings` (up to 3) and `detune_cents` per key: the engine keeps the median string exactly on pitch, and the
  String spread slider scales the detune. Give a detuned instrument every semitone as a key, because beat notches belong to one key.

- Keys are sorted by `note`. Between measured keys, partial `k` is interpolated linearly:
  levels in dB, and T60s in log.
- Layers are interpolated in velocity the same way. Below the lowest layer, the lowest layer is used
  and the velocity law is applied; the same holds above the highest. The law scales each partial's amplitude as
  `(v / v_edge)^(kappa * f / 1 kHz)`, where `v_edge` is the velocity of the nearest layer, `f` is the partial's frequency
  and `kappa = 2^(-(note - 60) / 48)`. A harder blow therefore brightens the sound, and more so for high partials. The
  correction is limited to +30 dB / -60 dB. The *Felt* controls use the same law: a hardness `H` acts like a blow
  `H^1.7` times as fast. This is why two or three layers spread over the velocity range are enough.
- Missing optional fields fall back to register-based defaults.

Validation: the file must have `format` set to exactly `resonance-instrument/1`, at least one key,
and at least one layer per key with at least one partial. Everything else is optional.
