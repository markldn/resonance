// Import recordings: a piano bar where every key takes an audio file (wav, mp3, flac, ogg, aiff where the browser decodes it).
// Files are placed automatically from their names (C4, F#3, Piano.mf.Eb3, A0_v40 ...) or, when a name says nothing, from their
// detected pitch; a key can also be clicked to choose its file by hand. Several files on one key become its strengths
// (soft to loud, by name or by loudness). "Build" measures every note in the analyzer worker and saves the instrument.
import { assemble, guessMidi, pitchEvidence, resolveKey } from './analyzer.js';
import { trimLevels } from './leveltrim.js';

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const nn = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DYN = { ppp: 16, pp: 32, p: 48, mp: 56, mf: 72, f: 88, ff: 104, fff: 120 };
const STRENGTH = [['pp', 32], ['p', 48], ['mf', 72], ['f', 88], ['ff', 104]];
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const AUDIO = /\.(wav|wave|mp3|flac|ogg|oga|opus|m4a|aif|aiff|aac)$/i;
const BLACK = new Set([1, 3, 6, 8, 10]);
const LO = 21, HI = 108;

let D, I = null, decoder = null;
export function initImportAudio(deps) { D = deps; }

/** the key and strength a file name gives: { midi, vel } with null for whatever it does not say (same rules as tools/analyze_instrument.py) */
export function parseName(name) {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  const m = /(?<![A-Za-z])([A-Ga-g])([#b♯♭]?)(-?\d)(?!\d)/.exec(base);
  let midi = null;
  if (m) midi = 12 * (+m[3] + 1) + NOTE[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0);
  let vel = null;
  const v = /(?:^|[^A-Za-z])v(\d{1,3})(?!\d)/i.exec(base);
  if (v) vel = Math.min(127, +v[1]);
  else for (const t of (m ? base.replace(m[0], ' ') : base).split(/[^A-Za-z]+/)) if (DYN[t.toLowerCase()]) { vel = DYN[t.toLowerCase()]; break; }   // (not the note's own letter: "F#5-ff" is ff, not f)
  if (midi != null && (midi < 0 || midi > 127)) midi = null;
  return { midi, vel };
}

async function decode(file) {
  decoder ||= new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000);
  const buf = await decoder.decodeAudioData(await file.arrayBuffer());
  const n = buf.length, ch = buf.numberOfChannels, x = new Float32Array(Math.min(n, Math.round(buf.sampleRate * 40)));   // 40 s is more than any key rings
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / ch; }
  return { x, sr: buf.sampleRate };
}
const peakDb = x => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return 20 * Math.log10(m + 1e-9); };

export function openImportAudio(files) {
  I = { name: 'My piano', items: [], sel: null, busy: false, log: '', seq: 0 };
  render();
  if (files && files.length) addFiles(files);
}

// ------------------------------------------------------------ adding and placing files
async function addFiles(list) {
  const files = [...list].filter(f => AUDIO.test(f.name) || /^audio\//.test(f.type));
  if (!files.length) { I.log = 'No audio files there (wav, mp3, flac, ogg, aiff).'; render(); return; }
  const forKey = I.forKey; I.forKey = null;
  I.busy = true;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], it = { id: ++I.seq, file: f, name: f.name, midi: null, vel: null, peak: -99, status: 'new', note: '' };
    I.log = `Reading ${i + 1} of ${files.length}: ${f.name}`; render();
    const nm = parseName(f.name); it.midi = nm.midi; it.vel = nm.vel; it.named = nm.midi;
    try {
      const { x, sr } = await decode(f); it.peak = peakDb(x); it.sr = sr;
      if (forKey != null) { const g = guessMidi(x, sr); it.midi = forKey; it.manual = true; if (g && Math.abs(g.midi - forKey) > 1) it.note = `sounds like ${nn(g.midi)}`; }
      else {
        if (it.named == null) { const g = guessMidi(x, sr); if (g) { it.named = g.midi; it.fromPitch = true; } }   // no name: YIN's key is the starting point, checked like a name
        if (it.named != null) it.ev = pitchEvidence(x, sr, it.named);
      }
      it.status = 'ready';
    } catch (e) { it.status = 'fail'; it.note = 'could not decode (' + (e && e.message || 'unsupported format') + ')'; }
    I.items.push(it);
  }
  I.busy = false; placeAll(); autoStrengths(); I.log = `${files.length} file${files.length > 1 ? 's' : ''} added.`; render();
}
/** Which key does every file play? A name is a label, not a measurement (a flute named A4 sounds an octave higher), so each file's own evidence decides
 *  (analyzer.js resolveKey) and the octave most of the files need breaks ties for the ones whose evidence is ambiguous: name errors are uniform within an instrument. */
