// resonance-instrument/1 -> per-note tables the engine plays (see docs/INSTRUMENT_FORMAT.md).
// Interpolation: between measured keys and between velocity layers, partial by partial
// (by order of ratio): level and remanent in dB, ratio linear, T60s in log.

export const FORMAT = 'resonance-instrument/1';

export function validate(doc) {
  const err = m => { throw new Error(m); };
  if (!doc || doc.format !== FORMAT) err(`not a ${FORMAT} file (format field)`);
  if (!Array.isArray(doc.keys) || !doc.keys.length) err('no keys');
  for (const k of doc.keys) {
    if (!(k.note >= 0 && k.note <= 127)) err('key without a valid note');
    if (!Array.isArray(k.layers) || !k.layers.length) err(`key ${k.note}: no layers`);
    for (const l of k.layers) if (!Array.isArray(l.partials) || !l.partials.length) err(`key ${k.note}: layer without partials`);
  }
  return true;
}

const PMAX = 100;
function layerArrays(l) {
  const ps = [...l.partials].sort((a, b) => a[0] - b[0]).slice(0, PMAX);
  return {
    v: l.velocity ?? 64, g: l.gain_db ?? 0,
    r: ps.map(p => p[0]), l: ps.map(p => p[1]),
    td: ps.map(p => Math.max(0.01, p[2])), tr: ps.map(p => Math.max(0.01, p[3] ?? p[2])), rm: ps.map(p => p[4] ?? -120),
  };
}
function mixLayer(a, b, t) {
  if (!b || t <= 0) return a; if (t >= 1) return b;
  const n = Math.max(a.r.length, b.r.length), o = { v: a.v + t * (b.v - a.v), g: a.g + t * (b.g - a.g), r: [], l: [], td: [], tr: [], rm: [] };
  for (let i = 0; i < n; i++) {
    const A = i < a.r.length, B = i < b.r.length;
    const ra = A ? a.r[i] : b.r[i], rb = B ? b.r[i] : a.r[i];
    const la = A ? a.l[i] : -90, lb = B ? b.l[i] : -90;
    o.r.push(ra + t * (rb - ra)); o.l.push(la + t * (lb - la));
    const tda = A ? a.td[i] : b.td[i], tdb = B ? b.td[i] : a.td[i];
    const tra = A ? a.tr[i] : b.tr[i], trb = B ? b.tr[i] : a.tr[i];
    o.td.push(Math.exp(Math.log(tda) + t * (Math.log(tdb) - Math.log(tda))));
    o.tr.push(Math.exp(Math.log(tra) + t * (Math.log(trb) - Math.log(tra))));
    const rma = A ? a.rm[i] : b.rm[i], rmb = B ? b.rm[i] : a.rm[i];
    o.rm.push(rma + t * (rmb - rma));
  }
  return o;
}
function atVelocity(layers, v) {
  if (v <= layers[0].v) return { ...layers[0], v };
  const last = layers[layers.length - 1];
  if (v >= last.v) return { ...last, v };
  let i = 0; while (layers[i + 1].v < v) i++;
  const a = layers[i], b = layers[i + 1];
  return mixLayer(a, b, (v - a.v) / (b.v - a.v));
}
const defStrings = m => (m < 31 ? 1 : m < 42 ? 2 : 3);
const defDetune = m => (m < 31 ? [0] : m < 42 ? [0, 0.2] : [0, 0.12, 0.42]);

export function compile(doc) {
  validate(doc);
  const keys = [...doc.keys].sort((a, b) => a.note - b.note).map(k => ({
    note: k.note, B: k.B ?? null, lv: k.level_db ?? 0, s: k.strings ?? null, dt: k.detune_cents ?? null, sy: k.synth ?? null,
    layers: k.layers.map(layerArrays).sort((a, b) => a.v - b.v),
  }));
  const V = [...new Set(keys.flatMap(k => k.layers.map(l => l.v)))].sort((a, b) => a - b);
  for (const k of keys) k.canon = V.map(v => atVelocity(k.layers, v));
  const notes = {};
  for (let m = 21; m <= 108; m++) {
    let i = 0; while (i < keys.length - 1 && keys[i + 1].note <= m) i++;
    const k0 = keys[i], k1 = keys[Math.min(i + 1, keys.length - 1)];
    const t = k1.note > k0.note ? Math.min(1, Math.max(0, (m - k0.note) / (k1.note - k0.note))) : 0;
    const near = t < 0.5 ? k0 : k1;
    const B0 = k0.B ?? 3e-4, B1 = k1.B ?? 3e-4;
    notes[m] = {
      sy: m === near.note ? near.sy : null,          // synth block of one key (drums, per-key noise): only for exact keys
      s: near.s ?? defStrings(m), dt: (m === near.note ? near.dt : null) ?? defDetune(m), dtm: m === near.note && near.dt != null,   // beat notches belong to one key: interpolated notes play smooth unisons
      lv: k0.lv + t * (k1.lv - k0.lv),
      B: Math.exp(Math.log(Math.max(B0, 1e-7)) + t * (Math.log(Math.max(B1, 1e-7)) - Math.log(Math.max(B0, 1e-7)))),
      layers: V.map((v, j) => mixLayer(k0.canon[j], k1.canon[j], t)),
      measured: m === k0.note || m === k1.note,
    };
  }
  const body = doc.body && doc.body.hz > 20 ? { hz: +doc.body.hz, level: doc.body.level_db ?? -20, tau: Math.max(0.02, (doc.body.t60 ?? 1.1) / 6.908) } : null;
  const air = doc.air ? { level: doc.air.level_db ?? -48, tau: Math.max(0.05, (doc.air.t60 ?? 1.5) / 6.908) } : null;
  const soundboard = doc.soundboard ? { amount: doc.soundboard.amount ?? 0.5 } : null;
  const eng = doc.engine && typeof doc.engine === 'object' ? doc.engine : null;   // per-instrument switches for piano-only behaviour (docs/INSTRUMENT_FORMAT.md)
  const hasKeyVibrato = keys.some(k => k.sy && k.sy.vibrato);
  return { format: 'compiled-1', name: doc.name || 'Imported instrument', velocities: V, notes, body, air, soundboard, eng, hasKeyVibrato };
}

