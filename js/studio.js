// Instrument studio: the variation pad and mix pad (random variations, layered engines), and the audio-import window.
import { draw, morph, generate } from './generator.js';
import { morphSynth, synthesize, SYNTH_LIST } from './synth.js';
import { compile, mixCompiled } from './instrument.js';
import { mountVarPad } from './varpad.js';
import { initImportAudio, openImportAudio } from './importaudio.js';
export { openImportAudio };

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const nn = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let D;                                             // deps from main.js
export function initStudio(deps) { D = deps; initImportAudio(deps); }

// ======================= generator =======================
// The variation pad, a joystick with the instrument in the middle and four things in the corners. Two modes:
//   Vary   the corners are four random variations of one instrument (the measured Iowa Grand or a synth); the puck blends them.
//   Mix    the corners are four instruments (any engine: measured pianos, synths, your own; each can be a random variation of itself);
//          the puck layers them (js/instrument.js mixCompiled), so a piano can turn into a bell into an organ under your fingers.
// The sound switches as you drag, also while a MIDI file plays. Nothing is stored until "Save". Settings are remembered per mode.
const GKEY = 'resonance.varpad2';
const gload = () => { try { return JSON.parse(localStorage.getItem(GKEY)) || {}; } catch { return {}; } };
const gsave = o => { try { localStorage.setItem(GKEY, JSON.stringify(o)); } catch { } };
const newSeed = () => (Math.random() * 1e9) >>> 0;
const tag = sd => sd == null ? 'original' : '#' + String(sd % 10000).padStart(4, '0');
let genDoc = null;
export async function openGenerator() {
  // every instrument the menu offers can be varied: the measured pianos, the synths, your imported and measured ones (a new import is in the list the next time this opens)
  const st = gload(), kinds = (await D.models()).map(([v, l]) => [v.startsWith('synth:') ? v.slice(6) : v, l]);
  if (st.kind === 'piano') { st.kind = 'builtin:iowa_grand'; if (st.vary && st.vary.piano) st.vary['builtin:iowa_grand'] ||= st.vary.piano; }          // the first version's name for the Iowa Grand
  const S = { mode: st.mode === 'mix' ? 'mix' : 'vary', kind: kinds.some(([id]) => id === st.kind) ? st.kind : 'builtin:iowa_grand', strength: st.strength ?? 2.2, vary: st.vary || {}, mix: st.mix || null };
  const cur = () => S.vary[S.kind] ||= { x: 0, y: 0, seeds: [newSeed(), newSeed(), newSeed(), newSeed()] };
  const remember = () => gsave({ mode: S.mode, kind: S.kind, strength: S.strength, vary: S.vary, mix: S.mix });
  D.modal('Instrument variation', `
    <div class="gen-row">
      <button class="btn" id="vpModeVary">Vary one instrument</button><button class="btn" id="vpModeMix">Mix instruments</button>
    </div>
    <p id="vpHelp"></p>
    <div id="vpVaryOpts">
      <div class="field"><label>Kind</label><select id="genKind">${kinds.map(([id, l]) => `<option value="${id}">${l.replace(/</g, '&lt;')}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Strength</label><input type="range" id="vpStrength" min="0.5" max="4" step="0.1" style="flex:1"><span id="vpStrengthV" class="hint" style="min-width:30px;text-align:right"></span></div>
    <div id="vpMixCentre" class="field"><label>Centre</label><select id="vpCentre" style="flex:1"></select><button class="btn mini" id="vpCentreNew" title="A random variation of the centre instrument">New</button></div>
    <div id="vpad"></div>
    <div class="gen-row">
      <button class="btn" id="vpHome" title="Puck back to the middle">Centre puck</button>
      <button class="btn" id="vpAll" title="Roll new corners: four new variations, or four random instruments">New corners</button>
      <button class="btn" id="vpMangle" title="Four random engines, each varied, the puck somewhere in between">Mangle</button>
      <button class="btn" id="genTest" disabled title="Play a short phrase with this sound">▶ Test</button>
    </div>
    <div class="field" style="margin-top:14px"><label>Name</label><input id="genName" class="inp" placeholder="(generated name)"><button class="btn" id="genSave" disabled>Save</button></div>
    <p id="genMsg" class="hint"></p>`);
  const $ = q => document.querySelector(q);
  let mixName = 'Mix', models = [], drawCache = new Map(), compCache = new Map(), busy = false, queued = null, pad = null, applied = null;
  const drawOf = seed => { if (!drawCache.has(seed)) drawCache.set(seed, draw(seed)); return drawCache.get(seed); };
  const mixSt = () => S.mix ||= { x: 0, y: 0, centre: { model: 'builtin:iowa_grand', seed: null }, corners: [{ model: 'synth:epiano', seed: null }, { model: 'synth:bell', seed: null }, { model: 'synth:organ', seed: null }, { model: 'synth:vibraphone', seed: null }] };
  const mlabel = m => (models.find(o => o[0] === m) || [m, m])[1].replace(/ ·.*$/, '').replace(/ \(.*$/, '');
  const slotName = sl => `${mlabel(sl.model)} ${sl.seed == null ? '' : tag(sl.seed)}`.trim();
  const strengthLabel = () => { $('#vpStrengthV').textContent = S.strength.toFixed(1) + '×'; };

  // ---- Vary mode
  const buildVary = async (w, gain) => {
    const c = cur(), g = gain * S.strength;
    if (SYNTH_LIST.some(([id]) => id === S.kind)) return morphSynth(S.kind, c.seeds, w, g);
    const doc = await D.rawDoc(S.kind);                                                        // a measured instrument (Iowa, Salamander, imported, from your folder)
    return morph(doc, c.seeds.map(drawOf), w, g, `${doc.name.replace(/ \((measured|sampled)\)$/, '')} variation`);
  };
  // ---- Mix mode: every slot (centre + 4 corners) is a compiled instrument, cached by its model, seed and strength
  const compiledFor = async sl => {
    const k = `${sl.model}|${sl.seed}|${S.strength}`;
    if (!compCache.has(k)) compCache.set(k, (async () => {
      let doc = await D.rawDoc(sl.model);
      if (sl.seed != null) doc = sl.model.startsWith('synth:') ? synthesize(sl.model.slice(6), sl.seed, 1) : generate(doc, sl.seed, S.strength);
      return compile(doc);
    })());
    return compCache.get(k);
  };
  const buildMix = async w => {
    const M = mixSt(), slots = [M.centre, ...M.corners], sig = slots.map(sl => `${sl.model}|${sl.seed}`).join(',') + '|' + S.strength, vec = [w.center, ...w.poles];
    if (applied === sig) { D.mixWeights(vec); return null; }                               // only the puck moved: same parts, new weights
    const parts = await Promise.all(slots.map(async (sl, i) => ({ inst: await compiledFor(sl), w: vec[i] })));
    applied = sig;
    const top = [...parts.keys()].sort((a, b) => vec[b] - vec[a]).slice(0, 2).map(i => slotName(slots[i]));
    const name = mixName = 'Mix: ' + top.join(' + ');
    D.applyMix(mixCompiled(parts, name), name);
    return { name, keys: 88, mix: true };
  };
  const say = doc => {
    $('#genName').placeholder = doc.name; $('#genTest').disabled = false; $('#genSave').disabled = false;
    $('#genMsg').textContent = `Now playing “${doc.name}”` + (doc.mix ? ' (a layered mix of engines).' : ` (${doc.keys.length} keys, ${nn(doc.keys[0].note)}–${nn(doc.keys[doc.keys.length - 1].note)}).`);
  };
  const apply = async (w, gain) => {                             // one build at a time; the latest puck position always wins
    if (busy) { queued = [w, gain]; return; }
    busy = true;
    try {
      if (S.mode === 'vary') { genDoc = await buildVary(w, gain); D.updateTemporary(genDoc); say(genDoc); }
      else { const r = await buildMix(w); if (r) { genDoc = null; say(r); } else say({ name: mixName, mix: true }); }
    } finally { busy = false; }
    if (queued) { const q = queued; queued = null; apply(...q); }
  };
  const repush = () => { applied = null; pad.move(pad.state.x, pad.state.y); };

  // ---- (re)build the pad for the current mode
  const mountPad = () => {
    const state = S.mode === 'vary' ? cur() : mixSt();
    pad = mountVarPad($('#vpad'), state, {
      onMove: (w, g) => { apply(w, g); }, onEnd: remember,
      label: i => S.mode === 'vary' ? tag(cur().seeds[i]) : slotName(mixSt().corners[i]),
      centre: () => S.mode === 'vary' ? 'original' : slotName(mixSt().centre),
    });
    pad.state = state;
    for (let i = 0; i < 4; i++) {
      const el = pad.pole(i);
      if (S.mode === 'vary') { el.innerHTML = `<button class="btn mini" title="Roll a new random variation for this corner">New</button><span>${tag(cur().seeds[i])}</span>`; el.querySelector('button').onclick = () => { cur().seeds[i] = newSeed(); remember(); mountPad(); repush(); }; }
      else {
        const sl = mixSt().corners[i];
        el.innerHTML = `<select class="pad-sel">${models.map(([v, l]) => `<option value="${v}">${l.replace(/</g, '&lt;')}</option>`).join('')}</select><span><button class="btn mini" title="A random variation of this instrument">New</button> <button class="btn mini" title="The instrument as it is">Orig</button> ${tag(sl.seed)}</span>`;
        const sel = el.querySelector('select'); sel.value = sl.model;
        sel.onchange = () => { sl.model = sel.value; sl.seed = null; remember(); mountPad(); repush(); };
        const [bn, bo] = el.querySelectorAll('button');
        bn.onclick = () => { sl.seed = newSeed(); remember(); mountPad(); repush(); }; bo.onclick = () => { sl.seed = null; remember(); mountPad(); repush(); };
      }
    }
  };
  const layout = () => {
    const vary = S.mode === 'vary';
    $('#vpModeVary').classList.toggle('primary', vary); $('#vpModeMix').classList.toggle('primary', !vary);
    $('#vpVaryOpts').style.display = vary ? '' : 'none'; $('#vpMixCentre').style.display = vary ? 'none' : '';
    $('#vpMangle').style.display = vary ? 'none' : '';
    $('#vpHelp').innerHTML = vary
      ? `Drag the puck. The <b>middle</b> is the instrument as it is; each <b>corner</b> is a different random variation of it, and the puck blends them, so you can steer between brightness, sustain, overtone balance and body. <b>Strength</b> sets how far the corners go; the <b>outer ring</b> goes further still. <b>New</b> rolls a different variation for a corner.`
      : `Pick an instrument for the <b>centre</b> and for each <b>corner</b>, from any engine: the measured pianos, the synths, your own. The puck layers them, so it can turn a piano into a bell into an organ as you drag; each keeps its own vibrato, noise and release. <b>New</b> makes a random variation of that corner's instrument, <b>Orig</b> takes it back. <b>Mangle</b> picks four random engines at once.`;
    $('#genKind').value = S.kind; $('#vpStrength').value = S.strength; strengthLabel();
    const cs = $('#vpCentre'); cs.innerHTML = models.map(([v, l]) => `<option value="${v}">${l.replace(/</g, '&lt;')}</option>`).join(''); cs.value = mixSt().centre.model;
    mountPad();
  };
  (async () => {
    models = await D.models();
    layout();
  })();
  const setMode = m => { S.mode = m; applied = null; remember(); layout(); };
  $('#vpModeVary').onclick = () => setMode('vary'); $('#vpModeMix').onclick = () => setMode('mix');
  $('#genKind').onchange = () => { S.kind = $('#genKind').value; remember(); mountPad(); repush(); };
  $('#vpStrength').oninput = () => { S.strength = +$('#vpStrength').value; strengthLabel(); applied = null; remember(); repush(); };
  $('#vpCentre').onchange = () => { const M = mixSt(); M.centre = { model: $('#vpCentre').value, seed: null }; remember(); mountPad(); repush(); };
  $('#vpCentreNew').onclick = () => { const M = mixSt(); M.centre.seed = newSeed(); remember(); mountPad(); repush(); };
  $('#vpHome').onclick = () => { pad.move(0, 0); remember(); };
  $('#vpAll').onclick = () => {
    if (S.mode === 'vary') cur().seeds = [newSeed(), newSeed(), newSeed(), newSeed()];
    else { const M = mixSt(), pool = models.map(o => o[0]).sort(() => Math.random() - 0.5); M.corners = M.corners.map((_, i) => ({ model: pool[i % pool.length], seed: null })); }
    remember(); mountPad(); repush();
  };
  $('#vpMangle').onclick = () => {                                // four random engines, each a random variation, the puck at a random place
    const M = mixSt(), pool = models.map(o => o[0]).sort(() => Math.random() - 0.5), a = Math.random() * 6.283, r = 0.35 + 0.5 * Math.random();
    M.centre = { model: pool[4 % pool.length], seed: null }; M.corners = [0, 1, 2, 3].map(i => ({ model: pool[i % pool.length], seed: newSeed() }));
    M.x = r * Math.cos(a); M.y = r * Math.sin(a); remember(); layout(); repush();
  };
  $('#genTest').onclick = () => D.playDemo(genDoc ? genDoc.keys[0].note : 21, genDoc ? genDoc.keys[genDoc.keys.length - 1].note : 108);
  $('#genSave').onclick = async () => {
    if (S.mode === 'mix') { $('#genMsg').textContent = 'A layered mix plays live but cannot be saved as one instrument file yet; use Vary mode to save an instrument.'; return; }
    if (!genDoc) return;
    const doc = { ...genDoc, name: $('#genName').value.trim() || genDoc.name };
    await D.saveAndSelect(doc);
    $('#genSave').disabled = true;
    $('#genMsg').textContent = `Saved as “${doc.name}” under Your instruments.`;
  };
}
