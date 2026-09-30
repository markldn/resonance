// Parameter surface: tuning, voicing, design, output, reverb and options, with default MIDI CC numbers.

import { SYNTH_LIST } from './synth.js';

export const TEMPERAMENTS = [
  ['equal', 'Equal'], ['zarlino', 'Zarlino'], ['pythagore', 'Pythagore'], ['mesotonic', 'Mesotonic'],
  ['welltempered', 'Well-tempered'], ['werckmeister', 'Werckmeister III'], ['flat', 'Flat'],
];

const f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);

// kind: 'range' (slider) unless noted. cc = default MIDI controller assignment.
export const PARAMS = [
  // Tuning
  { id: 'stretch', group: 'tuning', label: 'Tuning stretch', min: 0, max: 3, def: 1, cc: 103, fmt: f2, help: 'Railsback stretch — treble sharp, bass flat. 1 = a tuned concert grand (default: A0 12 cents flat, C8 40 cents sharp, middle exact); 0 = exact equal temperament; above 1 the stretch grows across the whole keyboard (3 = about ±24 cents at the ends of a 4-octave span).' },
  { id: 'unison', group: 'tuning', label: 'String spread', min: 0, max: 5, def: 1, cc: 102, fmt: f2, help: 'Detune between the strings of each unison. Right = honky-tonk; far left = sterile.' },
  { id: 'direct', group: 'tuning', label: 'Initial ring time', min: 0.25, max: 4, def: 1, log: true, cc: 104, fmt: f2, help: 'Length of the fast "direct" decay before the slow "remanent" sound takes over.' },
  { id: 'diapason', group: 'tuning', label: 'Concert pitch', min: 415, max: 466, def: 440, unit: 'Hz', fmt: f1, help: 'Frequency of A4. 415 Hz = baroque pitch, 466 Hz = +½ tone.' },
  // Voicing
  { id: 'character', group: 'voicing', label: 'Irregularity', min: 0, max: 3, def: 0.7, cc: 109, fmt: f2, help: 'Irregularity of the overtone intensities from note to note.' },
  { id: 'hardF', group: 'voicing', label: 'Felt · loud playing', min: 0, max: 2, def: 1.15, cc: 107, fmt: f2, help: 'Hammer felt hardness around velocity 96.' },
  { id: 'hardM', group: 'voicing', label: 'Felt · medium playing', min: 0, max: 2, def: 1, cc: 106, fmt: f2, help: 'Hammer felt hardness around velocity 64.' },
  { id: 'hardP', group: 'voicing', label: 'Felt · soft playing', min: 0, max: 2, def: 0.85, cc: 105, fmt: f2, help: 'Hammer felt hardness around velocity 32.' },
  { id: 'hammerNoise', group: 'voicing', label: 'Hammer thump', min: 0, max: 3, def: 0.8, cc: 108, fmt: f2, help: 'Weight of the percussive knock of hammer on string. Up to 0.8 it fades the measured knock; above 0.8 it grows quickly (the maximum is 23 dB over the default).' },
  { id: 'softSmooth', group: 'voicing', label: 'Una corda smoothing', min: 0, max: 1, def: 0.5, cc: 110, fmt: f2, help: 'How much the una corda pedal smooths the tone.' },
  // Design
  { id: 'size', group: 'design', label: 'String length', min: 0.5, max: 10, def: 2.7, log: true, cc: 114, unit: 'm', fmt: f2, help: 'String length → inharmonicity. Small = bell-like, 10 m = almost harmonic.' },
  { id: 'globalRes', group: 'design', label: 'Cabinet resonance', min: 0, max: 3, def: 1, cc: 115, fmt: f2, help: 'Harp + cabinet resonance of the whole instrument.' },
  { id: 'sympRes', group: 'design', label: 'String coupling', min: 0, max: 3, def: 1, cc: 116, fmt: f2, help: 'Strings resonating with each other. Silently hold keys (right-click) and play staccato to hear it.' },
  { id: 'sbRes', group: 'design', label: 'Board modes', min: 0, max: 3, def: 1, fmt: f2, help: 'Resonant modes of the soundboard, for instruments that do not already contain theirs (generated ones).' },
  { id: 'modulation', group: 'design', label: 'Modulation', min: 0, max: 2, def: 1, fmt: f2, help: 'Depth of the tremolo / auto-pan built into synth sounds (electric piano, organ, vibraphone). 0 = off. Pianos have none.' },
  { id: 'rotary', group: 'design', label: 'Rotary speed', min: 0, max: 1, def: 0, fmt: f2, help: 'Speed of the rotary speaker (organ): 0 = slow chorale, 1 = fast tremolo. The horn takes about a second to change speed, the drum several. Modulation scales the effect.' },
  { id: 'quadratic', group: 'design', label: 'Overtone doubling', min: 0, max: 3, def: 1, cc: 117, fmt: f2, help: 'Non-linear 2× frequency components on hard strokes.' },
  { id: 'impedance', group: 'design', label: 'Board loading', min: 0.25, max: 4, def: 1, log: true, cc: 111, fmt: f2, help: 'Soundboard mechanical impedance. Higher = longer sound.' },
  { id: 'sbCutoff', group: 'design', label: 'High-ring cut-off', min: 0, max: 1, def: 0.5, cc: 112, fmt: v => (1000 * Math.pow(12, v) / 1000).toFixed(1) + ' kHz', help: 'Frequency above which overtones decay faster. Higher = more long overtones.' },
  { id: 'sbQ', group: 'design', label: 'High-ring slope', min: 0, max: 1, def: 0.5, cc: 113, fmt: f2, help: 'Slope above the cut-off. Higher = high overtones die sooner.' },
  // Output
  { id: 'volume', group: 'output', label: 'Volume', min: -30, max: 10, def: 0, cc: 7, unit: 'dB', fmt: f1 },
  { id: 'dynamics', group: 'output', label: 'Dynamics', min: 12, max: 60, def: 30, unit: 'dB', fmt: v => v.toFixed(0), help: 'Loudness range between pianissimo and fortissimo.' },
  { id: 'width', group: 'output', label: 'Stereo width', min: 0, max: 2, def: 1, cc: 10, fmt: f2 },
  { id: 'polyphony', group: 'output', label: 'Polyphony', min: 16, max: 256, def: 128, step: 1, fmt: v => v.toFixed(0), help: 'Voices, including sympathetic resonances.' },
  // Reverb
  { id: 'wet', group: 'reverb', label: 'Wet / dry', min: 0, max: 1, def: 0.28, fmt: v => Math.round(v * 100) + '%' },
  { id: 'duration', group: 'reverb', label: 'Short / long', min: 0.3, max: 6, def: 1.9, log: true, unit: 's', fmt: f1 },
  { id: 'roomSize', group: 'reverb', label: 'Small / large', min: 0, max: 1, def: 0.55, fmt: f2 },
  // Options
  { id: 'bendRange', group: 'options', label: 'Pitch-bend range', min: 0, max: 12, def: 2, step: 1, unit: 'st', fmt: v => v.toFixed(0), help: 'Semitones moved by a full pitch-wheel deflection.' },
  { id: 'keyNoise', group: 'options', label: 'Key release noise', min: 0, max: 1, def: 0.2, fmt: f2 },
  { id: 'whoosh', group: 'options', label: 'Pedal noise', min: 0, max: 1, def: 0.4, fmt: f2 },
];