function placeAll() {
  const ev = I.items.filter(it => it.ev && !it.manual), votes = {};
  for (const it of ev) { const k = resolveKey(it.ev); votes[k] = (votes[k] || 0) + 1; }
  const best = Object.keys(votes).map(Number).sort((a, b) => votes[b] - votes[a])[0], prefer = best && votes[best] * 2 > ev.length ? best : 0;
  for (const it of ev) {
    const k = resolveKey(it.ev, prefer); it.midi = it.named + 12 * k; it.status = it.status === 'fail' ? 'fail' : 'ready';
    const was = it.fromPitch ? 'placed by its pitch: check it' : '';
    it.note = k ? `${it.fromPitch ? 'pitch' : 'name said ' + nn(it.named) + ', it'} sounds ${nn(it.midi)}` : (!it.ev.pres[0] ? (it.fromPitch ? was : 'no clear fundamental at the named pitch: check the key') : was);
    if (it.midi < LO || it.midi > HI) { it.midi = null; it.status = 'loose'; it.note = 'outside the piano range'; }
  }
  for (const it of I.items) if (it.midi == null && it.status !== 'fail' && !it.ev) it.status = 'loose';
}
/** files of one key without a stated strength take it from their loudness: 1 file = mf, 2 = p + f, 3 = pp mf ff, more spread evenly */
function autoStrengths() {
  const by = {};
  for (const it of I.items) if (it.midi != null) (by[it.midi] ||= []).push(it);
  for (const list of Object.values(by)) {
    const free = list.filter(it => it.vel == null || it.auto).sort((a, b) => a.peak - b.peak);
    const taken = new Set(list.filter(it => it.vel != null && !it.auto).map(it => it.vel));
    const plan = { 1: [72], 2: [48, 96], 3: [32, 72, 104], 4: [32, 56, 88, 104], 5: [16, 40, 64, 88, 112] }[Math.min(5, free.length)] || [];
    free.forEach((it, i) => { let v = plan[i] ?? 72; while (taken.has(v)) v++; taken.add(v); it.vel = v; it.auto = true; });
  }
}
const label = v => (STRENGTH.find(([, x]) => x === v) || [null])[0] || 'v' + v;