// A layered instrument: every part is a compiled instrument struck together (js/engine.worklet.js noteOn). The wrapper carries the dominant
// part's tables, engine block and master effects (rotary, tremolo, slider defaults); the weights can be changed live ({ type: 'mixw' }).
export function mixCompiled(parts, name = 'Mix') {
  const dom = parts[0];                                            // the first part (the pad's centre) provides the tables the wrapper is built on and the slider defaults
  const eng = { ...(dom.inst.eng || {}) };
  for (const key of ['tremolo', 'rotary']) {                        // master effects: from the first part that has one, at that part's weight (engine: multiW)
    const i = parts.findIndex(p => p.inst.eng && p.inst.eng[key]);
    if (i >= 0) { eng[key] = parts[i].inst.eng[key]; eng[key + '_from'] = i; } else { delete eng[key]; delete eng[key + '_from']; }
  }
  return { ...dom.inst, eng, name, multi: parts.map(p => ({ inst: p.inst, w: p.w })) };
}

// Which sliders cannot act on this compiled instrument, with the reason (shown greyed out; test/sliders.test.mjs checks that every
// other slider does change the sound). Only reasons that follow from the table and its engine block, never from a guess.
export function inertParams(c) {
  const e = c.eng || {}, out = {};
  let bmax = 0, sMax = 1, tdMin = Infinity, trMin = Infinity, gMin = Infinity, gMax = -Infinity, vMin = Infinity, vMax = -Infinity, nlay = 0, pMax = 0, cutMin = Infinity;
  for (const m in c.notes) {
    const n = c.notes[m]; bmax = Math.max(bmax, n.B); sMax = Math.max(sMax, n.s);
    for (const l of n.layers) {
      for (const t of l.td) tdMin = Math.min(tdMin, t); for (const t of l.tr) trMin = Math.min(trMin, t);
      gMin = Math.min(gMin, l.g); gMax = Math.max(gMax, l.g); vMin = Math.min(vMin, l.v); vMax = Math.max(vMax, l.v); nlay = Math.max(nlay, n.layers.length); pMax = Math.max(pMax, l.l.filter(v => v > -60).length);
      // the strongest the high-ring cut-off can be (corner 1 kHz, slope 5): the factor it can divide a partial's T60 by, at its frequency
      for (let k = 0; k < l.r.length; k++) if (l.l[k] > -50) { const f = 440 * Math.pow(2, (m - 69) / 12) * l.r[k] / (e.anchor ?? 1); cutMin = Math.min(cutMin, Math.min(l.td[k], l.tr[k]) * (1 + Math.pow(f / 3464.1, 2.8)) / (1 + Math.pow(f / 1000, 5))); }
    }
  }
  if (e.sympathetic === false) out.sympRes = 'The sound has no strings that could ring each other.';
  if (e.key_noise === false) { out.keyNoise = 'This instrument makes no key or damper noise.'; out.whoosh = 'This instrument has no sustain-pedal mechanism.'; }
  if (e.knock === 0 && !e.click) out.hammerNoise = 'This instrument has no hammer or key strike to make a thump.';
  if (e.quadratic === 0) out.quadratic = 'This instrument has no non-linear strike component.';
  if (!c.soundboard) out.sbRes = 'This instrument already contains its own body; there are no board modes to add.';
  if (bmax < 1e-5 && !e.inharm) out.size = 'The overtones of this instrument are fixed by its table, not by a string length.';
  if (e.fixed) out.stretch = 'The frequencies of this instrument are fixed, not tuned to the keys.';
  if (sMax === 1) out.unison = 'Every note is a single voice, so there is no unison to spread.';
  if (trMin >= 400 && tdMin >= 400) out.impedance = 'Held tones of this instrument do not decay, so there is no decay time to scale.';
  if (tdMin >= 400) out.direct = 'This instrument has no fast initial decay.';
  // (with a single recorded strength the slider still scales how much softer or harder blows differ from it, so only several equal layers make it inert)
  if (gMax - gMin < 0.05 && nlay > 1) out.dynamics = 'All strike strengths of this instrument are equally loud (no touch response).';
  if (pMax <= 1) for (const k of ['hardP', 'hardM', 'hardF', 'character']) out[k] = 'This sound is a single partial; there is no overtone balance to shape.';
  if (!e.tremolo && !e.rotary && !(e.synth && e.synth.vibrato) && !c.hasKeyVibrato) out.modulation = 'This instrument has no tremolo, vibrato or rotary speaker.';
  if (!e.rotary) out.rotary = 'This instrument has no rotary speaker.';
  return out;
}

// ---- user instrument store (IndexedDB: instrument files are too big for localStorage) ----
const DB = 'resonance-instruments', ST = 'instruments';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(ST, mode), s = t.objectStore(ST), out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
  });
}
export const store = {
  async list() { try { return (await tx('readonly', s => s.getAll())) || []; } catch { return []; } },
  async get(id) { try { return await tx('readonly', s => s.get(id)); } catch { return null; } },
  async put(doc) {
    validate(doc);
    const id = (doc.name || 'instrument').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now().toString(36);
    await tx('readwrite', s => s.put({ id, name: doc.name || id, added: Date.now(), doc }));
    return id;
  },
  async remove(id) { await tx('readwrite', s => s.delete(id)); },
};