// Instrument models: measured instruments shipped with the app (data/measured, built with
// tools/analyze_instrument.py from freely licensed recordings), user imports (added at runtime),
// No third-party instrument tables are shipped.
export const BUILTIN_MODELS = [
  ['builtin:iowa_grand', 'Iowa Grand · measured (UIowa MIS)'],
  ['builtin:salamander_grand', 'Salamander Grand · measured (Yamaha C5, CC BY)'],
  ...SYNTH_LIST.map(([id, label]) => ['synth:' + id, label]),      // built from physics, see js/synth.js
];
export const MODELS = BUILTIN_MODELS;

export const ENUMS = {
  model: { def: 'builtin:iowa_grand', options: MODELS },
  temperament: { def: 'equal', options: TEMPERAMENTS },
  mode: { def: 'stereo', options: [['stereo', 'Stereo'], ['mono', 'Mono'], ['headphones', 'Phones']] },
  voices: { def: 'instrument', options: [['instrument', 'Instrument'], ['poly', 'Chords'], ['mono', 'One note']] },
  lid: { def: 'open', options: [['closed', 'Closed'], ['semi', 'Semi'], ['open', 'Open']] },
  perspective: { def: 'orchestra', options: [['player', 'Player'], ['orchestra', 'Orchestra'], ['audience', 'Audience']] },
  room: { def: 'hall', options: [['studio', 'Studio'], ['chamber', 'Chamber'], ['hall', 'Concert hall'], ['club', 'Jazz club'], ['church', 'Church']] },
};
export const BOOLS = { reverbOn: true, damperNoise: true, fullSympa: true };
export const ROOMS = {
  studio: { duration: 0.7, roomSize: 0.2, wet: 0.16 },
  chamber: { duration: 1.3, roomSize: 0.4, wet: 0.24 },
  hall: { duration: 2.2, roomSize: 0.7, wet: 0.3 },
  club: { duration: 0.9, roomSize: 0.3, wet: 0.2 },
  church: { duration: 5.2, roomSize: 1, wet: 0.45 },
};
// CC 118 = reverb on/off
export const CC_BOOL = { 118: 'reverbOn' };