// ------------------------------------------------------------ rendering
function keyboard() {
  const whites = []; for (let m = LO; m <= HI; m++) if (!BLACK.has(m % 12)) whites.push(m);
  const w = 100 / whites.length, wi = m => whites.filter(x => x < m).length, count = {}, state = {};
  for (const it of I.items) if (it.midi != null) { count[it.midi] = (count[it.midi] || 0) + 1; const s = it.status === 'ok' ? 'ok' : it.status === 'fail' ? 'bad' : (state[it.midi] || 'has'); state[it.midi] = state[it.midi] === 'bad' ? 'bad' : s; }
  let h = '';
  const key = m => {
    const black = BLACK.has(m % 12), left = black ? wi(m) * w - w * 0.3 : wi(m) * w, wd = black ? w * 0.6 : w;
    return `<i class="ia-k${black ? ' b' : ''} ${state[m] || ''}${I.sel === m ? ' sel' : ''}" data-m="${m}" style="left:${left}%;width:${wd}%" title="${nn(m)}${count[m] ? ' · ' + count[m] + ' file' + (count[m] > 1 ? 's' : '') : ' · click to choose a file'}">${count[m] > 1 ? `<b>${count[m]}</b>` : ''}${m % 12 === 0 ? `<u>${nn(m)}</u>` : ''}</i>`;
  };
  for (let m = LO; m <= HI; m++) if (!BLACK.has(m % 12)) h += key(m);
  for (let m = LO; m <= HI; m++) if (BLACK.has(m % 12)) h += key(m);
  return `<div class="ia-kb">${h}</div>`;
}
function rows(list) {
  return list.map(it => `<div class="ia-row" data-id="${it.id}">
    <span class="ia-n" title="${esc(it.name)}">${esc(it.name)}${it.note ? `<small>${esc(it.note)}</small>` : ''}</span>
    <select data-k="midi" class="ia-s"><option value="">key?</option>${Array.from({ length: HI - LO + 1 }, (_, i) => LO + i).map(m => `<option value="${m}" ${m === it.midi ? 'selected' : ''}>${nn(m)}</option>`).join('')}</select>
    <select data-k="vel" class="ia-s">${STRENGTH.map(([l, v]) => `<option value="${v}" ${v === it.vel ? 'selected' : ''}>${l}</option>`).join('')}${STRENGTH.some(([, v]) => v === it.vel) ? '' : `<option value="${it.vel}" selected>v${it.vel}</option>`}</select>
    <span class="ia-st ${it.status}">${{ ok: 'measured', fail: 'failed', measuring: '…', ready: '', loose: 'unplaced', new: '' }[it.status] || ''}</span>
    <button class="mini" data-k="rm" title="Remove this file">×</button></div>`).join('');
}
function render() {
  if (!I) return;
  const placed = I.items.filter(it => it.midi != null && it.status !== 'fail'), keys = new Set(placed.map(it => it.midi)), loose = I.items.filter(it => it.midi == null || it.status === 'fail');
  const selItems = I.sel == null ? [] : I.items.filter(it => it.midi === I.sel);
  D.modal('Build an instrument from audio files', `
    <p>Choose the recordings of one instrument, a note per file. Resonance places them by their names or their pitch; click a key on the bar to pick a file for it by hand.
    More than one file on a key gives it several strengths. Keys you leave empty are filled in from their neighbours.</p>
    <div class="gen-row">
      <button class="btn" id="iaAdd">Add files…</button><button class="btn" id="iaDir" title="Every audio file in a folder">Add folder…</button>
      <button class="btn" id="iaClear" ${I.items.length ? '' : 'disabled'}>Clear</button>
    </div>
    ${keyboard()}
    <div class="hint" id="iaSum">${I.busy ? esc(I.log) : `${placed.length} file${placed.length === 1 ? '' : 's'} on ${keys.size} key${keys.size === 1 ? '' : 's'}${loose.length ? ` · ${loose.length} not placed` : ''}${keys.size ? ` · ${nn(Math.min(...keys))}–${nn(Math.max(...keys))}` : ''}${I.log ? ' · ' + esc(I.log) : ''}`}</div>
    ${I.sel != null ? `<h3>${nn(I.sel)}</h3>${rows(selItems) || '<p class="hint">Nothing on this key yet.</p>'}<button class="btn mini" id="iaKeyAdd">Add a file to ${nn(I.sel)}…</button>` : ''}
    ${loose.length ? `<h3>Not placed</h3><p class="hint">Choose a key for these, or remove them.</p>${rows(loose)}` : ''}
    <div class="field" style="margin-top:14px"><label>Name</label><input id="iaName" class="inp" value="${esc(I.name)}"><button class="btn" id="iaBuild" ${placed.length && !I.busy ? '' : 'disabled'}>Build instrument</button></div>
    <p id="iaMsg" class="hint"></p>`);
  const $ = q => document.querySelector(q);
  const pick = (dir, keyFor) => { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.aif,.aiff,.m4a'; if (dir) inp.webkitdirectory = true; inp.onchange = () => { I.forKey = keyFor ?? null; addFiles(inp.files); }; inp.click(); };
  $('#iaAdd').onclick = () => pick(false); $('#iaDir').onclick = () => pick(true);
  $('#iaClear').onclick = () => { I.items = []; I.sel = null; I.log = ''; render(); };
  if ($('#iaKeyAdd')) $('#iaKeyAdd').onclick = () => pick(false, I.sel);
  $('#iaName').oninput = e => { I.name = e.target.value; };
  document.querySelectorAll('.ia-k').forEach(el => el.onclick = () => {
    const m = +el.dataset.m; I.sel = m; render();
    if (!I.items.some(it => it.midi === m)) pick(false, m);
  });
  document.querySelectorAll('.ia-row').forEach(row => {
    const it = I.items.find(x => x.id === +row.dataset.id);
    row.querySelectorAll('[data-k]').forEach(el => el[el.tagName === 'BUTTON' ? 'onclick' : 'onchange'] = () => {
      const k = el.dataset.k;
      if (k === 'rm') I.items = I.items.filter(x => x !== it);
      else if (k === 'midi') { it.manual = true; it.midi = el.value === '' ? null : +el.value; it.status = it.midi == null ? 'loose' : 'ready'; it.note = ''; if (it.midi != null) I.sel = it.midi; it.auto = false; autoStrengths(); }
      else { it.vel = +el.value; it.auto = false; }
      render();
    });
  });
  $('#iaBuild').onclick = build;
}

// ------------------------------------------------------------ measuring
async function build() {
  const todo = I.items.filter(it => it.midi != null && it.status !== 'fail');
  I.busy = true; let done = 0, bad = [];
  const msg = t => { const e = document.querySelector('#iaMsg'); if (e) e.textContent = t; };
  const takes = [];
  document.querySelector('#iaBuild').disabled = true;
  for (const it of todo) {
    msg(`Measuring ${++done} of ${todo.length}: ${nn(it.midi)} (${it.name})…`);
    try {
      const { x, sr } = await decode(it.file);
      const r = await D.analyze(x, sr, it.midi);
      if (!r) { bad.push(`${it.name}: silent or unreadable`); it.status = 'fail'; continue; }
      const cents = 1200 * Math.log2(r.f0_hz / (440 * Math.pow(2, (it.midi - 69) / 12)));
      if (Math.abs(cents) > 70 && !r.inharmonic) { bad.push(`${it.name}: measured ${Math.round(cents)} cents from ${nn(it.midi)}, so it is probably a different key`); it.status = 'fail'; continue; }
      it.status = 'ok'; takes.push({ midi: it.midi, velocity: it.vel, result: r });
    } catch (e) { bad.push(`${it.name}: ${e && e.message || e}`); it.status = 'fail'; }
  }
  I.busy = false;
  if (!takes.length) { I.log = 'No usable notes: ' + (bad[0] || 'nothing measured'); render(); return; }
  let doc;
  try { doc = assemble(takes, { name: I.name || 'My piano', source: `measured from ${takes.length} audio files with Resonance, ${new Date().toISOString().slice(0, 10)}` }); }
  catch (e) { I.log = 'Could not build the instrument: ' + e.message; render(); return; }
  msg('Matching the loudness of every note…');
  const tr = await trimLevels(doc, takes); doc = tr.doc;
  await D.saveAndSelect(doc);
  D.modal('Instrument ready', `<p><b>${esc(doc.name)}</b> is saved and selected: ${doc.keys.length} key${doc.keys.length > 1 ? 's' : ''}, ${takes.length} note${takes.length > 1 ? 's' : ''} measured (${nn(doc.keys[0].note)}–${nn(doc.keys[doc.keys.length - 1].note)}).
    ${bad.length ? `</p><p>${bad.length} file${bad.length > 1 ? 's were' : ' was'} left out:</p><ul>${bad.slice(0, 12).map(b => `<li>${esc(b)}</li>`).join('')}${bad.length > 12 ? `<li>and ${bad.length - 12} more</li>` : ''}</ul><p>` : ''}
    Keys without a recording are filled in from their neighbours. Play it now, use the sliders to adjust it, and <b>Manage</b> to export it as a file.</p>
    <button class="btn" id="iaDl">Download instrument file</button>`);
  document.querySelector('#iaDl').onclick = () => D.download(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), doc.name + '.json');
  I = null;
}