export const VEL_PRESETS = {
  Linear: [[0, 0], [1, 1]],
  Soft: [[0, 0], [0.35, 0.55], [1, 1]],
  Hard: [[0, 0], [0.6, 0.4], [1, 1]],
  'Light touch': [[0, 0.08], [0.3, 0.5], [0.7, 0.85], [1, 1]],
  Compressed: [[0, 0.3], [1, 0.85]],
};
export const EQ_DEFAULT = [[40, 0], [200, 0], [1000, 0], [5000, 0], [16000, 0]];

export function defaults() {
  const p = {};
  for (const d of PARAMS) p[d.id] = d.def;
  for (const [k, e] of Object.entries(ENUMS)) p[k] = e.def;
  Object.assign(p, BOOLS);
  p.profile = [0, 0, 0, 0, 0, 0, 0, 0];
  p.eq = EQ_DEFAULT.map(a => a.slice());
  p.vel = VEL_PRESETS.Linear.map(a => a.slice());
  return p;
}

// Factory presets — overrides over defaults(). Group = menu section.
export const PRESETS = [
  { name: 'Concert Grand', group: 'Grands', p: { model: 'builtin:iowa_grand',} },
  { name: 'Concert Grand · close', group: 'Grands', p: { model: 'builtin:iowa_grand', perspective: 'player', wet: 0.16, hammerNoise: 1.4, width: 1.3 } },
  { name: 'Baroque · Werckmeister III', group: 'Historic', p: { model: 'builtin:iowa_grand', temperament: 'werckmeister', diapason: 415, hardP: 0.7, hardM: 0.85, hardF: 1, size: 2.2, room: 'chamber', duration: 1.6, wet: 0.3 } },
  { name: 'Meantone Chapel', group: 'Historic', p: { model: 'builtin:iowa_grand', temperament: 'mesotonic', diapason: 430, room: 'church', duration: 4.5, wet: 0.42, roomSize: 0.9, hardM: 0.8 } },
  { name: 'Pure Just (Zarlino)', group: 'Historic', p: { model: 'builtin:iowa_grand', temperament: 'zarlino', stretch: 0.3, unison: 0.5 } },
  { name: 'Cathedral Grand', group: 'Spaces', p: { model: 'builtin:iowa_grand', room: 'church', duration: 5.5, wet: 0.5, roomSize: 1, perspective: 'audience', impedance: 1.3 } },
  { name: 'Dry Studio', group: 'Spaces', p: { model: 'builtin:iowa_grand', reverbOn: false, perspective: 'player', hammerNoise: 1.2 } },
];
// Sounds for the sound pad (js/pad.js): continuous settings only, so the pad can blend them while you play. The first four are the
// default poles and sit close to the ends of the sliders; the older ones are milder and can be chosen from the pole menus.
export const VOICINGS = [
  { name: 'Glass', p: { model: 'builtin:iowa_grand', hardP: 1.7, hardM: 1.95, hardF: 2, sbCutoff: 1, sbQ: 0.8, character: 2.4, hammerNoise: 2.4, impedance: 0.4, direct: 0.5, unison: 0.6, quadratic: 2.2, profile: [4, 3, 4, 3, 2, 2, 0, 0], duration: 0.5, roomSize: 0.15, wet: 0.1 } },
  { name: 'Velvet', p: { model: 'builtin:iowa_grand', hardP: 0.15, hardM: 0.25, hardF: 0.45, sbCutoff: 0.12, sbQ: 0.3, character: 0.15, hammerNoise: 0.2, impedance: 1.8, direct: 1.6, quadratic: 0.3, profile: [3, 0, -2, -4, -6, -6, -6, -6], duration: 2.2, roomSize: 0.5, wet: 0.3 } },
  { name: 'Cathedral Bloom', p: { model: 'builtin:iowa_grand', size: 8, globalRes: 2.8, sympRes: 3, sbRes: 2.5, impedance: 2.6, direct: 3, hardM: 0.7, width: 1.6, duration: 6, roomSize: 1, wet: 0.75 } },
  { name: 'Tack Upright', p: { model: 'builtin:iowa_grand', size: 0.6, unison: 4.5, stretch: 2.2, character: 2.6, impedance: 0.35, sbCutoff: 0.2, sbQ: 0.9, direct: 0.4, hardM: 1.5, hardF: 1.8, hammerNoise: 2.6, quadratic: 2.5, profile: [2, -3, 3, -4, 4, -3, 0, 0], duration: 0.4, roomSize: 0.1, wet: 0.06 } },
  { name: 'Bright Pop Grand', p: { model: 'builtin:iowa_grand', hardP: 1.15, hardM: 1.35, hardF: 1.55, sbCutoff: 0.66, profile: [0, 1, 2, 1, 0, 0, -2, 0], room: 'studio', duration: 0.8, wet: 0.17, roomSize: 0.25 } },
  { name: 'Mellow Jazz Grand', p: { model: 'builtin:iowa_grand', hardP: 0.55, hardM: 0.72, hardF: 0.9, sbCutoff: 0.38, character: 0.5, room: 'club', duration: 0.9, wet: 0.2, roomSize: 0.3, lid: 'semi' } },
  { name: 'Romantic Grand', p: { model: 'builtin:iowa_grand', impedance: 1.5, direct: 1.4, sympRes: 1.6, globalRes: 1.4, size: 3, hardM: 0.9, room: 'hall', duration: 2.6, wet: 0.34 } },
  { name: 'Vintage Upright', p: { model: 'builtin:iowa_grand', size: 1.3, unison: 1.7, character: 1.5, impedance: 0.7, sbCutoff: 0.33, sbQ: 0.6, lid: 'closed', room: 'chamber', duration: 1, wet: 0.2, roomSize: 0.3, hammerNoise: 1.5, globalRes: 1.5 } },
  { name: 'Honky-Tonk', p: { model: 'builtin:iowa_grand', size: 1.4, unison: 4.2, direct: 1.6, character: 1.6, hardM: 1.25, hardF: 1.45, impedance: 0.8, room: 'club', wet: 0.18, duration: 0.8, hammerNoise: 1.6 } },
  { name: 'Electro-acoustic', p: { model: 'builtin:iowa_grand', size: 1.1, unison: 2, impedance: 0.45, sbCutoff: 0.28, sbQ: 0.85, direct: 0.6, hardP: 1.2, hardM: 1.4, hardF: 1.7, profile: [3, -2, 3, 0, 0, 0, 0, 0], hammerNoise: 1.8, globalRes: 0.4, sympRes: 0.4, room: 'studio', wet: 0.15, duration: 0.7 } },
];


export const RANDOM_GROUPS = ['tuning', 'voicing', 'design'];
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const noteName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
